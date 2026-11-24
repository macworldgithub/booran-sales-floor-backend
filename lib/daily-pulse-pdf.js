'use strict';

const path = require('path');
const fs = require('fs');

const DEALERSHIP_CODES = {
  'South Morang Hyundai': 'SMHY',
  'South Morang Kia': 'SMKIA',
  'Dandenong Nissan': 'DANNIS',
  'Mornington Mazda': 'MMZD',
  'Cranbourne Hyundai': 'CRHY',
  'Cranbourne Kia': 'CRKIA',
  'Berwick Mitsubishi': 'BWMIT',
  'Frankston Kia': 'FKKIA',
};

function getDealershipCode(name) {
  if (!name) return 'DEALER';
  if (DEALERSHIP_CODES[name]) return DEALERSHIP_CODES[name];
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase();
}

function formatLongDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Melbourne' });
  } catch (_) {
    return dateStr;
  }
}

function formatShortDate(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Melbourne' });
  } catch (_) {
    return dateStr;
  }
}

function formatDue(dueAt) {
  if (!dueAt) return '—';
  try {
    const d = new Date(dueAt);
    if (!Number.isFinite(d.getTime())) return '—';
    const day = d.getDate();
    const month = d.getMonth() + 1;
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12 || 12;
    return `${day}/${month} ${hours}:${minutes} ${ampm}`;
  } catch (_) {
    return '—';
  }
}

function getTriggerText(customer) {
  if (customer.createdToday && customer.allocatedToday) return 'Created & allocated today';
  if (customer.allocatedToday) return 'Allocated Today';
  if (customer.createdToday) return 'Created Today';
  return 'Assigned';
}

function renderDailyPulseHtml(report, options = {}) {
  const rooftop = report.rooftop || report.dealership || 'South Morang Hyundai';
  const code = getDealershipCode(rooftop);
  const dateFormatted = formatLongDate(report.date);
  const shortDateFormatted = formatShortDate(report.date);

  const preparedBy = options.userName
    ? `${options.userName}, ${options.userRole || 'Sales Manager'}`
    : 'Quoc Truong, General Sales Manager';

  const summary = report.summary || { newCustomers: 0, coverage: { videosSent: 0, nextActionsSet: 0 } };
  const totalLeads = summary.newCustomers || 0;
  const videosSent = summary.coverage?.videosSent || 0;
  const followUpsSet = summary.coverage?.nextActionsSet || 0;
  const videoRate = totalLeads ? Math.round((videosSent / totalLeads) * 100) : 100;
  const fuRate = totalLeads ? Math.round((followUpsSet / totalLeads) * 100) : 100;
  const openActions = report.priorities?.unassigned || totalLeads;

  const customers = report._customers || [];
  const members = (report.members || [])
    .filter(m => m.newCustomers > 0 || m.counts?.videosSent > 0 || m.counts?.nextActionsSet > 0)
    .sort((a, b) => (b.newCustomers || 0) - (a.newCustomers || 0));

  // Determine pagination: Page 1 holds up to 18 rows. Page 2 holds rest + breakdown.
  const splitNeeded = customers.length > 12;
  const page1Customers = splitNeeded ? customers.slice(0, 18) : customers;
  const page2Customers = splitNeeded ? customers.slice(18) : [];
  const totalPages = splitNeeded ? 2 : 1;

  const logoSvg = `
    <svg class="gs-logo" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M30 10C21 8 13 12 10 19C7 26 10 34 18 36C26 38 32 33 33 26C33.5 22.5 31 20 27 20H21" stroke="#0B192C" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M26 14C19 12.5 14 15 12 20C10 25 12 30 17 31.5C22 33 26 29.5 27 25C27.3 23 25.5 21.5 23 21.5H21" stroke="#0B192C" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  const watermarkSvg = `
    <svg class="watermark-logo" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M30 10C21 8 13 12 10 19C7 26 10 34 18 36C26 38 32 33 33 26C33.5 22.5 31 20 27 20H21" stroke="#0B192C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M26 14C19 12.5 14 15 12 20C10 25 12 30 17 31.5C22 33 26 29.5 27 25C27.3 23 25.5 21.5 23 21.5H21" stroke="#0B192C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  const renderTableRows = (list, startIndex = 0) => list.map((customer, idx) => {
    const isVideoSent = Boolean(customer.coverage?.videosSent);
    const isFollowUpSet = Boolean(customer.coverage?.nextActionsSet);
    return `
      <tr>
        <td class="text-center font-mono">${startIndex + idx + 1}</td>
        <td class="font-semibold">${customer.name || 'Customer'}</td>
        <td class="text-slate-600">${getTriggerText(customer)}</td>
        <td>${customer.ownerName || 'Unassigned'}</td>
        <td class="text-center">
          <span class="status-indicator ${isVideoSent ? 'status-green' : 'status-red'}">
            ● ${isVideoSent ? 'Sent' : 'Due'}
          </span>
        </td>
        <td class="text-center">
          <span class="status-indicator ${isFollowUpSet ? 'status-green' : 'status-red'}">
            ● ${isFollowUpSet ? 'Set' : 'Due'}
          </span>
        </td>
        <td class="text-right font-mono text-slate-600">${formatDue(customer.followUpDue)}</td>
      </tr>
    `;
  }).join('');

  const renderSalespersonRows = () => members.map(m => {
    const leads = m.newCustomers || 0;
    const vSent = m.coverage?.videosSent ?? (m.counts?.videosSent || 0);
    const fuSet = m.coverage?.nextActionsSet ?? (m.counts?.nextActionsSet || 0);
    const vRate = leads ? Math.round((vSent / leads) * 100) : 100;
    const fRate = leads ? Math.round((fuSet / leads) * 100) : 100;
    return `
      <tr>
        <td class="font-semibold">${m.name}</td>
        <td class="text-center">${leads}</td>
        <td class="text-center">${vSent}</td>
        <td class="text-center">${fuSet}</td>
        <td class="text-center">${vRate}%</td>
        <td class="text-center">${fRate}%</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Daily Pulse Wrap · ${rooftop} · ${dateFormatted}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');

    @page {
      size: A4 landscape;
      margin: 8mm 12mm 8mm 12mm;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0B192C;
      background-color: #FFFFFF;
      line-height: 1.35;
      font-size: 9pt;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .page {
      position: relative;
      width: 100%;
      height: 194mm;
      max-height: 194mm;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      page-break-after: always;
      background: #FFFFFF;
    }

    .page:last-child {
      page-break-after: avoid;
    }

    .watermark-container {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 380px;
      height: 380px;
      opacity: 0.04;
      pointer-events: none;
      z-index: 0;
    }
    .watermark-logo {
      width: 100%;
      height: 100%;
    }

    .page-content {
      position: relative;
      z-index: 1;
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    /* Running Header */
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 6px;
      border-bottom: 1.5px solid #0B192C;
      margin-bottom: 10px;
    }
    .top-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .top-left .title-badge {
      font-size: 8pt;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #0B192C;
    }
    .top-left .dealership-sub {
      font-size: 8pt;
      color: #64748B;
      font-weight: 600;
    }
    .top-right {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 8.5pt;
      font-weight: 700;
      color: #0B192C;
    }
    .gs-logo {
      width: 18px;
      height: 18px;
    }

    /* Title Block */
    .title-block {
      margin-bottom: 10px;
    }
    .main-title {
      font-size: 20pt;
      font-weight: 800;
      color: #0B192C;
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .main-subtitle {
      font-size: 8.5pt;
      color: #64748B;
      font-weight: 500;
      margin-top: 2px;
    }

    /* Meta Bar */
    .meta-bar {
      display: grid;
      grid-template-columns: 1fr 1.6fr 1fr 0.8fr;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 4px;
      padding: 6px 12px;
      margin-bottom: 12px;
      font-size: 8pt;
    }
    .meta-item {
      display: flex;
      gap: 6px;
    }
    .meta-label {
      color: #64748B;
      font-weight: 600;
    }
    .meta-value {
      color: #0B192C;
      font-weight: 700;
    }

    /* Pulse Summary */
    .section-heading {
      font-size: 8.5pt;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #0B192C;
      margin-bottom: 6px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 8px;
    }
    .summary-card {
      border: 1.5px solid #2563EB;
      border-radius: 4px;
      padding: 8px 12px;
      background: #FFFFFF;
      text-align: center;
    }
    .summary-card.card-green {
      border-color: #10B981;
    }
    .summary-card.card-slate {
      border-color: #64748B;
    }
    .summary-label {
      font-size: 7.5pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748B;
    }
    .summary-val {
      font-size: 22pt;
      font-weight: 800;
      color: #0B192C;
      line-height: 1.1;
      margin: 2px 0;
    }
    .summary-sub {
      font-size: 7.5pt;
      color: #64748B;
      font-weight: 600;
    }

    /* Legend */
    .legend-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 7.5pt;
      color: #475569;
      margin-bottom: 10px;
    }
    .legend-bar .dot {
      font-size: 8pt;
      margin-right: 2px;
    }
    .legend-note {
      font-style: italic;
      color: #64748B;
      margin-left: auto;
    }

    /* Table Styles */
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 7.5pt;
      margin-bottom: 8px;
    }
    table.data-table thead tr {
      background: #0B192C;
      color: #FFFFFF;
    }
    table.data-table th {
      padding: 5px 8px;
      font-weight: 700;
      text-align: left;
      border: 1px solid #0B192C;
      font-size: 7.5pt;
      letter-spacing: 0.02em;
    }
    table.data-table td {
      padding: 4px 8px;
      border: 1px solid #E2E8F0;
      font-size: 7.5pt;
    }
    table.data-table tbody tr:nth-child(even) {
      background: #F8FAFC;
    }
    table.data-table tfoot tr {
      background: #EEF2FF;
      font-weight: 800;
      border-top: 2px solid #0B192C;
    }
    table.data-table tfoot td {
      padding: 5px 8px;
      border: 1px solid #CBD5E1;
      font-size: 8pt;
    }

    .text-center { text-align: center !important; }
    .text-right { text-align: right !important; }
    .font-semibold { font-weight: 600; }
    .font-mono { font-family: 'JetBrains Mono', monospace; font-size: 7pt; }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-weight: 700;
      font-size: 7.5pt;
    }
    .status-green { color: #059669; }
    .status-red { color: #DC2626; }
    .dot.green { color: #10B981; }
    .dot.red { color: #EF4444; }

    /* Footnote */
    .footnote {
      font-size: 7pt;
      color: #64748B;
      line-height: 1.3;
      margin-top: 6px;
      text-align: center;
    }

    /* Running Footer */
    .page-footer {
      position: relative;
      z-index: 1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 6px;
      border-top: 1px solid #E2E8F0;
      font-size: 7.5pt;
      color: #64748B;
      font-weight: 600;
    }
  </style>
</head>
<body>

  <!-- PAGE 1 -->
  <div class="page">
    <div class="watermark-container">${watermarkSvg}</div>
    <div class="page-content">
      <div class="top-bar">
        <div class="top-left">
          ${logoSvg}
          <span class="title-badge">DAILY PULSE WRAP</span>
          <span class="dealership-sub">${code} · ${rooftop}</span>
        </div>
        <div class="top-right">
          ${logoSvg}
          <span>Good Showroom</span>
        </div>
      </div>

      <div class="title-block">
        <h1 class="main-title">Daily Pulse Wrap</h1>
        <p class="main-subtitle">End-of-Day Floor Log · ${rooftop} (${code}) · Booran Motor Group</p>
      </div>

      <div class="meta-bar">
        <div class="meta-item"><span class="meta-label">Date</span><span class="meta-value">${dateFormatted}</span></div>
        <div class="meta-item"><span class="meta-label">Prepared by</span><span class="meta-value">${preparedBy}</span></div>
        <div class="meta-item"><span class="meta-label">Dealership</span><span class="meta-value">${code}</span></div>
        <div class="meta-item"><span class="meta-label">Shift</span><span class="meta-value">Day</span></div>
      </div>

      <h2 class="section-heading">PULSE SUMMARY</h2>
      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-label">TOTAL LEADS</div>
          <div class="summary-val">${totalLeads}</div>
          <div class="summary-sub">Logged today</div>
        </div>
        <div class="summary-card card-green">
          <div class="summary-label">VIDEOS SENT</div>
          <div class="summary-val">${videosSent}</div>
          <div class="summary-sub">${videoRate}% rate</div>
        </div>
        <div class="summary-card card-green">
          <div class="summary-label">FOLLOW-UPS SET</div>
          <div class="summary-val">${followUpsSet}</div>
          <div class="summary-sub">${fuRate}% rate</div>
        </div>
        <div class="summary-card card-slate">
          <div class="summary-label">OPEN ACTIONS</div>
          <div class="summary-val">${openActions}</div>
          <div class="summary-sub">All pending review</div>
        </div>
      </div>

      <div class="legend-bar">
        <span><span class="dot green">●</span> Green = Completed (Video Sent / Follow-up Set)</span>
        <span><span class="dot red">●</span> Red = Outstanding</span>
        <span class="legend-note">Platform status lights as registered in Good Showroom</span>
      </div>

      <h2 class="section-heading">FLOOR LOG</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 32px;" class="text-center">#</th>
            <th style="width: 140px;">Customer</th>
            <th style="width: 180px;">Trigger</th>
            <th style="width: 160px;">Salesperson</th>
            <th style="width: 80px;" class="text-center">Video</th>
            <th style="width: 90px;" class="text-center">Follow-up</th>
            <th style="width: 120px;" class="text-right">Due</th>
          </tr>
        </thead>
        <tbody>
          ${renderTableRows(page1Customers, 0)}
          ${page1Customers.length === 0 ? '<tr><td colspan="7" class="text-center text-slate-500 py-3">No leads recorded for this workday.</td></tr>' : ''}
        </tbody>
      </table>

      ${!splitNeeded ? `
        <h2 class="section-heading" style="margin-top: 10px;">SALESPERSON BREAKDOWN</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Salesperson</th>
              <th class="text-center">Leads</th>
              <th class="text-center">Videos Sent</th>
              <th class="text-center">Follow-ups Set</th>
              <th class="text-center">Video Rate</th>
              <th class="text-center">F/U Rate</th>
            </tr>
          </thead>
          <tbody>
            ${renderSalespersonRows()}
          </tbody>
          <tfoot>
            <tr>
              <td>TOTAL</td>
              <td class="text-center">${totalLeads}</td>
              <td class="text-center">${videosSent}</td>
              <td class="text-center">${followUpsSet}</td>
              <td class="text-center">${videoRate}%</td>
              <td class="text-center">${fuRate}%</td>
            </tr>
          </tfoot>
        </table>
        <p class="footnote">This Daily Pulse Wrap is generated by Good Showroom. Red and green status lights reflect platform registration for Video Sent and Next Follow-up Set. All figures are based on the end-of-day Floor Log for ${code}.</p>
      ` : ''}
    </div>

    <div class="page-footer">
      <span>${rooftop} · Booran Motor Group</span>
      <span>Page 1 · ${shortDateFormatted}</span>
    </div>
  </div>

  ${splitNeeded ? `
  <!-- PAGE 2 -->
  <div class="page">
    <div class="watermark-container">${watermarkSvg}</div>
    <div class="page-content">
      <div class="top-bar">
        <div class="top-left">
          ${logoSvg}
          <span class="title-badge">DAILY PULSE WRAP</span>
          <span class="dealership-sub">${code} · ${rooftop}</span>
        </div>
        <div class="top-right">
          ${logoSvg}
          <span>Good Showroom</span>
        </div>
      </div>

      ${page2Customers.length > 0 ? `
        <h2 class="section-heading">FLOOR LOG (CONTINUED)</h2>
        <table class="data-table" style="margin-bottom: 14px;">
          <thead>
            <tr>
              <th style="width: 32px;" class="text-center">#</th>
              <th style="width: 140px;">Customer</th>
              <th style="width: 180px;">Trigger</th>
              <th style="width: 160px;">Salesperson</th>
              <th style="width: 80px;" class="text-center">Video</th>
              <th style="width: 90px;" class="text-center">Follow-up</th>
              <th style="width: 120px;" class="text-right">Due</th>
            </tr>
          </thead>
          <tbody>
            ${renderTableRows(page2Customers, 18)}
          </tbody>
        </table>
      ` : ''}

      <h2 class="section-heading">SALESPERSON BREAKDOWN</h2>
      <table class="data-table">
        <thead>
          <tr>
            <th>Salesperson</th>
            <th class="text-center">Leads</th>
            <th class="text-center">Videos Sent</th>
            <th class="text-center">Follow-ups Set</th>
            <th class="text-center">Video Rate</th>
            <th class="text-center">F/U Rate</th>
          </tr>
        </thead>
        <tbody>
          ${renderSalespersonRows()}
        </tbody>
        <tfoot>
          <tr>
            <td>TOTAL</td>
            <td class="text-center">${totalLeads}</td>
            <td class="text-center">${videosSent}</td>
            <td class="text-center">${followUpsSet}</td>
            <td class="text-center">${videoRate}%</td>
            <td class="text-center">${fuRate}%</td>
          </tr>
        </tfoot>
      </table>

      <p class="footnote" style="margin-top: 14px;">This Daily Pulse Wrap is generated by Good Showroom. Red and green status lights reflect platform registration for Video Sent and Next Follow-up Set. All figures are based on the end-of-day Floor Log for ${code}.</p>
    </div>

    <div class="page-footer">
      <span>${rooftop} · Booran Motor Group</span>
      <span>Page 2 · ${shortDateFormatted}</span>
    </div>
  </div>
  ` : ''}

</body>
</html>`;
}

function findChromiumExecutable() {
  if (process.env.CONNEX_CHROMIUM_EXECUTABLE && fs.existsSync(process.env.CONNEX_CHROMIUM_EXECUTABLE)) {
    return process.env.CONNEX_CHROMIUM_EXECUTABLE;
  }
  if (process.platform === 'win32') {
    const winPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
    ];
    for (const p of winPaths) {
      if (p && fs.existsSync(p)) return p;
    }
  } else {
    const linuxPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * Attempts to generate a PDF Buffer using Playwright Chromium
 */
async function generateDailyPulsePdf(report, options = {}) {
  const html = renderDailyPulseHtml(report, options);
  const chromium = require('playwright-core').chromium;
  const executablePath = findChromiumExecutable();

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: {
        top: '8mm',
        bottom: '8mm',
        left: '10mm',
        right: '10mm'
      }
    });
    return pdfBuffer;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  renderDailyPulseHtml,
  generateDailyPulsePdf,
  getDealershipCode
};
