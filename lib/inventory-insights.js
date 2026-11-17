const { dayKey, isActiveLead } = require('./followup-policy');
const { createHash } = require('node:crypto');
const { assessEngagement } = require('./prospect-engagement');

const HOLDING_POLICY = Object.freeze({ version: '2026-11-17', annualRate: 0.075, yearDays: 365, carsalesRate: 80, driveRate: 50 });
const money = number => Math.round((number + Number.EPSILON) * 100) / 100;
const key = value => String(value || '').trim().toUpperCase();
const siteKey = value => String(value || '').trim().toLowerCase();
const validVin = value => /^[A-HJ-NPR-Z\d]{17}$/.test(key(value));
const sourceRefs = lead => [lead.nexgate, ...(lead.source_refs || []).map(ref => ref.nexgate)].filter(Boolean);
const openSource = ref => ref.archived !== true && !['sold', 'lost', 'duplicate', 'unworkable', 'closed', 'closed won', 'closed lost'].includes(String(ref.stage || '').trim().toLowerCase());
function paidSource(value) {
  const name = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (['carsales', 'carsales.com.au', 'www.carsales.com.au'].includes(name)) return 'Carsales';
  if (['drive', 'drive.com', 'drive.com.au', 'www.drive.com.au'].includes(name)) return 'Drive.com';
  return null;
}
function vehicleIndex(vehicles) {
  const stock = new Map(), vin = new Map(), ids = new Map();
  const put = (map, value, vehicle) => { if (!value) return; const at = `${siteKey(vehicle.rooftopName)}:${key(value)}`;
    map.set(at, map.has(at) ? null : vehicle); };
  for (const vehicle of vehicles) { ids.set(String(vehicle._id), vehicle); put(stock, vehicle.stockNumber, vehicle); if (validVin(vehicle.vin)) put(vin, vehicle.vin, vehicle); }
  return { stock, vin, ids };
}
function resolveVehicle(index, site, reference) {
  const byId = index.ids.get(String(reference.stock_key || reference.inventory_vehicle_id || ''));
  if (byId && siteKey(byId.rooftopName) === siteKey(site)) return byId;
  if (validVin(reference.vin || reference.vehicle_vin)) {
    const found = index.vin.get(`${siteKey(site)}:${key(reference.vin || reference.vehicle_vin)}`);
    if (found) return found;
  }
  const stock = index.stock.get(`${siteKey(site)}:${key(reference.stock_number || reference.vehicle_stock_number || reference.stockNumber)}`) || null;
  if (stock && validVin(stock.vin) && validVin(reference.vin || reference.vehicle_vin) && key(stock.vin) !== key(reference.vin || reference.vehicle_vin)) return null;
  return stock;
}
function holdingCost(vehicle, leads = vehicle.holdingCostBreakdown?.leads || [], now = new Date()) {
  const policy = HOLDING_POLICY, storedDays = Math.max(0, Number(vehicle.daysInStock) || 0), stockDay = vehicle.dateInStock ? dayKey(vehicle.dateInStock) : '';
  const exitAt = vehicle.stockExitedAt || vehicle.holdingCostBreakdown?.stockExitedAt;
  const exitDay = exitAt ? dayKey(exitAt) : '';
  const endDay = exitDay && exitDay >= stockDay && exitDay < dayKey(now) ? exitDay : dayKey(now);
  const days = stockDay && (exitDay || !['sold', 'wholesale'].includes(String(vehicle.status).toLowerCase())) ?
    Math.max(0, Math.round((Date.parse(`${endDay}T12:00:00Z`) - Date.parse(`${stockDay}T12:00:00Z`)) / 86400000)) : storedDays;
  const onlineAt = vehicle.availableOnlineAt || vehicle.firstOnlineAt || vehicle.dateAvailableOnline, onlineDay = onlineAt ? dayKey(onlineAt) : '';
  const cost = Number(vehicle.vehicleCost), knownCost = vehicle.vehicleCost !== null && vehicle.vehicleCost !== undefined && Number.isFinite(cost) && cost >= 0;
  const carsalesLeads = leads.filter(lead => lead.source === 'Carsales').length, driveLeads = leads.filter(lead => lead.source === 'Drive.com').length;
  const floorplanCost = knownCost ? money(cost * policy.annualRate * days / policy.yearDays) : null;
  const carsalesCost = carsalesLeads * policy.carsalesRate, driveCost = driveLeads * policy.driveRate;
  const leadCharges = carsalesCost + driveCost;
  const holdingCostBreakdown = { policyVersion: policy.version, annualRate: policy.annualRate, yearDays: policy.yearDays,
    vehicleCost: knownCost ? cost : null, daysInStock: days, floorplanCost, carsalesLeads, driveLeads,
    carsalesRate: policy.carsalesRate, driveRate: policy.driveRate, carsalesCost, driveCost, leadCharges,
    segments: [...new Map(leads.map(lead => [`${lead.source}:${lead.type}`, { source: lead.source, type: lead.type }])).values()]
      .map(segment => ({ ...segment, count: leads.filter(lead => lead.source === segment.source && lead.type === segment.type).length })),
    total: knownCost ? money(floorplanCost + leadCharges) : null, leads, computedAt: now.toISOString(), stockExitedAt: vehicle.stockExitedAt || vehicle.holdingCostBreakdown?.stockExitedAt || null,
    leadDataCheckedAt: vehicle.holdingCostBreakdown?.leadDataCheckedAt || null,
    warnings: [...(!knownCost ? ['Vehicle cost is missing; holding cost is incomplete.'] : []),
      ...(!vehicle.holdingCostBreakdown?.leadDataCheckedAt ? ['Nextgate lead reconciliation is pending.'] : [])],
  };
  return { ...vehicle, daysInStock: days, agingBucket: days > 90 ? '90+' : days > 60 ? '61-90' : days > 45 ? '46-60' : days > 30 ? '31-45' : '0-30',
    holdingCostPerDay: knownCost ? money(cost * policy.annualRate / policy.yearDays) : null,
    accumulatedHoldingCost: holdingCostBreakdown.total, holdingCostBreakdown,
    usedCarLeadTimeDays: vehicle.category === 'Used' && stockDay && onlineDay ?
      Math.max(0, Math.round((Date.parse(`${onlineDay}T12:00:00Z`) - Date.parse(`${stockDay}T12:00:00Z`)) / 86400000)) : null };
}
function inventoryAdvisory(vehicle) {
  const exited = vehicle.holdingCostBreakdown?.stockExitedAt;
  if (exited && dayKey(exited) >= dayKey(vehicle.dateInStock) && Date.parse(exited) <= Date.parse(vehicle.holdingCostBreakdown.computedAt)) return { actionReason: '', recommendedAction: 'NONE' };
  if (['sold', 'wholesale'].includes(String(vehicle.status).toLowerCase())) return { actionReason: '', recommendedAction: 'NONE' };
  const total = vehicle.accumulatedHoldingCost, costText = total === null ? 'Holding cost is incomplete.' : `$${total.toFixed(2)} holding cost (floorplan interest plus paid Nextgate leads).`;
  const gross = Number.isFinite(Number(vehicle.potentialGross)) && vehicle.potentialGross != null ? Number(vehicle.potentialGross) :
    Number(vehicle.advertisedPrice) > 0 && Number(vehicle.vehicleCost) >= 0 ? Number(vehicle.advertisedPrice) - Number(vehicle.vehicleCost) : null;
  const consumed = total !== null && total > 0 && gross !== null && total >= Math.max(0, gross);
  if (vehicle.daysInStock > 90 || consumed) return { recommendedAction: 'WHOLESALE', actionReason: `Capital trap: ${vehicle.daysInStock > 90 ? `${vehicle.daysInStock} DIS exceeds the 90-day wholesale threshold.` : 'Holding cost has consumed the available gross margin.'} ${costText}` };
  if (vehicle.daysInStock > 60 && vehicle.category === 'New') return { recommendedAction: 'PRICE', actionReason: `Aging new unit (${vehicle.daysInStock} DIS). Review margin after ${costText}` };
  return { recommendedAction: 'NONE', actionReason: '' };
}
const referenceFields = ['seller_id', 'customer_id', 'lead_id', 'channel', 'stock_number', 'vin', 'lead_type', 'created_at', 'synced_at', 'stage', 'archived', 'engagement_events'];
const metadataProjection = { _id: 1, deal_id: 1, dealership_name: 1, status: 1, merged_into: 1, 'sms_campaign.active': 1,
  stock_number: 1, stockNumber: 1, vehicle_stock_number: 1, stock_key: 1, inventory_vehicle_id: 1, vehicle_vin: 1, vin: 1, created_at: 1, createdAt: 1,
  ...Object.fromEntries(referenceFields.flatMap(field => [[`nexgate.${field}`, 1], [`source_refs.nexgate.${field}`, 1]])),
  ...Object.fromEntries(['fingerprint', 'computedAt', 'score', 'state', 'policyVersion', 'signals.key', 'signals.score', 'signals.reason', 'signals.metrics'].map(field => [`engagement_assessment.${field}`, 1])),
};
async function refreshInventoryInsights(crm, inventory, now = new Date()) {
  const [vehicles, completedDeals, registeredDeals, automaticActions, metadata] = await Promise.all([
    inventory.collection('vehicles').find({ salesFloorHidden: { $ne: true } }).toArray(),
    crm.collection('deals').find({ status: 'completed', stock_key: { $exists: true } }, { projection: { stock_key: 1, completed_at: 1 } }).toArray(),
    crm.collection('deals').find({ status: 'registered', stock_key: { $exists: true } }, { projection: { stock_key: 1, lead_id: 1 } }).toArray(),
    inventory.collection('actionitems').find({ insight_rule: HOLDING_POLICY.version }).toArray(),
    // A compact metadata cursor serves billing and stock joins. Load diaries
    // and message histories only for participants in the current assessment.
    crm.collection('leads').find({}, { projection: metadataProjection, batchSize: 2000 }).toArray(),
  ]);
  const index = vehicleIndex(vehicles), exits = new Map(completedDeals.filter(deal => deal.completed_at).map(deal => [String(deal.stock_key), deal.completed_at]));
  const unitKey = row => `${siteKey(row.rooftopName)}:${key(row.stockNumber)}`;
  const actionKey = row => `${unitKey(row)}:${row.actionType}`;
  const existingActions = new Map(automaticActions.map(row => [actionKey(row), row])), actionsByUnit = new Map(), dealsByLead = new Map();
  for (const action of automaticActions) { const at = unitKey(action); const rows = actionsByUnit.get(at) || []; rows.push(action); actionsByUnit.set(at, rows); }
  for (const deal of registeredDeals) { const at = String(deal.lead_id); const rows = dealsByLead.get(at) || []; rows.push(deal); dealsByLead.set(at, rows); }
  const links = lead => {
    const linked = new Set();
    for (const ref of sourceRefs(lead).filter(openSource)) { const unit = resolveVehicle(index, lead.dealership_name, ref); if (unit) linked.add(String(unit._id)); }
    const direct = resolveVehicle(index, lead.dealership_name, lead); if (direct) linked.add(String(direct._id));
    for (const deal of dealsByLead.get(String(lead._id)) || []) { const unit = resolveVehicle(index, lead.dealership_name, deal); if (unit) linked.add(String(unit._id)); }
    return [...linked];
  };
  const paid = new Map(), summaries = new Map(vehicles.map(vehicle => [String(vehicle._id), { activeProspects: 0, buying: 0, losing: 0, neutral: 0, computedAt: now.toISOString() }]));
  for (const lead of metadata) for (const ref of sourceRefs(lead)) {
    const source = paidSource(ref.channel); if (!source || !ref.lead_id || !ref.seller_id) continue;
    const vehicle = resolveVehicle(index, lead.dealership_name, ref), id = `${ref.seller_id}:${ref.lead_id}`, old = paid.get(id);
    if (old && (Date.parse(old.syncedAt) || 0) > (Date.parse(ref.synced_at) || 0)) continue;
    paid.set(id, { vehicleId: vehicle ? String(vehicle._id) : null, providerId: id, source, type: ref.lead_type || 'Unspecified',
      stockNumber: ref.stock_number || '', vin: ref.vin || '', createdAt: ref.created_at || null, syncedAt: ref.synced_at || null });
  }
  const participants = metadata.filter(lead => lead.engagement_assessment || !lead.merged_into && isActiveLead(lead) && lead.sms_campaign?.active !== false && links(lead).length);
  let assessed = 0, unmatchedPaid = 0;
  for (let at = 0; at < participants.length; at += 100) {
    const batch = participants.slice(at, at + 100), ids = batch.map(lead => String(lead._id));
    const [details, messages, appointments] = await Promise.all([
      crm.collection('leads').find({ _id: { $in: batch.map(lead => lead._id) } }, { projection: { ...metadataProjection, diary_entries: 1, engagement_events: 1, engagement_history: 1 } }).toArray(),
      crm.collection('customer_messages').find({ lead_id: { $in: ids } }).toArray(),
      crm.collection('appointments').find({ leadId: { $in: [...ids, ...batch.map(lead => lead.deal_id).filter(Boolean)] } }).toArray(),
    ]);
    const updates = [];
    for (const lead of details) {
      const linked = links(lead), references = sourceRefs(lead);
      const events = references.filter(openSource).flatMap(ref => [
        ...((ref.created_at || ref === lead.nexgate && (lead.created_at || lead.createdAt)) ? [{ id: `${ref.seller_id}:${ref.lead_id}`, at: ref.created_at || lead.created_at || lead.createdAt, type: 'enquiry', source: 'Nextgate' }] : []),
        ...(ref.engagement_events || []),
      ]);
      const assessment = lead.merged_into ? null : assessEngagement({ lead, linkedVehicles: linked, now, events,
        messages: messages.filter(row => row.lead_id === String(lead._id)), appointments: appointments.filter(row => [String(lead._id), lead.deal_id].includes(row.leadId)) });
      if (assessment) { assessed++; for (const id of linked) { const summary = summaries.get(id); summary.activeProspects++; summary[assessment.state]++; } }
      const previous = lead.engagement_assessment;
      if (assessment) assessment.fingerprint = createHash('sha256').update(JSON.stringify({ score: assessment.score, policy: assessment.policy,
        linkedVehicles: assessment.linkedVehicles, signals: assessment.signals })).digest('hex');
      const history = [...(lead.engagement_history || [])];
      if (previous && previous.fingerprint !== assessment?.fingerprint) history.push({ computedAt: previous.computedAt, score: previous.score,
        state: previous.state, policyVersion: previous.policyVersion, fingerprint: previous.fingerprint,
        signals: previous.signals.map(({ key, score, reason, metrics }) => ({ key, score, reason, metrics })) });
      if (assessment || previous) updates.push({ updateOne: { filter: { _id: lead._id }, update: { $set: { engagement_assessment: assessment, engagement_history: history.slice(-30) } } } });
    }
    if (updates.length) await crm.collection('leads').bulkWrite(updates, { ordered: false });
  }
  const byVehicle = new Map();
  for (const row of paid.values()) { if (!row.vehicleId) { unmatchedPaid++; continue; } const list = byVehicle.get(row.vehicleId) || []; list.push(row); byVehicle.set(row.vehicleId, list); }
  const vehicleUpdates = [], actionUpdates = [];
  for (const vehicle of vehicles) {
    const row = holdingCost({ ...vehicle, ...(exits.has(String(vehicle._id)) ? { stockExitedAt: exits.get(String(vehicle._id)) } : {}), holdingCostBreakdown: { leadDataCheckedAt: now.toISOString() } }, byVehicle.get(String(vehicle._id)) || [], now);
    const advisory = inventoryAdvisory(row);
    vehicleUpdates.push({ updateOne: { filter: { _id: vehicle._id }, update: { $set: { daysInStock: row.daysInStock, agingBucket: row.agingBucket,
      accumulatedHoldingCost: row.accumulatedHoldingCost, holdingCostPerDay: row.holdingCostPerDay, holdingCostBreakdown: row.holdingCostBreakdown,
      engagementSummary: summaries.get(String(vehicle._id)), usedCarLeadTimeDays: row.usedCarLeadTimeDays, ...advisory } } } });
    const existingAction = existingActions.get(actionKey({ ...vehicle, actionType: advisory.recommendedAction }));
    const reopen = existingAction?.status === 'resolved' && existingAction.auto_resolved;
    if (advisory.recommendedAction !== 'NONE') actionUpdates.push({ updateOne: { filter: { stockNumber: vehicle.stockNumber, rooftopName: vehicle.rooftopName, actionType: advisory.recommendedAction },
      update: { $set: { reason: advisory.actionReason, impactMetric: `Holding cost: ${row.accumulatedHoldingCost === null ? 'incomplete' : '$' + row.accumulatedHoldingCost.toFixed(2)}`,
        ...(reopen ? { status: 'open', auto_resolved: false, resolvedNotes: '' } : {}),
        vehicleTitle: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '), vin: vehicle.vin, rooftopName: vehicle.rooftopName, rooftopId: vehicle.rooftopId,
        updatedAt: now }, $setOnInsert: { insight_rule: HOLDING_POLICY.version, ...(!reopen ? { status: 'open' } : {}), priority: advisory.recommendedAction === 'WHOLESALE' ? 'high' : 'medium', createdAt: now } }, upsert: true } });
    for (const action of (actionsByUnit.get(unitKey(vehicle)) || []).filter(action => action.status === 'open' && action.actionType !== advisory.recommendedAction)) {
      actionUpdates.push({ updateOne: { filter: { _id: action._id, status: 'open', insight_rule: HOLDING_POLICY.version }, update: { $set: { status: 'resolved', auto_resolved: true,
        resolvedNotes: 'The automatic holding-cost threshold is no longer met.', updatedAt: now } } } });
    }
  }
  for (let at = 0; at < vehicleUpdates.length; at += 250) await inventory.collection('vehicles').bulkWrite(vehicleUpdates.slice(at, at + 250), { ordered: false });
  for (let at = 0; at < actionUpdates.length; at += 250) await inventory.collection('actionitems').bulkWrite(actionUpdates.slice(at, at + 250), { ordered: false });
  const result = { kind: 'inventory_insights', computedAt: now.toISOString(), vehicles: vehicles.length, assessed, paidLeads: paid.size, matchedPaid: paid.size - unmatchedPaid, unmatchedPaid };
  await crm.collection('integration_sync').findOneAndUpdate({ _id: 'inventory-insights' }, { $set: result }, { upsert: true });
  return result;
}
function createInventoryInsightsService(database) {
  let running, timer, lastStarted = 0;
  const refresh = () => {
    if (running) return running;
    lastStarted = Date.now();
    return running = Promise.all([database('MONGODB_URI_FLWUP', 'insights'), database('MONGODB_URI_BOORAN', 'insights')])
      .then(([crm, inventory]) => refreshInventoryInsights(crm, inventory)).finally(() => { running = null; });
  };
  return { refresh, schedule() {
    if (timer) return;
    // Coalesce busy showroom writes; never rescan the fleet on every HTTP request.
    timer = setTimeout(() => { timer = null; void refresh().catch(() => console.warn('Inventory insights refresh unavailable.')); }, Math.max(5000, 5 * 60000 - (Date.now() - lastStarted)));
    timer.unref?.();
  } };
}
async function decorateVehicleEngagement(vehicles, scopedCrm) {
  if (!vehicles.length) return vehicles;
  const leads = await scopedCrm.collection('leads').find({ merged_into: { $exists: false }, status: { $in: ['new_lead', 'following_up', 'returned'] },
    'sms_campaign.active': { $ne: false }, 'engagement_assessment.linkedVehicles': { $in: vehicles.map(vehicle => String(vehicle._id)) } },
    { projection: { 'engagement_assessment.linkedVehicles': 1, 'engagement_assessment.state': 1 } }).toArray();
  return vehicles.map(vehicle => {
    const linked = leads.filter(lead => lead.engagement_assessment?.linkedVehicles.includes(String(vehicle._id)));
    return { ...holdingCost(vehicle), engagementSummary: { activeProspects: linked.length,
      buying: linked.filter(lead => lead.engagement_assessment.state === 'buying').length,
      losing: linked.filter(lead => lead.engagement_assessment.state === 'losing').length,
      neutral: linked.filter(lead => lead.engagement_assessment.state === 'neutral').length } };
  });
}
module.exports = { HOLDING_POLICY, paidSource, vehicleIndex, resolveVehicle, holdingCost, inventoryAdvisory, refreshInventoryInsights, createInventoryInsightsService, decorateVehicleEngagement };
