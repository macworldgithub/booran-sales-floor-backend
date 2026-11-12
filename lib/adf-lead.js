const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { normalisePhone, formatToPlus61 } = require('./phone');

const MAX_XML_SIZE = 100000;
const values = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const text = value => String(value && typeof value === 'object' ? value['#text'] ?? '' : value ?? '').trim();
const review = reason => { throw Object.assign(new Error(reason), { emailReview: true }); };
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
  removeNSPrefix: true, ignoreDeclaration: true, ignorePiTags: true, maxNestedTags: 30 });

function adfDocument(message) {
  const body = String(message.text || '').trim().replace(/^\uFEFF/, '');
  if (/<(?:[\w.-]+:)?adf\b/i.test(body) || /^<\?xml\b/i.test(body)) return body;
  const attachment = values(message.attachments).find(item =>
    /\.xml$/i.test(item.filename || '') || /^(?:application|text)\/xml\b/i.test(item.contentType || ''));
  if (!attachment) return null;
  const content = Buffer.isBuffer(attachment.content) ? attachment.content.toString('utf8') : String(attachment.content || '');
  if (content.length > MAX_XML_SIZE) review('The XML lead exceeds the 100 KB parsing limit. Review the original email.');
  return content.trim().replace(/^\uFEFF/, '');
}

function parseAdfLead(message) {
  const xml = adfDocument(message);
  if (xml === null) return null;
  if (xml.length > MAX_XML_SIZE) review('The XML lead exceeds the 100 KB parsing limit. Review the original email.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) review('XML declarations with custom entities are not accepted. Review the original email.');
  if (XMLValidator.validate(xml) !== true) review('The ADF XML is malformed. Review the original email.');
  let document;
  try { document = parser.parse(xml); } catch { review('The ADF XML could not be parsed. Review the original email.'); }
  if (!document?.adf || Object.keys(document).some(key => key !== 'adf')) review('Expected a single ADF XML document.');
  const prospects = values(document.adf.prospect);
  if (prospects.length !== 1) review('Expected one customer prospect per ADF email. Review the original email.');
  const prospect = prospects[0];
  const vendor = text(prospect.vendor?.vendorname);
  if (vendor.toLowerCase().replace(/\s+/g, ' ') !== 'south morang hyundai') review('This XML lead names a different or missing dealership.');
  const requestDate = text(prospect.requestdate);
  if (!requestDate || !Number.isFinite(Date.parse(requestDate))) review('The XML lead has no valid request date.');
  const vehicles = values(prospect.vehicle);
  const vehicle = vehicles.find(item => item['@_interest'] !== 'trade-in') || vehicles[0];
  if (!vehicle || !text(vehicle.year) || !text(vehicle.make) || !text(vehicle.model)) review('The XML lead is missing vehicle year, make or model.');
  const contacts = values(prospect.customer?.contact);
  const contact = contacts.find(item => item['@_primarycontact'] === '1') || contacts[0];
  const names = values(contact?.name);
  const full = names.find(item => item['@_part'] === 'full');
  const name = (text(full) || ['first', 'middle', 'last'].map(part => text(names.find(item => item['@_part'] === part))).filter(Boolean).join(' ') ||
    names.map(text).filter(Boolean).join(' ')).slice(0, 200);
  const phones = values(contact?.phone).sort((a, b) => Number(b?.['@_type'] === 'cellphone') - Number(a?.['@_type'] === 'cellphone'));
  let phone = '';
  for (const candidate of phones) {
    const raw = text(candidate), digits = raw.replace(/[\s().-]/g, '');
    try { phone = normalisePhone(raw); } catch {
      // A landline-only enquiry is still a valid lead for allocation; SMS
      // sending separately requires an Australian mobile.
      if (/^(?:0[2378]\d{8}|61[2378]\d{8}|\+[1-9]\d{7,14})$/.test(digits)) phone = formatToPlus61(digits);
    }
    if (phone) break;
  }
  const email = values(contact?.email).map(text).find(value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) || '';
  if (!name || (!phone && !email)) review('The XML lead needs a customer name and a valid phone or email.');
  const ids = values(prospect.id);
  const identifier = ids.find(item => text(item) && item['@_source']) || ids.find(item => text(item));
  const provider = prospect.provider || {};
  const providerName = values(provider.name).map(text).filter(Boolean).join(' ');
  const adf = { id: text(identifier).slice(0, 500), id_source: text(identifier?.['@_source']).slice(0, 200),
    request_date: new Date(requestDate).toISOString(), prospect_status: text(prospect['@_status']).slice(0, 50), vendor,
    provider: providerName.slice(0, 200), service: text(provider.service).slice(0, 200), url: text(provider.url).slice(0, 1000),
    vehicle_status: text(vehicle['@_status']).slice(0, 50), interest: text(vehicle['@_interest']).slice(0, 100),
    year: text(vehicle.year).slice(0, 10), vin: text(vehicle.vin).slice(0, 100), stock: text(vehicle.stock).slice(0, 100),
    comments: text(prospect.customer?.comments).slice(0, 5000),
  };
  return { name, phone, email, vehicle_make: text(vehicle.make).slice(0, 200), vehicle_model: text(vehicle.model).slice(0, 200),
    vehicle_year: /^\d{4}$/.test(adf.year) ? Number(adf.year) : undefined, adf,
    notes: [`Website enquiry: ${adf.service || adf.interest || 'Vehicle enquiry'}`, `Vehicle: ${adf.year} ${text(vehicle.make)} ${text(vehicle.model)}`,
      adf.id && `Website lead reference: ${adf.id}`, adf.comments].filter(Boolean).join('\n') };
}

module.exports = { parseAdfLead, MAX_XML_SIZE };
