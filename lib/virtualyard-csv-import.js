const express = require('express');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { ObjectId } = require('mongodb');
const { SITE, KIND, archiveKey } = require('./virtualyard-source');
const { MAX_BYTES, readVirtualyardCsv, leadFields, driveFields, exportTime } = require('./virtualyard-csv');
const { isManager, canAccessSite } = require('./roles');
const { fail, route } = require('./workflow-route');
const { phoneKey, phonePattern } = require('./phone');
const { appointmentInput } = require('./records');

const UPLOAD_PATH = '/integrations/virtualyard/csv';
const JOB_KIND = 'virtualyard_csv_upload';
const BATCH_SIZE = 100;
const DAY = 86400000;
const counts = () => ({ inserted: 0, updated: 0, unchanged: 0, skipped: 0 });
const leadId = id => `VIRTUALYARD-SOUTH-MORANG-BYD-${id}`;
const nameKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function documentId(type, id) {
  const key = type === 'lead' ? `virtualyard:${SITE}:${id}` : `virtualyard:test-drive:${SITE}:${id}`;
  return new ObjectId(createHash('sha256').update(key).digest('hex').slice(0, 24));
}

function parseRows(type, rows) {
  const parse = type === 'lead' ? leadFields : driveFields;
  const unique = new Map();
  const rejectedIds = new Set();
  const problems = [];
  let duplicateRows = 0;
  const conflicts = new Set();
  for (const row of rows) {
    const parsed = parse(row.fields);
    if (parsed.error) {
      if (parsed.id) rejectedIds.add(parsed.id);
      problems.push({ row: row.row, message: parsed.error });
      continue;
    }
    const previous = unique.get(parsed.id);
    if (previous) {
      duplicateRows++;
      if (!isDeepStrictEqual(previous.fields, row.fields)) conflicts.add(parsed.id);
      else previous.lines.push(row.row);
      continue;
    }
    unique.set(parsed.id, { id: parsed.id, fields: row.fields, lines: [row.row] });
  }
  for (const id of rejectedIds) if (unique.has(id)) conflicts.add(id);
  for (const id of conflicts) {
    problems.push({ row: unique.get(id).lines[0], message: 'Conflicting rows share this Virtual Yard ID.' });
    unique.delete(id);
  }
  return { rows: [...unique.values()], problems, duplicateRows };
}

function sourceIds(type, document) {
  if (type === 'test_drive') return [document.virtualyard?.id];
  const idFromDeal = /^VIRTUALYARD-SOUTH-MORANG-BYD-(\d+)$/i.exec(document.deal_id || '')?.[1];
  return [document.external?.virtualyard?.lead_id, idFromDeal, ...(document.source_refs || []).map(ref => ref.external?.virtualyard?.lead_id)];
}

async function findExisting(db, type, ids, session, preview = false) {
  const result = new Map();
  const { collection, siteField, sourceFields, projection } = type === 'lead'
    ? { collection: 'leads', siteField: 'dealership_name', sourceFields: ['external.virtualyard.lead_id', 'source_refs.external.virtualyard.lead_id'],
      projection: { deal_id: 1, source_refs: 1, external: 1, merged_into: 1, source: 1, status: 1, customer_name: 1, customer_phone: 1,
        notes: 1, vehicle_make: 1, vehicle_model: 1, created_at: 1, createdAt: 1, stage_history: 1, booran_edited_fields: 1, loss_review: 1 } }
    : { collection: 'appointments', siteField: 'dealership', sourceFields: ['virtualyard.id'],
      projection: { virtualyard: 1, prospectName: 1, when: 1, vehicle: 1, status: 1, status_history: 1, confirmed: 1, shown_at: 1 } };
  // Limit the size of $in and only read the scoped records for this file/batch.
  for (let offset = 0; offset < ids.length; offset += 500) {
    const subset = ids.slice(offset, offset + 500);
    const wanted = new Set(subset);
    const alternatives = [
      ...sourceFields.map(field => ({ [field]: { $in: subset } })),
      { _id: { $in: subset.map(id => documentId(type, id)) } },
      ...(type === 'lead' ? [{ deal_id: { $in: subset.map(leadId) } }] : []),
    ];
    const fields = !preview ? projection : type === 'lead'
      ? { deal_id: 1, merged_into: 1, customer_name: 1, 'external.virtualyard.lead_id': 1, 'source_refs.external.virtualyard.lead_id': 1 }
      : { 'virtualyard.id': 1 };
    const rows = await db.collection(collection).find({ [siteField]: SITE, $or: alternatives }, { session, projection: fields }).toArray();
    for (const row of rows) {
      for (const id of new Set(sourceIds(type, row).map(String).filter(value => wanted.has(value)))) {
        const matches = result.get(id) ?? [];
        matches.push(row);
        result.set(id, matches);
      }
    }
  }
  return result;
}

function chooseExisting(matches) {
  const current = (matches || []).filter(item => !item.merged_into);
  if (current.length === 1) return current[0];
  if (current.length > 1 || matches?.length) return false;
  return null;
}

function sourceLead(parsed) {
  return {
    provider: 'Virtual Yard', lead_id: parsed.id, dealership: SITE, channel: parsed.channel, stage: parsed.stage,
    status: parsed.rawStatus, assigned_to: parsed.assignee, notes: parsed.notes, vehicle: parsed.car,
    stock_number: parsed.stock, stock_yard: parsed.yard, price: parsed.price, last_contact_label: parsed.lastContact,
    ...(parsed.phone ? { phone: parsed.phone } : {}),
  };
}

function newLead(parsed, job) {
  return {
    deal_id: leadId(parsed.id), dealership_name: SITE, dealer_code: 'BOORAN-BYD', source: 'Virtual Yard',
    customer_name: parsed.name, customer_phone: parsed.phone, customer_email: '', vehicle_make: parsed.make, vehicle_model: parsed.model,
    status: parsed.status, owner_id: null, owner_name: 'Unassigned', notes: parsed.notes,
    created_at: parsed.when, createdAt: new Date(parsed.when), updatedAt: new Date(job.stagedAt),
    booran_ai_enabled: false, follow_ups_sent: 0, diary_entries: [],
    external: { virtualyard: { ...sourceLead(parsed), forms: parsed.fields.Forms, tags: parsed.fields.Tags, file: job.file } },
  };
}

function sourceDrive(parsed, file) {
  return { id: parsed.id, status: parsed.rawStatus, timestamp: parsed.rawDate, file,
    stockNumber: parsed.stock, customerEmail: parsed.email, customerPhone: parsed.phone, leadReference: parsed.fields.Lead };
}

function newDrive(parsed, job) {
  const { createdAt, ...appointment } = appointmentInput({ when: parsed.when, prospectName: parsed.name, vehicle: parsed.car });
  return { ...appointment, dealership: SITE, status: parsed.status,
    ...(parsed.status === 'Confirmed' ? { confirmed: true } : {}), virtualyard: sourceDrive(parsed, job.file) };
}

function changedFields(type, record, next, prior, file) {
  const fields = {};
  const preserve = new Set(record.booran_edited_fields || []);
  const stageEdit = record.stage_history?.length || record.loss_review?.status === 'pending';
  const driveEdit = record.status_history?.length || record.shown_at;
  function take(field, value, old, protectedField = false) {
    if (protectedField || preserve.has(field) || value === '' || value === undefined || isDeepStrictEqual(record[field], value)) return;
    // Staff changes take precedence. An archived prior export is the baseline.
    if (prior && isDeepStrictEqual(record[field], old)) fields[field] = value;
  }
  if (type === 'lead') {
    const details = { ...sourceLead(next), forms: next.fields.Forms, tags: next.fields.Tags, file };
    const directlyOwned = record.source === 'Virtual Yard' && (record.external?.virtualyard?.lead_id === next.id || record.deal_id === leadId(next.id));
    if (!directlyOwned) {
      const refs = record.source_refs || [];
      const index = refs.findIndex(ref => ref.external?.virtualyard?.lead_id === next.id);
      if (index >= 0) {
        for (const [key, value] of Object.entries(details)) fields[`source_refs.${index}.external.virtualyard.${key}`] = value;
        return { $set: fields };
      }
      return { $addToSet: { source_refs: { source: 'Virtual Yard', deal_id: leadId(next.id),
        provider_id: String(documentId(type, next.id)), external: { virtualyard: details } } } };
    }
    if (record.external === null || record.external?.virtualyard === null) {
      if (record.external === null) fields.external = { virtualyard: details };
      else fields['external.virtualyard'] = details;
    } else {
      for (const [key, value] of Object.entries(details)) {
        if (value !== '' || key !== 'phone') fields[`external.virtualyard.${key}`] = value;
      }
    }
    take('customer_name', next.name, prior?.name);
    take('vehicle_make', next.make, prior?.make);
    take('vehicle_model', next.model, prior?.model);
    take('notes', next.notes, prior?.notes);
    take('created_at', next.when, prior?.when);
    if (fields.created_at && isDeepStrictEqual(record.createdAt, new Date(prior.when))) fields.createdAt = new Date(next.when);
    take('status', next.status, prior?.status, stageEdit || record.status === 'sold');
    return { $set: fields };
  }
  const details = sourceDrive(next, file);
  if (record.virtualyard == null) fields.virtualyard = details;
  else for (const [key, value] of Object.entries(details)) fields[`virtualyard.${key}`] = value;
  if (record.virtualyard?.id) {
    take('prospectName', next.name, prior?.name);
    take('vehicle', next.car, record.vehicle === prior?.legacyCar ? prior.legacyCar : prior?.car);
    take('when', next.when, prior?.when);
    take('status', next.status, prior?.status, driveEdit);
    if (fields.status) fields.confirmed = fields.status === 'Confirmed';
  }
  return { $set: fields };
}

async function findNativeMatch(db, type, parsed, nativeRows, session) {
  // Never link unrelated records on a name alone. A phone-only lead is
  // matched using its explicit phone number, which is its only identity.
  if (type === 'lead' && parsed.phone && phoneKey(parsed.phone)) {
    const phone = { $regex: phonePattern(parsed.phone) };
    const matches = await db.collection('leads').find({ dealership_name: SITE, merged_into: { $exists: false },
      $or: [{ customer_phone: phone }, { alternate_phones: phone }] }, { session }).limit(2).toArray();
    return matches.length > 1 ? false : matches[0] || null;
  }
  const matches = nativeRows.filter(row => type === 'lead'
    ? row.created_at === parsed.when && nameKey(row.customer_name) === nameKey(parsed.name)
    : row.when === parsed.when && nameKey(row.prospectName) === nameKey(parsed.name));
  return matches.length > 1 ? false : matches[0] || null;
}

async function applyRows(db, job, rows, session) {
  const type = job.type;
  const parse = type === 'lead' ? leadFields : driveFields;
  const match = await findExisting(db, type, rows.map(row => row.id), session);
  const parsedRows = rows.map(row => ({ row, parsed: { ...parse(row.fields), fields: row.fields } }));
  const times = [...new Set(parsedRows.filter(({ row }) => !match.has(row.id)).map(({ parsed }) => parsed.when))];
  let nativeRows = [];
  if (times.length && type === 'test_drive') {
    nativeRows = await db.collection('appointments').find({ dealership: SITE, type: 'Test Drive',
      when: { $in: times }, 'virtualyard.id': { $exists: false } }, { session, projection: { prospectName: 1, when: 1, virtualyard: 1 } }).toArray();
  } else if (times.length) {
    nativeRows = await db.collection('leads').find({ dealership_name: SITE, merged_into: { $exists: false }, created_at: { $in: times },
      'external.virtualyard.lead_id': { $exists: false }, 'source_refs.external.virtualyard.lead_id': { $exists: false },
    }, { session, projection: { customer_name: 1, created_at: 1 } }).toArray();
  }
  const usedNative = new Set();
  const archives = db.collection('integration_sync');
  const ids = [...new Set(rows.map(row => archiveKey(type, row.id)))];
  const projection = Object.fromEntries(rows.map(row => [`records.${row.id}`, 1]));
  const buckets = await archives.find({ _id: { $in: ids }, kind: KIND, dealership: SITE }, { session, projection }).toArray();
  const before = new Map(buckets.map(bucket => [bucket._id, bucket.records]));
  const totals = counts();
  const crmOps = [];
  const archiveOps = new Map();
  for (const { row, parsed } of parsedRows) {
    const key = archiveKey(type, row.id);
    const archived = before.get(key)?.[row.id];
    const current = chooseExisting(match.get(row.id));
    if (current === false) { totals.skipped++; continue; }
    const oldExportAt = archived?.exportAt || archived?.exports?.map(entry => exportTime(entry.file)).filter(Boolean).sort().at(-1);
    if (oldExportAt && job.exportAt && job.exportAt < oldExportAt) { totals.unchanged++; continue; }
    const equal = isDeepStrictEqual(archived?.fields, row.fields);
    if (!parsed.name && current?.customer_name) parsed.name = current.customer_name;
    if (!parsed.name) { totals.skipped++; continue; }
    const native = current || await findNativeMatch(db, type, parsed, nativeRows, session);
    if (native === false) { totals.skipped++; continue; }
    if (native && !current) {
      const id = String(native._id);
      if (usedNative.has(id)) { totals.skipped++; continue; }
      usedNative.add(id);
    }
    const siteField = type === 'lead' ? 'dealership_name' : 'dealership';
    if (!native) {
      const doc = type === 'lead' ? newLead(parsed, job) : newDrive(parsed, job);
      const sourceKey = type === 'lead' ? 'external.virtualyard.lead_id' : 'virtualyard.id';
      crmOps.push({ updateOne: { filter: { _id: documentId(type, row.id), [siteField]: SITE, [sourceKey]: row.id },
        update: { $setOnInsert: doc }, upsert: true } });
      totals.inserted++;
    } else if (!equal || !current) {
      const prior = archived ? parse(archived.fields) : null;
      const update = changedFields(type, native, parsed, prior?.error ? null : prior, job.file);
      crmOps.push({ updateOne: { filter: { _id: native._id, [siteField]: SITE }, update } });
      totals.updated++;
    } else totals.unchanged++;

    const update = archiveOps.get(key) || { $set: {}, $addToSet: {}, $setOnInsert: { kind: KIND, dealership: SITE, type } };
    const field = `records.${row.id}`;
    const exports = row.lines.map(line => ({ file: job.file, row: line }));
    if (!equal) update.$set[field] = { fields: row.fields, exports, exportAt: job.exportAt || job.stagedAt.toISOString() };
    else {
      if (exports.some(item => !archived.exports?.some(old => isDeepStrictEqual(item, old)))) update.$addToSet[`${field}.exports`] = { $each: exports };
      if (job.exportAt && (!oldExportAt || job.exportAt > oldExportAt)) update.$set[`${field}.exportAt`] = job.exportAt;
    }
    archiveOps.set(key, update);
  }
  if (crmOps.length) await db.collection(type === 'lead' ? 'leads' : 'appointments').bulkWrite(crmOps, { session, ordered: true });
  const ops = [...archiveOps].filter(([, update]) => Object.keys(update.$set).length || Object.keys(update.$addToSet).length)
    .map(([_id, update]) => ({ updateOne: { filter: { _id, kind: KIND, dealership: SITE }, update, upsert: true } }));
  if (ops.length) await archives.bulkWrite(ops, { session, ordered: true });
  return totals;
}

async function applyNextBatch(db, scope) {
  const queue = db.collection('integration_sync');
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.client.withSession(session => session.withTransaction(async () => {
        const job = await queue.findOne(scope, { session, projection: { file: 1, type: 1, exportAt: 1, stagedAt: 1, offset: 1, total: 1, result: 1 } });
        if (!job) fail(404, 'CSV preview expired. Preview the file again.');
        if (job.offset === job.total) return { processed: job.offset, total: job.total, done: true, result: job.result };
        const { rows: batch } = await queue.findOne(scope, { session, projection: { rows: { $slice: [job.offset, BATCH_SIZE] } } });
        if (!batch?.length) fail(409, 'CSV preview is incomplete. Preview the file again.');
        const batchCounts = await applyRows(db, job, batch, session);
        const processed = job.offset + batch.length;
        const result = Object.fromEntries(Object.keys(batchCounts).map(key => [key, job.result[key] + batchCounts[key]]));
        const done = processed === job.total;
        await queue.updateOne(scope, { $set: { offset: processed, result }, ...(done ? { $unset: { rows: '' } } : {}) }, { session });
        return { processed, total: job.total, done, result };
      }));
    } catch (error) {
      if (error.code !== 11000) throw error;
      if (attempt >= 2) fail(409, 'A record changed during this import. Resume the import to check it again.');
      // A concurrent first insert can win a unique-key upsert. A fresh
      // transaction rechecks the now-existing source ID and job cursor.
    }
  }
}

function installVirtualyardCsvImport(router, database) {
  const guard = (req, res, next) => {
    if (!isManager(req.user) || !canAccessSite(req.user, SITE)) {
      return res.status(403).json({ success: false, error: 'CSV import requires manager access to BYD South Morang.' });
    }
    next();
  };
  router.post(UPLOAD_PATH, guard, express.raw({ type: 'text/csv', limit: MAX_BYTES, inflate: false }), route(async (req, res) => {
    const file = req.query.file;
    if (typeof file !== 'string' || !/^[^/\\\u0000-\u001f]{1,180}\.csv$/i.test(file)) fail(400, 'Choose a named CSV file.');
    const input = readVirtualyardCsv(req.body);
    const plan = parseRows(input.type, input.rows);
    const db = await database();
    const existing = await findExisting(db, input.type, plan.rows.map(row => row.id), undefined, true);
    const usable = [];
    for (const row of plan.rows) {
      const current = chooseExisting(existing.get(row.id));
      if (current === false) plan.problems.push({ row: row.lines[0], message: 'Existing records share this source ID. Review them before importing.' });
      else if (input.type === 'lead' && !current && !leadFields(row.fields).name) {
        plan.problems.push({ row: row.lines[0], message: 'Customer name could not be separated from the enquiry preview.' });
      } else usable.push(row);
    }
    const summary = { type: input.type, file, rows: input.rows.length, ready: usable.length,
      existing: usable.filter(row => existing.has(row.id)).length, duplicates: plan.duplicateRows,
      issues: plan.problems.length, examples: plan.problems.slice(0, 8) };
    if (!usable.length) return res.json({ success: true, data: { ...summary, id: null } });
    const queue = db.collection('integration_sync');
    const now = new Date();
    await queue.deleteMany({ kind: JOB_KIND, dealership: SITE, expiresAt: { $lte: now } });
    const id = `virtualyard:upload:${randomUUID()}`;
    await queue.insertOne({ _id: id, kind: JOB_KIND, dealership: SITE, userId: req.user.id,
      file, type: input.type, exportAt: exportTime(file), stagedAt: now, expiresAt: new Date(+now + DAY),
      rows: usable, offset: 0, total: usable.length, result: counts() });
    res.json({ success: true, data: { ...summary, id } });
  }));
  router.post(`${UPLOAD_PATH}/:id/apply`, guard, route(async (req, res) => {
    const { id } = req.params;
    if (!/^virtualyard:upload:[\da-f-]{36}$/i.test(id)) fail(404, 'CSV preview not found.');
    const db = await database();
    const scope = { _id: id, kind: JOB_KIND, dealership: SITE, userId: req.user.id, expiresAt: { $gt: new Date() } };
    res.json({ success: true, data: await applyNextBatch(db, scope) });
  }));
}

module.exports = { UPLOAD_PATH, parseRows, documentId, installVirtualyardCsvImport };
