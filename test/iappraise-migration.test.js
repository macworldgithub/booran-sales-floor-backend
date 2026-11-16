const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inspectBundle, applyBundle, digest } = require('../lib/iappraise-migration');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'booran-migration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'bundle'); await fs.mkdir(bundle);
  const original = Buffer.from(JSON.stringify({ vehicle: { rego: 'FIXTURE' }, unknown: { keep: 'all source fields' } }));
  const media = Buffer.from('fixture media bytes');
  await fs.writeFile(path.join(bundle, 'record.json'), original); await fs.writeFile(path.join(bundle, 'photo.bin'), media);
  const manifest = { version: 1, expectedRecords: 1, expectedCounts: { appraisal: 1, dealer: 0, wholesaler: 0 }, records: [{
    kind: 'appraisal', sourceId: 'source-123', dealership: 'South Morang Kia', dataPath: 'record.json', sha256: digest(original),
    media: [{ id: 'photo-1', name: 'original.jpg', path: 'photo.bin', sha256: digest(media), size: media.length }],
  }] };
  const filename = path.join(bundle, 'manifest.json');
  const write = () => fs.writeFile(filename, JSON.stringify(manifest)); await write();
  return { directory, bundle, manifest, filename, write, original, media };
}

test('legacy import validates complete bundle, saves original bytes and replays without duplication', async t => {
  const f = await fixture(t), storage = path.join(f.directory, 'archive');
  const collections = new Map();
  const db = { collection(name) { const rows = collections.get(name) || new Map(); collections.set(name, rows); return {
    async insertOne(row) { const id = String(row._id); if (rows.has(id)) throw Object.assign(new Error('duplicate'), { code: 11000 }); rows.set(id, structuredClone({ ...row, _id: id })); },
    async findOne(query) { return rows.get(String(query._id)); },
    async bulkWrite(operations) {
      let upsertedCount = 0, matchedCount = 0;
      for (const { updateOne: { filter, update } } of operations) {
        const id = String(filter._id), old = rows.get(id);
        if (old) { assert.equal(old.version, filter.version); matchedCount++; }
        else { rows.set(id, { ...update.$setOnInsert, _id: id }); upsertedCount++; }
      }
      return { upsertedCount, matchedCount };
    },
  }; } };
  const bundle = await inspectBundle(f.filename);
  assert.equal(bundle.counts.appraisal, 1);
  const imported = await applyBundle(db, bundle, storage); assert.equal(imported.inserted, 1); assert.equal(imported.completeSourceVerified, false);
  assert.deepEqual(await fs.readFile(path.join(storage, 'records', `${digest(f.original)}.json`)), f.original);
  assert.deepEqual(await fs.readFile(path.join(storage, 'media', digest(f.media))), f.media);
  assert.equal([...collections.get('iappraise_archive').values()][0].raw.unknown.keep, 'all source fields');
  const replay = await applyBundle(db, bundle, storage); assert.equal(replay.inserted, 0); assert.equal(replay.existing, 1);
  await fs.writeFile(path.join(storage, 'media', digest(f.media)), 'corrupted');
  await assert.rejects(applyBundle(db, bundle, storage), /checksum/);
});

test('legacy migration rejects missing media, wrong counts, duplicates and paths outside the bundle', async t => {
  const f = await fixture(t);
  f.manifest.expectedRecords = 2; await f.write(); await assert.rejects(inspectBundle(f.filename), /count/);
  f.manifest.expectedRecords = 1; f.manifest.records[0].media[0].sha256 = '0'.repeat(64); await f.write(); await assert.rejects(inspectBundle(f.filename), /checksum/);
  f.manifest.records[0].media[0].sha256 = digest(f.media);
  const outside = path.join(f.directory, 'outside.json'); await fs.writeFile(outside, f.original);
  f.manifest.records[0].dataPath = '../outside.json'; await f.write(); await assert.rejects(inspectBundle(f.filename), /escapes/);
  f.manifest.records[0].dataPath = 'record.json'; f.manifest.records.push(f.manifest.records[0]); f.manifest.expectedRecords = 2; await f.write(); await assert.rejects(inspectBundle(f.filename), /Duplicate/);
});
