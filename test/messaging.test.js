const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalisePhone, validateSmsLength, sendSms, lookupMessage, listInbound } = require('../lib/mobilemessage');

test('inbox reads use provider Basic auth, date and offset without consuming messages', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { MOBILEMESSAGE_USERNAME: 'fixture', MOBILEMESSAGE_PASSWORD: 'secret', MOBILEMESSAGE_SENDER_ID: 'Fixture' });
  try {
    let request;
    const page = { status: 'complete', results: [{ message_id: 'in-1' }], total: 201 };
    assert.deepEqual(await listInbound({ from: '2026-10-01', offset: 200 }, async (url, options) => { request = { url, options }; return { ok: true, json: async () => page }; }), { results: page.results, total: 201 });
    assert.equal(request.url.pathname, '/v1/inbound');
    assert.equal(request.url.searchParams.get('offset'), '200');
    assert.equal(request.url.searchParams.get('limit'), '200');
    assert.equal(request.url.searchParams.get('from'), '2026-10-01');
    assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from('fixture:secret').toString('base64')}`);
    assert.equal(request.options.method, undefined);
    await assert.rejects(listInbound({ from: '2026-10-01' }, async () => ({ ok: false })), /Incoming SMS/);
    await assert.rejects(listInbound({ from: '2026-10-01' }, async () => ({ ok: true, json: async () => ({ results: [] }) })), /Incoming SMS/);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
const { validateMedia, createLocalStorage } = require('../lib/media-storage');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

async function localStorage(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'salesfloor-media-test-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, storage: createLocalStorage({ directory, serverless: false }) };
}
const fixtureMedia = () => ({ name: 'vehicle.mp4', size: 6, content_type: 'video/mp4', staging_key: 'staging/123456789012345678901234', storage_key: 'files/123456789012345678901234' });

test('local files are private until complete and survive creating a new storage instance', async (t) => {
  const { directory, storage } = await localStorage(t);
  const media = fixtureMedia();
  assert.equal((await storage.prepare(media)).chunk_size, 2 * 1024 * 1024);
  await assert.rejects(storage.download(media), { status: 404 });
  assert.equal(await storage.uploadChunk(media, 0, Buffer.from([0, 255, 1])), 3);
  await assert.rejects(storage.complete(media), { status: 400 });
  assert.equal(await storage.uploadChunk(media, 3, Buffer.from([128, 2, 3])), 6);
  await storage.complete(media);
  const restarted = createLocalStorage({ directory, serverless: false });
  const filename = await restarted.download(media);
  assert.deepEqual(await fs.readFile(filename), Buffer.from([0, 255, 1, 128, 2, 3]));
  await restarted.complete(media);
  await assert.rejects(fs.stat(path.join(directory, media.staging_key)), { code: 'ENOENT' });
});

test('local chunks are ordered, bounded, retryable and reject changes to saved bytes', async (t) => {
  const { storage } = await localStorage(t);
  const media = fixtureMedia();
  await storage.prepare(media);
  await assert.rejects(storage.uploadChunk(media, 2, Buffer.from('ab')), { status: 409 });
  await storage.uploadChunk(media, 0, Buffer.from('abc'));
  assert.equal(await storage.uploadChunk(media, 0, Buffer.from('abc')), 3);
  await assert.rejects(storage.uploadChunk(media, 0, Buffer.from('xyz')), { status: 409 });
  await assert.rejects(storage.uploadChunk(media, 2, Buffer.from('cd')), { status: 409 });
  await assert.rejects(storage.uploadChunk(media, 3, Buffer.from('toolong')), { status: 400 });
  await assert.rejects(storage.uploadChunk(media, -1, Buffer.from('a')), { status: 400 });
});

test('local storage rejects path traversal and unavailable Vercel disk', async (t) => {
  const { storage } = await localStorage(t);
  await assert.rejects(storage.prepare({ ...fixtureMedia(), staging_key: '../escape' }), { status: 400 });
  await assert.rejects(storage.download({ ...fixtureMedia(), storage_key: 'files/../../escape' }), { status: 400 });
  const vercel = createLocalStorage({ serverless: true });
  assert.equal(vercel.configured(), false);
  await assert.rejects(vercel.prepare(fixtureMedia()), { status: 503 });
});

test('Australian recipient numbers are normalised and malformed/non-mobile numbers rejected', () => {
  for (const input of ['0412 345 678', '+61 412 345 678', '61412345678', '(04)1234-5678', '412345678']) assert.equal(normalisePhone(input), '+61412345678');
  for (const input of ['', '0312345678', '+14123456789', '04123456789', '+61+412345678', {}, null]) assert.throws(() => normalisePhone(input), { status: 400 });
});

test('SMS length accounts for GSM escapes and UTF-16 emoji parts', () => {
  validateSmsLength('a'.repeat(1530));
  validateSmsLength('€'.repeat(765));
  validateSmsLength('🙂'.repeat(335));
  assert.throws(() => validateSmsLength('€'.repeat(766)), { status: 400 });
  assert.throws(() => validateSmsLength('🙂'.repeat(336)), { status: 400 });
  assert.throws(() => validateSmsLength('界'.repeat(671)), { status: 400 });
});

test('uploads reject unsupported files, malformed sizes and over-limit videos', () => {
  assert.equal(validateMedia({ name: 'seal.mp4', content_type: 'video/mp4', size: 100 * 1024 * 1024 }).size, 104857600);
  for (const fields of [{ content_type: 'text/html' }, { content_type: 'image/svg+xml' }, { size: 0 }, { size: '100' }, { size: 104857601 }, { name: '' }]) {
    assert.throws(() => validateMedia({ name: 'test.jpg', content_type: 'image/jpeg', size: 100, ...fields }), { status: 400 });
  }
});

test('Mobile Message uses configured sender, Unicode, Basic auth and stable idempotency', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { MOBILEMESSAGE_USERNAME: 'fixture', MOBILEMESSAGE_PASSWORD: 'fixture-secret', MOBILEMESSAGE_SENDER_ID: 'Fixture' });
  try {
    const payload = { phone: '+61412345678', body: 'Test 🙂 https://example.com/photo', requestId: 'stable-key' };
    let sent;
    const fetcher = async (url, options) => { sent = { url, options }; return { ok: true, status: 200, json: async () => ({ results: [{ status: 'success', message_id: 'msg-123' }] }) }; };
    assert.deepEqual(await sendSms(payload, fetcher), { status: 'queued', provider_message_id: 'msg-123' });
    assert.equal(sent.options.headers['Idempotency-Key'], 'stable-key');
    assert.equal(sent.options.headers.Authorization, `Basic ${Buffer.from('fixture:fixture-secret').toString('base64')}`);
    assert.deepEqual(JSON.parse(sent.options.body), { enable_unicode: true, messages: [{ to: payload.phone, message: payload.body, sender: 'Fixture', custom_ref: 'stable-key' }] });
    for (const result of [{ status: 'success' }, { status: 'error', message_id: 'not-accepted' }]) {
      assert.equal((await sendSms(payload, async () => ({ ok: true, status: 200, json: async () => ({ results: [result] }) }))).status, 'failed');
    }
    assert.equal((await sendSms(payload, async () => { throw new Error('timeout'); })).status, 'unknown');
    assert.equal((await sendSms(payload, async () => ({ ok: false, status: 503, json: async () => ({}) }))).status, 'unknown');
    delete process.env.MOBILEMESSAGE_USERNAME;
    let called = false;
    assert.equal((await sendSms(payload, async () => { called = true; })).status, 'failed');
    assert.equal(called, false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('delivery lookup uses the documented GET endpoint and validates the provider message and recipient', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { MOBILEMESSAGE_USERNAME: 'fixture', MOBILEMESSAGE_PASSWORD: 'fixture-secret', MOBILEMESSAGE_SENDER_ID: 'Fixture' });
  try {
    let request;
    const payload = { messageId: 'provider-123', phone: '+61412345678' };
    const fetcher = (rows) => async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ status: 'complete', results: rows }) }; };
    const result = await lookupMessage(payload, fetcher([{ message_id: 'provider-123', to: '61412345678', status: 'delivered' }]));
    assert.equal(result.status, 'delivered');
    assert.equal(result.error, null);
    assert.equal(request.url.searchParams.get('message_id'), 'provider-123');
    assert.equal(request.options.method, undefined);
    assert.equal(request.options.cache, 'no-store');
    assert.equal(await lookupMessage(payload, fetcher([{ message_id: 'other-id', to: '61412345678', status: 'delivered' }])), null);
    assert.equal(await lookupMessage(payload, fetcher([{ message_id: 'provider-123', to: '61499999999', status: 'delivered' }])), null);
    assert.equal(await lookupMessage(payload, fetcher([{ message_id: 'provider-123', to: '61412345678', status: 'unsupported' }])), null);
    await lookupMessage({ customRef: 'known-attempt', phone: payload.phone }, fetcher([]));
    assert.equal(request.url.searchParams.get('custom_ref'), 'known-attempt');
    assert.equal(request.url.searchParams.has('message_id'), false);
    await assert.rejects(lookupMessage(payload, async () => ({ ok: false })), /temporarily unavailable/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
