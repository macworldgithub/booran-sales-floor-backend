const { parse } = require('csv-parse/sync');
const { SITE } = require('./virtualyard-source');
const { fail } = require('./workflow-route');
const { phoneKey, formatToPlus61 } = require('./phone');

const MAX_ROWS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;
const HEADERS = {
  lead: ['Prospect', 'Vehicle', 'Forms', 'Tags', 'Status'],
  test_drive: ['Id', 'Details', 'Lead', 'Tags', 'Status'],
};
const LEAD = /^(.*?)\s+(\d{1,15})\s+Source\s+(.*?)\s+Assigned To\s+(.*?)\s+Date\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+Stage\s+(.*?)\s+Last Contact\s+(.*)$/s;
const PREVIEW = /(?<=\s)(?:Enquiry (?:Type:|from\b)|Proposal #|Customer (?:has|accepted|requested|declined|is looking)\b|VIN:|Fleet Order\b|Postcode:|Order (?:Number #|#|\()|Finance Application via:|Test Drive (?:Booking|Completed|for|Location|Confirmed|Request)\b|(?:Online|Web) (?:Enquiry|Order|Lead)\b|Trade.in (?:Enquiry|Request|Details)\b|New (?:Walk in|TradingPost)|(?:Message|Email|Subject):|Hi\b|Hello\b|Good (?:Morning|Afternoon)|Dear\b|I(?:\s|['’])|(?:Interested|Looking|Would like|Please)\b|Planning to buy\b|Is (?:this|there)\b|Trade in\.{3}$|Price\.{3}$|We have\b|Contract signed for\b|have a vehicle to trade\b|请用)/gi;
const DRIVE = /^(.+?)\s+(?=Email\b|Phone\b|Type\b)(?:Email\s*(.*?)\s*(?=Phone\b|Type\b))?(?:Phone\s*(.*?)\s*(?=Type\b))?Type\s+Test Drive\s+Location\s+(?:BYD South Morang|South Morang BYD)(?=\s|$)(?:\s+(.*))?$/is;
const DRIVE_STATUS = /^(Confirmed|Pending|In-Progress|Finished|Missed|Cancelled)\s+(?:(\d{4})\/(\d{2})\/(\d{2}) (\d{1,2}):(\d{2}) ([AP]M)|unixtime\[(\d+)\])$/i;
const TO_STATUS = { confirmed: 'Confirmed', pending: 'Booked', 'in-progress': 'Booked', finished: 'Completed', missed: 'No Show', cancelled: 'Cancelled' };
const AU = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Australia/Melbourne', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' });

function melbourneTime(wall) {
  const base = Date.parse(wall.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(base)) return null;
  const matches = [10, 11].map(offset => new Date(base - offset * 3600000)).filter(date => AU.format(date) === wall);
  return matches.length === 1 ? matches[0].toISOString() : null;
}

function nameLooksValid(name) {
  return name.length > 0 && name.length <= 180 && /\p{L}/u.test(name) &&
    (name.split(/\s+/).length <= 12 || /\b(?:pty ltd|trustee|trust)\b/i.test(name)) &&
    !/(?:\b(?:enquiry type|postcode|proposal|marked as|has been|would like|please|thank you)\b|@|https?:\/\/)/i.test(name);
}

function leadName(value) {
  if (value.endsWith(' ...') && nameLooksValid(value.slice(0, -4))) return [value.slice(0, -4).trim(), ''];
  for (const match of value.matchAll(PREVIEW)) {
    const name = value.slice(0, match.index).trim();
    const notes = value.slice(match.index).trim();
    if (notes.replace(/\.{3}$/, '').trimEnd().length <= 60 && nameLooksValid(name)) return [name, notes];
  }
  const phoneOnly = /^(\+?\d+)\s+(Order Number #.*)$/is.exec(value);
  if (phoneOnly && phoneKey(phoneOnly[1])) return ['Anonymous Prospect', phoneOnly[2], formatToPlus61(phoneOnly[1])];
  if (value.endsWith('...') && /\s/.test(value.at(-64) || '')) {
    const name = value.slice(0, -64).trim();
    if (nameLooksValid(name)) return [name, value.slice(-63)];
  }
  return ['', value];
}

function leadFields(fields) {
  const match = LEAD.exec(fields.Prospect.trim());
  if (!match) return { error: 'Missing lead ID or dated prospect details.' };
  const [, flattened, id, channel, assignee, date, stage, lastContact] = match;
  const location = /\bLocation:\s*([^]*?)$/i.exec(flattened);
  if (location && !/^(?:BYD South Moran(?:g)?|South Morang BYD)(?=\W|$)/i.test(location[1])) {
    return { id, error: 'Enquiry location is outside BYD South Morang.' };
  }
  const when = melbourneTime(date);
  if (!when) return { id, error: 'Lead date is invalid or ambiguous in Melbourne time.' };
  const [name, notes, phone = ''] = leadName(flattened);
  const vehicle = fields.Vehicle.trim();
  const car = vehicle.split(/\s+Yard:/i, 1)[0].trim().slice(0, 200);
  const stock = /(?:^|\s)Stock#\s+(\S+)/i.exec(vehicle)?.[1] || '';
  const yard = /\bYard:\s*(.*?)\s*(?=Stock#|Price|$)/is.exec(vehicle)?.[1] || '';
  const price = /\bPrice\s*:?\s*(\$[\d,.]+)/i.exec(vehicle)?.[1] || '';
  const model = /^(?:(\d{4})\s+)?(?:\S+\s+)?\bBYD\s+(.+)$/i.exec(car);
  const rawStatus = fields.Status.trim();
  const status = /^(?:LOST|CANCELLED|ORDER-CANCELLED)$/i.test(rawStatus) ? 'lost'
    : /^complete$/i.test(stage) ? 'completed' : /^new$/i.test(stage) ? 'new_lead' : 'following_up';
  return { id, name, notes, phone, when, status, rawStatus, stage, channel, assignee, lastContact, car, stock, yard, price,
    make: model ? 'BYD' : '', model: model?.[2] || car };
}

function driveFields(fields) {
  const id = fields.Id.trim();
  if (!/^\d{1,15}$/.test(id)) return { error: 'Missing or invalid test-drive ID.' };
  const details = DRIVE.exec(fields.Details.trim());
  if (!details) return { id, error: 'Missing customer details or an unverified test-drive location.' };
  const [, name, email = '', phone = '', vehicle = ''] = details;
  if (!name.trim() || name.trim().length > 180) return { id, error: 'Missing or invalid customer name.' };
  const match = DRIVE_STATUS.exec(fields.Status.trim());
  if (!match) return { id, error: 'Unknown test-drive status or time.' };
  const [, rawStatus, year, month, day, hour, minute, meridiem, epoch] = match;
  const time = epoch && Number(epoch) >= Date.UTC(2000, 0, 1) && Number(epoch) < Date.UTC(2100, 0, 1) ? new Date(Number(epoch)).toISOString()
    : !epoch && +hour >= 1 && +hour <= 12 && +minute < 60
      ? melbourneTime(`${year}-${month}-${day} ${String((+hour % 12) + (meridiem.toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0')}:${minute}:00`) : null;
  if (!time) return { id, error: 'Test-drive time is missing, invalid or ambiguous.' };
  const car = vehicle.split(/\s+(?:Stock#|Reg#|RWC\b|Rego Expiry\b)/i, 1)[0].trim().slice(0, 200);
  const legacyCar = vehicle.split(/\s+(?:RWC\b|Rego Expiry\b)/i, 1)[0].trim();
  const stock = /(?:^|\s)Stock#\s+(\S+)/i.exec(vehicle)?.[1] || '';
  return { id, name: name.trim(), email: email.trim(), phone: phone.trim(), when: time, status: TO_STATUS[rawStatus.toLowerCase()], rawStatus,
    rawDate: epoch ? `unixtime[${epoch}]` : fields.Status.trim().slice(rawStatus.length).trim(), car, legacyCar, stock };
}

function readVirtualyardCsv(body) {
  if (!Buffer.isBuffer(body) || !body.length) fail(400, 'Choose a Virtual Yard CSV file.');
  if (body.length > MAX_BYTES) fail(413, 'Each CSV file must be 2 MB or less.');
  let records;
  try {
    const csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body).replace(/^[\r\n]*\uFEFF?/, '');
    records = parse(csv, { skip_empty_lines: true, max_record_size: 20000 });
  } catch { fail(400, 'The file must be a valid UTF-8 CSV with the original Virtual Yard columns.'); }
  const [header, ...rows] = records;
  const type = Object.keys(HEADERS).find(key => header?.length === HEADERS[key].length && HEADERS[key].every((field, i) => field === header[i]));
  if (!type) fail(400, 'Choose a Virtual Yard Leads or Test Drives CSV export.');
  if (!rows.length || rows.length > MAX_ROWS) fail(400, `The CSV must contain between 1 and ${MAX_ROWS.toLocaleString('en-AU')} rows.`);
  return { type, rows: rows.map((values, i) => ({ row: i + 2, fields: Object.fromEntries(header.map((name, j) => [name, values[j]])) })) };
}

function exportTime(file) {
  const match = /(?:^|[-_])(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})(?:\s*\(\d+\))?\.csv$/i.exec(file);
  return match ? melbourneTime(`${match[1]} ${match[2]}:${match[3]}:${match[4]}`) : null;
}

module.exports = { SITE, MAX_BYTES, readVirtualyardCsv, leadFields, driveFields, exportTime };
