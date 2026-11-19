const { ObjectId } = require('mongodb');
const { createHash } = require('node:crypto');
const { isManager, canAccessSite, canReceiveLeads } = require('./roles');
const { route, fail } = require('./workflow-route');
const { reference, transferAssignedWork } = require('./lead-allocation');
const { serializeLead, string, dealership } = require('./records');
const { siteMatch, mobileMatches } = require('./lead-identity');
async function notify(db, lead, kind, event) {
    const alert = { _id: createHash('sha256').update(`${lead._id}:${kind}:${event}`).digest('hex'),
        dealership: lead.dealership_name, owner_id: lead.owner_id || null, lead_id: String(lead._id), kind,
        title: { approval_requested: 'Awaiting Manager Approval', action_recorded: 'Action Recorded', approval_resolved: 'Manager review completed', video_viewed: 'Customer viewed video' }[kind] || kind,
        createdAt: new Date().toISOString() };
    try {
        await db.collection('sales_alerts').insertOne(alert);
    }
    catch (error) {
        if (error.code === 11000)
            return;
        throw error;
    }
    await require('./lead-alerts').publishPush(db, alert).catch(() => console.warn('CRM push notification could not be delivered.'));
}
async function decorateActivity(db, lead) {
    if (!lead.diary_entries?.some(entry => !entry.author_role))
        return lead;
    const people = await db.collection('users').find({}, { projection: { name: 1, role: 1, site: 1, allowedSites: 1 } }).toArray();
    const scoped = people.filter(person => canAccessSite(person, lead.dealership_name)), byId = new Map(scoped.map(person => [String(person._id), person]));
    return { ...lead, diary_entries: lead.diary_entries.map(entry => {
            const matches = scoped.filter(person => person.name?.trim().toLowerCase() === entry.author?.trim().toLowerCase());
            return { ...entry, author_role: entry.author_role || byId.get(String(entry.author_id))?.role || (matches.length === 1 ? matches[0].role : undefined) };
        }) };
}
function installCrmUpdates(router, database) {
    const context = async (req) => {
        if (!isManager(req.user) && req.user.role !== 'sales_consultant')
            fail(403, 'A sales account is required.');
        const db = await database(req), raw = await database();
        const lead = await db.collection('leads').findOne({ ...reference(req.params.id), merged_into: { $exists: false } });
        if (!lead)
            fail(404, 'Customer not found.');
        return { db, raw, lead };
    };
    router.get('/crm/loss-categories', route(async (req, res) => res.json({ success: true, data: require('./connex-policy').LOST_REASONS })));
    router.post('/leads/:id/notes', route(async (req, res) => {
        const { db, lead } = await context(req), note = string(req.body.note, 'Customer note', { required: true, max: 5000 }), id = req.body.requestId;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))
            fail(400, 'Include a valid note request ID.');
        const previous = lead.diary_entries?.find(entry => entry.request_id === id);
        if (previous) {
            if (previous.note !== note)
                fail(409, 'This request ID was used for another note.');
            return res.json({ success: true, data: serializeLead(lead) });
        }
        const completeAction = req.body.completeAction === true || req.body.actionDone === true;
        const now = new Date();
        const setFields = {
            updatedAt: now,
            last_activity_at: now.toISOString(),
            last_activity_by: req.user.id,
            ...(completeAction ? { 'next_action.status': 'completed' } : {})
        };
        const entry = {
            kind: completeAction ? 'action_completed' : 'note',
            request_id: id,
            author_role: req.user.role,
            author: req.user.name,
            author_id: req.user.id,
            note: completeAction && lead.next_action?.title && !note.includes(lead.next_action.title)
                ? `${note}\nAction completed: ${lead.next_action.title}`
                : note,
            date: now.toISOString(),
            ...(completeAction ? { action_completed: true } : {})
        };
        const updated = await db.collection('leads').findOneAndUpdate(
            { _id: lead._id, process_revision: lead.process_revision ?? null, 'diary_entries.request_id': { $ne: id } },
            { $set: setFields, $inc: { process_revision: 1 }, $push: { diary_entries: entry } },
            { returnDocument: 'after' }
        );
        if (!updated)
            fail(409, 'The customer changed. Refresh before retrying this note.');
        if (completeAction) {
            const leadIdentifiers = [String(lead._id), lead._id, lead.deal_id].filter(Boolean);
            await db.collection('sales_tasks').updateMany(
                { lead_id: { $in: leadIdentifiers }, status: 'open' },
                {
                    $set: { status: 'completed', completed_at: now.toISOString(), closed_by: req.user.id },
                    $push: { completion_events: { date: now.toISOString(), user_id: req.user.id } }
                }
            );
        }
        res.json({ success: true, data: serializeLead(updated) });
    }));
    router.get('/crm/duplicate-check', route(async (req, res) => {
        const site = dealership(req.query.dealership);
        if (!canAccessSite(req.user, site) || req.user.role === 'contractor')
            fail(403, 'This dealership is unavailable.');
        const phone = string(req.query.phone, 'Phone', { max: 50 }), email = string(req.query.email, 'Email', { max: 254 }).toLowerCase();
        const db = await database();
        const found = new Map((await mobileMatches(db, site, phone)).map(row => [String(row._id), row]));
        if (email)
            for (const row of await db.collection('leads').find({ dealership_name: siteMatch(site), merged_into: { $exists: false }, customer_email: { $regex: `^${require('./query').escapeRegex(email)}$`, $options: 'i' } }).limit(20).toArray())
                found.set(String(row._id), row);
        res.json({ success: true, data: { duplicate: found.size > 0, customers: [...found.values()].filter(row => isManager(req.user) || row.owner_id === req.user.id).map(serializeLead) } });
    }));
    router.get('/manager-approvals', route(async (req, res) => {
        if (!isManager(req.user))
            fail(403, 'Manager access is required.');
        const db = await database(req);
        const [leads, merges] = await Promise.all([
            db.collection('leads').find({ merged_into: { $exists: false }, $or: [{ 'next_action_review.status': 'pending' }, { 'loss_review.status': 'pending' }, { 'consent_review.status': 'pending' }] }, { projection: { customer_name: 1, dealership_name: 1, status: 1, owner_id: 1, owner_name: 1, next_action_review: 1, loss_review: 1, consent_review: 1 } }).sort({ updatedAt: 1 }).limit(200).toArray(),
            db.collection('lead_merge_requests').find({ status: 'open' }).sort({ createdAt: 1 }).limit(200).toArray(),
        ]);
        const rows = leads.flatMap(lead => [['followup', lead.next_action_review], ['loss', lead.loss_review], ['consent', lead.consent_review]]
            .filter(([, review]) => review?.status === 'pending').map(([kind, review]) => ({ kind, lead: serializeLead(lead), review })));
        res.json({ success: true, data: { requests: rows, merges: merges.map(row => ({ id: row._id, dealership: row.dealership, name: row.incoming?.customer_name, updatedAt: row.updatedAt })), limit: 200 } });
    }));
    router.post('/leads/:id/followup-review', route(async (req, res) => {
        if (!isManager(req.user))
            fail(403, 'Only managers can review date overrides.');
        const { db, raw, lead } = await context(req), review = lead.next_action_review;
        if (!review || review.status !== 'pending' || review.id !== req.body.reviewId)
            fail(409, 'This follow-up review has changed.');
        if (!['approve', 'reject'].includes(req.body.action))
            fail(400, 'Approve or reject the proposed date.');
        const notes = string(req.body.notes, 'Review notes', { max: 2000, required: req.body.action === 'reject' }), now = new Date().toISOString();
        if (req.body.action === 'approve' && Date.parse(review.due_at) <= Date.now())
            fail(409, 'The proposed time has passed. Reject it and request a future date.');
        const approved = req.body.action === 'approve';
        const result = await raw.client.withSession(session => session.withTransaction(async () => {
            const updated = await db.collection('leads').findOneAndUpdate({ _id: lead._id, process_revision: lead.process_revision ?? null, 'next_action_review.id': review.id, 'next_action_review.status': 'pending' }, {
                $set: { next_action_review: { ...review, status: approved ? 'approved' : 'rejected', reviewed_by: req.user.id, reviewed_name: req.user.name, reviewed_at: now, notes },
                    next_action: approved ? { ...lead.next_action, status: 'open' } : null, updatedAt: new Date() }, $inc: { process_revision: 1 },
                $push: { diary_entries: { kind: 'approval', author_role: req.user.role, author: req.user.name, author_id: req.user.id, date: now, note: `Follow-up date ${approved ? 'approved' : 'rejected'}: ${review.due_at}. ${notes}` } },
            }, { session, returnDocument: 'after' });
            if (!updated)
                fail(409, 'The customer changed. Refresh the review.');
            await db.collection('sales_tasks').updateMany({ lead_id: String(lead._id), review_id: review.id, status: 'awaiting_approval' }, { $set: { status: approved ? 'open' : 'cancelled', assignee_id: lead.owner_id, assignee_name: lead.owner_name } }, { session });
            if (!approved && lead.owner_id)
                await raw.collection('sales_tasks').insertOne({ _id: new ObjectId(), lead_id: String(lead._id), dealership: lead.dealership_name, assignee_id: lead.owner_id, assignee_name: lead.owner_name,
                    title: 'Choose a new follow-up date', notes, status: 'open', kind: 'followup_rejected', createdAt: now, due_at: now }, { session });
            return updated;
        }));
        await notify(raw, result, 'approval_resolved', review.id);
        res.json({ success: true, data: serializeLead(result) });
    }));
    router.post('/leads/:id/consent', route(async (req, res) => {
        const { db, raw, lead } = await context(req);
        if (typeof req.body.optOut !== 'boolean')
            fail(400, 'Choose a communication consent setting.');
        const reason = string(req.body.reason, 'Consent reason', { required: true, max: 2000 }), now = new Date().toISOString(), manager = isManager(req.user);
        const review = { id: new ObjectId().toString(), status: manager ? 'approved' : 'pending', opt_out: req.body.optOut, reason, requested_by: req.user.id, requested_name: req.user.name, requested_at: now };
        // An opt-out takes effect immediately, including while a salesperson request
        // awaits review. Restoring contact always requires a manager.
        const apply = manager || req.body.optOut;
        const updated = await db.collection('leads').findOneAndUpdate({ _id: lead._id, process_revision: lead.process_revision ?? null }, {
            $set: { consent_review: review, ...(apply ? { communication_consent: { opted_out: req.body.optOut, reason, changed_by: req.user.id, changed_at: now }, booran_opted_out: req.body.optOut } : {}), updatedAt: new Date() },
            $inc: { process_revision: 1 }, $push: { diary_entries: { kind: 'consent', author_role: req.user.role, author: req.user.name, author_id: req.user.id, date: now, note: `${manager ? 'Consent updated' : 'Consent review requested'}: ${req.body.optOut ? 'Opt out' : 'Restore contact'}. ${reason}` } },
        }, { returnDocument: 'after' });
        if (!updated)
            fail(409, 'The customer changed. Refresh and retry.');
        await notify(raw, updated, manager ? 'action_recorded' : 'approval_requested', review.id);
        res.json({ success: true, data: serializeLead(updated) });
    }));
    router.post('/leads/:id/consent-review', route(async (req, res) => {
        if (!isManager(req.user))
            fail(403, 'Only managers can review consent.');
        const { db, raw, lead } = await context(req), review = lead.consent_review;
        if (!review || review.status !== 'pending' || review.id !== req.body.reviewId)
            fail(409, 'This consent review changed.');
        if (!['approve', 'reject'].includes(req.body.action))
            fail(400, 'Approve or reject the request.');
        const notes = string(req.body.notes, 'Review notes', { required: true, max: 2000 }), now = new Date().toISOString();
        const approve = req.body.action === 'approve';
        const updated = await db.collection('leads').findOneAndUpdate({ _id: lead._id, process_revision: lead.process_revision ?? null, 'consent_review.id': review.id, 'consent_review.status': 'pending' }, {
            $set: { consent_review: { ...review, status: approve ? 'approved' : 'rejected', reviewed_by: req.user.id, notes, reviewed_at: now },
                ...(approve ? { booran_opted_out: review.opt_out, communication_consent: { opted_out: review.opt_out, reason: notes, changed_by: req.user.id, changed_at: now } } : {}), updatedAt: new Date() },
            $inc: { process_revision: 1 }, $push: { diary_entries: { kind: 'consent', author_role: req.user.role, author: req.user.name, author_id: req.user.id, date: now, note: `Consent request ${req.body.action}: ${notes}` } },
        }, { returnDocument: 'after' });
        if (!updated)
            fail(409, 'The customer changed.');
        await notify(raw, updated, 'approval_resolved', review.id);
        res.json({ success: true, data: serializeLead(updated) });
    }));
    router.post('/leads/bulk-assignment', route(async (req, res) => {
        if (!isManager(req.user))
            fail(403, 'Only managers can reassign leads.');
        if (!Array.isArray(req.body.leads) || !req.body.leads.length || req.body.leads.length > 100 || req.body.leads.some(item => !ObjectId.isValid(item.id) || !(item.expectedOwnerId === null || ObjectId.isValid(item.expectedOwnerId))))
            fail(400, 'Choose up to 100 leads with their current owners.');
        if (!ObjectId.isValid(req.body.assigneeId))
            fail(400, 'Choose a salesperson or manager.');
        const db = await database(req), raw = await database(), assignee = await raw.collection('users').findOne({ _id: new ObjectId(req.body.assigneeId), active: true });
        if (!canReceiveLeads(assignee))
            fail(403, 'This assignee is unavailable.');
        const reassigned = [], errors = [];
        for (const input of [...new Map(req.body.leads.map(item => [item.id, item])).values()]) {
            try {
                const lead = await db.collection('leads').findOne({ _id: new ObjectId(input.id), merged_into: { $exists: false } });
                if (!lead || !canAccessSite(assignee, lead.dealership_name))
                    fail(403, 'Lead or assignee is unavailable at this dealership.');
                const now = new Date();
                await raw.client.withSession(session => session.withTransaction(async () => {
                    const changed = await db.collection('leads').findOneAndUpdate({ _id: lead._id, owner_id: input.expectedOwnerId, process_revision: lead.process_revision ?? null }, {
                        $set: { owner_id: String(assignee._id), owner_name: assignee.name, assigned_by: req.user.id, assigned_at: now, updatedAt: now }, $inc: { process_revision: 1 },
                        $push: { diary_entries: { kind: 'assignment', assignee_id: String(assignee._id), assignee_name: assignee.name, author: req.user.name, author_id: req.user.id, author_role: req.user.role, date: now.toISOString(), note: `Assigned to ${assignee.name}.` } },
                    }, { session, returnDocument: 'after' });
                    if (!changed)
                        fail(409, 'Assignment changed. Refresh and review.');
                    await transferAssignedWork(raw, lead, String(assignee._id), assignee.name, session);
                }));
                reassigned.push(input.id);
            }
            catch (error) {
                errors.push({ id: input.id, error: [400, 403, 404, 409].includes(error.status) ? error.message : 'Reassignment could not be confirmed. Refresh before retrying.' });
            }
        }
        res.json({ success: true, data: { reassigned, errors } });
    }));
}
async function completeVideoActions(db, leadId, event, actorId, at = new Date().toISOString(), existingSession) {
    if (!ObjectId.isValid(leadId))
        return;
    const pattern = event === 'sent' ? '\\b(send|share|record|upload)\\b.*\\bvideo\\b' : '\\b(record|upload)\\b.*\\bvideo\\b';
    const operation = async (session) => {
        const lead = await db.collection('leads').findOne({ _id: new ObjectId(leadId), merged_into: { $exists: false } }, { session });
        if (!lead)
            return;
        await db.collection('sales_tasks').updateMany({ lead_id: leadId, dealership: lead.dealership_name, status: 'open', title: { $regex: pattern, $options: 'i' },
            $or: [{ createdAt: { $lte: at } }, { createdAt: null }] }, { $set: { status: 'completed', completed_at: at, closed_by: actorId }, $push: { completion_events: { date: at, user_id: actorId } } }, { session });
        if (lead.next_action?.status !== 'awaiting_approval' && lead.next_action?.status !== 'completed' && new RegExp(pattern, 'i').test(lead.next_action?.title || '') && lead.next_action.recorded_at <= at) {
            await db.collection('leads').findOneAndUpdate({ _id: lead._id, process_revision: lead.process_revision ?? null, 'next_action.due_at': lead.next_action.due_at }, { $set: { 'next_action.status': 'completed' }, $inc: { process_revision: 1 } }, { session });
        }
    };
    if (existingSession)
        await operation(existingSession);
    else
        await db.client.withSession(session => session.withTransaction(() => operation(session)));
}
module.exports = { installCrmUpdates, notify, decorateActivity, completeVideoActions };
