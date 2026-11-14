const { isManager, canAccessSite } = require('./roles');
const { transferAssignedWork } = require('./lead-allocation');

async function allocationOnlyName(db, name, site) {
  if (!name || name === 'Unassigned') return false;
  const people = await db.collection('users').find({ active: true, allocation_only: true },
    { projection: { name: 1, role: 1, site: 1, allowedSites: 1 } }).toArray();
  return people.some(person => person.name?.trim().toLowerCase() === name.trim().toLowerCase() && canAccessSite(person, site));
}

function routingQuery(allocator, site) {
  return { dealership_name: site, owner_id: String(allocator._id), merged_into: { $exists: false },
    owner_source: { $in: ['dealersocket', 'connex'] }, assigned_by: { $exists: false },
    status: { $in: ['new_lead', 'following_up', 'returned', null, ''] },
    'loss_review.status': { $ne: 'pending' }, booran_edited_fields: { $ne: 'owner_name' } };
}
async function planAllocationOnlyRouting(db, name, site) {
  const people = await db.collection('users').find({ name, active: true }).toArray();
  if (people.length !== 1 || !isManager(people[0]) || !canAccessSite(people[0], site)) throw new Error('Choose one active allocating manager at the dealership.');
  const allocator = people[0], leads = await db.collection('leads').find(routingQuery(allocator, site), { projection: {
    _id: 1, deal_id: 1, owner_id: 1, owner_name: 1, owner_source: 1, assigned_at: 1, assigned_by: 1, process_revision: 1, dealership_name: 1, status: 1,
  } }).toArray();
  return { allocator, site, leads };
}
async function applyAllocationOnlyRouting(db, plan, now = new Date()) {
  const user = await db.collection('users').findOneAndUpdate({ _id: plan.allocator._id, active: true },
    { $set: { allocation_only: true } }, { returnDocument: 'after' });
  if (!user || !isManager(user) || !canAccessSite(user, plan.site)) throw new Error('The allocating manager changed; rebuild the plan.');
  let moved = 0;
  for (const lead of plan.leads) {
    const changed = await db.client.withSession(session => session.withTransaction(async () => {
      const changed = await db.collection('leads').findOneAndUpdate({ ...routingQuery(user, plan.site), _id: lead._id,
        process_revision: lead.process_revision ?? null }, { $set: { owner_id: null, owner_name: 'Unassigned', updatedAt: now },
        $inc: { process_revision: 1 }, $push: { diary_entries: { kind: 'assignment', author: 'Sales Floor routing',
          date: now.toISOString(), assignee_id: null, assignee_name: 'Unassigned',
          note: 'Allocating manager is not the sales recipient. Awaiting salesperson allocation.' } } }, { session, returnDocument: 'after' });
      if (changed) await transferAssignedWork(db, lead, null, 'Unassigned', session);
      return changed;
    }));
    if (changed) moved++;
  }
  return { planned: plan.leads.length, returnedToQueue: moved, skippedConcurrentChanges: plan.leads.length - moved };
}
module.exports = { allocationOnlyName, routingQuery, planAllocationOnlyRouting, applyAllocationOnlyRouting };
