const { randomUUID } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { ConnexClient } = require('./connex-client');
const { SITE, ACTIONS, LOST_REASONS, opportunityId, attention, cleanError, closed, nextBusinessDeadline } = require('./connex-policy');
const { ingestSnapshot, resolveLead, recordsForLead, hash } = require('./connex-store');
const { canAccessSite } = require('./roles');
const { fail } = require('./workflow-route');
const LIVE = ['queued', 'retry', 'processing'];
const CONTROL = 'connex:control';
const current = lead => ({ owner: lead.owner_id || null, status: lead.status,
  activity: lead.last_activity_at || null, revision: lead.process_revision || 0 });

class ConnexService {
  constructor(database, client = new ConnexClient()) { this.database = database; this.client = client; }
  get configured() { return this.client.configured; }
  get writes() { return this.client.settings.writes; }
  async requestSync({ fullRefresh = false } = {}) {
    this.lastFailure = null;
    const db = await this.database();
    await db.collection('integration_sync').updateMany({ kind: 'connex_candidate', dealership: SITE, ...(fullRefresh ? {} : { error: { $nin: [null, ''] } }) },
      { $set: { last_read_at: new Date(0), read_attempts: 0 }, $unset: { retry_at: '', error: '' } });
    await db.collection('integration_sync').findOneAndUpdate({ _id: CONTROL }, { $set: {
      kind: 'connex_sync', dealership: SITE, requested_at: new Date() }, $unset: { retry_at: '' } }, { upsert: true });
  }
  async queue(db, lead, record, input, actor, validateOnly = false) {
    const action = input.action;
    if (!ACTIONS.includes(action)) fail(400, 'Choose a Connex action.');
    if (!this.configured) fail(503, 'The Connex connection needs setup.');
    if (!this.writes && action !== 'refresh') fail(409, 'Connex updates are currently paused.');
    if (!/^[a-zA-Z0-9:_-]{8,100}$/.test(input.requestId || '')) fail(400, 'Include a unique action reference.');
    if (record.dealership !== SITE || lead.dealership_name !== SITE) fail(403, 'This lead does not belong to South Morang Hyundai.');
    const payload = { action, recordId: record.recordId, requestId: input.requestId, leadId: String(lead._id) };
    if (['assign', 'accept', 'qualify'].includes(action) && lead.owner_id) {
      const owner = ObjectId.isValid(lead.owner_id) && await db.collection('users').findOne({ _id: new ObjectId(lead.owner_id), active: true });
      const settings = await db.collection('integration_sync').findOne({ _id: 'connex:settings' });
      if (!owner || !canAccessSite(owner, SITE)) fail(409, 'Allocate this lead to an active South Morang Hyundai salesperson first.');
      payload.salesperson = settings?.staffMap?.[lead.owner_id] || owner.name;
      payload.ownerId = lead.owner_id;
    }
    if (action === 'assign' && !payload.salesperson) fail(409, 'Allocate this lead before sending its salesperson to Connex.');
    if (input.subStatus !== undefined) {
      if (typeof input.subStatus !== 'string' || input.subStatus.length > 100) fail(400, 'Choose a valid dealer sub-status.');
      payload.subStatus = input.subStatus.trim();
    }
    if (action === 'note') {
      if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 3500) fail(400, 'Enter a note of up to 3,500 characters.');
      payload.note = input.note.trim();
    }
    if (action === 'close_won' && lead.status !== 'sold') fail(409, 'Record the sale in Sales Floor before closing the Connex opportunity as won.');
    if (action === 'close_lost') {
      if (lead.status !== 'lost' || lead.loss_review?.status !== 'approved' || !lead.loss_review.reason) fail(409, 'A manager must approve a loss reason before closing the Connex opportunity.');
      payload.lostReason = input.lostReason || lead.loss_review.connex_lost_reason || 'LMS Lost';
      if (!LOST_REASONS.includes(payload.lostReason)) fail(400, 'Choose a valid Connex loss reason.');
      payload.note = lead.loss_review.reason;
    }
    if (validateOnly) return payload;
    const key = `connex:job:${hash([payload.recordId, input.requestId])}`, state = db.collection('integration_sync');
    const previous = await state.findOne({ _id: key });
    if (previous) {
      if (hash(previous.payload) !== hash(payload)) fail(409, 'This action reference has already been used.');
      return publicJob(previous);
    }
    const job = await state.findOneAndUpdate({ _id: key }, { $setOnInsert: { kind: 'connex_job', dealership: SITE,
      recordId: record.recordId, lead_id: String(lead._id), payload, status: 'queued', attempts: 0,
      milestone_at: action === 'close_lost' ? lead.loss_review.reviewed_at || new Date() : action === 'assign' ? lead.assigned_at || new Date() : lead.last_activity_at || new Date(),
      requested_by: actor?.id || 'milestone', created_at: new Date(), available_at: new Date() } }, { upsert: true, returnDocument: 'after' });
    if (hash(job.payload) !== hash(payload)) fail(409, 'This action reference has already been used.');
    return publicJob(job);
  }
  async milestones(db, heartbeat = async () => {}) {
    const state = db.collection('integration_sync');
    // Baselines prevent importing historical outcomes from causing a bulk write to Connex.
    const records = await state.find({ kind: 'connex_record', dealership: SITE, lead_id: { $ne: null } }).toArray();
    const leadIds = [...new Set(records.map(record => record.lead_id).filter(ObjectId.isValid))].map(id => new ObjectId(id));
    const [leads, baselines, jobs] = await Promise.all([
      db.collection('leads').find({ _id: { $in: leadIds }, dealership_name: SITE, merged_into: { $exists: false } }).toArray(),
      state.find({ kind: 'connex_baseline', dealership: SITE }).toArray(),
      state.find({ kind: 'connex_job', dealership: SITE, status: { $in: LIVE } }).toArray(),
    ]);
    const leadMap = new Map(leads.map(lead => [String(lead._id), lead]));
    const baselineMap = new Map(baselines.map(row => [row._id, row]));
    const activeIds = new Set(jobs.map(job => job.recordId));
    for (const record of records) {
      await heartbeat();
      const lead = leadMap.get(record.lead_id) || await resolveLead(db, record.snapshot);
      if (!lead) continue;
      const key = `connex:baseline:${record.recordId}`, before = baselineMap.get(key), value = current(lead);
      if (activeIds.has(record.recordId) || before && hash(before.value) === hash(value)) continue;
      const action = before && !closed(record.snapshot.stage) && (
        before.value.status !== value.status && value.status === 'sold' ? 'close_won' :
        before.value.status !== value.status && value.status === 'lost' && lead.loss_review?.status === 'approved' ? 'close_lost' :
        before.value.owner !== value.owner && value.owner && lead.assigned_by ? 'assign' :
        before.value.activity !== value.activity && lead.last_activity_by && !['Accepted', 'Sales Qualified'].includes(record.snapshot.stage) ? 'accept' : null);
      if (action && this.writes) {
        try { await this.queue(db, lead, record, { action, requestId: `milestone:${hash([record.recordId, value]).slice(0, 40)}` }); }
        catch (error) { await state.findOneAndUpdate({ _id: `connex:record:${record.recordId}` }, { $set: { milestone_error: cleanError(error) } }); continue; }
      }
      if (record.milestone_error) await state.findOneAndUpdate({ _id: `connex:record:${record.recordId}` }, { $unset: { milestone_error: '' } });
      await state.findOneAndUpdate({ _id: key }, { $set: { kind: 'connex_baseline', dealership: SITE, value } }, { upsert: true });
    }
  }
  async status(db) {
    const state = db.collection('integration_sync');
    const [control, records, jobs, settings, users, failedPulls, holidaySettings] = await Promise.all([
      state.findOne({ _id: CONTROL }), state.find({ kind: 'connex_record', dealership: SITE }).toArray(),
      state.find({ kind: 'connex_job', dealership: SITE, status: { $ne: 'done' } }).sort({ created_at: -1 }).limit(50).toArray(),
      state.findOne({ _id: 'connex:settings' }), db.collection('users').find({ active: true }).toArray(),
      state.countDocuments({ kind: 'connex_candidate', dealership: SITE, error: { $nin: [null, ''] }, last_read_at: { $gt: new Date(0) } }),
      state.findOne({ _id: 'connex:calendar' }),
    ]);
    const flags = records.map(record => attention(record.snapshot, new Date(), require('./connex-calendar').holidays(holidaySettings)));
    const failure = this.lastFailure && (!control?.last_success || +new Date(control.last_success) <= +this.lastFailure.at) ? this.lastFailure : null;
    const running = Boolean(control?.lease_until > new Date() && !(failure?.token === control?.lease_token && !this.running));
    return { configured: this.configured, writesEnabled: this.writes, running,
      requestedAt: control?.requested_at, lastPullAt: control?.last_success, lastListAt: control?.last_list_at,
      phase: failure && !running ? 'waiting_retry' : control?.phase || 'idle', retryAt: failure?.retryAt || control?.retry_at || null, lastErrorAt: failure?.at || control?.last_error_at || null,
      discoveryWarning: control?.discovery_error || null, activeDiscovered: control?.active_discovered, activeCoverageConfirmed: control?.active_complete === true,
      errorPhase: failure?.phase || control?.error_phase || null, errorCode: failure?.code || control?.error_code || null,
      recovering: Boolean((failure || control?.error) && running && (!failure?.at && !control?.last_error_at || control?.last_attempt > (failure?.at || control?.last_error_at))),
      complete: control?.complete === true, discovered: control?.discovered || 0, pendingDetails: control?.pending_details || 0, failedPulls,
      error: failure?.message || control?.error || null, records: records.length, imported: records.filter(r => r.lead_id).length,
      mergeReviews: records.filter(r => r.outcome === 'merge_review').length, masked: records.filter(r => r.detailsPending).length,
      milestoneErrors: records.filter(r => r.milestone_error).length,
      acceptanceOverdue: flags.filter(f => f.acceptanceOverdue).length,
      notAcceptedThreeDays: flags.filter(f => f.notAcceptedThreeDays).length, openSixWeeks: flags.filter(f => f.openSixWeeks).length,
      jobs: jobs.map(job => publicJob(job, require('./connex-calendar').holidays(holidaySettings))), staff: users.filter(user => !['super_admin', 'contractor'].includes(user.role) && canAccessSite(user, SITE))
        .map(user => ({ id: String(user._id), name: user.name, connexName: settings?.staffMap?.[String(user._id)] || '' })) };
  }
  async run() {
    if (!this.configured || this.running || this.stopping || this.lastFailure && +this.lastFailure.retryAt > Date.now()) return;
    this.running = true;
    const token = randomUUID(); let db, state, acquired = false, phase = 'starting';
    try {
      db = await this.database(); state = db.collection('integration_sync');
      await state.findOneAndUpdate({ _id: CONTROL }, { $setOnInsert: { kind: 'connex_sync', dealership: SITE, lease_until: new Date(0) } }, { upsert: true });
      const now = new Date();
      const control = await state.findOneAndUpdate({ _id: CONTROL, $and: [
        { $or: [{ lease_until: { $lte: now } }, { lease_until: { $exists: false } }] },
        { $or: [{ retry_at: { $lte: now } }, { retry_at: { $exists: false } }] }] },
      { $set: { lease_token: token, lease_until: new Date(+now + 180000), last_attempt: now, phase } }, { returnDocument: 'after' });
      if (!control) return;
      acquired = true;
      let heartbeatAt = 0;
      const heartbeat = async (nextPhase) => {
        if (this.stopping) throw Object.assign(new Error('Worker stopping.'), { code: 'CONNEX_STOPPED' });
        if (typeof nextPhase === 'string') phase = nextPhase;
        if (Date.now() - heartbeatAt < 20000 && typeof nextPhase !== 'string') return;
        const held = await state.findOneAndUpdate({ _id: CONTROL, lease_token: token }, { $set: { phase, lease_until: new Date(Date.now() + 180000) } });
        if (!held) throw new Error('Connex worker lease expired.');
        heartbeatAt = Date.now();
      };
      await heartbeat('checking_milestones');
      await this.milestones(db, heartbeat);
      await heartbeat('sending_updates');
      const jobs = await state.find({ kind: 'connex_job', dealership: SITE, $or: [
        { status: { $in: ['queued', 'retry'] }, available_at: { $lte: now } },
        { status: 'processing', started_at: { $lte: new Date(+now - 180000) } }] }).sort({ created_at: 1 }).limit(10).toArray();
      for (const job of jobs) {
        await heartbeat();
        if (job.status === 'processing' && job.payload.action === 'note') {
          await state.findOneAndUpdate({ _id: job._id }, { $set: { status: 'needs_attention', error: 'The note submission was interrupted. Check the note in Connex before sharing again.' } });
          continue;
        }
        // Revalidate current canonical CRM state before any deferred source mutation.
        const record = await state.findOne({ _id: `connex:record:${job.recordId}` });
        const lead = record && await resolveLead(db, record.snapshot);
        try {
          if (!lead) fail(409, 'The linked lead is unavailable.');
          if (job.payload.action === 'close_won' && lead.status !== 'sold' || job.payload.action === 'close_lost' &&
            (lead.status !== 'lost' || lead.loss_review?.status !== 'approved' || lead.loss_review.reason !== job.payload.note) ||
            job.payload.salesperson && (String(lead._id) !== job.lead_id || lead.owner_id !== job.payload.ownerId) ||
            ['accept', 'assign', 'qualify'].includes(job.payload.action) && ['sold', 'lost'].includes(lead.status)) fail(409, 'The lead changed after this Connex action was queued. Review it before retrying.');
          const attempts = (job.attempts || 0) + 1;
          await state.findOneAndUpdate({ _id: job._id }, { $set: { status: 'processing', started_at: new Date(), attempts } });
          const snapshot = await this.client.apply(job.payload);
          await ingestSnapshot(db, snapshot);
          await state.findOneAndUpdate({ _id: job._id }, { $set: { status: 'done', completed_at: new Date(), error: null } });
        } catch (error) {
          // A note whose submit response was lost is never blindly posted a second time.
          const uncertain = job.payload.action === 'note' || error.code === 'CONNEX_UNCERTAIN';
          await state.findOneAndUpdate({ _id: job._id }, { $set: { status: uncertain || error.status === 409 || (job.attempts || 0) >= 4 ? 'needs_attention' : 'retry',
            error: cleanError(error), available_at: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** (job.attempts || 0))) } });
          if (['CONNEX_LOGIN', 'CONNEX_MFA'].includes(error.code)) throw error;
        }
      }
      const requested = control.requested_at && (!control.last_list_at || control.requested_at > control.last_list_at);
      if ((requested || !control.last_list_at || +now - +new Date(control.last_list_at) >= 300000) && (!control.discovery_retry_at || +new Date(control.discovery_retry_at) <= +now)) {
        await heartbeat('discovering');
        try {
        const listing = await (this.client.discover ? this.client.discover({ progress: heartbeat }) : this.client.list({ progress: heartbeat }));
        const previousCandidates = await state.find({ kind: 'connex_candidate', dealership: SITE }).toArray();
        const previousMap = new Map(previousCandidates.map(row => [row.recordId, row]));
        const activeIds = new Set(listing.activeIds || []), listedIds = new Set(listing.records.map(row => row.recordId));
        for (let offset = 0; offset < listing.records.length; offset += 20) {
          await heartbeat();
          await Promise.all(listing.records.slice(offset, offset + 20).map((item, index) => {
            const signature = hash(Object.fromEntries(['Opportunity Status','Dealer Sub-Status','Salesperson in charge','Account Name','Product of Interest','Opportunity Type'].map(field => [field,item.fields?.[field] || ''])));
            const previous = previousMap.get(item.recordId), changed = previous?.list_fingerprint && previous.list_fingerprint !== signature;
            return state.findOneAndUpdate({ _id: `connex:candidate:${item.recordId}` }, { $set: { kind: 'connex_candidate', dealership: SITE,
              recordId: item.recordId, priority_order: offset + index, last_seen_at: now, list_fingerprint: signature,
              ...(listing.activeAvailable ? { was_active: activeIds.has(item.recordId) } : {}),
              ...(changed ? { last_read_at: new Date(0), read_attempts: 0, retry_at: new Date(0) } : {}) },
              $setOnInsert: changed ? {} : { last_read_at: new Date(0) } }, { upsert: true });
          }));
        }
        if (listing.activeAvailable) for (const previous of previousCandidates.filter(row => row.was_active && !activeIds.has(row.recordId) && !listedIds.has(row.recordId))) {
          await heartbeat();
          // Absence only schedules a verified re-read; it never retires a customer.
          await state.findOneAndUpdate({ _id: previous._id }, { $set: { last_read_at: new Date(0), read_attempts: 0, was_active: false, retry_at: new Date(0), priority_order: -1 } });
        }
        await state.findOneAndUpdate({ _id: CONTROL, lease_token: token }, { $set: { last_list_at: new Date(), complete: listing.complete, discovered: listing.records.length,
          active_discovered: listing.activeCount ?? null, active_complete: listing.activeComplete === true, discovery_error: listing.warning || null,
          discovery_retry_at: listing.warning ? new Date(Date.now() + 60000) : new Date(0) } });
        } catch (error) {
          if (this.stopping || ['CONNEX_LOGIN', 'CONNEX_MFA'].includes(error.code)) throw error;
          await state.findOneAndUpdate({ _id: CONTROL, lease_token: token }, { $set: { discovery_error: cleanError(error), discovery_retry_at: new Date(Date.now() + 60000) } });
          await this.client.close(); // Continue existing detail work with a fresh session.
        }
      }
      await heartbeat('reading_details');
      const stale = { kind: 'connex_candidate', dealership: SITE, last_read_at: { $lte: new Date(+now - 6 * 3600000) }, $and: [
        { $or: [{ read_attempts: { $lt: 5 } }, { read_attempts: { $exists: false } }] },
        { $or: [{ retry_at: { $lte: new Date() } }, { retry_at: { $exists: false } }] }] };
      const candidates = await state.find(stale).sort({ last_read_at: 1, priority_order: 1, _id: 1 }).limit(this.client.settings.detailBatch || 20).toArray();
      for (const candidate of candidates) {
        await heartbeat();
        try {
          await ingestSnapshot(db, await this.client.read(candidate.recordId));
          await state.findOneAndUpdate({ _id: candidate._id }, { $set: { last_read_at: new Date(), error: null, read_attempts: 0 }, $unset: { retry_at: '' } });
        } catch (error) {
          if (['CONNEX_LOGIN', 'CONNEX_MFA'].includes(error.code)) throw error;
          await state.findOneAndUpdate({ _id: candidate._id }, { $set: { error: cleanError(error), retry_at: new Date(Date.now() + 60000 * 2 ** (candidate.read_attempts || 0)) }, $inc: { read_attempts: 1 } });
        }
      }
      await heartbeat('checking_milestones'); await this.milestones(db, heartbeat);
      await state.findOneAndUpdate({ _id: CONTROL, lease_token: token }, { $set: { last_success: new Date(), error: null,
        phase: 'idle', pending_details: await state.countDocuments({ kind: 'connex_candidate', dealership: SITE, last_read_at: { $lte: new Date(+now - 6 * 3600000) } }) },
        $unset: { retry_at: '', error_code: '', error_phase: '' } });
      this.lastFailure = null;
    } catch (error) {
      if (!this.stopping) {
        const code = /space quota|storage limit|writes are blocked/i.test(error.message || '') ? 'CONNEX_STORAGE' : error.code || (error.name === 'TimeoutError' ? 'CONNEX_TIMEOUT' : 'CONNEX_TEMPORARY');
        this.lastFailure = { code, phase, token, at: new Date(), retryAt: new Date(Date.now() + (['CONNEX_LOGIN', 'CONNEX_MFA'].includes(code) ? 900000 : 30000)),
          message: cleanError({ ...error, code, status: error.status, message: error.message }) };
        console.warn(JSON.stringify({ event: 'connex_sync_failed', phase, code }));
        if (state && acquired) await state.findOneAndUpdate({ _id: CONTROL, lease_token: token }, { $set: { phase: 'waiting_retry',
          error: this.lastFailure.message, error_code: code, error_phase: phase, last_error_at: this.lastFailure.at,
          retry_at: this.lastFailure.retryAt } }).catch(() => console.warn('Connex failure checkpoint unavailable.'));
      }
    } finally {
      try { await this.client.close(); } catch { /* Worker status already persisted. */ }
      try {
        if (state && acquired) await state.findOneAndUpdate({ _id: CONTROL, lease_token: token }, { $set: { lease_until: new Date(0), ...(this.stopping ? { phase: 'idle' } : {}) } });
      } catch { console.warn('Connex lease release will recover on expiry.'); }
      finally { this.running = false; }
    }
  }
  async stop() {
    this.stopping = true;
    await this.client.close().catch(() => {});
    const deadline = Date.now() + 15000;
    while (this.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function publicJob(job, holidays) {
  const dueAt = ['refresh', 'note'].includes(job.payload.action) ? null : nextBusinessDeadline(job.milestone_at || job.created_at, holidays);
  return { id: job._id, recordId: job.recordId, leadId: job.lead_id, action: job.payload.action,
    status: job.status, attempts: job.attempts, error: job.error || null, createdAt: job.created_at, dueAt,
    overdue: job.status !== 'done' && Boolean(dueAt) && Date.parse(dueAt) < Date.now() };
}
module.exports = { ConnexService, publicJob, LIVE, current };
