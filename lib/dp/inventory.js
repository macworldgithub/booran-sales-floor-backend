const { number, sum, rate, round, key, inRange } = require('./common');
const { holdingCost, inventoryAdvisory } = require('../inventory-insights');
function inventoryMetrics(vehicles, events, leads, settings, range, now) {
  const rows = vehicles.filter(row => !row.salesFloorHidden && !['sold', 'wholesale'].includes(key(row.status))).map(vehicle => {
    const current = holdingCost(vehicle, undefined, now), cost = number(vehicle.vehicleCost ?? vehicle.totalStockCost);
    const days = Number.isFinite(Date.parse(vehicle.dateInStock)) || number(vehicle.daysInStock) !== null ? Math.floor(current.daysInStock) : null;
    return { id: String(vehicle._id), site: vehicle.rooftopName, stockNumber: vehicle.stockNumber, vin: vehicle.vin, make: vehicle.make, model: vehicle.model,
      category: vehicle.category || 'Unknown', days, costCents: cost === null ? null : Math.round(cost * 100),
      carryingCents: days === null || current.accumulatedHoldingCost == null ? null : Math.round(current.accumulatedHoldingCost * 100),
      carryingPerDayCents: cost === null ? null : Math.round(cost * settings.annualCarryingRate / 365 * 100),
      priceCents: number(vehicle.advertisedPrice) === null ? null : Math.round(Number(vehicle.advertisedPrice) * 100),
      action: days === null ? 'Record the stock arrival date' : days > 90 ? 'Review wholesale or promotional options' : days > settings.agingWarningDays ? 'Review pricing and promotion' : inventoryAdvisory(current).actionReason };
  });
  const recent = events.filter(row => inRange(row.at, range.velocityFrom, require('../pulse').calendarDay(range.today).$lt));
  const categories = [...new Set([...rows.map(row => row.category), ...recent.map(row => row.category || 'Unknown')])].sort().map(category => {
    const stock = rows.filter(row => row.category === category), sold = sum(recent.filter(row => (row.category || 'Unknown') === category).map(row => row.units));
    const supply = sold ? round(stock.length / (sold / 30)) : null;
    return { category, units: stock.length, sold30: sold, daysSupply: supply, signal: supply === null ? 'unknown' : supply > settings.daysSupplyMax ? 'red' : supply < settings.daysSupplyMin ? 'amber' : 'green' };
  });
  const buckets = [[0, 30, '0–30'], [31, 60, '31–60'], [61, 90, '61–90'], [91, Infinity, '90+']].map(([min, max, label]) => {
    const stock = rows.filter(row => row.days !== null && row.days >= min && row.days <= max), known = stock.filter(row => row.costCents !== null);
    return { label, units: stock.length, valueCents: known.length ? sum(known.map(row => row.costCents)) : null, valuedUnits: known.length };
  });
  const unknownAge = rows.filter(row => row.days === null);
  if (unknownAge.length) buckets.push({ label: 'Unknown age', units: unknownAge.length, valueCents: unknownAge.some(row => row.costCents !== null) ? sum(unknownAge.map(row => row.costCents)) : null, valuedUnits: unknownAge.filter(row => row.costCents !== null).length });
  const models = new Map();
  for (const row of rows) { const id = key(row.make) + ':' + key(row.model); const model = models.get(id) || { name: [row.make, row.model].filter(Boolean).join(' ') || 'Unknown', stock: 0, enquiries: 0, sold30: 0 }; model.stock++; models.set(id, model); }
  for (const lead of leads.filter(row => !row.merged_into && ['new_lead', 'following_up', 'returned'].includes(row.status) && (row.source_active ?? row.sms_campaign?.active) !== false && inRange(row.source_created_at || row.created_at || row.createdAt, range.velocityFrom, require('../pulse').calendarDay(range.today).$lt))) {
    const id = key(lead.vehicle_make) + ':' + key(lead.vehicle_model), model = models.get(id) || { name: [lead.vehicle_make, lead.vehicle_model].filter(Boolean).join(' ') || 'Unknown', stock: 0, enquiries: 0, sold30: 0 }; model.enquiries++; models.set(id, model);
  }
  for (const sale of recent) { const id = key(sale.make) + ':' + key(sale.model), model = models.get(id) || { name: [sale.make, sale.model].filter(Boolean).join(' ') || 'Unknown', stock: 0, enquiries: 0, sold30: 0 }; model.sold30 += sale.units; models.set(id, model); }
  const known = rows.filter(row => row.costCents !== null), carrying = rows.filter(row => row.carryingCents !== null), sold30 = sum(recent.map(row => row.units));
  return { units: rows.length, valueCents: known.length ? sum(known.map(row => row.costCents)) : null, valueCoverage: rate(known.length, rows.length),
    carryingCents: carrying.length ? sum(carrying.map(row => row.carryingCents)) : null, carryingCoverage: rate(carrying.length, rows.length),
    daysSupply: sold30 ? round(rows.length / (sold30 / 30)) : null,
    annualizedTurnProxy: rows.length ? round(sold30 / 30 * 365 / rows.length) : null,
    turnBasis: 'Annualized 30-day unit sales divided by current stock; a velocity proxy, not audited average-inventory turnover.',
    buckets, categories, hotModels: [...models.values()].filter(row => row.enquiries >= 3 && row.enquiries > row.stock * 2 || row.sold30 > 0 && row.stock < row.sold30 / 30 * settings.daysSupplyMin).sort((a, b) => b.enquiries - a.enquiries || a.stock - b.stock).slice(0, 20),
    aging: rows.filter(row => row.days !== null && row.days > settings.agingWarningDays).sort((a, b) => b.days - a.days).slice(0, 30), _rows: rows };
}
module.exports = { inventoryMetrics };
