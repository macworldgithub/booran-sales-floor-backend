const { ObjectId } = require('mongodb');
const { serializeLead, string, dateBoundary } = require('./records');
const { reference } = require('./lead-allocation');
const { isManager, canAccessSite, ROLES } = require('./roles');
const { route, fail } = require('./workflow-route');
const { followupPolicy, validateFollowup, isActiveLead } = require('./followup-policy');
const version = lead => ({ process_revision: lead.process_revision ?? null });

function installLeadProcess(router, database) {
  const context = async req => {
    if (!isManager(req.user) && req.user.role !== 'sales_consultant') fail(403, 'A sales account is required.');
    const db = await database(req);
    const lead = await db.collection('leads').findOne(reference(req.params.id));
    if (!lead || lead.merged_into) fail(404, 'Lead not found.');
    return { db, lead };
  };
  router.get('/leads/:id/follow-up-policy', route(async (req, res) => {
    const { lead } = await context(req);
    res.json({ success: true, data: { ...followupPolicy(lead), afterContact: followupPolicy(lead, new Date(), true) } });
  }));
  router.post('/leads/:id/next-action', route(async (req, res) => {
    const { db, lead } = await context(req);
    if (!lead.owner_id) fail(409, 'Assign this lead before setting its next action.');
    if (!isActiveLead(lead)) fail(409, 'Reopen this lead before setting a follow-up.');
    if (lead.loss_review?.status === 'pending') fail(409, 'Resolve the pending loss review before scheduling a new follow-up.');
    const now = new Date();
    const title = string(req.body.title, 'Next action', { required: true });
    const note = string(req.body.note, 'Contact / follow-up note', { required: true, max: 2000 });
    const dueAt = dateBoundary(req.body.dueAt);
    const policy = validateFollowup(lead, dueAt, now, true);
    const raw = await database();
    const updated = await raw.client.withSession(session => session.withTransaction(async () => {
      const changed = await db.collection('leads').findOneAndUpdate({ _id: lead._id, owner_id: lead.owner_id, ...version(lead), status: lead.status }, {
        $set: { status: 'following_up', next_action: { title, due_at: dueAt, recorded_at: now.toISOString(), author: req.user.name }, followup_days: policy.days,
          last_activity_at: now.toISOString(), updatedAt: now },
        $inc: { process_revision: 1 }, $addToSet: { booran_edited_fields: 'status' },
        $push: { diary_entries: { author: req.user.name, date: now.toISOString(), note: `${note}\nNext action: ${title} · ${dueAt}` } },
      }, { returnDocument: 'after', session });
      if (!changed) fail(409, 'The lead changed. Refresh before saving the next action.');
      // Record the previous action as done when contact is logged.
      await db.collection('sales_tasks').updateMany({ lead_id: String(lead._id), kind: 'next_action', status: 'open' },
        { $set: { status: 'completed', completed_at: now.toISOString() } }, { session });
      await raw.collection('sales_tasks').insertOne({ _id: new ObjectId(), lead_id: String(lead._id), dealership: lead.dealership_name,
        assignee_id: lead.owner_id, assignee_name: lead.owner_name, title, notes: note, due_at: dueAt, status: 'open', kind: 'next_action',
        created_by: req.user.id, createdAt: now.toISOString() }, { session });
      return changed;
    }));
    res.json({ success: true, data: serializeLead(updated) });
  }));
  router.post('/leads/:id/loss-request', route(async (req, res) => {
    const { db, lead } = await context(req);
    if (lead.status === 'sold' || lead.status === 'lost') fail(409, 'This lead already has a final outcome.');
    if (lead.loss_review?.status === 'pending') fail(409, 'This lead is already awaiting manager review.');
    const reason = string(req.body.reason, 'Loss reason', { required: true, max: 2000 });
    const now = new Date();
    const review = { id: new ObjectId().toString(), status: 'pending', reason, requested_by: req.user.id, requested_name: req.user.name, requested_at: now.toISOString() };
    const updated = await db.collection('leads').findOneAndUpdate({ _id: lead._id, status: lead.status, ...version(lead) }, {
      $set: { loss_review: review, updatedAt: now, last_activity_at: now.toISOString() }, $inc: { process_revision: 1 },
      $push: { diary_entries: { author: req.user.name, date: now.toISOString(), note: `Loss requested: ${reason}` } },
    }, { returnDocument: 'after' });
    if (!updated) fail(409, 'The lead changed. Refresh and try again.');
    res.json({ success: true, data: serializeLead(updated) });
  }));
  router.post('/leads/:id/loss-review', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can review lost leads.');
    const { db, lead } = await context(req);
    const { action, reviewId } = req.body;
    if (!['approve', 'call', 'reassign', 'return'].includes(action)) fail(400, 'Choose a manager review action.');
    if (!reviewId || lead.loss_review?.id !== reviewId || lead.loss_review.status !== 'pending') fail(409, 'This loss review has changed or is already resolved.');
    if (!isActiveLead(lead)) fail(409, 'This lead already has a final outcome.');
    const notes = string(req.body.notes, 'Manager notes', { required: action !== 'approve', max: 2000 });
    const raw = await database();
    let assignee;
    if (action === 'reassign') {
      if (typeof req.body.assigneeId !== 'string' || !ObjectId.isValid(req.body.assigneeId)) fail(400, 'Choose a salesperson.');
      assignee = await raw.collection('users').findOne({ _id: new ObjectId(req.body.assigneeId), active: true });
      if (!assignee || !ROLES.includes(assignee.role) || assignee.role === 'contractor' || !canAccessSite(assignee, lead.dealership_name)) fail(403, 'Salesperson is unavailable at this dealership.');
    }
    const now = new Date();
    const review = { ...lead.loss_review, status: action === 'call' ? 'pending' : action === 'approve' ? 'approved' : 'returned',
      last_action: action, reviewed_by: req.user.id, reviewed_name: req.user.name, reviewed_at: now.toISOString(), notes };
    const fields = { loss_review: review, updatedAt: now, last_activity_at: now.toISOString() };
    if (action === 'approve') fields.status = 'lost';
    if (action === 'return' || action === 'reassign') fields.status = 'following_up';
    if (assignee) Object.assign(fields, { owner_id: String(assignee._id), owner_name: assignee.name, assigned_at: now, assigned_by: req.user.id, followup_days: [], next_action: null });
    const updated = await raw.client.withSession(session => session.withTransaction(async () => {
      const result = await db.collection('leads').findOneAndUpdate({ _id: lead._id, status: lead.status, 'loss_review.id': reviewId, 'loss_review.status': 'pending', ...version(lead) }, {
        $set: fields, $inc: { process_revision: 1 },
        $addToSet: { booran_edited_fields: 'status' },
        $push: { diary_entries: { author: req.user.name, date: now.toISOString(), note: `Loss review — ${action}: ${notes || lead.loss_review.reason}` } },
      }, { returnDocument: 'after', session });
      if (!result) fail(409, 'The lead changed. Refresh and try again.');
      if (action === 'approve') await db.collection('sales_tasks').updateMany({ lead_id: String(lead._id), status: 'open' }, { $set: { status: 'completed', completed_at: now.toISOString(), resolution: 'Loss approved by manager' } }, { session });
      if (assignee) {
        for (const name of ['deals', 'appraisals', 'deliveries', 'sales_alerts']) await db.collection(name).updateMany({ lead_id: String(lead._id), dealership: lead.dealership_name }, { $set: { owner_id: String(assignee._id) } }, { session });
        await db.collection('sales_tasks').updateMany({ lead_id: String(lead._id), status: 'open' }, { $set: { assignee_id: String(assignee._id), assignee_name: assignee.name } }, { session });
        await db.collection('appointments').updateMany({ leadId: { $in: [String(lead._id), lead.deal_id].filter(Boolean) }, dealership: lead.dealership_name }, { $set: { consultant_id: String(assignee._id), consultantName: assignee.name } }, { session });
      }
      if (action === 'call' || action === 'return' || assignee) await raw.collection('sales_tasks').insertOne({ _id: new ObjectId(),
        lead_id: String(lead._id), dealership: lead.dealership_name, assignee_id: action === 'call' ? req.user.id : fields.owner_id || lead.owner_id || req.user.id,
        assignee_name: action === 'call' ? req.user.name : fields.owner_name || lead.owner_name || req.user.name,
        title: action === 'call' ? 'Manager call: review proposed loss' : 'Follow up returned loss', notes,
        due_at: now.toISOString(), status: 'open', createdAt: now.toISOString(), created_by: req.user.id }, { session });
      return result;
    }));
    res.json({ success: true, data: serializeLead(updated) });
  }));
}
module.exports = { installLeadProcess };
