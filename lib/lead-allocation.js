const { ObjectId } = require('mongodb');
const { ROLES, isManager, canAccessSite } = require('./roles');
const { serializeLead } = require('./records');

const reference = (id) => ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { deal_id: id };

function installAllocation(router, database) {
  const route = (handler) => async (req, res) => {
    if (!isManager(req.user)) return res.status(403).json({ success: false, error: 'Lead allocation requires a manager account.' });
    try {
      const db = await database(req);
      const lead = await db.collection('leads').findOne(reference(req.params.id));
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found.' });
      await handler(req, res, db, lead, await database());
    } catch (error) {
      console.error('Lead allocation failed:', error.message);
      res.status(500).json({ success: false, error: 'Unable to complete the allocation request.' });
    }
  };
  const eligible = (user, lead) => user && ROLES.includes(user.role) && user.role !== 'contractor' && canAccessSite(user, lead.dealership_name);

  router.get('/leads/:id/assignees', route(async (req, res, db, lead, rawDb) => {
    const active = await rawDb.collection('users').find({ active: true }).sort({ name: 1, _id: 1 }).toArray();
    res.json({ success: true, data: active.filter(user => eligible(user, lead))
      .map(user => ({ id: String(user._id), name: user.name, email: user.email })) });
  }));

  router.patch('/leads/:id/assignment', route(async (req, res, db, lead, rawDb) => {
    const { assigneeId, expectedOwnerId } = req.body;
    if ((assigneeId !== null && (typeof assigneeId !== 'string' || !ObjectId.isValid(assigneeId))) ||
      (expectedOwnerId !== null && (typeof expectedOwnerId !== 'string' || !ObjectId.isValid(expectedOwnerId)))) {
      return res.status(400).json({ success: false, error: 'Choose an assignee and include the current assignment.' });
    }
    const assignee = assigneeId && await rawDb.collection('users').findOne({ _id: new ObjectId(assigneeId), active: true });
    if (assigneeId && !eligible(assignee, lead)) {
      return res.status(403).json({ success: false, error: 'The selected account does not have access to this dealership.' });
    }
    const nextId = assignee ? String(assignee._id) : null;
    const ownerName = assignee?.name || 'Unassigned';
    const now = new Date();
    const updated = await rawDb.client.withSession(session => session.withTransaction(async () => {
      const result = await db.collection('leads').findOneAndUpdate(
        { _id: lead._id, dealership_name: lead.dealership_name, owner_id: expectedOwnerId },
        {
          $set: { owner_id: nextId, owner_name: ownerName, assigned_at: now, assigned_by: req.user.id, updatedAt: now, followup_days: [], next_action: null, last_activity_at: now.toISOString() },
          $inc: { process_revision: 1 },
          $push: { diary_entries: { author: req.user.name, date: now.toISOString(), note: nextId ? `Assigned to ${ownerName}.` : 'Returned to the unassigned queue.' } },
        },
        { returnDocument: 'after', session },
      );
      if (!result) return null;
      const linked = { dealership: lead.dealership_name, lead_id: String(lead._id) };
      for (const name of ['deals', 'appraisals', 'deliveries', 'sales_alerts']) {
        await db.collection(name).updateMany(linked, { $set: { owner_id: nextId } }, { session });
      }
      await db.collection('sales_tasks').updateMany({ ...linked, status: 'open' }, { $set: { assignee_id: nextId, assignee_name: ownerName } }, { session });
      const references = [String(lead._id), lead.deal_id].filter(Boolean);
      await db.collection('appointments').updateMany(
        { dealership: lead.dealership_name, leadId: { $in: references } },
        { $set: { consultant_id: nextId, consultantName: ownerName } }, { session },
      );
      return result;
    }));
    if (!updated) return res.status(409).json({ success: false, error: 'The lead assignment changed. Reload it and try again.' });
    res.json({ success: true, data: serializeLead(updated) });
  }));
}

module.exports = { installAllocation, reference };
