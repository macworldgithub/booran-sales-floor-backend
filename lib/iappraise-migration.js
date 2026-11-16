const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, constants } = require('node:fs');
const { ObjectId, BSON } = require('mongodb');
const { partnerInput } = require('./appraisal-centre');
const { dealership } = require('./records');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = value => new ObjectId(digest(JSON.stringify(value)).slice(0, 24));
const hashPattern = /^[a-f\d]{64}$/;
const kinds = ['appraisal', 'dealer', 'wholesaler'];

async function bundleFile(root, relative, maxSize) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Bundle paths must be relative.');
  const resolved = await fs.realpath(path.resolve(root, relative));
  if (!resolved.startsWith(root + path.sep)) throw new Error('A bundle path escapes the export directory.');
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxSize) throw new Error('Bundle file is empty or exceeds its size limit.');
  return { resolved, stat };
}
async function verifiedBytes(root, relative, checksum, maxSize) {
  if (typeof checksum !== 'string' || !hashPattern.test(checksum)) throw new Error('Every source file requires its SHA-256 checksum.');
  const { resolved } = await bundleFile(root, relative, maxSize);
  const bytes = await fs.readFile(resolved);
  if (digest(bytes) !== checksum) throw new Error('Source file checksum mismatch.');
  return bytes;
}
async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifiedMedia(root, file) {
  if (typeof file.sha256 !== 'string' || !hashPattern.test(file.sha256)) throw new Error('Every attachment requires a SHA-256 checksum.');
  const { resolved, stat } = await bundleFile(root, file.path, 1024 * 1024 * 1024);
  if (!Number.isSafeInteger(file.size) || stat.size !== file.size) throw new Error('Media byte count mismatch.');
  if (await fileHash(resolved) !== file.sha256) throw new Error('Media checksum mismatch.');
  return resolved;
}
function parseJson(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value;
}
async function inspectBundle(manifestPath) {
  const resolved = await fs.realpath(manifestPath);
  const root = path.dirname(resolved);
  const manifestBytes = await fs.readFile(resolved);
  if (manifestBytes.length > 25 * 1024 * 1024) throw new Error('Manifest is too large.');
  const manifest = parseJson(manifestBytes);
  if (manifest.version !== 1 || !Array.isArray(manifest.records) || !manifest.records.length || manifest.records.length > 100000) throw new Error('Use a version 1 manifest with 1–100,000 records.');
  if (manifest.expectedRecords !== manifest.records.length) throw new Error('Manifest record count does not match its expectedRecords.');
  const counts = { appraisal: 0, dealer: 0, wholesaler: 0 }, seen = new Set();
  const rows = [];
  const sourceFiles = manifest.sourceFiles ?? [];
  if (!Array.isArray(sourceFiles) || sourceFiles.length > 100) throw new Error('Invalid source file manifest.');
  for (const file of sourceFiles) {
    const bytes = await verifiedBytes(root, file.path, file.sha256, 25 * 1024 * 1024);
    if (file.size !== bytes.length) throw new Error('Source file byte count mismatch.');
  }
  for (const record of manifest.records) {
    if (!kinds.includes(record.kind)) throw new Error('Unknown legacy record kind.');
    const site = dealership(record.dealership);
    if (typeof record.sourceId !== 'string' || !record.sourceId || record.sourceId.length > 200) throw new Error('Every record requires its original source ID.');
    const key = JSON.stringify([site, record.kind, record.sourceId]);
    if (seen.has(key)) throw new Error('Duplicate source record identity in the bundle.');
    seen.add(key);
    const bytes = await verifiedBytes(root, record.dataPath, record.sha256, 12 * 1024 * 1024);
    const raw = parseJson(bytes);
    if (BSON.calculateObjectSize({ raw }) > 12 * 1024 * 1024) throw new Error('Legacy JSON exceeds safe MongoDB document size.');
    const media = record.media ?? [];
    if (!Array.isArray(media) || media.length > 2000) throw new Error('Invalid legacy media list.');
    const mediaIds = new Set();
    for (const file of media) {
      if (typeof file.id !== 'string' || !/^[a-zA-Z\d_-]{1,100}$/.test(file.id) || mediaIds.has(file.id)) throw new Error('Media IDs must be unique within each record.');
      mediaIds.add(file.id);
      if (typeof file.name !== 'string' || !file.name || file.name.length > 250) throw new Error('Every attachment needs its original filename.');
      await verifiedMedia(root, file);
    }
    let partner;
    if (record.kind !== 'appraisal') {
      // Explicitly mapped partner fields supplement the complete immutable raw record.
      partner = partnerInput({ ...record.partner, kind: record.kind, dealership: site });
    }
    const version = digest(JSON.stringify([record.sha256, media.map(file => [file.id, file.sha256, file.size, file.name]), partner || null]));
    rows.push({ ...record, dealership: site, media, partner, version, archiveId: identity(['iappraise-version', key, version]) });
    counts[record.kind]++;
  }
  for (const kind of kinds) {
    if (manifest.expectedCounts?.[kind] !== counts[kind]) throw new Error(`Manifest count mismatch for ${kind}.`);
  }
  return { root, resolved, manifest, manifestHash: digest(manifestBytes), counts, rows };
}
async function storeFile(destination, bytes, checksum) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (digest(await fs.readFile(destination)) !== checksum) throw new Error('Existing archived file failed checksum verification.');
  }
}
async function storeMedia(destination, source, checksum) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o600);
    if (await fileHash(temporary) !== checksum) throw new Error('Media changed during archival.');
    try { await fs.link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await fileHash(destination) !== checksum) throw new Error('Existing archived media failed checksum verification.');
    }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
async function applyBundle(db, bundle, archiveDirectory) {
  if (!archiveDirectory || !path.isAbsolute(archiveDirectory)) throw new Error('Set IAPPRAISE_ARCHIVE_DIR to an absolute persistent server directory.');
  const result = { expectedRecords: bundle.rows.length, inserted: 0, existing: 0, mediaVerified: 0, partnerRecordsCreated: 0 };
  const pending = [];
  async function flush() {
    if (!pending.length) return;
    const outcome = await db.collection('iappraise_archive').bulkWrite(pending.map(archive => ({ updateOne: {
      filter: { _id: archive._id, version: archive.version, source_sha256: archive.source_sha256 },
      update: { $setOnInsert: archive }, upsert: true,
    } })), { ordered: false });
    result.inserted += outcome.upsertedCount;
    result.existing += outcome.matchedCount;
    pending.length = 0;
  }
  // Save the source manifest as immutable evidence before creating any database rows.
  const manifestBytes = await fs.readFile(bundle.resolved);
  if (digest(manifestBytes) !== bundle.manifestHash) throw new Error('Manifest changed after validation.');
  await storeFile(path.join(archiveDirectory, 'manifests', `${bundle.manifestHash}.json`), manifestBytes, bundle.manifestHash);
  for (const file of bundle.manifest.sourceFiles || []) {
    const bytes = await verifiedBytes(bundle.root, file.path, file.sha256, 25 * 1024 * 1024);
    await storeFile(path.join(archiveDirectory, 'sources', file.sha256), bytes, file.sha256);
  }
  for (const record of bundle.rows) {
    const bytes = await verifiedBytes(bundle.root, record.dataPath, record.sha256, 12 * 1024 * 1024);
    await storeFile(path.join(archiveDirectory, 'records', `${record.sha256}.json`), bytes, record.sha256);
    const media = [];
    for (const file of record.media) {
      const source = await verifiedMedia(bundle.root, file);
      await storeMedia(path.join(archiveDirectory, 'media', file.sha256), source, file.sha256);
      media.push({ id: file.id, name: file.name, sha256: file.sha256, size: file.size });
      result.mediaVerified++;
    }
    const raw = parseJson(bytes);
    const summary = {};
    for (const [key, header] of Object.entries({ rego: 'Rego', vin: 'VIN', make: 'Make', model: 'Model', customer: 'Customer Name', name: 'User Name', department: 'Department', request_date: 'Request Date' })) {
      if (typeof raw[header] === 'string') summary[key] = raw[header];
    }
    const archive = {
      _id: record.archiveId, source: 'iappraise', source_id: record.sourceId, dealership: record.dealership,
      kind: record.kind, source_sha256: record.sha256, version: record.version, manifest_sha256: bundle.manifestHash,
      raw, summary, media, createdAt: new Date().toISOString(),
    };
    pending.push(archive);
    if (pending.length >= 250) await flush();
    if (record.partner) {
      const _id = identity(['iappraise-partner', record.dealership, record.kind, record.sourceId]);
      // Preserve changes made in Sales Floor on rerun. Raw source versions remain in the archive.
      try {
        await db.collection('appraisal_partners').insertOne({ _id, ...record.partner, revision: 0,
          source: 'iappraise', source_id: record.sourceId, archive_id: record.archiveId, createdAt: archive.createdAt });
        result.partnerRecordsCreated++;
      } catch (error) { if (error.code !== 11000) throw error; }
    }
  }
  await flush();
  return { ...result, counts: bundle.counts, completeSourceVerified: false,
    note: 'Bundle checksums and counts verified. Upstream completeness and customer/deal linkage still require reconciliation before cutover.' };
}
module.exports = { digest, identity, inspectBundle, applyBundle, bundleFile };
