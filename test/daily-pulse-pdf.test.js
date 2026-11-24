'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDailyPulseHtml, generateDailyPulsePdf, getDealershipCode } = require('../lib/daily-pulse-pdf');

const mockReport = {
  date: '2026-11-24',
  rooftop: 'South Morang Hyundai',
  dealership: 'South Morang Hyundai',
  summary: {
    newCustomers: 20,
    coverage: { videosSent: 20, nextActionsSet: 20 }
  },
  priorities: { unassigned: 20 },
  _customers: [
    {
      id: 'lead-1',
      name: 'Verga',
      createdToday: true,
      allocatedToday: false,
      ownerName: 'Isaac Bugeja',
      coverage: { videosSent: true, nextActionsSet: true },
      followUpDue: '2026-11-24T11:55:00.000Z'
    },
    {
      id: 'lead-2',
      name: 'IANGRIO',
      createdToday: false,
      allocatedToday: true,
      ownerName: 'Paul Daoud',
      coverage: { videosSent: true, nextActionsSet: true },
      followUpDue: '2026-11-24T16:16:00.000Z'
    }
  ],
  members: [
    { name: 'Paul Daoud', newCustomers: 6, coverage: { videosSent: 6, nextActionsSet: 6 } },
    { name: 'Isaac Bugeja', newCustomers: 2, coverage: { videosSent: 2, nextActionsSet: 2 } }
  ]
};

test('getDealershipCode maps known dealerships or extracts initials', () => {
  assert.equal(getDealershipCode('South Morang Hyundai'), 'SMHY');
  assert.equal(getDealershipCode('South Morang Kia'), 'SMKIA');
  assert.equal(getDealershipCode('Dandenong Nissan'), 'DANNIS');
  assert.equal(getDealershipCode('Unknown Dealership'), 'UD');
});

test('renderDailyPulseHtml generates complete Good Showroom styled document', () => {
  const html = renderDailyPulseHtml(mockReport, {
    userName: 'Quoc Truong',
    userRole: 'General Sales Manager'
  });

  assert.ok(html.includes('Daily Pulse Wrap'));
  assert.ok(html.includes('End-of-Day Floor Log · South Morang Hyundai (SMHY) · Booran Motor Group'));
  assert.ok(html.includes('Quoc Truong, General Sales Manager'));
  assert.ok(html.includes('24 November 2026'));
  assert.ok(html.includes('TOTAL LEADS'));
  assert.ok(html.includes('VIDEOS SENT'));
  assert.ok(html.includes('FOLLOW-UPS SET'));
  assert.ok(html.includes('OPEN ACTIONS'));
  assert.ok(html.includes('FLOOR LOG'));
  assert.ok(html.includes('Verga'));
  assert.ok(html.includes('Created Today'));
  assert.ok(html.includes('IANGRIO'));
  assert.ok(html.includes('Allocated Today'));
  assert.ok(html.includes('SALESPERSON BREAKDOWN'));
  assert.ok(html.includes('Paul Daoud'));
  assert.ok(html.includes('Good Showroom'));
  assert.ok(html.includes('watermark-container'));
});

test('generateDailyPulsePdf returns valid PDF binary buffer', async () => {
  const pdfBuffer = await generateDailyPulsePdf(mockReport, {
    userName: 'Quoc Truong',
    userRole: 'General Sales Manager'
  });

  assert.ok(Buffer.isBuffer(pdfBuffer));
  assert.ok(pdfBuffer.length > 1000);
  assert.equal(pdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-');
});
