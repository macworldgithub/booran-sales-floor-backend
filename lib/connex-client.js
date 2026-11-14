const fs = require('node:fs');
const path = require('node:path');
const { PORTAL, SITE, DEALER_CODE, STATUSES, opportunityId, opportunityUrl, portalDate, closed } = require('./connex-policy');

const problem = (code, message) => Object.assign(new Error(message), { code });
const normal = value => String(value || '').replace(/\s+/g, ' ').trim();
// Serialized into the browser by locator.evaluateAll. Follow rendered slots and
// open shadow roots, which native document queries and textContent omit.
function readRecordFields(labels) {
  const fields = {};
  const renderedText = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.matches('script,style,.slds-assistive-text')) return '';
    const assigned = node.tagName === 'SLOT' ? node.assignedNodes({ flatten: true }) : null;
    const children = assigned?.length ? assigned : node.shadowRoot?.childNodes || node.childNodes;
    return [...children].map(renderedText).join('') + (node.matches('br,p,div') ? '\n' : '');
  };
  for (const label of labels) {
    const value = label.closest('.slds-form-element')?.querySelector('.test-id__field-value');
    fields[label.textContent.trim()] = value ? renderedText(value).trim() : '';
  }
  return fields;
}
function config(env = process.env) {
  return { enabled: env.CONNEX_ENABLED === 'true', username: env.CONNEX_USERNAME || '', password: env.CONNEX_PASSWORD || '',
    writes: env.CONNEX_WRITEBACK_ENABLED === 'true', executablePath: env.CONNEX_CHROMIUM_EXECUTABLE || undefined,
    sessionFile: env.CONNEX_SESSION_FILE || path.resolve('storage/connex/session.json'),
    maxRecords: Math.min(20000, Math.max(50, Number(env.CONNEX_MAX_RECORDS) || 10000)),
    detailBatch: Math.min(100, Math.max(1, Number(env.CONNEX_DETAIL_BATCH) || 20)) };
}

// Uses the normal, authorized Hyundai portal UI. No guessed Salesforce API, hidden
// customer endpoint, or bypass of the Accepted/contact-reveal gate is used.
class ConnexClient {
  constructor(settings = config(), chromium) { this.settings = settings; this.chromium = chromium; }
  get configured() { return this.settings.enabled && Boolean(this.settings.username && this.settings.password); }
  async open() {
    if (this.page) return this.page;
    if (!this.configured) throw problem('CONNEX_CONFIG', 'Connex connection is not configured.');
    const chromium = this.chromium || require('playwright-core').chromium;
    this.browser = await chromium.launch({ headless: true, executablePath: this.settings.executablePath });
    let storageState;
    try { storageState = JSON.parse(fs.readFileSync(this.settings.sessionFile, 'utf8')); } catch { /* First sign-in. */ }
    this.context = await this.browser.newContext({ storageState, viewport: { width: 1440, height: 1080 } });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(25000);
    await this.page.goto(`${PORTAL}/s/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const username = this.page.getByPlaceholder('Username', { exact: true });
    await Promise.race([username.waitFor({ state: 'visible' }), this.page.getByRole('menuitem', { name: 'Opportunity', exact: true }).waitFor({ state: 'visible' })]);
    if (await username.isVisible()) {
      await username.fill(this.settings.username);
      await this.page.getByPlaceholder('Password', { exact: true }).fill(this.settings.password);
      await this.page.getByRole('button', { name: 'Log in', exact: true }).click();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (await this.page.getByText('Your login attempt has failed.', { exact: false }).isVisible()) throw problem('CONNEX_LOGIN', 'Connex sign-in failed.');
        if (await this.page.getByRole('menuitem', { name: 'Opportunity', exact: true }).isVisible()) break;
        if (await this.page.locator('input[autocomplete="one-time-code"],iframe[src*="recaptcha"]').count() || /verification|mfa|identity/i.test(this.page.url())) {
          throw problem('CONNEX_MFA', 'Interactive Connex sign-in is required.');
        }
        await this.page.waitForTimeout(300);
      }
    }
    await this.page.getByRole('menuitem', { name: 'Opportunity', exact: true }).waitFor({ state: 'visible' });
    await this.saveSession();
    return this.page;
  }
  async saveSession() {
    if (!this.context || !this.settings.sessionFile) return;
    fs.mkdirSync(path.dirname(this.settings.sessionFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.settings.sessionFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(await this.context.storageState()), { mode: 0o600 });
    fs.renameSync(temporary, this.settings.sessionFile);
    fs.chmodSync(this.settings.sessionFile, 0o600);
  }
  async close() {
    try { await this.saveSession(); } finally {
      await this.browser?.close(); this.page = null; this.context = null; this.browser = null;
    }
  }
  async list({ progress = async () => {} } = {}) {
    const page = await this.open();
    await page.goto(`${PORTAL}/s/opportunity/Opportunity/Default`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const views = page.getByRole('button', { name: 'Select a List View: Opportunities', exact: true });
    await views.waitFor({ state: 'visible' }); await views.click();
    await page.getByText('All Opportunities', { exact: true }).filter({ visible: true }).click();
    await page.getByRole('heading', { name: /Opportunities.*All Opportunities/s }).waitFor({ state: 'visible' });
    const table = page.locator('table').filter({ visible: true }).first();
    await table.waitFor({ state: 'visible' });
    const created = table.locator('thead th').filter({ has: page.getByRole('button', { name: /^Sort Created Date(?:\s|$)/ }) });
    for (let attempt = 0; attempt < 2 && !(await created.innerText()).includes('Sorted Descending'); attempt++) {
      await created.getByRole('button', { name: /^Sort Created Date(?:\s|$)/ }).click();
      await page.waitForTimeout(800);
    }
    if (!(await created.innerText()).includes('Sorted Descending')) throw problem('CONNEX_FORMAT', 'Connex list sort could not be verified.');
    const found = new Map(); let stable = 0, lastSize = -1, completeness = false;
    for (let pass = 0; pass < 500; pass++) {
      const rows = await table.evaluate(table => {
        const headers = Array.from(table?.querySelectorAll('thead th,thead [role="columnheader"]') || []).map(el =>
          (el.querySelector('[title]')?.getAttribute('title') || el.innerText).replace(/^Sort\s+/, '').replace(/\s+/g, ' ').trim());
        return Array.from(table.querySelectorAll('tbody tr')).flatMap(row => {
          const link = row.querySelector('a[href*="/s/opportunity/006"]');
          if (!link) return [];
          const fields = Object.fromEntries(Array.from(row.children).map((cell, i) => [headers[i] || String(i), cell.innerText.trim()]));
          return [{ url: link.href, opportunityName: link.innerText.trim(), fields }];
        });
      });
      const countLabel = page.locator('.countSortedByFilteredBy').filter({ visible: true });
      const counts = await countLabel.count() ? await countLabel.first().innerText() : '';
      const match = /([\d,]+)(\+)? items/.exec(counts);
      const loading = await page.locator('[role="status"],.slds-spinner').filter({ visible: true }).evaluateAll(elements => elements.some(el =>
          el.getClientRects().length && (el.classList.contains('slds-spinner') || /^Loading(?:\.\.\.)?$/.test(el.innerText.trim()))));
      const batch = { rows, count: match ? Number(match[1].replace(/,/g, '')) : null, more: Boolean(match?.[2]), loading };
      for (const row of batch.rows) {
        const id = opportunityId(row.url); if (id) found.set(id, { ...row, recordId: id, url: opportunityUrl(id) });
      }
      await progress({ discovered: found.size });
      if (!batch.loading && batch.count !== null && !batch.more && found.size >= batch.count) { completeness = true; break; }
      if (found.size >= this.settings.maxRecords) break;
      stable = found.size === lastSize && !batch.loading ? stable + 1 : 0; lastSize = found.size;
      if (stable >= 8) break;
      await table.evaluate(table => {
        let node = table.parentElement;
        while (node && !(node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement || node.getRootNode().host;
        if (node) node.scrollTop = node.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(650);
    }
    return { records: [...found.values()], complete: completeness };
  }
  async read(id) {
    const page = await this.open(); const url = opportunityUrl(id);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.test-id__field-label').filter({ hasText: /^Dealer Code$/ }).waitFor({ state: 'visible' });
    // Salesforce renders record fields inside native shadow roots. Playwright
    // locators pierce those roots; document.querySelectorAll does not.
    let fields = {};
    for (let attempt = 0; attempt < 50; attempt++) {
      fields = await page.locator('.test-id__field-label').evaluateAll(readRecordFields);
      if (fields['Dealer Code'] && fields['Opportunity Status']) break;
      await page.waitForTimeout(300);
    }
    const f = fields;
    if (f['Dealer Showroom'] !== SITE || f['Dealer Code'] !== DEALER_CODE) throw problem('CONNEX_SCOPE', 'Unexpected Connex dealership.');
    if (!STATUSES.includes(f['Opportunity Status'])) throw problem('CONNEX_FORMAT', 'Unknown Connex opportunity status.');
    return { recordId: opportunityId(id), url, dealership: SITE, dealerCode: DEALER_CODE,
      opportunityName: f['Opportunity Name'] || await page.locator('h1').first().innerText(), type: f['Opportunity Type'], name: f['Account Name'],
      phone: f['Contact Mobile'], email: f['Contact Email'], vehicle: f['Product of Interest'],
      stage: f['Opportunity Status'], subStatus: f['Dealer Sub-Status'], salesperson: f['Salesperson in charge'],
      summary: f.Summary, comments: f.Comments, latestNote: f['Latest Dealer Note'], lostReason: f['Lost Reason'],
      distributedAt: portalDate(f['Distributed Date']), createdAt: portalDate(f['Lead Created Date']),
      acceptedAt: portalDate(f['Accepted Date']), qualifiedAt: portalDate(f['Sales Qualified Date']),
      sourceUpdatedAt: f['Last Modified By'], observedAt: new Date().toISOString() };
  }
  async select(dialog, label, value) {
    const field = dialog.getByRole('combobox', { name: new RegExp(`^${label}(?: |$)`) });
    if (normal(await field.innerText()) === value) return;
    await field.click();
    await this.page.getByRole('listbox').filter({ visible: true }).getByRole('option', { name: value, exact: true }).click();
    // Do not save if a custom/dependent picklist ignored a selection.
    await field.filter({ hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).waitFor({ state: 'visible' });
  }
  async salesperson(dialog, name) {
    const input = dialog.getByRole('combobox', { name: /^Salesperson in charge/ });
    if (!(await input.count())) throw problem('CONNEX_FORMAT', 'Salesperson lookup is not available.');
    const remove = dialog.getByRole('button', { name: /^Remove / });
    if (await remove.count()) await remove.click();
    await input.fill(name);
    const result = this.page.getByRole('option').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`) });
    await result.first().waitFor({ state: 'visible' });
    if (await result.count() !== 1) throw problem('CONNEX_MAPPING', 'Connex salesperson lookup is ambiguous.');
    await result.click();
  }
  async apply(job) {
    if (!this.settings.writes && job.action !== 'refresh') throw problem('CONNEX_READONLY', 'Connex updates are disabled.');
    let before = await this.read(job.recordId);
    if (job.action === 'refresh') return before;
    const page = this.page, marker = `[Sales Floor ${job.requestId}]`;
    if (job.action === 'note') {
      // The marker makes a retry after a lost response safe for the source note too.
      if (!String(before.latestNote || '').includes(marker)) {
        await page.getByRole('button', { name: 'Show more actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'New Note', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('textbox', { name: 'Comments', exact: true }).fill(`${job.note}\n${marker}`);
        await dialog.getByRole('button', { name: 'Create', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
      }
      const after = await this.read(job.recordId);
      if (!String(after.latestNote || '').includes(marker)) throw problem('CONNEX_UNCERTAIN', 'Connex note could not be verified.');
      return after;
    }
    const target = job.action === 'close_won' ? 'Closed Won' : job.action === 'close_lost' ? 'Closed Lost' :
      job.action === 'qualify' ? 'Sales Qualified' : ['Accepted', 'Sales Qualified'].includes(before.stage) ? before.stage : 'Accepted';
    if (closed(before.stage) && before.stage !== target) throw Object.assign(new Error('This opportunity is already closed in Connex. Review it before changing the outcome.'), { status: 409 });
    if (['qualify', 'close_won', 'close_lost'].includes(job.action) && !['Accepted', 'Sales Qualified'].includes(before.stage) && !closed(before.stage)) {
      before = await this.apply({ ...job, action: 'accept', subStatus: undefined });
    }
    const personMatches = !job.salesperson || before.salesperson === job.salesperson;
    if (before.stage === target && personMatches && (!job.subStatus || before.subStatus === job.subStatus) &&
      (target !== 'Closed Lost' || before.lostReason === job.lostReason)) return before;
    // The Accept dialog is the portal action that includes Salesperson in charge.
    // Never change Opportunity Owner when allocating an enquiry.
    if (job.salesperson && !personMatches && !closed(target)) {
      await page.getByRole('button', { name: 'Accept', exact: true }).click();
      const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
      await this.select(dialog, 'Opportunity Status', target);
      await this.salesperson(dialog, job.salesperson);
      if (job.subStatus) await this.select(dialog, 'Dealer Sub-Status', job.subStatus);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      before = await this.read(job.recordId);
      if (before.salesperson !== job.salesperson || before.stage !== target) throw problem('CONNEX_UNCERTAIN', 'Connex allocation could not be verified.');
      return before;
    }
    await page.getByRole('button', { name: closed(target) ? 'Close' : target === 'Accepted' ? 'Accept' : 'Update', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
    await this.select(dialog, 'Opportunity Status', target);
    if (job.subStatus) await this.select(dialog, 'Dealer Sub-Status', job.subStatus);
    if (target === 'Closed Lost') {
      await this.select(dialog, 'Lost Reason', job.lostReason);
      const comments = dialog.getByRole('textbox', { name: 'Comments', exact: true });
      const previous = await comments.inputValue();
      if (!previous.includes(marker)) await comments.fill(`${previous}\nSales Floor loss reason: ${job.note}\n${marker}`.trim());
    }
    await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const after = await this.read(job.recordId);
    if (after.stage !== target || target === 'Closed Lost' && after.lostReason !== job.lostReason) throw problem('CONNEX_UNCERTAIN', 'Connex outcome could not be verified.');
    return after;
  }
}
module.exports = { ConnexClient, config, readRecordFields };
