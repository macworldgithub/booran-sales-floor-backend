const { string } = require('../records');
const { calendarDay } = require('../pulse');
const { fail } = require('../workflow-route');
const { defaultSettings, dayKey, number } = require('./common');
const { SERVICE_FIELDS } = require('./service');
const MODULES = Object.freeze([{ id: 'sales', title: 'Sales performance' }, { id: 'inventory', title: 'Inventory issues & opportunities' }, { id: 'benchmark', title: 'Multi-site benchmarking' }, { id: 'service', title: 'Service matrix' }]);
const CUSTOM_METRICS = ['units', 'grossCents', 'averageGrossCents', 'conversion', 'closeRatio', 'stockUnits', 'stockValueCents', 'daysSupply', 'csi', 'technicianEfficiency', 'retention', 'serviceRevenueCents'];
function finite(value, label, min = 0, max = 1000000000000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(400, `Enter a valid ${label}.`);
  return value;
}
function settingsInput(input, previous = defaultSettings()) {
  const allowed = ['monthlyUnitsTarget', 'annualUnitsTarget', 'grossTargetCents', 'conversionTarget', 'daysSupplyMin', 'daysSupplyMax', 'agingWarningDays', 'annualCarryingRate', 'serviceTargets', 'widgets', 'customKpis', 'revision'];
  if (Object.keys(input).some(field => !allowed.includes(field))) fail(400, 'An unsupported dashboard setting was provided.');
  const result = { ...defaultSettings(), ...previous };
  for (const field of allowed.filter(field => !['revision', 'serviceTargets', 'widgets', 'customKpis'].includes(field))) if (Object.hasOwn(input, field)) {
    result[field] = input[field] === null && ['monthlyUnitsTarget', 'annualUnitsTarget', 'grossTargetCents'].includes(field) ? null : finite(input[field], field, 0, field === 'annualCarryingRate' ? 1 : field === 'conversionTarget' ? 100 : 1000000000000);
    if (['monthlyUnitsTarget', 'annualUnitsTarget', 'grossTargetCents', 'daysSupplyMin', 'daysSupplyMax', 'agingWarningDays'].includes(field) && result[field] !== null && !Number.isSafeInteger(result[field])) fail(400, 'Targets and day limits must be whole numbers.');
  }
  if (result.daysSupplyMin > result.daysSupplyMax) fail(400, 'Minimum days supply cannot exceed the maximum.');
  if (input.serviceTargets !== undefined) {
    if (!input.serviceTargets || Array.isArray(input.serviceTargets) || Object.keys(input.serviceTargets).some(field => !Object.hasOwn(defaultSettings().serviceTargets, field))) fail(400, 'Choose supported service targets.');
    result.serviceTargets = { ...result.serviceTargets, ...Object.fromEntries(Object.entries(input.serviceTargets).map(([field, value]) => [field, finite(value, field, 0, ['csi', 'retention'].includes(field) ? 100 : 1000)])) };
  }
  if (input.widgets !== undefined) {
    if (!Array.isArray(input.widgets) || !input.widgets.length || input.widgets.some(id => !MODULES.some(module => module.id === id))) fail(400, 'Choose supported dashboard modules.');
    result.widgets = [...new Set(input.widgets)];
  }
  if (input.customKpis !== undefined) {
    if (!Array.isArray(input.customKpis) || input.customKpis.length > 12) fail(400, 'Configure up to twelve custom KPIs.');
    result.customKpis = input.customKpis.map(row => {
      if (!row || !CUSTOM_METRICS.includes(row.metric) || !['above', 'below'].includes(row.direction)) fail(400, 'Choose a supported KPI metric and direction.');
      return { title: string(row.title, 'KPI title', { required: true, max: 80 }), metric: row.metric, direction: row.direction, target: finite(row.target, 'KPI target', -1000000000000) };
    });
  }
  return result;
}
function serviceInput(input, now = new Date()) {
  const date = string(input.date, 'Service date', { required: true }); calendarDay(date);
  if (date > dayKey(now)) fail(400, 'Service observations cannot be dated in the future.');
  const department = string(input.department, 'Department', { required: true, max: 60 });
  const fields = {};
  for (const field of SERVICE_FIELDS) fields[field] = input[field] == null || input[field] === '' ? null : finite(input[field], field);
  if (SERVICE_FIELDS.every(field => fields[field] === null)) fail(400, 'Record at least one service measurement.');
  for (const [numerator, denominator] of [['csiPoints', 'csiResponses'], ['productiveHours', 'availableHours'], ['repairHours', 'repairs'], ['retainedCustomers', 'eligibleCustomers'], ['claimCycleHours', 'claimCycleSamples']]) {
    if ((fields[numerator] === null) !== (fields[denominator] === null)) fail(400, `Record both ${numerator} and ${denominator}.`);
    if (fields[denominator] === 0 && fields[numerator] !== 0 && fields[numerator] !== null) fail(400, 'A measurement with no sample cannot have a positive total.');
  }
  if (fields.csiPoints > fields.csiResponses * 100 || fields.retainedCustomers > fields.eligibleCustomers) fail(400, 'CSI and retention totals exceed the recorded sample.');
  for (const field of ['csiResponses', 'claimsOpened', 'claimsClosed', 'claimCycleSamples', 'repairs', 'revenueCents', 'retainedCustomers', 'eligibleCustomers']) if (fields[field] !== null && !Number.isSafeInteger(fields[field])) fail(400, `${field} must be a whole number.`);
  return { date, department, ...fields };
}
module.exports = { MODULES, CUSTOM_METRICS, finite, settingsInput, serviceInput };
