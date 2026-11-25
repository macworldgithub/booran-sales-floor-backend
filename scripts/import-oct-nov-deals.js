const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { phoneKey } = require('../lib/phone');
const { saleDateIso } = require('../lib/records');
const { businessId } = require('../lib/prospects');
const { withLeadState } = require('../lib/lead-state');

const SITE = 'South Morang Hyundai';
const CSV_PATH = path.join(__dirname, 'data', 'oct_nov_2026_deals.csv');

const deterministicId = (seed) => new ObjectId(createHash('sha256').update(seed).digest('hex').slice(0, 24));
const linkHashId = (seed) => createHash('sha256').update(seed).digest('hex').slice(0, 24);

const STAFF_ALIASES = {
  'kris libreri': 'Kris Liberi',
  'fleet (ac) manager': 'Anthony C',
  'anthony calderone': 'Anthony C',
};

const COMPANY_SUFFIX_RE = /\b(pty|ltd|inc|llc|corp|group|trust|services|solutions|dept|department|housing|trading|maintance|maintenance|enterprise|enterprises|cleaning|painting)\b/i;

function parseCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map((line, idx) => {
    const cols = line.split(',');
    const raw = Object.fromEntries(headers.map((h, i) => [h, (cols[i] || '').trim()]));
    return normalizeRow(raw, idx + 2);
  });
}

function cleanNamePart(part) {
  const s = String(part || '').trim();
  if (!s || s === '.') return '';
  return s.replace(/^\.+/, '').trim();
}

function parseDayIso(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const datePart = trimmed.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  return saleDateIso(datePart, 'CSV date');
}

function normPhoneDisplay(raw) {
  const k = phoneKey(raw);
  if (k) return `+${k}`;
  const clean = String(raw || '').trim();
  return clean || '';
}

function normalizeRow(raw, lineNumber) {
  const rawCompany = String(raw['Company'] || '').trim();
  const first = cleanNamePart(raw['First Name']);
  const last = cleanNamePart(raw['Last Name']);
  const personName = [first, last].filter(Boolean).join(' ').trim();

  // Ignore single-letter stray artifact like "B"
  const cleanCompany = rawCompany.length > 1 ? rawCompany : '';
  const hasPerson = Boolean(personName);
  const companyIsBusiness = Boolean(cleanCompany && (hasPerson || COMPANY_SUFFIX_RE.test(cleanCompany)));

  let customerName = personName;
  if (!customerName && cleanCompany) customerName = cleanCompany;
  else if (cleanCompany && personName.toLowerCase() === cleanCompany.toLowerCase()) customerName = cleanCompany;

  const emails = [...new Set(
    String(raw['Email Address'] || '')
      .split(';')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  )];

  const phone = normPhoneDisplay(raw['Mobile Number']);
  const pKey = phoneKey(raw['Mobile Number']);
  const year = /^\d{4}$/.test(raw['Year']) ? Number(raw['Year']) : null;
  const make = String(raw['Make'] || '').trim();
  let model = String(raw['Model'] || '').trim();
  if (make && model.toLowerCase().startsWith(make.toLowerCase() + ' ')) {
    model = model.slice(make.length).trim();
  }

  return {
    lineNumber,
    company: companyIsBusiness ? cleanCompany : '',
    customerName: customerName || cleanCompany || 'Unknown Customer',
    phone,
    phoneKey: pKey,
    emails,
    primaryEmail: emails[0] || '',
    alternateEmails: emails.slice(1),
    assignToRaw: String(raw['Assign to'] || '').trim(),
    dealNumber: String(raw['Deal Number'] || '').trim().toUpperCase(),
    year,
    make,
    model,
    soldAt: parseDayIso(raw['Purchase Date']),
    deliveredAt: parseDayIso(raw['Delivered Date']),
  };
}

function buildStaffResolver(users) {
  const byName = new Map();
  for (const u of users) {
    if (!u?.name) continue;
    byName.set(u.name.trim().toLowerCase(), { id: String(u._id), name: u.name.trim() });
  }
  return (assignToRaw) => {
    const key = String(assignToRaw || '').trim().toLowerCase();
    if (!key) return { ownerId: null, ownerName: 'Unassigned' };
    const aliased = STAFF_ALIASES[key];
    if (aliased && byName.has(aliased.toLowerCase())) {
      const hit = byName.get(aliased.toLowerCase());
      return { ownerId: hit.id, ownerName: hit.name };
    }
    if (byName.has(key)) {
      const hit = byName.get(key);
      return { ownerId: hit.id, ownerName: hit.name };
    }
    return { ownerId: null, ownerName: assignToRaw.trim() };
  };
}

function groupRowsByCustomer(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.company
      ? `company:${row.company.toLowerCase()}`
      : row.phoneKey
        ? `phone:${row.phoneKey}`
        : row.primaryEmail
          ? `email:${row.primaryEmail}`
          : `name:${row.customerName.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(list => {
    list.sort((a, b) => (Date.parse(b.soldAt || 0) || 0) - (Date.parse(a.soldAt || 0) || 0) || b.dealNumber.localeCompare(a.dealNumber));
    return list;
  });
}

function scoreMatchedLead(lead, groupDealNumbers) {
  if (lead.deal_number && groupDealNumbers.includes(String(lead.deal_number).toUpperCase())) return 1000;
  const statusScores = { sold: 500, following_up: 300, returned: 250, new_lead: 200, lost: 100 };
  const base = statusScores[lead.status] || 50;
  const ts = Date.parse(lead.sold_at || lead.last_activity_at || lead.created_at || 0) || 0;
  return base + ts / 1e14;
}

async function runImport(db, { apply = false, csvText = fs.readFileSync(CSV_PATH, 'utf8') } = {}) {
  const rows = parseCsv(csvText);
  const users = await db.collection('users').find({ active: true }).toArray();
  const resolveStaff = buildStaffResolver(users);

  const siteRx = { $regex: '^South Morang Hyundai$', $options: 'i' };
  const existingLeads = await db.collection('leads').find({ dealership_name: siteRx, merged_into: { $exists: false } }).toArray();

  const byDealNo = new Map();
  const byPhone = new Map();
  const byEmail = new Map();
  const byName = new Map();

  const indexLead = (l) => {
    if (l.deal_number) byDealNo.set(String(l.deal_number).trim().toUpperCase(), l);
    for (const p of [l.customer_phone, ...(l.alternate_phones || [])]) {
      const k = phoneKey(p);
      if (k) (byPhone.get(k) || byPhone.set(k, []).get(k)).push(l);
    }
    for (const e of [l.customer_email, ...(l.alternate_emails || [])]) {
      const k = String(e || '').trim().toLowerCase();
      if (k) (byEmail.get(k) || byEmail.set(k, []).get(k)).push(l);
    }
    for (const n of [l.customer_name, l.business_name]) {
      const k = String(n || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (k) (byName.get(k) || byName.set(k, []).get(k)).push(l);
    }
  };
  for (const l of existingLeads) indexLead(l);

  const groups = groupRowsByCustomer(rows);
  const now = new Date();
  const nowIso = now.toISOString();

  const stats = {
    totalCsvRows: rows.length,
    customerGroups: groups.length,
    leadsMatched: 0,
    leadsCreated: 0,
    leadsUpdated: 0,
    dealsUpserted: 0,
    businessesLinked: 0,
    newlyAssignedCount: 0,
    unmatchedExamples: [],
  };

  for (const group of groups) {
    const latest = group[0];
    const dealNumbers = group.map(r => r.dealNumber).filter(Boolean);
    const allEmails = [...new Set(group.flatMap(r => r.emails))];
    const allPhones = [...new Set(group.map(r => r.phone).filter(Boolean))];
    const candidates = new Map();

    for (const dn of dealNumbers) if (byDealNo.has(dn)) candidates.set(String(byDealNo.get(dn)._id), byDealNo.get(dn));
    for (const r of group) {
      if (r.phoneKey && byPhone.has(r.phoneKey)) byPhone.get(r.phoneKey).forEach(l => candidates.set(String(l._id), l));
      for (const em of r.emails) if (byEmail.has(em)) byEmail.get(em).forEach(l => candidates.set(String(l._id), l));
    }
    if (!candidates.size) {
      for (const n of [latest.customerName, latest.company]) {
        const k = String(n || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (k && byName.has(k)) byName.get(k).forEach(l => candidates.set(String(l._id), l));
      }
    }

    const staff = resolveStaff(latest.assignToRaw);
    const bizName = group.find(r => r.company)?.company || '';
    const bizId = bizName ? businessId(SITE, bizName) : null;
    let targetLead = null;

    if (candidates.size > 0) {
      const sorted = [...candidates.values()].sort((a, b) => scoreMatchedLead(b, dealNumbers) - scoreMatchedLead(a, dealNumbers));
      targetLead = sorted[0];
      stats.leadsMatched++;

      const currentPhoneKey = phoneKey(targetLead.customer_phone);
      const nextPrimaryPhone = targetLead.customer_phone || allPhones[0] || '';
      const nextPrimaryPhoneKey = phoneKey(nextPrimaryPhone);
      const altPhones = [...new Set([
        ...(targetLead.alternate_phones || []),
        ...allPhones,
      ].map(normPhoneDisplay).filter(p => p && (nextPrimaryPhoneKey ? phoneKey(p) !== nextPrimaryPhoneKey : p !== nextPrimaryPhone)))];

      const currentEmail = String(targetLead.customer_email || '').trim().toLowerCase();
      const nextPrimaryEmail = currentEmail || allEmails[0] || '';
      const altEmails = [...new Set([
        ...(targetLead.alternate_emails || []),
        ...allEmails,
      ].map(e => String(e || '').trim().toLowerCase()).filter(e => e && e !== nextPrimaryEmail))];

      const leadUnassigned = !targetLead.owner_id && (!targetLead.owner_name || String(targetLead.owner_name).trim().toLowerCase() === 'unassigned');
      const needsOwnerIdBackfill = !targetLead.owner_id && staff.ownerId && targetLead.owner_name && targetLead.owner_name.toLowerCase() === staff.ownerName.toLowerCase();

      const setFields = {
        status: 'sold',
        sold_at: latest.soldAt,
        delivery_date: latest.deliveredAt,
        deal_number: latest.dealNumber,
        updatedAt: now,
        last_activity_at: targetLead.last_activity_at || latest.soldAt,
      };
      if (!targetLead.customer_phone && nextPrimaryPhone) setFields.customer_phone = nextPrimaryPhone;
      if (!currentEmail && nextPrimaryEmail) setFields.customer_email = nextPrimaryEmail;
      if (altPhones.length) setFields.alternate_phones = altPhones;
      if (altEmails.length) setFields.alternate_emails = altEmails;
      if (!targetLead.vehicle_make && latest.make) setFields.vehicle_make = latest.make;
      if (!targetLead.vehicle_model && latest.model) setFields.vehicle_model = latest.model;
      if (bizName && !targetLead.business_name) {
        setFields.business_name = bizName;
        setFields.business_id = bizId;
      }
      if (leadUnassigned || needsOwnerIdBackfill) {
        setFields.owner_id = staff.ownerId;
        setFields.owner_name = staff.ownerName;
        if (leadUnassigned) stats.newlyAssignedCount++;
      }

      const stageHistory = Array.isArray(targetLead.stage_history) ? [...targetLead.stage_history] : [];
      if (targetLead.status !== 'sold') {
        stageHistory.push({ from: targetLead.status || 'unknown', to: 'sold', at: latest.soldAt, by: 'oct_nov_2026_deals_script' });
        setFields.stage_history = stageHistory;
      } else if (stageHistory.some(e => e.to === 'sold')) {
        setFields.stage_history = stageHistory.map(e => e.to === 'sold' ? { ...e, at: latest.soldAt } : e);
      }

      stats.leadsUpdated++;
      if (apply) {
        await db.collection('leads').findOneAndUpdate(
          { _id: targetLead._id },
          {
            $set: setFields,
            $addToSet: { booran_edited_fields: { $each: ['sold_at', 'delivery_date', 'deal_number', 'status'] } },
          },
        );
      }
    } else {
      const seed = `octnov2026:${SITE}:${latest.company || latest.phoneKey || latest.primaryEmail || latest.dealNumber}`;
      const newLeadId = deterministicId(seed);
      const nextPrimaryEmail = allEmails[0] || '';
      const altEmails = allEmails.filter(e => e !== nextPrimaryEmail);
      const nextPrimaryPhone = allPhones[0] || '';
      const altPhones = allPhones.slice(1);

      const newLead = {
        _id: newLeadId,
        deal_id: `BOORAN-IMPORT-${latest.dealNumber}`,
        dealership_name: SITE,
        dealer_code: 'BOORAN',
        customer_name: latest.customerName,
        customer_phone: nextPrimaryPhone,
        ...(altPhones.length ? { alternate_phones: altPhones } : {}),
        customer_email: nextPrimaryEmail,
        ...(altEmails.length ? { alternate_emails: altEmails } : {}),
        business_name: bizName,
        business_id: bizId,
        vehicle_make: latest.make,
        vehicle_model: latest.model,
        vehicle_year: latest.year,
        status: 'sold',
        sold_at: latest.soldAt,
        delivery_date: latest.deliveredAt,
        deal_number: latest.dealNumber,
        owner_id: staff.ownerId,
        owner_name: staff.ownerName,
        source: 'DMS / Deal Import',
        had_contact_opportunity: true,
        follow_ups_sent: 0,
        created_at: latest.soldAt,
        createdAt: new Date(latest.soldAt),
        updatedAt: now,
        last_activity_at: latest.soldAt,
        booran_edited_fields: ['sold_at', 'delivery_date', 'deal_number', 'status'],
        stage_history: [{ from: 'new_lead', to: 'sold', at: latest.soldAt, by: 'oct_nov_2026_deals_script' }],
        diary_entries: [{
          author: 'Sales Floor Import',
          date: nowIso,
          note: `Imported sold record from Oct–Nov 2026 deal list (${dealNumbers.join(', ')}).`,
        }],
      };

      targetLead = newLead;
      stats.leadsCreated++;
      stats.unmatchedExamples.push({ deal: latest.dealNumber, name: latest.customerName, company: bizName, assign: staff.ownerName });

      if (apply) {
        const { _id: _omit, ...leadInsert } = newLead;
        await db.collection('leads').findOneAndUpdate(
          { _id: newLeadId },
          { $setOnInsert: leadInsert },
          { upsert: true },
        );
      }
      indexLead(targetLead);
    }

    // Link Business Entity if company present
    if (bizName && bizId) {
      stats.businessesLinked++;
      if (apply) {
        await db.collection('businesses').findOneAndUpdate(
          { _id: bizId, dealership: siteRx },
          {
            $set: { name: bizName, dealership: SITE, updatedAt: nowIso },
            $setOnInsert: { abn: '', industry: '', createdAt: nowIso, createdBy: 'oct_nov_2026_deals_script' },
          },
          { upsert: true },
        );
        const lKey = linkHashId(`${SITE}:${targetLead._id}:${bizId}`);
        await db.collection('customer_businesses').findOneAndUpdate(
          { _id: lKey },
          {
            $set: { dealership: SITE, lead_id: String(targetLead._id), business_id: bizId, updatedAt: nowIso },
            $setOnInsert: { role: 'Contact', is_primary: true, createdAt: nowIso, createdBy: 'oct_nov_2026_deals_script' },
          },
          { upsert: true },
        );
      }
    }

    // Upsert each individual deal in the deals collection so multi-vehicle/fleet customers show all deals in History & DP
    for (const row of group) {
      const dealStaff = resolveStaff(row.assignToRaw);
      const dealId = deterministicId(`deal:${SITE}:${row.dealNumber}`);
      stats.dealsUpserted++;
      if (apply) {
        await db.collection('deals').findOneAndUpdate(
          { _id: dealId },
          {
            $set: {
              dealership: SITE,
              lead_id: String(targetLead._id),
              deal_number: row.dealNumber,
              status: 'completed',
              make: row.make,
              model: row.model,
              year: row.year,
              completed_at: row.soldAt,
              delivery_date: row.deliveredAt,
              owner_id: dealStaff.ownerId,
              owner_name: dealStaff.ownerName,
              business_name: bizName || '',
              business_id: bizId || null,
              source: 'oct_nov_2026_import',
              updatedAt: nowIso,
            },
            $setOnInsert: {
              createdAt: row.soldAt || nowIso,
              created_by: 'oct_nov_2026_deals_script',
            },
          },
          { upsert: true },
        );
      }
    }
  }

  return stats;
}

async function main() {
  require('dotenv').config();
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI_FLWUP;
  if (!uri) throw new Error('MONGODB_URI_FLWUP is required');

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = withLeadState(client.db());
    const stats = await runImport(db, { apply });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', ...stats }, null, 2));
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseCsv, normalizeRow, groupRowsByCustomer, runImport };
