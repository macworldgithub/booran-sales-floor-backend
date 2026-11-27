const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { load } = require('cheerio');
const { formatToPlus61 } = require('./phone');
const { upsertImportedLeads } = require('./lead-identity');

const SITE = 'BYD South Morang';
const ORIGIN = 'https://dealers.virtualyard.com.au';
const DAY = 86400000;
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const siteKey = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const isSite = value => ['bydsouthmorang', 'southmorangbyd'].includes(siteKey(value));
const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readPrivate(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw fault('storage_error', 'Cannot read private Virtual Yard state.'); }
}
function limit(value, fallback, min, max, name) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw fault('configuration_required', `Invalid ${name}.`);
  return n;
}

// Keep the session separate from Harmony and from Git. No background keep-alive,
// automatic block clearing, proxy rotation, or browser fingerprint impersonation.
class VirtualyardClient {
  constructor({ directory, portal, fetchImpl = global.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = Date.now, delayMs = 5000, dailyLimit = 500, pageSize = 100 } = {}) {
    if (!directory || !path.isAbsolute(directory)) throw fault('configuration_required', 'Set an absolute VIRTUALYARD_DATA_DIR.');
    this.directory = directory;
    this.portal = portal;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.delayMs = limit(delayMs, 5000, 5000, 60000, 'request interval');
    this.dailyLimit = limit(dailyLimit, 500, 1, 500, 'daily request limit');
    this.pageSize = limit(pageSize, 100, 1, 100, 'page size');
    this.lastRequest = null;
    this.stateFile = path.join(directory, 'state.json');
    this.sessionFile = path.join(directory, 'session.json');
    this.state = readPrivate(this.stateFile);
  }
  save(patch) {
    this.state = { ...this.state, ...patch };
    writePrivate(this.stateFile, this.state);
  }
  assertReady() {
    if (['provider_blocked', 'authentication_required'].includes(this.state.status)) {
      throw fault(this.state.status, 'Virtual Yard sync is paused. Resolve provider access, then explicitly resume.');
    }
    if (Date.parse(this.state.retryAt) > this.now()) throw fault('cooldown', 'Virtual Yard retry time has not been reached.');
    let portal;
    try { portal = new URL(this.portal); } catch (_) { /* handled below */ }
    if (!portal || portal.origin !== ORIGIN || portal.pathname === '/' || portal.username || portal.password || portal.search || portal.hash) {
      throw fault('configuration_required', 'Set the verified South Morang BYD Virtual Yard portal URL.');
    }
    const cookie = readPrivate(this.sessionFile).cookie;
    if (typeof cookie !== 'string' || cookie.length > 16000 || /[\r\n]/.test(cookie) || !/(?:^|;\s*)PHPSESSID=[^;\s]+/.test(cookie)) {
      throw fault('authentication_required', 'Configure the private South Morang BYD session file.');
    }
    return cookie;
  }
  async request(resource) {
    const cookie = this.assertReady();
    const url = new URL(resource, ORIGIN);
    if (url.origin !== ORIGIN || url.pathname !== '/ajax/datatable/search.php') throw fault('configuration_required', 'Unexpected Virtual Yard endpoint.');
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const requests = this.state.requestDay === day ? this.state.requests || 0 : 0;
    if (requests >= this.dailyLimit) throw fault('request_budget', 'Daily request budget reached. No partial snapshot will be imported.', {
      retryAt: new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString(),
    });
    if (this.lastRequest !== null) await this.sleep(Math.max(0, this.delayMs - (this.now() - this.lastRequest)));
    this.lastRequest = this.now();
    this.save({ requestDay: day, requests: requests + 1 });
    let response;
    try {
      response = await this.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: {
        Accept: 'application/json', Cookie: cookie, Referer: this.portal,
        'User-Agent': 'BooranSalesFloor/1.0 (dealership data integration)', 'X-Requested-With': 'XMLHttpRequest',
      } });
    } catch (_) { throw fault('network_error', 'Virtual Yard could not be reached.'); }
    const body = await response.text();
    if (/abnormal activity|free of malware|data scraping tools|captcha|verify.{0,30}(?:device|human)/i.test(body)) {
      throw fault('provider_blocked', 'Virtual Yard blocked automated access. Sync is paused until provider access is resolved.');
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const at = /^\d+$/.test(retry || '') ? this.now() + Number(retry) * 1000 : Date.parse(retry);
      throw fault('rate_limited', 'Virtual Yard rate limit reached. No further requests made.', {
        retryAt: new Date(Math.max(this.now() + DAY, Number.isFinite(at) ? at : 0)).toISOString(),
      });
    }
    if ([401, 403].includes(response.status) || response.status >= 300 && response.status < 400 || /frmLogin|<title>[^<]*(?:login|sign in)/i.test(body)) {
      throw fault('authentication_required', 'Virtual Yard requires a new verified session. Sync is paused.');
    }
    if (!response.ok) throw fault('provider_error', 'Virtual Yard returned an unsuccessful response.');
    if (body.length > 10 * 1024 * 1024) throw fault('invalid_response', 'Virtual Yard page exceeds the allowed size.');
    let data;
    try { data = JSON.parse(body); } catch (_) { throw fault('invalid_response', 'Virtual Yard returned an unexpected page.'); }
    if (data?.error) throw fault('invalid_response', 'Virtual Yard rejected the data request.');
    if (!Array.isArray(data?.data)) {
      if (data && ['recordsTotal', 'recordsFiltered'].every(k => Object.hasOwn(data, k) && Number.isFinite(Number(data[k])) && Number(data[k]) >= 0) && data.data == null) data.data = [];
      else throw fault('invalid_response', 'Virtual Yard returned invalid rows.');
    }
    // Save only PHP session rotation; analytics/Stripe cookies are unnecessary.
    const cookies = response.headers.getSetCookie?.() || [];
    for (const item of cookies) {
      const match = item.match(/^PHPSESSID=([^;\s]+)/);
      if (match) writePrivate(this.sessionFile, { cookie: `PHPSESSID=${match[1]}` });
    }
    return data.data;
  }
}

function card(html) {
  const $ = load(String(html ?? ''));
  const meta = {};
  $('table.card tr').each((_, tr) => {
    const cells = $(tr).find('td');
    for (let i = 0; i + 1 < cells.length; i += 2) meta[$(cells[i]).text().trim().replace(/:$/, '')] = $(cells[i + 1]).text().trim();
  });
  return { $, meta };
}
function parseRow(row, type, tab, stage) {
  const cells = Array.isArray(row) ? row : Object.keys(row || {}).sort((a, b) => Number(a) - Number(b)).map(k => row[k]);
  if (cells.length < (type === 'lead' ? 8 : 6)) throw fault('invalid_response', 'Virtual Yard row has missing columns.');
  const { $, meta } = card(cells[2]);
  const anchor = $('a.loadPage').first();
  const vehicle = card(cells[3]);
  const id = type === 'lead' ? String(cells[7]).match(/leadId=(\d+)/)?.[1] || (anchor.attr('data-id') || '').match(/leadId=(\d+)/)?.[1] : String(cells[0]).trim();
  const site = type === 'lead' ? meta.Dealership || meta.Location || meta.Yard || vehicle.meta.Yard : meta.Location;
  if (!isSite(site)) return null; // Never label all account records as South Morang.
  if (!id || !/^\d+$/.test(id) || !anchor.text().trim()) throw fault('invalid_response', 'South Morang record has no stable source ID or name.');
  const status = card(type === 'lead' ? cells[6] : cells[5]);
  return {
    id, type, site: SITE, tab, stage,
    leadId: type === 'lead' ? id : (anchor.attr('data-id') || '').match(/leadId=(\d+)/)?.[1] || '',
    customer: { name: anchor.text().trim(), phone: meta.Mobile || meta.Phone || meta['Mobile Phone'] || '', email: meta.Email || '' },
    receivedAt: meta.Date || '', source: meta.Source || '', assignedTo: meta['Assigned To'] || '',
    status: (type === 'test_drive' ? status.$('a.loadPage').first().text() : status.$.text()).trim(), stageText: meta.Stage || '',
    notes: $('span.lead-body-preview').text().trim(),
    vehicle: { description: vehicle.$('a.loadPage').first().text().trim(), stock: vehicle.meta['Stock#'] || '', yard: vehicle.meta.Yard || '' },
    ...(type === 'test_drive' ? { date: status.$('span.label').first().text().trim() } : {}),
  };
}
function params(menuId, tab, stage, start, length) {
  const p = new URLSearchParams({ menuId: String(menuId), tab: String(tab), stage: String(stage), start: String(start), length: String(length), draw: '1',
    'order[0][column]': '0', 'order[0][dir]': 'desc', 'search[value]': '', 'search[regex]': 'false',
    ssrFilters: '', parent: '', child: '', params: '', 'ssrDateRange[startDate]': '', 'ssrDateRange[endDate]': '' });
  for (let i = 0; i < 8; i++) for (const [key, value] of Object.entries({ data: String(i), name: '', searchable: 'true', orderable: i === 0 ? 'true' : 'false', 'search][value': '', 'search][regex': 'false' })) {
    p.set(`columns[${i}][${key}]`, value);
  }
  return `/ajax/datatable/search.php?${p}`;
}
async function scrape(client) {
  const combinations = [0, 2, 3, 4, 5].flatMap(tab => [0, 1, 2, 3, 4].map(stage => ({ type: 'lead', menu: 245, tab, stage })));
  combinations.push({ type: 'test_drive', menu: 899, tab: 0, stage: 0 });
  const records = new Map();
  for (const combo of combinations) {
    const hashes = new Set();
    for (let start = 0; ; start += client.pageSize) {
      const rows = await client.request(params(combo.menu, combo.tab, combo.stage, start, client.pageSize));
      if (!rows.length) break;
      const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      if (hashes.has(hash)) throw fault('invalid_response', 'Virtual Yard repeated a page. Snapshot not imported.');
      hashes.add(hash);
      for (const row of rows) {
        const record = parseRow(row, combo.type, combo.tab, combo.stage);
        if (record && !records.has(`${record.type}:${record.id}`)) records.set(`${record.type}:${record.id}`, record);
      }
    }
  }
  const all = [...records.values()];
  if (!all.some(row => row.type === 'lead')) throw fault('scope_unverified', 'No verified South Morang BYD leads found. No records imported.');
  return { version: 1, dealership: SITE, scrapedAt: new Date(client.now()).toISOString(),
    leads: all.filter(row => row.type === 'lead'), testDrives: all.filter(row => row.type === 'test_drive') };
}
function planSnapshot(snapshot) {
  if (snapshot?.version !== 1 || snapshot.dealership !== SITE || !Number.isFinite(Date.parse(snapshot.scrapedAt)) ||
      !Array.isArray(snapshot.leads) || !snapshot.leads.length || !Array.isArray(snapshot.testDrives)) throw fault('invalid_snapshot', 'Invalid scoped Virtual Yard snapshot.');
  const ids = new Set();
  for (const row of [...snapshot.leads, ...snapshot.testDrives]) {
    if (!row || row.site !== SITE || !['lead', 'test_drive'].includes(row.type) || !/^\d+$/.test(row.id) || !text(row.customer?.name)) throw fault('invalid_snapshot', 'Snapshot has an invalid record or a record outside South Morang BYD.');
    const key = `${row.type}:${row.id}`;
    if (ids.has(key)) throw fault('invalid_snapshot', 'Snapshot contains duplicate source records.');
    ids.add(key);
  }
  if (snapshot.leads.some(row => row.type !== 'lead') || snapshot.testDrives.some(row => row.type !== 'test_drive')) throw fault('invalid_snapshot', 'Invalid snapshot record type.');
  const drivesByLead = new Map();
  for (const drive of snapshot.testDrives) {
    const drives = drivesByLead.get(drive.leadId) || [];
    drives.push({ id: drive.id, date: text(drive.date), status: text(drive.status) });
    drivesByLead.set(drive.leadId, drives);
  }
  return snapshot.leads.map(row => {
    const id = new ObjectId(createHash('sha256').update(`virtualyard:${SITE}:${row.id}`).digest('hex').slice(0, 24));
    const received = Number.isFinite(Date.parse(row.receivedAt)) ? new Date(row.receivedAt).toISOString() : snapshot.scrapedAt;
    const drives = drivesByLead.get(row.id) || [];
    const external = { provider: 'Virtual Yard', lead_id: row.id, dealership: SITE, channel: text(row.source),
      stage: text(row.stageText), status: text(row.status), assigned_to: text(row.assignedTo), notes: text(row.notes, 5000),
      phone: text(row.customer.phone), email: text(row.customer.email, 254), vehicle: text(row.vehicle?.description),
      stock_number: text(row.vehicle?.stock), test_drives: drives, snapshot_at: snapshot.scrapedAt };
    return { updateOne: { filter: { _id: id }, update: {
      $set: { 'external.virtualyard': external },
      $setOnInsert: { deal_id: `VIRTUALYARD-SOUTH-MORANG-BYD-${row.id}`, dealership_name: SITE, dealer_code: 'BOORAN-BYD',
        customer_name: text(row.customer.name), customer_phone: formatToPlus61(text(row.customer.phone)), customer_email: text(row.customer.email, 254),
        vehicle_make: /^BYD\b/i.test(text(row.vehicle?.description)) ? 'BYD' : '', vehicle_model: text(row.vehicle?.description),
        source: 'Virtual Yard', status: /\b(sold|delivered)\b/i.test(row.status) ? 'sold' : /\b(lost|cancelled)\b/i.test(row.status) ? 'lost' : row.stage === 0 ? 'new_lead' : 'following_up',
        owner_id: null, owner_name: 'Unassigned', notes: text(row.notes, 5000),
        created_at: received, createdAt: new Date(received), updatedAt: new Date(snapshot.scrapedAt),
        booran_ai_enabled: false, follow_ups_sent: 0, diary_entries: [],
      },
    }, upsert: true } };
  });
}
async function importSnapshot(db, snapshot) {
  const operations = planSnapshot(snapshot); // Validate the entire scope before any writes.
  let inserted = 0;
  for (let i = 0; i < operations.length; i += 100) inserted += (await upsertImportedLeads(db, operations.slice(i, i + 100))).upsertedCount;
  const leadIds = new Set(snapshot.leads.map(row => row.id));
  return { sourceRecords: snapshot.leads.length, testDrives: snapshot.testDrives.filter(row => leadIds.has(row.leadId)).length, inserted };
}

module.exports = { SITE, ORIGIN, DAY, isSite, writePrivate, readPrivate, VirtualyardClient, parseRow, params, scrape, planSnapshot, importSnapshot };
