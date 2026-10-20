const { randomUUID } = require('node:crypto');
const { normalisePhone, formatToPlus61 } = require('./phone');

function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function string(value, field, { required = false, max = 200 } = {}) {
  if (value === undefined) { if (required) invalid(`${field} is required.`); return ''; }
  if (typeof value !== 'string' || value.trim().length > max) invalid(`${field} must be text (up to ${max} characters).`);
  const result = value.trim();
  if (required && !result) invalid(`${field} is required.`);
  return result;
}
function oneOf(value, field, choices) {
  if (!choices.includes(value)) invalid(`Invalid ${field}.`);
  return value;
}
function dealership(value) {
  const result = string(value, 'Dealership', { required: true });
  if (['all', 'all locations', 'south morang'].includes(result.toLowerCase())) invalid('Select a specific dealership.');
  return result;
}
const leadStatuses = ['new_lead', 'following_up', 'sold', 'lost', 'returned'];
function email(value) {
  const result = string(value, 'Email', { max: 254 });
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) invalid('Enter a valid email address.');
  return result;
}
const safeText = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
const dateText = (value) => value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : '') : safeText(value);
function serializeLead(lead) {
  const name = safeText(lead.customer_name, 'Anonymous Prospect');
  const make = safeText(lead.vehicle_make);
  const model = safeText(lead.vehicle_model);
  const owner = safeText(lead.owner_name, 'Unassigned');
  const site = safeText(lead.dealership_name, 'Unspecified dealership');
  return {
    _id: String(lead._id), id: String(lead._id), deal_id: lead.deal_id,
    name, customer_name: name, initials: name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
    phone: safeText(lead.customer_phone), customer_phone: safeText(lead.customer_phone),
    email: safeText(lead.customer_email), customer_email: safeText(lead.customer_email),
    vehicle: [make, model].filter(Boolean).join(' ') || 'Unspecified Vehicle',
    make, model, vehicle_make: make, vehicle_model: model,
    status: safeText(lead.status, 'new_lead'), dealership: site, dealership_name: site,
    dealer_code: lead.dealer_code, owner_name: owner, assignedTo: owner,
    source: safeText(lead.source, 'Manual'), notes: safeText(lead.notes),
    created_at: lead.created_at || lead.createdAt, first_contact_at: lead.first_contact_at,
    minutes_to_first_contact: lead.minutes_to_first_contact, first_followup_due_at: lead.first_followup_due_at,
    had_contact_opportunity: lead.had_contact_opportunity, follow_ups_sent: lead.follow_ups_sent || 0,
    priority: lead.status === 'new_lead' || Number(lead.minutes_to_first_contact) > 60,
    testDrive: Object.hasOwn(lead, 'test_drive') ? lead.test_drive : lead.testDrive,
    tradeIn: Object.hasOwn(lead, 'trade_in') ? lead.trade_in : lead.tradeIn,
    diary_entries: Array.isArray(lead.diary_entries) ? lead.diary_entries.filter((entry) => entry && typeof entry.note === 'string').map((entry) => ({ author: safeText(entry.author, 'Sales Floor'), note: entry.note, date: dateText(entry.date) })) : [],
    post_sales_followup: lead.post_sales_followup,
  };
}
function createLead(body, user) {
  const now = new Date();
  const notes = string(body.notes, 'Notes', { max: 5000 });
  const rawPhone = body.phone ?? body.customer_phone;
  let formattedPhone = '';
  if (rawPhone && typeof rawPhone === 'string' && rawPhone.trim()) {
    try {
      formattedPhone = normalisePhone(rawPhone);
    } catch {
      formattedPhone = formatToPlus61(rawPhone);
    }
  }
  return {
    deal_id: `BOORAN-${randomUUID()}`, dealership_name: dealership(body.dealership_name || body.dealership), dealer_code: 'BOORAN',
    owner_name: string(body.owner_name, 'Consultant') || user.name,
    source: string(body.source, 'Source') || 'Walk-in Showroom',
    customer_name: string(body.name ?? body.customer_name, 'Customer name', { required: true }),
    customer_phone: formattedPhone, customer_email: email(body.email ?? body.customer_email),
    vehicle_make: string(body.vehicle_make, 'Make'), vehicle_model: string(body.vehicle_model ?? body.vehicle, 'Model'),
    status: oneOf(body.status ?? 'new_lead', 'lead status', leadStatuses),
    had_contact_opportunity: true, follow_ups_sent: 0, created_at: now.toISOString(), createdAt: now, updatedAt: now,
    diary_entries: notes ? [{ author: user.name, date: now.toISOString(), note: notes }] : [],
  };
}
function nested(value, field, schema) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${field}.`);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!schema[key]) invalid(`Invalid ${field} field.`);
    if (schema[key] === 'nullableDate') {
      if (item !== null && (typeof item !== 'string' || !Number.isFinite(Date.parse(item)))) invalid(`Invalid ${field} ${key}.`);
      result[key] = item;
    } else if (schema[key] === 'string') result[key] = string(item, `${field} ${key}`);
    else if (typeof item !== schema[key] || (typeof item === 'number' && (!Number.isFinite(item) || item < 0))) invalid(`Invalid ${field} ${key}.`);
    else result[key] = item;
  }
  return result;
}
function leadUpdate(body, user) {
  const fields = {};
  for (const key of ['owner_name', 'customer_name', 'customer_phone', 'vehicle_make', 'vehicle_model', 'notes']) {
    if (key in body) fields[key] = string(body[key], key, { required: key === 'customer_name', max: key === 'notes' ? 5000 : 200 });
  }
  if (fields.customer_phone) fields.customer_phone = normalisePhone(fields.customer_phone);
  if ('status' in body) fields.status = oneOf(body.status, 'lead status', leadStatuses);
  if ('assignedTo' in body) fields.owner_name = string(body.assignedTo, 'Consultant', { required: true });
  if ('dealership_name' in body) fields.dealership_name = dealership(body.dealership_name);
  if ('customer_email' in body) fields.customer_email = email(body.customer_email);
  if ('testDrive' in body) fields.test_drive = nested(body.testDrive, 'test drive', { testDriveDate: 'nullableDate', location: 'string', status: 'string', confirmed: 'boolean' });
  if ('tradeIn' in body) fields.trade_in = nested(body.tradeIn, 'trade in', { make: 'string', model: 'string', year: 'number', rego: 'string', estimatedValue: 'number' });
  const note = 'newNote' in body ? string(body.newNote, 'Note', { required: true, max: 5000 }) : '';
  if (!Object.keys(fields).length && !note) invalid('No supported changes were provided.');
  const update = { $set: { ...fields, updatedAt: new Date() } };
  if (note) update.$push = { diary_entries: { author: user.name, date: new Date().toISOString(), note } };
  return update;
}
function actionUpdate(body, user) {
  const status = oneOf(body.status, 'action status', ['open', 'in_progress', 'resolved']);
  const fields = { status, resolvedNotes: string(body.resolvedNotes, 'Resolution notes', { max: 5000 }), updatedAt: new Date() };
  if (status === 'resolved') return { $set: { ...fields, resolvedAt: new Date().toISOString(), resolvedBy: user.name } };
  return { $set: fields, $unset: { resolvedAt: '', resolvedBy: '' } };
}
function dateBoundary(value) {
  const input = string(value, 'Appointment date', { required: true });
  const match = /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(input);
  const date = new Date(input);
  const day = match && new Date(`${match[1]}T00:00:00Z`);
  if (!match || !Number.isFinite(date.getTime()) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1] || !/^\d{4}-/.test(date.toISOString())) invalid('Invalid appointment date range.');
  return date.toISOString();
}
function appointmentInput(body) {
  const when = string(body.when, 'Appointment time', { required: true });
  const date = new Date(when);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(when) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== when.slice(0, 19)) invalid('Enter a valid appointment time.');
  const duration = body.duration ?? 45;
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) invalid('Duration must be 5 to 480 minutes.');
  return {
    leadId: string(body.leadId, 'Lead ID'), prospectName: string(body.prospectName, 'Customer name', { required: true }),
    consultantName: string(body.consultantName, 'Consultant'), vehicle: string(body.vehicle, 'Vehicle'),
    type: oneOf(body.type ?? 'Test Drive', 'appointment type', ['Test Drive', 'Showroom Visit', 'Delivery Handover', 'Callback']),
    when: date.toISOString(), duration, notes: string(body.notes, 'Notes', { max: 2000 }), status: 'Booked', createdAt: new Date().toISOString(),
  };
}
module.exports = { invalid, string, dealership, serializeLead, createLead, leadUpdate, actionUpdate, appointmentInput, dateBoundary };
