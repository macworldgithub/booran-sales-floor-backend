const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { parseAdfLead } = require('../lib/adf-lead');
const { emailLead } = require('../lib/inbound-lead-email');
const xml = readFileSync(path.join(__dirname, 'fixtures/hyundai-website-lead.xml'), 'utf8');
const message = text => ({ messageId: '<adf-fixture@example.test>', subject: 'XML New Lead', text });

test('the supplied Dealer Studio ADF example extracts contact, vehicle, timezone and enquiry details', () => {
  const lead = emailLead('new', message(xml));
  assert.equal(lead.customer_name, 'Test User');
  assert.equal(lead.customer_phone, '+61412345678');
  assert.equal(lead.customer_email, 'test@example.com');
  assert.equal(lead.vehicle_make, 'Hyundai'); assert.equal(lead.vehicle_model, 'Kona'); assert.equal(lead.vehicle_year, 2026);
  assert.equal(lead.created_at, '2026-11-12T06:43:00.000Z');
  assert.equal(lead.owner_id, null); assert.equal(lead.status, 'new_lead'); assert.equal(lead.dealership_name, 'South Morang Hyundai');
  assert.equal(lead.inbound_email.adf.service, 'Test Drive Booking');
  assert.equal(lead.inbound_email.adf.interest, 'test-drive');
  assert.match(lead.diary_entries[0].note, /Preferred time 9:15am/);
});

test('XML attachments, email-only customers and New/Used inbox routing preserve lead identity on resend', () => {
  const incoming = { ...message('See lead.xml.'), attachments: [{ filename: 'lead.xml', content: Buffer.from(xml) }] };
  const first = emailLead('used', incoming);
  const second = emailLead('new', { ...message(xml.replace('status="new"', 'status="resend"')), messageId: '<different@example.test>' });
  assert.equal(String(first._id), String(second._id));
  assert.equal(first.inbound_email.category, 'used'); assert.equal(first.inbound_email.adf.vehicle_status, 'new');
  const emailOnly = emailLead('new', message(xml.replace('<phone type="cellphone">0412345678</phone>', '')));
  assert.equal(emailOnly.customer_phone, ''); assert.equal(emailOnly.customer_email, 'test@example.com');
  assert.equal(parseAdfLead(message('Customer Name: Legacy\nMobile: 0412345678')), null);
});

test('ADF preserves leading zeroes, Unicode, CDATA and escaped names while preferring a mobile', () => {
  const escaped = xml.replace('Test</name>', 'Renée &amp; Co</name>').replace('User</name>', 'O&apos;Brien</name>')
    .replace('<phone type="cellphone">', '<phone type="voice">03 8432 3000</phone><phone type="cellphone">')
    .replace('Interested in test drive for Kona. Preferred time 9:15am.', '<![CDATA[Ask about <Kona> & test drive.]]>');
  const result = parseAdfLead(message(escaped));
  assert.equal(result.name, "Renée & Co O'Brien"); assert.equal(result.phone, '+61412345678');
  assert.match(result.notes, /Ask about <Kona> & test drive/);
});

test('malformed, unsafe, misrouted and incomplete XML is flagged for review instead of creating blank customers', () => {
  for (const invalid of [xml.replace('</customer>', ''), '<!DOCTYPE adf [<!ENTITY external SYSTEM "file:///etc/passwd">]>' + xml,
    xml.replace('South Morang Hyundai</vendorname>', 'Another Dealer</vendorname>'), xml.replace('<model>Kona</model>', ''),
    xml.replace('2026-11-12T17:43:00+11:00', 'not-a-date'), xml.replace('<customer>', '<customer-disabled>').replace('</customer>', '</customer-disabled>'),
    xml.replace('</adf>', '<prospect/></adf>'), xml.replace('Kona</model>', 'K'.repeat(100001) + '</model>')]) {
    assert.throws(() => emailLead('new', message(invalid)), error => error.emailReview === true);
  }
});
