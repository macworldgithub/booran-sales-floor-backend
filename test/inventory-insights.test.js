const { test } = require('node:test');
const assert = require('node:assert/strict');
const { holdingCost, inventoryAdvisory, paidSource, vehicleIndex, resolveVehicle } = require('../lib/inventory-insights');
const { assessEngagement } = require('../lib/prospect-engagement');
const now = new Date('2026-11-17T01:00:00Z');
const at = days => new Date(+now - days * 86400000).toISOString();
const lead = { status: 'following_up', diary_entries: [] };
const assess = input => assessEngagement({ lead, linkedVehicles: ['unit'], now, ...input });

test('holding cost uses unrounded 7.5% annual interest and actual paid leads segmented by type', () => {
  const result = holdingCost({ vehicleCost: 36500, daysInStock: 30, holdingCostBreakdown: { leadDataCheckedAt: now.toISOString() } }, [
    { source: 'Carsales', type: 'Web enquiry' }, { source: 'Carsales', type: 'Phone' }, { source: 'Drive.com', type: 'Web enquiry' },
  ], now);
  assert.equal(result.holdingCostPerDay, 7.5); assert.equal(result.holdingCostBreakdown.floorplanCost, 225);
  assert.equal(result.holdingCostBreakdown.leadCharges, 210); assert.equal(result.accumulatedHoldingCost, 435);
  assert.equal(result.holdingCostBreakdown.segments.length, 3);
  assert.equal(paidSource('carsales'), 'Carsales'); assert.equal(paidSource('Drive'), 'Drive.com');
  for (const source of ['test drive', 'SMS connect', 'Call connect', 'AutoTrader Group', 'website']) assert.equal(paidSource(source), null);
});
test('Melbourne stock calendar days, online lead time and sold interest cutoff stay separate', () => {
  const unit = { vehicleCost: 36500, daysInStock: 999, dateInStock: '2026-10-03T01:00:00Z', category: 'Used', availableOnlineAt: '2026-10-04T01:00:00Z' };
  const result = holdingCost(unit, [], new Date('2026-10-05T01:00:00Z'));
  assert.equal(result.daysInStock, 2); assert.equal(result.accumulatedHoldingCost, 15); assert.equal(result.usedCarLeadTimeDays, 1);
  const sold = holdingCost({ ...unit, stockExitedAt: '2026-10-05T01:00:00Z' }, [], now);
  assert.equal(sold.accumulatedHoldingCost, 15); assert.equal(inventoryAdvisory(sold).recommendedAction, 'NONE');
  const missing = holdingCost({ advertisedPrice: 50000, daysInStock: 30 }, [], now);
  assert.equal(missing.accumulatedHoldingCost, null); assert.match(missing.holdingCostBreakdown.warnings.join(' '), /Vehicle cost/);
});
test('capital trap and wholesale thresholds use full holding cost against gross margin', () => {
  const vehicle = { vehicleCost: 36500, daysInStock: 30, potentialGross: 300, category: 'Used' };
  assert.equal(inventoryAdvisory(holdingCost(vehicle, [], now)).recommendedAction, 'NONE');
  const withLeads = holdingCost(vehicle, [{ source: 'Carsales', type: 'Web' }], now);
  assert.equal(inventoryAdvisory(withLeads).recommendedAction, 'WHOLESALE');
  assert.match(inventoryAdvisory(withLeads).actionReason, /305\.00.*paid Nextgate/);
  assert.equal(inventoryAdvisory(holdingCost({ ...vehicle, daysInStock: 91 }, [], now)).recommendedAction, 'WHOLESALE');
});
test('stock linking is exact, dealership-scoped and never matches a shared model name or ambiguous unit', () => {
  const unit = { _id: 'a', rooftopName: 'South Morang Hyundai', stockNumber: 'U123', model: 'i30', vin: 'KMHCT41DMCU012345' };
  const index = vehicleIndex([unit, { ...unit, _id: 'b', rooftopName: 'South Morang Kia' }]);
  assert.equal(resolveVehicle(index, unit.rooftopName, { stock_number: 'u123' })._id, 'a');
  assert.equal(resolveVehicle(index, 'Other dealer', { stock_number: 'U123' }), null);
  assert.equal(resolveVehicle(index, unit.rooftopName, { model: 'i30' }), null);
  assert.equal(resolveVehicle(vehicleIndex([unit, { ...unit, _id: 'c' }]), unit.rooftopName, { stock_number: 'U123' }), null);
});
test('engagement applies SMS, notes and observed interactions in the specified priority and weights', () => {
  const result = assess({ lead: { ...lead, diary_entries: [{ author_role: 'sales_consultant', author: 'Sales', date: at(1), note: 'Ready to buy; appointment booked' }] },
    messages: [{ _id: 'out', provider_message_id: 'sent', status: 'sent', created_at: at(2) }, { _id: 'reply', direction: 'inbound', status: 'received', original_message_id: 'sent', created_at: at(1.5) }],
    events: [{ id: 'visit', at: at(1), type: 'vehicle_view', source: 'Good Showroom' }, { id: 'form', at: at(1), type: 'finance_requested', source: 'Nextgate' }] });
  assert.deepEqual(result.signals.map(signal => signal.score), [3, 2, 1]); assert.equal(result.score, 6); assert.equal(result.state, 'buying');
  assert.equal(result.signals[0].metrics.responseRate, 100); assert.equal(result.signals[0].metrics.medianResponseMinutes, 720);
  assert.equal(result.signals[0].metrics.repliesWithin24Hours, 1); assert.ok(result.signals.every(signal => signal.evidence.length));
});
test('two unanswered SMS only become negative after seven days; failed, future and unsubscribe records do not earn response credit', () => {
  const messages = [7, 8].map((day, i) => ({ _id: 'out-' + i, status: 'sent', created_at: at(day) }));
  const result = assess({ messages, events: [{ id: 'old', at: at(11), type: 'vehicle_view', source: 'Good Showroom' }] });
  assert.deepEqual(result.signals.map(signal => signal.score), [-3, -2, -1]); assert.equal(result.state, 'losing');
  const fresh = assess({ messages: [1, 2].map((day, i) => ({ ...messages[i], created_at: at(day) })) });
  assert.equal(fresh.signals[0].score, 0);
  const excluded = assess({ messages: [{ status: 'failed', created_at: at(8) }, { direction: 'inbound', event_type: 'unsubscribe', created_at: at(1) }, { direction: 'inbound', created_at: at(-1) }] });
  assert.equal(excluded.score, 0); assert.equal(excluded.signals[0].metrics.responseRate, null);
});
test('latest decisive human note wins and imports, stale notes and negated intent do not create a false positive', () => {
  const notes = [
    { author: 'Sales', date: at(10), note: 'ready to buy' }, { author: 'Sales', date: at(1), note: 'Bought elsewhere' },
    { author: 'DealerSocket import', date: at(0), note: 'ready to buy' },
  ];
  assert.equal(assess({ lead: { ...lead, diary_entries: notes } }).signals[1].score, -2);
  assert.equal(assess({ lead: { ...lead, diary_entries: [{ author: 'Sales', date: at(1), note: 'Not ready to buy' }] } }).signals[1].score, 0);
  assert.equal(assess({ lead: { ...lead, diary_entries: [{ author: 'Sales', date: at(15), note: 'Ready to buy' }] } }).score, 0);
});
test('neutral scores and unlinked, sold, lost or inactive source prospects do not receive positive/warning badges', () => {
  assert.equal(assess({}).state, 'neutral');
  assert.equal(assess({ lead: { ...lead, diary_entries: [{ author: 'Sales', date: at(1), note: 'Hot' }] } }).state, 'neutral');
  for (const status of ['sold', 'lost']) assert.equal(assess({ lead: { ...lead, status } }), null);
  assert.equal(assess({ linkedVehicles: [] }), null);
  assert.equal(assess({ lead: { ...lead, sms_campaign: { active: false } } }), null);
});

test('a fresh SMS reply resets overall silence and duplicate provider rows cannot multiply contacts', () => {
  const messages = [{ _id: 'one', provider_message_id: 'same-send', status: 'sent', created_at: at(8) },
    { _id: 'copy', provider_message_id: 'same-send', status: 'sent', created_at: at(8) }];
  assert.equal(assess({ messages }).signals[0].metrics.outboundCount, 1);
  assert.equal(assess({ messages }).signals[0].score, 0);
  const result = assess({ messages: [...messages, { _id: 'reply', direction: 'inbound', status: 'received', original_message_id: 'same-send', created_at: at(1) }],
    events: [{ id: 'old', at: at(11), type: 'vehicle_view', source: 'Good Showroom' }] });
  assert.equal(result.signals[2].score, 1); assert.equal(result.state, 'buying');
});
