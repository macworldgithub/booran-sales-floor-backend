const { sum, rate, round, inRange, dayKey, key } = require('./common');
const SERVICE_FIELDS = ['csiPoints', 'csiResponses', 'claimsOpened', 'claimsClosed', 'claimCycleHours', 'claimCycleSamples', 'productiveHours', 'availableHours', 'repairHours', 'repairs', 'revenueCents', 'retainedCustomers', 'eligibleCustomers'];
function serviceMetrics(rows, bookings, targets, range) {
  const selected = rows.filter(row => inRange(row.date, range.from, range.to));
  const aggregate = values => {
    const total = field => values.some(row => row[field] != null) ? sum(values.map(row => row[field])) : null;
    const csiResponses = total('csiResponses'), available = total('availableHours'), repairs = total('repairs'), eligible = total('eligibleCustomers'), samples = total('claimCycleSamples');
    return { csi: csiResponses ? round(total('csiPoints') / csiResponses) : null, csiResponses: csiResponses || 0,
      claimsOpened: total('claimsOpened'), claimsClosed: total('claimsClosed'), claimCycleDays: samples ? round(total('claimCycleHours') / samples / 24) : null,
      technicianEfficiency: available ? rate(total('productiveHours'), available) : null,
      averageRepairHours: repairs ? round(total('repairHours') / repairs) : null,
      revenueCents: total('revenueCents'), retention: eligible ? rate(total('retainedCustomers'), eligible) : null,
      retentionEligible: eligible || 0, repairs: repairs || 0, records: values.length };
  };
  const health = metrics => {
    const rules = [['csi', 'csi', false], ['technicianEfficiency', 'technicianEfficiency', false], ['averageRepairHours', 'repairHours', true], ['retention', 'retention', false], ['claimCycleDays', 'claimCycleDays', true]];
    const signals = Object.fromEntries(rules.map(([metric, target, lower]) => [metric, metrics[metric] == null ? 'unknown' : (lower ? metrics[metric] <= targets[target] : metrics[metric] >= targets[target]) ? 'green' : 'red']));
    return { signals, health: Object.values(signals).includes('red') ? 'red' : Object.values(signals).includes('unknown') ? 'unknown' : 'green' };
  };
  const totals = aggregate(selected);
  const departments = [...new Set(['Service', 'Warranty', 'Quick Lane', 'Body Shop', ...selected.map(row => row.department)])].map(department => {
    const values = aggregate(selected.filter(row => row.department === department));
    return { department, ...values, ...health(values) };
  });
  const months = [...new Set(rows.map(row => String(row.date).slice(0, 7)))].sort().slice(-6);
  return { ...totals, ...health(totals), targets,
    bookings: bookings.filter(row => key(row.status) !== 'cancelled' && inRange(row.starts_at, range.from, range.to)).length,
    departments, trend: months.map(month => ({ month, ...aggregate(rows.filter(row => String(row.date).startsWith(month))) })),
    source: 'Sales Floor service records and service bookings', updatedAt: selected.map(row => row.updatedAt).filter(Boolean).sort().at(-1) || null,
    _rows: selected.map(row => ({ id: String(row._id), site: row.dealership, date: dayKey(row.date), department: row.department, ...Object.fromEntries(SERVICE_FIELDS.map(field => [field, row[field] ?? null])) })) };
}
module.exports = { SERVICE_FIELDS, serviceMetrics };
