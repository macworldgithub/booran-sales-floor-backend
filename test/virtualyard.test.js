const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SITE, DAY, VirtualyardClient, writePrivate, readPrivate, parseRow, params, scrape, planSnapshot } = require('../lib/virtualyard');

const portal = 'https://dealers.virtualyard.com.au/SOUTH-MORANG-BYD/';
function clientFor(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'booran-vy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writePrivate(path.join(directory, 'session.json'), { cookie: 'PHPSESSID=test-session' });
  return new VirtualyardClient({ directory, portal, sleep: async () => {}, ...options });
}
function row(site = 'South Morang BYD', id = '123') {
  return ['', '', '<a class="loadPage">Example Buyer</a><table class="card"><tr><td>Phone:</td><td>0412345678</td><td>Email:</td><td>buyer@example.test</td></tr></table>',
    `<a class="loadPage">BYD Seal</a><table class="card"><tr><td>Yard:</td><td>${site}</td></tr></table>`, '', '', 'New', `<a data-id="leadId=${id}">Open</a>`];
}
const snapshot = () => ({ version: 1, dealership: SITE, scrapedAt: '2026-11-27T00:00:00Z', leads: [parseRow(row(), 'lead', 0, 0)], testDrives: [] });

test('site verification rejects other BYD yards, unknown sites and non-BYD South Morang', () => {
  assert.equal(parseRow(row('BYD Dandenong'), 'lead', 0, 0), null);
  assert.equal(parseRow(row('South Morang Hyundai'), 'lead', 0, 0), null);
  assert.equal(parseRow(row(''), 'lead', 0, 0), null);
  const parsed = parseRow(row(), 'lead', 0, 0);
  assert.equal(parsed.site, SITE);
  assert.equal(parsed.id, '123');
  assert.equal(parsed.customer.phone, '0412345678');
  assert.equal(parsed.customer.email, 'buyer@example.test');
  assert.throws(() => parseRow(row(SITE, ''), 'lead', 0, 0), { code: 'invalid_response' });
});

test('provider block latches a pause across new processes and session replacements', async t => {
  let calls = 0;
  const client = clientFor(t, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: 'We have detected abnormal activity coming from this device.' })); } });
  await assert.rejects(client.request(params(245, 0, 0, 0, 100)), { code: 'provider_blocked' });
  // CLI records the provider error; subsequent attempts must not hit Virtual Yard.
  client.save({ status: 'provider_blocked' });
  writePrivate(client.sessionFile, { cookie: 'PHPSESSID=new-test-session' });
  const next = new VirtualyardClient({ directory: client.directory, portal, fetchImpl: async () => { calls++; throw new Error('must not request'); } });
  await assert.rejects(next.request(params(245, 0, 0, 0, 100)), { code: 'provider_blocked' });
  assert.equal(calls, 1);
});

test('rate limits preserve Retry-After without further requests and require at least a day', async t => {
  const now = Date.parse('2026-11-27T00:00:00Z');
  const client = clientFor(t, { now: () => now, fetchImpl: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '172800' } }) });
  await assert.rejects(client.request(params(245, 0, 0, 0, 100)), error => {
    assert.equal(error.code, 'rate_limited');
    assert.equal(Date.parse(error.retryAt), now + 2 * DAY);
    client.save({ retryAt: error.retryAt });
    return true;
  });
  await assert.rejects(client.request(params(245, 0, 0, 0, 100)), { code: 'cooldown' });
});

test('daily request budget persists across processes and cookie rotation stays private', async t => {
  let calls = 0;
  const client = clientFor(t, { dailyLimit: 1, fetchImpl: async () => {
    calls++;
    return new Response('{"data":[]}', { headers: { 'Set-Cookie': 'PHPSESSID=rotated-session; Path=/; HttpOnly' } });
  } });
  await client.request(params(245, 0, 0, 0, 100));
  assert.equal(readPrivate(client.sessionFile).cookie, 'PHPSESSID=rotated-session');
  const next = new VirtualyardClient({ directory: client.directory, portal, dailyLimit: 1, fetchImpl: async () => { calls++; } });
  await assert.rejects(next.request(params(245, 0, 0, 0, 100)), { code: 'request_budget' });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(client.state).includes('session'));
});

test('missing configuration, off-origin portals and endpoint redirects fail closed', async t => {
  let calls = 0;
  const client = clientFor(t, { portal: 'https://another.example.test/portal/', fetchImpl: async () => { calls++; } });
  await assert.rejects(client.request(params(245, 0, 0, 0, 100)), { code: 'configuration_required' });
  assert.equal(calls, 0);
  client.portal = portal;
  client.fetch = async () => new Response('', { status: 302, headers: { location: 'https://another.example.test/login' } });
  await assert.rejects(client.request(params(245, 0, 0, 0, 100)), { code: 'authentication_required' });
});

test('serial requests respect minimum spacing and repeated pages cannot produce a snapshot', async t => {
  const delays = [];
  const client = clientFor(t, { now: () => 10000, sleep: async ms => { delays.push(ms); }, fetchImpl: async () => new Response(JSON.stringify({ data: [row()] })) });
  await assert.rejects(scrape(client), { code: 'invalid_response' });
  assert.deepEqual(delays, [5000]);
});

test('complete sweep deduplicates sources and excludes unrelated dealership data', async () => {
  let calls = 0;
  const client = { pageSize: 100, now: Date.now, async request(resource) {
    calls++;
    const p = new URL(resource, portal).searchParams;
    if (p.get('menuId') === '899' || p.get('start') !== '0') return [];
    return [row(), row('BYD Dandenong', '999')];
  } };
  const result = await scrape(client);
  assert.equal(calls, 51);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].site, SITE);
  assert.equal(result.testDrives.length, 0);
});

test('import validates entire snapshot before writing and updates source metadata only', () => {
  const value = snapshot();
  const first = planSnapshot(value)[0];
  assert.equal(first.updateOne.update.$setOnInsert.dealership_name, SITE);
  assert.equal(first.updateOne.update.$setOnInsert.owner_id, null);
  assert.equal(first.updateOne.update.$setOnInsert.booran_ai_enabled, false);
  assert.deepEqual(Object.keys(first.updateOne.update.$set), ['external.virtualyard']);
  assert.equal(String(planSnapshot(value)[0].updateOne.filter._id), String(first.updateOne.filter._id));
  value.leads.push({ ...value.leads[0], id: '999', site: 'BYD Dandenong' });
  assert.throws(() => planSnapshot(value), { code: 'invalid_snapshot' });
});

test('test drives link by source lead ID, while unknown locations are excluded', () => {
  const drive = ['456', '', '<a class="loadPage" data-id="leadId=123">Example Buyer</a><table class="card"><tr><td>Location:</td><td>South Morang BYD</td></tr></table>', '', '', '<span class="label">2026-12-01T10:00:00+11:00</span><a class="loadPage">Confirmed</a>'];
  const parsed = parseRow(drive, 'test_drive', 0, 0);
  assert.equal(parsed.leadId, '123');
  const value = snapshot();
  value.testDrives = [parsed];
  assert.equal(planSnapshot(value)[0].updateOne.update.$set['external.virtualyard'].test_drives[0].id, '456');
  drive[2] = drive[2].replace('South Morang BYD', 'BYD Dandenong');
  assert.equal(parseRow(drive, 'test_drive', 0, 0), null);
});
