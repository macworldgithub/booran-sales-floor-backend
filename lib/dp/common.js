const { dayKey, shiftDay, dayDistance } = require('../followup-policy');
const { calendarDay } = require('../pulse');
const { fail } = require('../workflow-route');
const { createHash } = require('node:crypto');
const number = value => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const sum = values => values.reduce((total, value) => total + (number(value) ?? 0), 0);
const mean = values => { const known = values.map(number).filter(value => value !== null); return known.length ? sum(known) / known.length : null; };
const rate = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : null;
const round = value => value === null ? null : Math.round(value * 100) / 100;
const key = value => String(value || '').trim().toLowerCase();
const hash = value => createHash('sha256').update(value).digest('hex');
const inRange = (value, from, to) => value && +new Date(value) >= +new Date(from) && +new Date(value) < +new Date(to);
function windowFor(query, now = new Date()) {
  const today = dayKey(now), mode = ['mtd', 'ytd', 'custom'].includes(query.period) ? query.period : 'mtd';
  const start = mode === 'ytd' ? today.slice(0, 4) + '-01-01' : today.slice(0, 7) + '-01';
  const first = mode === 'custom' ? query.from : start, last = mode === 'custom' ? query.to : today;
  const from = calendarDay(first).$gte, to = calendarDay(last).$lt;
  const days = dayDistance(first, last) + 1;
  if (days < 1 || days > 366 || last > today) fail(400, 'Choose a date range of 1–366 days ending no later than today.');
  const previousFrom = calendarDay(shiftDay(first, -days)).$gte;
  const velocityFrom = calendarDay(shiftDay(today, -29)).$gte;
  const serviceFrom = calendarDay(shiftDay(today.slice(0, 7) + '-01', -185)).$gte;
  return { mode, first, last, from, to, days, previousFrom, velocityFrom, serviceFrom, today, timezone: 'Australia/Melbourne' };
}
const defaultSettings = () => ({ monthlyUnitsTarget: null, annualUnitsTarget: null, grossTargetCents: null, conversionTarget: 20,
  daysSupplyMin: 45, daysSupplyMax: 60, agingWarningDays: 60, annualCarryingRate: 0.075,
  serviceTargets: { csi: 90, technicianEfficiency: 85, repairHours: 3, retention: 70, claimCycleDays: 5 },
  widgets: ['sales', 'inventory', 'benchmark', 'service'], customKpis: [] });
module.exports = { number, sum, mean, rate, round, key, hash, inRange, windowFor, defaultSettings, dayKey, shiftDay, dayDistance };
