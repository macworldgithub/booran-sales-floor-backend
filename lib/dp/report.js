const { isManager, canAccessSite } = require('../roles');
const { locationCondition, isAllLocations, LOCATION_GROUPS } = require('../query');
const { fail } = require('../workflow-route');
const { windowFor, defaultSettings, key, sum, number, inRange, dayKey, shiftDay } = require('./common');
const { salesEvents, salesMetrics } = require('./sales');
const { inventoryMetrics } = require('./inventory');
const { serviceMetrics } = require('./service');
const { inventoryTurn } = require('./snapshots');
const { MODULES } = require('./validation');
const cache = new Map(), inflight = new Map();
const limits = { leads: 50000, deals: 50000, vehicles: 50000, dp_sales_events: 50000, dp_service_entries: 25000, service_bookings: 50000, dp_inventory_snapshots: 25000 };
async function bounded(db, collection, query, projection) {
  const rows = await db.collection(collection).find(query, { projection }).limit(limits[collection] + 1).toArray();
  if (rows.length > limits[collection]) fail(413, 'This report exceeds the reporting limit. Select a smaller site or reporting period.');
  return rows;
}
const visible = data => { const { _rows, ...publicData } = data; return publicData; };
async function buildReport(req, crm, inventory, now = new Date()) {
  if (!isManager(req.user)) fail(403, 'Dealer Principal reporting requires a management account.');
  const range = windowFor(req.query, now), db = await crm(req), stockDb = await inventory(req);
  const earliest = [range.previousFrom, range.velocityFrom, range.serviceFrom].sort()[0];
  const unfilteredReq = { ...req, query: { ...req.query, rooftop: 'All Locations' } };
  const [allCrm, allStock] = await Promise.all([crm(unfilteredReq), inventory(unfilteredReq)]);
  const [leads, deals, vehicles, feedSales, serviceRows, bookings, settings, crmSites, stockSites, snapshots] = await Promise.all([
    bounded(db, 'leads', { merged_into: { $exists: false }, $or: [{ created_at: { $gte: earliest } }, { created_at: { $gte: new Date(earliest) } }, { source_created_at: { $gte: earliest } }, { createdAt: { $gte: new Date(earliest) } },
      { 'stage_history.at': { $gte: earliest } }, { sold_at: { $gte: earliest } }, { 'loss_review.reviewed_at': { $gte: earliest } },
      { status: { $in: ['new_lead', 'following_up', 'returned'] } }] }, { _id: 1, deal_id: 1, dealership_name: 1, created_at: 1, createdAt: 1, source_created_at: 1,
      status: 1, stage_history: 1, sold_at: 1, loss_review: 1, owner_id: 1, owner_name: 1, vehicle_make: 1, vehicle_model: 1, vehicle_vin: 1, vehicle_type: 1, stock_number: 1, 'sms_campaign.active': 1, source_active: 1 }),
    bounded(db, 'deals', { $or: [{ status: 'completed', completed_at: { $gte: earliest } }, { status: 'registered' }] }, { _id: 1, lead_id: 1, dealership: 1, status: 1, completed_at: 1, owner_id: 1, owner_name: 1, stock_key: 1, stockNumber: 1, vin: 1, make: 1, model: 1, category: 1, gross_cents: 1, sale_price_cents: 1 }),
    bounded(stockDb, 'vehicles', { salesFloorHidden: { $ne: true } }, { _id: 1, rooftopName: 1, status: 1, stockNumber: 1, vin: 1, make: 1, model: 1, category: 1, dateInStock: 1, daysInStock: 1, vehicleCost: 1, totalStockCost: 1, advertisedPrice: 1, holdingCostBreakdown: 1, availableOnlineAt: 1, stockExitedAt: 1 }),
    bounded(db, 'dp_sales_events', { date: { $gte: earliest } }),
    bounded(db, 'dp_service_entries', { date: { $gte: dayKey(earliest), $lte: range.last } }),
    bounded(db, 'service_bookings', { starts_at: { $gte: earliest } }, { _id: 1, dealership: 1, status: 1, starts_at: 1 }),
    db.collection('dp_settings').find({}).limit(500).toArray(),
    allCrm.collection('rooftops').find({}, { projection: { name: 1 } }).limit(500).toArray(),
    allStock.collection('rooftops').find({}, { projection: { name: 1 } }).limit(500).toArray(),
    bounded(db, 'dp_inventory_snapshots', { date: { $gte: dayKey(range.velocityFrom), $lte: range.today } }),
  ]);
  const availableSites = [...new Map([...crmSites, ...stockSites].map(row => row.name).filter(name => typeof name === 'string' && !Object.hasOwn(LOCATION_GROUPS, key(name)) && canAccessSite(req.user, name)).map(name => [key(name), name.trim()])).values()].sort();
  const dataSites = [...leads.map(row => row.dealership_name), ...deals.map(row => row.dealership), ...vehicles.map(row => row.rooftopName), ...serviceRows.map(row => row.dealership), ...feedSales.map(row => row.dealership)];
  for (const name of dataSites) if (name && canAccessSite(req.user, name) && !availableSites.some(site => key(site) === key(name))) availableSites.push(name);
  availableSites.sort();
  const condition = !isAllLocations(req.query.rooftop) && locationCondition(req.query.rooftop);
  const matcher = condition && new RegExp(condition.$regex, condition.$options);
  const sites = availableSites.filter(site => !matcher || matcher.test(site));
  if (condition && !sites.length) fail(403, 'This dealership is unavailable in your reporting scope.');
  const siteKeys = new Set(sites.map(key));
  const filter = (rows, field) => rows.filter(row => siteKeys.has(key(row[field])));
  const input = { leads: filter(leads, 'dealership_name'), deals: filter(deals, 'dealership'), vehicles: filter(vehicles, 'rooftopName'), feedSales: filter(feedSales, 'dealership') };
  const completedStocks = new Set(input.deals.filter(row => row.status === 'completed').map(row => String(row.stock_key)));
  input.vehicles = input.vehicles.map(row => completedStocks.has(String(row._id)) ? { ...row, status: 'Sold' } : row);
  const events = salesEvents(input, now), settingsBySite = new Map(settings.map(row => [key(row.dealership), { ...defaultSettings(), ...row }]));
  const siteSettings = site => settingsBySite.get(key(site)) || defaultSettings();
  const groupSettings = { ...defaultSettings(), ...(['monthlyUnitsTarget', 'annualUnitsTarget', 'grossTargetCents'].reduce((result, field) => {
    const values = sites.map(site => siteSettings(site)[field]); result[field] = values.length && values.every(value => number(value) !== null) ? sum(values) : null; return result;
  }, {})) };
  const config = sites.length === 1 ? siteSettings(sites[0]) : groupSettings;
  const sales = salesMetrics(events, input.leads, config, range);
  const stock = inventoryMetrics(input.vehicles, events, input.leads, config, range, now);
  Object.assign(stock, inventoryTurn(snapshots, sites, range.today, sum(events.filter(row => inRange(row.at, range.velocityFrom, require('../pulse').calendarDay(range.today).$lt)).map(row => row.units))));
  const service = serviceMetrics(filter(serviceRows, 'dealership'), filter(bookings, 'dealership'), config.serviceTargets, range);
  const benchmarks = sites.map(site => {
    const localEvents = events.filter(row => key(row.dealership) === key(site)), localLeads = input.leads.filter(row => key(row.dealership_name) === key(site));
    const localSales = salesMetrics(localEvents, localLeads, siteSettings(site), range);
    const localStock = inventoryMetrics(input.vehicles.filter(row => key(row.rooftopName) === key(site)), localEvents, localLeads, siteSettings(site), range, now);
    Object.assign(localStock, inventoryTurn(snapshots, [site], range.today, sum(localEvents.filter(row => inRange(row.at, range.velocityFrom, require('../pulse').calendarDay(range.today).$lt)).map(row => row.units))));
    const localService = serviceMetrics(serviceRows.filter(row => key(row.dealership) === key(site)), bookings.filter(row => key(row.dealership) === key(site)), siteSettings(site).serviceTargets, range);
    return { site, units: localSales.units, target: localSales.target, attainment: localSales.attainment, grossCents: localSales.grossCents, financialCoverage: localSales.financialCoverage,
      conversion: localSales.conversion, stockUnits: localStock.units, stockValueCents: localStock.valueCents, daysSupply: localStock.daysSupply, turnProxy: localStock.annualizedTurnProxy, inventoryTurn: localStock.annualizedTurn,
      csi: localService.csi, serviceRevenueCents: localService.revenueCents, signal: localSales.signal };
  });
  const alerts = [];
  if (sales.signal === 'red' || sales.signal === 'amber') alerts.push({ id: 'sales-pace', module: 'sales', tone: sales.signal, title: 'Sales behind target pace', detail: `${sales.units} sold against ${sales.paceTarget} expected by this date.` });
  if (sales.conversion !== null && sales.conversion < config.conversionTarget) alerts.push({ id: 'conversion', module: 'sales', tone: 'amber', title: 'Conversion below target', detail: `${sales.conversion}% against ${config.conversionTarget}% target. Review the enquiry cohort.` });
  if (config.grossTargetCents > 0 && sales.financialCoverage === 100 && sales.grossCents < config.grossTargetCents) alerts.push({ id: 'gross-target', module: 'sales', tone: 'amber', title: 'Gross profit below period target', detail: 'Recorded gross profit is below the configured reporting-period target.' });
  if (stock.aging.length) alerts.push({ id: 'aged-stock', module: 'inventory', tone: 'red', title: 'Aging stock needs review', detail: `${stock._rows.filter(row => row.days > config.agingWarningDays).length} units exceed ${config.agingWarningDays} days.` });
  if (stock.hotModels.length) alerts.push({ id: 'hot-models', module: 'inventory', tone: 'green', title: 'Demand and supply opportunities', detail: `${stock.hotModels.length} models have high enquiry demand or low supply against sales velocity.` });
  if (service.health === 'red') alerts.push({ id: 'service-targets', module: 'service', tone: 'red', title: 'Service KPIs need attention', detail: 'One or more recorded service KPIs are below their configured target.' });
  const metricValues = { units: sales.units, grossCents: sales.grossCents, averageGrossCents: sales.averageGrossCents, conversion: sales.conversion, closeRatio: sales.closeRatio,
    stockUnits: stock.units, stockValueCents: stock.valueCents, daysSupply: stock.daysSupply, csi: service.csi, technicianEfficiency: service.technicianEfficiency, retention: service.retention, serviceRevenueCents: service.revenueCents };
  const customKpis = config.customKpis.map(kpi => ({ ...kpi, value: metricValues[kpi.metric] ?? null, signal: metricValues[kpi.metric] == null ? 'unknown' : (kpi.direction === 'above' ? metricValues[kpi.metric] >= kpi.target : metricValues[kpi.metric] <= kpi.target) ? 'green' : 'red' }));
  return { computedAt: now.toISOString(), timezone: range.timezone, range, availableSites, sites, settings: config, settingsRevision: config.revision || 0,
    modules: MODULES, sales: visible(sales), inventory: visible(stock), service: visible(service), benchmarks, alerts, customKpis,
    sources: [{ name: 'Sales Floor CRM', state: 'connected', detail: 'Live CRM outcomes and completed deals' }, { name: 'Sales Floor inventory', state: 'connected', detail: 'Current stock and the existing stock feed' },
      { name: 'Sales Floor service', state: service.records ? 'connected' : 'awaiting-data', detail: service.records ? 'Recorded departmental measurements' : 'Enter service measurements to populate CSI, revenue and efficiency.' },
      { name: 'DMS sales feed', state: process.env.DP_DMS_FEED_URL ? 'configured' : 'optional', detail: 'Optional additional sales source; existing Sales Floor data is used immediately.' }],
    definitions: { sales: 'Completed deals, DMS sales and directly marked Sold CRM outcomes are reconciled by site, date and vehicle/customer reference. Unknown gross remains unavailable; financial coverage is shown.',
      conversion: 'Sold enquiries / enquiries first received in this reporting period. Close ratio is unique won customer/opportunity outcomes / (won outcomes + approved losses).',
      inventory: 'Inventory is current, independent of the sales reporting period. Days supply uses the latest 30 Melbourne calendar days. Annualized unit turnover uses 30 daily observed stock balances; unavailable until all 30 exist. Current-stock velocity is a separate proxy.',
      service: 'CSI, efficiency, repairs and retention use weighted totals and sample counts from Sales Floor service entries. Missing observations are unavailable, not zero. Group targets use common defaults; individual sites use their saved targets.',
      comparisons: 'Sales variance compares an equally long immediately preceding period. Site comparisons include only sites authorised for the signed-in manager.' },
    _rows: { sales: sales._rows, inventory: stock._rows, service: service._rows } };
}
async function loadReport(req, crm, inventory) {
  if (!isManager(req.user)) fail(403, 'Dealer Principal reporting requires a management account.');
  const id = JSON.stringify([req.user.id, req.user.role, req.user.site, req.user.allowedSites, req.query]);
  if (cache.get(id)?.until > Date.now()) return cache.get(id).data;
  if (inflight.has(id)) return inflight.get(id);
  const operation = buildReport(req, crm, inventory).then(data => { if (cache.size > 20) cache.clear(); cache.set(id, { data, until: Date.now() + 5000 }); return data; }).finally(() => inflight.delete(id));
  inflight.set(id, operation); return operation;
}
module.exports = { buildReport, loadReport, cache };
