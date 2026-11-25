const { number, sum, rate, round, key, inRange, dayKey, dayDistance } = require('./common');

function salesEvents({ leads, deals, feedSales, vehicles }, now = new Date()) {
  const byLead = new Map(leads.flatMap(lead => [String(lead._id), lead.deal_id].filter(Boolean).map(id => [String(id), lead])));
  const stock = new Map(vehicles.map(vehicle => [String(vehicle._id), vehicle]));
  const records = [];
  for (const row of deals.filter(row => row.status === 'completed')) {
    const lead = byLead.get(String(row.lead_id)), unit = stock.get(String(row.stock_key));
    records.push({ id: String(row._id), dealership: row.dealership, at: row.completed_at, leadId: lead ? String(lead._id) : row.lead_id,
      stockId: unit ? String(unit._id) : null, stockNumber: row.stockNumber || unit?.stockNumber, vin: row.vin || unit?.vin,
      make: row.make || unit?.make || lead?.vehicle_make, model: row.model || unit?.model || lead?.vehicle_model,
      category: row.category || unit?.category || 'Unknown', ownerId: row.owner_id, ownerName: row.owner_name || lead?.owner_name || 'Unassigned',
      grossCents: number(row.gross_cents), revenueCents: number(row.sale_price_cents), units: 1, origin: 'Sales Floor deal', priority: 2 });
  }
  for (const lead of leads.filter(lead => !lead.merged_into)) {
    const stages = (lead.stage_history || []).filter(event => event.to === 'sold').sort((a, b) => +new Date(b.at) - +new Date(a.at));
    const at = (lead.booran_edited_fields?.includes('sold_at') && lead.sold_at) ? lead.sold_at : (stages[0]?.at || (lead.status === 'sold' ? lead.sold_at : null));
    if (at) records.push({ id: 'lead:' + lead._id, leadId: String(lead._id), dealership: lead.dealership_name, at,
      ownerId: lead.owner_id, ownerName: lead.owner_name || 'Unassigned', make: lead.vehicle_make, model: lead.vehicle_model,
      vin: lead.vehicle_vin || lead.vin, stockNumber: lead.stock_number, category: lead.vehicle_type || 'Unknown',
      units: 1, grossCents: null, revenueCents: null, origin: 'Sold prospect', priority: 1 });
  }
  for (const row of feedSales.filter(row => row.status !== 'cancelled')) records.push({ ...row, id: String(row._id), at: row.date,
    ownerName: row.ownerName || 'Unassigned', leadId: byLead.get(String(row.leadId))?._id?.toString() || row.leadId,
    grossCents: number(row.grossCents), revenueCents: number(row.revenueCents), units: row.units || 1, origin: 'DMS feed', priority: 3 });
  // External and local records share vehicle/customer aliases. Higher fidelity
  // DMS financials win; unrelated sales without a proven common key stay distinct.
  const result = [], aliases = new Map(), leadAliases = new Map();
  for (const row of records.filter(row => Number.isFinite(+new Date(row.at)) && +new Date(row.at) <= +now).sort((a, b) => b.priority - a.priority)) {
    const prefix = key(row.dealership) + ':' + dayKey(row.at) + ':';
    const identities = [row.vin && 'vin:' + key(row.vin), row.stockNumber && 'stock:' + key(row.stockNumber)].filter(Boolean).map(id => prefix + id);
    const leadKey = row.leadId ? prefix + 'lead:' + row.leadId : null, related = leadKey ? leadAliases.get(leadKey) || [] : [];
    const matched = identities.map(id => aliases.get(id)).find(Boolean) || related.find(previous => row.priority === 1 || previous.priority !== row.priority && (!identities.length || !previous.hasVehicle));
    if (matched) {
      for (const field of ['grossCents', 'revenueCents', 'leadId', 'stockId', 'stockNumber', 'vin', 'make', 'model', 'ownerId']) if (matched.row[field] == null && row[field] != null) matched.row[field] = row[field];
      for (const id of identities) aliases.set(id, matched);
      matched.hasVehicle ||= identities.length > 0;
      if (leadKey) leadAliases.set(leadKey, [...new Set([...related, matched])]); continue;
    }
    const entry = { row, priority: row.priority, hasVehicle: identities.length > 0 };
    result.push(row); for (const id of identities) aliases.set(id, entry); if (leadKey) leadAliases.set(leadKey, [...related, entry]);
  }
  return result;
}

function salesMetrics(events, leads, settings, range) {
  const rows = events.filter(row => inRange(row.at, range.from, range.to));
  const prior = events.filter(row => inRange(row.at, range.previousFrom, range.from));
  const cohort = leads.filter(lead => !lead.merged_into && inRange(lead.source_created_at || lead.created_at || lead.createdAt, range.from, range.to));
  const converted = cohort.filter(lead => (lead.stage_history || []).some(event => event.to === 'sold' && +new Date(event.at) < +new Date(range.to)) || lead.status === 'sold' && (lead.sold_at ? +new Date(lead.sold_at) < +new Date(range.to) : range.last === range.today)).length;
  const losses = leads.filter(lead => lead.loss_review?.status === 'approved' && inRange(lead.loss_review.reviewed_at, range.from, range.to)).length;
  const grossRows = rows.filter(row => row.grossCents !== null), units = sum(rows.map(row => row.units)), priorUnits = sum(prior.map(row => row.units));
  const grossCents = grossRows.length ? sum(grossRows.map(row => row.grossCents)) : null;
  const grossUnits = sum(grossRows.map(row => row.units));
  const daysInYear = dayDistance(range.today.slice(0, 4) + '-01-01', (+range.today.slice(0, 4) + 1) + '-01-01');
  const daysInMonth = new Date(Date.UTC(+range.today.slice(0, 4), +range.today.slice(5, 7), 0)).getUTCDate();
  const configured = range.mode === 'ytd' ? settings.annualUnitsTarget : range.mode === 'mtd' ? settings.monthlyUnitsTarget : null;
  const target = number(configured), periodDays = range.mode === 'ytd' ? daysInYear : daysInMonth;
  const paceTarget = target === null ? null : target * range.days / periodDays;
  const groups = new Map(), days = new Map();
  for (const row of rows) {
    const id = row.ownerId || row.ownerName || 'Unassigned', person = groups.get(String(id)) || { id: String(id), name: row.ownerName || 'Unassigned', units: 0, grossCents: 0, grossKnown: 0 };
    person.units += row.units; if (row.grossCents !== null) { person.grossCents += row.grossCents; person.grossKnown += row.units; } groups.set(String(id), person);
    const date = dayKey(row.at), point = days.get(date) || { date, units: 0, grossCents: 0, grossKnown: 0 };
    point.units += row.units; if (row.grossCents !== null) { point.grossCents += row.grossCents; point.grossKnown++; } days.set(date, point);
  }
  const trend = []; let cumulative = 0;
  for (let i = 0; i < range.days; i++) {
    const date = require('./common').shiftDay(range.first, i), point = days.get(date) || { date, units: 0, grossCents: null, grossKnown: 0 };
    cumulative += point.units; trend.push({ ...point, grossCents: point.grossKnown ? point.grossCents : null, cumulativeUnits: cumulative, target: target === null ? null : round(target * (i + 1) / periodDays) });
  }
  const wins = new Set(rows.map(row => row.dealership + ':' + (row.leadId || row.id))).size;
  const priorGrossRows = prior.filter(row => row.grossCents !== null), previousGrossCents = priorGrossRows.length ? sum(priorGrossRows.map(row => row.grossCents)) : null;
  return { units, target, paceTarget: round(paceTarget), attainment: target === null ? null : rate(units, target), previousUnits: priorUnits,
    unitChange: priorUnits ? round((units - priorUnits) / priorUnits * 100) : null,
    grossCents, previousGrossCents, grossTargetCents: settings.grossTargetCents, grossAttainment: grossCents === null ? null : rate(grossCents, settings.grossTargetCents), financialCoverage: rate(grossUnits, units), averageGrossCents: grossUnits ? Math.round(grossCents / grossUnits) : null,
    conversion: rate(converted, cohort.length), conversionNumerator: converted, conversionDenominator: cohort.length,
    closeRatio: rate(wins, wins + losses), wins, losses, trend,
    leaderboard: [...groups.values()].map(person => ({ ...person, grossCents: person.grossKnown ? person.grossCents : null })).sort((a, b) => b.units - a.units || a.name.localeCompare(b.name)),
    signal: paceTarget === null ? 'unknown' : units >= paceTarget ? 'green' : units >= paceTarget * 0.85 ? 'amber' : 'red',
    _rows: rows };
}
module.exports = { salesEvents, salesMetrics };
