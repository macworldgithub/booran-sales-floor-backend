const { ObjectId } = require('mongodb');
const { serializeLead, string, dateBoundary } = require('./records');
const { reference } = require('./lead-allocation');
const { isManager, canAccessSite, canReceiveLeads } = require('./roles');
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
    const requestId = req.body.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId))) fail(400, 'Include a valid next-action request ID.');
    if (requestId && lead.last_next_action_request?.id === requestId) {
      if (JSON.stringify([title, note, dueAt]) !== lead.last_next_action_request.fingerprint) fail(409, 'This request ID was already used for another action.');
      await require('./crm-updates').notify(await database(), lead, lead.next_action_review?.status==='pending'?'approval_requested':'action_recorded', requestId);
      return res.json({ success: true, data: serializeLead(lead) });
    }
    if (lead.next_action_review?.status === 'pending') fail(409, 'A manager is already reviewing this follow-up date.');
    const policy = validateFollowup(lead, dueAt, now, true, true);
    const review = policy.needsApproval ? { id: new ObjectId().toString(), status: 'pending', title, note, due_at: dueAt,
      requested_by: req.user.id, requested_name: req.user.name, requested_at: now.toISOString(), max_date: policy.maxDate } : null;
    const raw = await database();
    const updated = await raw.client.withSession(session => session.withTransaction(async () => {
      const changed = await db.collection('leads').findOneAndUpdate({ _id: lead._id, owner_id: lead.owner_id, ...version(lead), status: lead.status }, {
        $set: { status: 'following_up', next_action: { title, due_at: dueAt, recorded_at: now.toISOString(), author: req.user.name, author_id: req.user.id, status: review ? 'awaiting_approval' : 'open' },
          next_action_review: review, ...(requestId ? { last_next_action_request: { id: requestId, fingerprint: JSON.stringify([title, note, dueAt]) } } : {}), followup_days: policy.days,
          last_activity_at: now.toISOString(), last_activity_by: req.user.id, updatedAt: now },
        $inc: { process_revision: 1 }, $addToSet: { booran_edited_fields: 'status' },
        $push: { ...(lead.status!=='following_up'?{stage_history:{from:lead.status,to:'following_up',at:now.toISOString(),by:req.user.id}}:{}), diary_entries: { kind: 'next_action', author_role: req.user.role, author: req.user.name, author_id: req.user.id, date: now.toISOString(), note: `${note}\nNext action: ${title} · ${dueAt}${review ? ' · Awaiting Manager Approval' : ' · Action Recorded'}` } },
      }, { returnDocument: 'after', session });
      if (!changed) fail(409, 'The lead changed. Refresh before saving the next action.');
      // Record the previous action as done when contact is logged.
      await db.collection('sales_tasks').updateMany({ lead_id: String(lead._id), kind: 'next_action', status: 'open' },
        { $set: { status: 'completed', completed_at: now.toISOString(), closed_by: req.user.id },
          $push: { completion_events: { date: now.toISOString(), user_id: req.user.id } } }, { session });
      await raw.collection('sales_tasks').insertOne({ _id: new ObjectId(), lead_id: String(lead._id), dealership: lead.dealership_name,
        assignee_id: lead.owner_id, assignee_name: lead.owner_name, title, notes: note, due_at: dueAt, status: review ? 'awaiting_approval' : 'open', review_id: review?.id, kind: 'next_action',
        created_by: req.user.id, createdAt: now.toISOString() }, { session });
      return changed;
    }));
    await require('./crm-updates').notify(await database(), updated, review ? 'approval_requested' : 'action_recorded', requestId || String(updated.process_revision));
    res.json({ success: true, data: serializeLead(updated) });
  }));
  router.post('/leads/:id/loss-request', route(async (req, res) => {
    const { db, lead } = await context(req);
    if (lead.status === 'sold' || lead.status === 'lost') fail(409, 'This lead already has a final outcome.');
    if (lead.loss_review?.status === 'pending') fail(409, 'This lead is already awaiting manager review.');
    if (lead.next_action_review?.status === 'pending') fail(409, 'Resolve the pending follow-up date review before requesting a loss.');
    const reason = string(req.body.reason, 'Loss reason', { required: true, max: 2000 });
    const connexLostReason = req.body.connexLostReason;
    if (connexLostReason !== undefined && !require('./connex-policy').LOST_REASONS.includes(connexLostReason)) fail(400, 'Choose a valid Connex loss category.');
    const now = new Date();
    const review = { id: new ObjectId().toString(), status: 'pending', reason, requested_by: req.user.id, requested_name: req.user.name, requested_at: now.toISOString() };
    if (connexLostReason) review.connex_lost_reason = connexLostReason;
    const raw = await database();
    const updated = await raw.client.withSession(session => session.withTransaction(async()=>{
    const changed = await db.collection('leads').findOneAndUpdate({ _id: lead._id, status: lead.status, ...version(lead) }, {
      $set: { loss_review: review, updatedAt: now, last_activity_at: now.toISOString(), last_activity_by: req.user.id }, $inc: { process_revision: 1 },
      $push: { diary_entries: { kind: 'loss_request', author_role: req.user.role, author_id: req.user.id, author: req.user.name, date: now.toISOString(), note: `Loss requested: ${reason}` } },
    }, { returnDocument: 'after', session });
    if (!changed) fail(409, 'The lead changed. Refresh and try again.');
    await db.collection('sales_tasks').updateMany({ lead_id: String(lead._id), status: 'open' }, { $set: { status: 'awaiting_approval', review_id: review.id } }, {session});
    return changed;
    }));
    await require('./crm-updates').notify(raw, updated, 'approval_requested', review.id);
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
    if (req.body.connexLostReason !== undefined && !require('./connex-policy').LOST_REASONS.includes(req.body.connexLostReason)) fail(400, 'Choose a valid Connex loss category.');
    const raw = await database();
    let assignee;
    if (action === 'reassign') {
      if (typeof req.body.assigneeId !== 'string' || !ObjectId.isValid(req.body.assigneeId)) fail(400, 'Choose a salesperson.');
      assignee = await raw.collection('users').findOne({ _id: new ObjectId(req.body.assigneeId), active: true });
      if (!canReceiveLeads(assignee) || !canAccessSite(assignee, lead.dealership_name)) fail(403, 'Salesperson is unavailable at this dealership.');
    }
    const now = new Date();
    const review = { ...lead.loss_review, status: action === 'call' ? 'pending' : action === 'approve' ? 'approved' : 'returned',
      last_action: action, reviewed_by: req.user.id, reviewed_name: req.user.name, reviewed_at: now.toISOString(), notes };
    if (req.body.connexLostReason) review.connex_lost_reason = req.body.connexLostReason;
    const fields = { loss_review: review, updatedAt: now, last_activity_at: now.toISOString(), last_activity_by: req.user.id };
    if (action === 'approve') {
      fields.status = 'lost';
      fields.lost_at = now.toISOString();
      fields.trade_in_loss_checked = false;
      fields.next_action = null;
      fields.next_action_review = null;
      fields.first_followup_due_at = null;
      fields.followup_days = [];
    }
    if (action === 'return' || action === 'reassign') fields.status = 'following_up';
    if (assignee) Object.assign(fields, { owner_id: String(assignee._id), owner_name: assignee.name, assigned_at: now, assigned_by: req.user.id });
    const updated = await raw.client.withSession(session => session.withTransaction(async () => {
      const result = await db.collection('leads').findOneAndUpdate({ _id: lead._id, status: lead.status, 'loss_review.id': reviewId, 'loss_review.status': 'pending', ...version(lead) }, {
        $set: fields, $inc: { process_revision: 1 },
        $addToSet: { booran_edited_fields: 'status' },
        $push: { ...(fields.status&&fields.status!==lead.status?{stage_history:{from:lead.status,to:fields.status,at:now.toISOString(),by:req.user.id}}:{}), diary_entries: { author_role: req.user.role, kind: 'loss_review', author: req.user.name, author_id: req.user.id, date: now.toISOString(),
          ...(assignee ? { kind: 'assignment', assignee_id: String(assignee._id), assignee_name: assignee.name } : {}),
          note: `Loss review — ${action}: ${notes || lead.loss_review.reason}` } },
      }, { returnDocument: 'after', session });
      if (!result) fail(409, 'The lead changed. Refresh and try again.');
      const leadIdentifiers = [String(lead._id), lead._id, lead.deal_id].filter(Boolean);
      if (action !== 'call') await db.collection('sales_tasks').updateMany({ lead_id: { $in: leadIdentifiers }, status: 'awaiting_approval', review_id: reviewId }, { $set: { status: action === 'approve' ? 'completed' : 'open', ...(action === 'approve' ? { completed_at: now.toISOString(), resolution: 'Loss approved by manager' } : {}) } }, { session });
      if (action === 'approve') {
        await db.collection('sales_tasks').updateMany({ lead_id: { $in: leadIdentifiers }, status: { $in: ['open', 'awaiting_approval'] } }, { $set: { status: 'completed', completed_at: now.toISOString(), resolution: 'Loss approved by manager' } }, { session });
        await db.collection('appointments').updateMany({ leadId: { $in: leadIdentifiers }, status: { $ne: 'Cancelled' } }, { $set: { status: 'Cancelled' } }, { session });
      }
      if (assignee) {
        for (const name of ['deals', 'appraisals', 'deliveries', 'sales_alerts', 'trade_in_opportunities', 'service_bookings']) await db.collection(name).updateMany({ lead_id: String(lead._id), dealership: lead.dealership_name }, { $set: { owner_id: String(assignee._id) } }, { session });
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
