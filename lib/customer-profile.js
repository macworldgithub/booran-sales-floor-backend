const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { string, email: cleanEmail, serializeLead, createLead } = require('./records');
const { isManager, canAccessSite } = require('./roles');
const { reference } = require('./lead-allocation');
const { route, fail } = require('./workflow-route');
const { createUniqueLead, duplicateError, siteMatch } = require('./lead-identity');
const { escapeRegex } = require('./query');
const { normalisePhone, phoneKey, formatToPlus61 } = require('./phone');
const { dayKey } = require('./dp/common');
const { businessId } = require('./prospects');

const ALLOWED_ROLES_WRITE = (user) => isManager(user) || user?.role === 'sales_consultant';
const linkKey = (site, leadId, bizId) => createHash('sha256').update(JSON.stringify([site.toLowerCase(), String(leadId), String(bizId)])).digest('hex').slice(0, 24);
const safeStr = (value, max = 200) => (value == null ? '' : string(String(value), 'Field', { max }));

function businessFields(body = {}, requiredName = false) {
  const name = string(body.name, 'Business name', { required: requiredName, max: 160 });
  const abn = body.abn !== undefined ? string(body.abn, 'ABN', { max: 32 }) : undefined;
  const industry = body.industry !== undefined ? string(body.industry, 'Industry / type', { max: 160 }) : undefined;
  const phone = body.phone !== undefined ? string(body.phone, 'Business phone', { max: 40 }) : undefined;
  const email = body.email !== undefined ? cleanEmail(body.email) : undefined;
  const address = body.address !== undefined ? string(body.address, 'Business address', { max: 300 }) : undefined;
  const notes = body.notes !== undefined ? string(body.notes, 'Business notes', { max: 2000 }) : undefined;
  const out = {};
  if (name) out.name = name;
  if (abn !== undefined) out.abn = abn;
  if (industry !== undefined) out.industry = industry;
  if (phone !== undefined) out.phone = phone;
  if (email !== undefined) out.email = email;
  if (address !== undefined) out.address = address;
  if (notes !== undefined) out.notes = notes;
  return out;
}

async function resolveLeadAccess(req, database) {
  const db = await database(req);
  const raw = await database();
  const lead = await db.collection('leads').findOne(reference(req.params.id));
  if (!lead) fail(404, 'Customer not found.');
  return { db, raw, lead, leadId: String(lead._id), site: lead.dealership_name };
}

async function collectCustomerBusinesses(raw, lead) {
  const leadId = String(lead._id);
  const site = lead.dealership_name;
  const links = await raw.collection('customer_businesses').find({ dealership: siteMatch(site), lead_id: leadId }).toArray();
  const legacyBizId = lead.business_name?.trim() ? (lead.business_id || businessId(site, lead.business_name)) : null;

  const linkByBiz = new Map();
  for (const link of links) linkByBiz.set(String(link.business_id), link);

  const bizIds = [...new Set([...linkByBiz.keys(), ...(legacyBizId ? [String(legacyBizId)] : [])])];
  const bizDocs = bizIds.length
    ? await raw.collection('businesses').find({ dealership: siteMatch(site), _id: { $in: bizIds } }).toArray()
    : [];
  const bizById = new Map(bizDocs.map(doc => [String(doc._id), doc]));

  const resolvedIds = [...bizIds];
  if (legacyBizId && !bizById.has(String(legacyBizId))) {
    bizById.set(String(legacyBizId), {
      _id: String(legacyBizId),
      dealership: site,
      name: lead.business_name.trim(),
      abn: '',
      industry: '',
      phone: '',
      email: '',
      address: '',
      notes: '',
    });
  }

  return resolvedIds
    .map(id => {
      const business = bizById.get(id);
      if (!business) return null;
      const link = linkByBiz.get(id);
      return {
        business,
        link: {
          _id: link ? String(link._id) : null,
          role: link?.role || 'Contact',
          isPrimary: link ? Boolean(link.is_primary) : (id === String(legacyBizId) && links.length === 0),
          createdAt: link?.createdAt || lead.created_at || null,
          syncedFromLead: !link,
        },
      };
    })
    .filter(Boolean);
}

async function buildBusinessPayload(raw, lead, user) {
  const leadId = String(lead._id);
  const site = lead.dealership_name;
  const entries = await collectCustomerBusinesses(raw, lead);
  const bizIds = entries.map(e => String(e.business._id));

  const [allLinks, legacyLeads] = await Promise.all([
    bizIds.length ? raw.collection('customer_businesses').find({ dealership: siteMatch(site), business_id: { $in: bizIds } }).toArray() : [],
    bizIds.length ? raw.collection('leads').find({ dealership_name: siteMatch(site), business_id: { $in: bizIds }, merged_into: { $exists: false } }).limit(200).toArray() : [],
  ]);

  const linkedLeadIds = [...new Set([
    ...allLinks.map(l => String(l.lead_id)),
    ...legacyLeads.map(l => String(l._id)),
  ])];
  const missingIds = linkedLeadIds.filter(id => !legacyLeads.some(l => String(l._id) === id) && ObjectId.isValid(id)).map(id => new ObjectId(id));
  const extraLeads = missingIds.length
    ? await raw.collection('leads').find({ dealership_name: siteMatch(site), _id: { $in: missingIds }, merged_into: { $exists: false } }).toArray()
    : [];
  const leadMap = new Map([...legacyLeads, ...extraLeads].map(l => [String(l._id), l]));

  const businesses = entries.map(({ business, link }) => {
    const bId = String(business._id);
    const peopleMap = new Map();
    for (const l of allLinks.filter(row => String(row.business_id) === bId)) {
      const person = leadMap.get(String(l.lead_id));
      if (!person) continue;
      const pid = String(person._id);
      peopleMap.set(pid, {
        leadId: pid,
        name: person.customer_name || 'Unnamed Contact',
        phone: person.customer_phone || '',
        email: person.customer_email || '',
        role: l.role || 'Contact',
        isPrimary: Boolean(l.is_primary),
        status: person.status || 'new_lead',
        vehicle: [person.vehicle_make, person.vehicle_model].filter(Boolean).join(' ') || '',
        isCurrentPerson: pid === leadId,
        canOpen: isManager(user) || person.owner_id === user.id,
      });
    }
    for (const person of legacyLeads.filter(row => String(row.business_id) === bId)) {
      const pid = String(person._id);
      if (peopleMap.has(pid)) continue;
      peopleMap.set(pid, {
        leadId: pid,
        name: person.customer_name || 'Unnamed Contact',
        phone: person.customer_phone || '',
        email: person.customer_email || '',
        role: 'Contact',
        isPrimary: false,
        status: person.status || 'new_lead',
        vehicle: [person.vehicle_make, person.vehicle_model].filter(Boolean).join(' ') || '',
        isCurrentPerson: pid === leadId,
        canOpen: isManager(user) || person.owner_id === user.id,
      });
    }
    const people = [...peopleMap.values()].sort((a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) ||
      Number(a.isCurrentPerson) - Number(b.isCurrentPerson) ||
      a.name.localeCompare(b.name)
    );
    return {
      business: {
        _id: bId,
        name: business.name,
        abn: business.abn || '',
        industry: business.industry || '',
        phone: business.phone || '',
        email: business.email || '',
        address: business.address || '',
        notes: business.notes || '',
        dealership: business.dealership || site,
      },
      link,
      people,
    };
  });

  businesses.sort((a, b) => Number(b.link.isPrimary) - Number(a.link.isPrimary) || a.business.name.localeCompare(b.business.name));
  return {
    person: {
      id: leadId,
      name: lead.customer_name || 'Customer',
      phone: lead.customer_phone || '',
      email: lead.customer_email || '',
      dealership: site,
    },
    primaryBusinessId: businesses[0]?.business._id || null,
    businesses,
  };
}

async function syncLeadBusinessSummary(raw, leadId, site) {
  const links = await raw.collection('customer_businesses').find({ dealership: siteMatch(site), lead_id: String(leadId) }).toArray();
  const chosen = links.find(l => l.is_primary) || links[0] || null;
  if (!chosen) {
    await raw.collection('leads').findOneAndUpdate(
      { _id: new ObjectId(leadId), dealership_name: siteMatch(site) },
      { $set: { business_name: '', business_id: null, updatedAt: new Date() } },
    );
    return;
  }
  const biz = await raw.collection('businesses').findOne({ _id: String(chosen.business_id), dealership: siteMatch(site) });
  if (biz) {
    await raw.collection('leads').findOneAndUpdate(
      { _id: new ObjectId(leadId), dealership_name: siteMatch(site) },
      { $set: { business_name: biz.name, business_id: String(biz._id), updatedAt: new Date() } },
    );
  }
}

function buildHistoryTimeline({ lead, allLeadRows, deals, feedSales, deliveries, stockMap, businessLeadMeta, includeBusiness }) {
  const customerIdSet = new Set([String(lead._id), ...(lead.merged_lead_ids || []).map(String)]);
  const leadById = new Map(allLeadRows.map(r => [String(r._id), r]));
  const deliveryByDeal = new Map();
  const deliveryByLead = new Map();
  for (const d of deliveries) {
    if (d.deal_id) deliveryByDeal.set(String(d.deal_id), d);
    if (d.lead_id) {
      const existing = deliveryByLead.get(String(d.lead_id)) || [];
      existing.push(d);
      deliveryByLead.set(String(d.lead_id), existing);
    }
  }

  const rawRecords = [];

  for (const row of deals) {
    const lid = String(row.lead_id || '');
    const isCustomer = customerIdSet.has(lid) || !lid;
    if (!includeBusiness && !isCustomer) continue;
    const ownerLead = leadById.get(lid);
    const meta = businessLeadMeta.get(lid);
    const unit = row.stock_key ? stockMap.get(String(row.stock_key)) : null;
    const deliv = deliveryByDeal.get(String(row._id));
    const isDelivered = deliv?.status === 'completed';
    const statusLabel = row.status === 'cancelled'
      ? 'Cancelled'
      : isDelivered
        ? 'Delivered'
        : row.status === 'completed'
          ? 'Completed'
          : 'Registered';
    const make = row.make || unit?.make || ownerLead?.vehicle_make || '';
    const model = row.model || unit?.model || ownerLead?.vehicle_model || '';
    const year = row.year || unit?.year || null;
    rawRecords.push({
      id: `deal:${row._id}`,
      origin: 'deal',
      priority: 2,
      scope: isCustomer ? 'customer' : 'business',
      buyerName: ownerLead?.customer_name || meta?.name || lead.customer_name || 'Customer',
      businessName: row.business_name || meta?.businessName || null,
      vehicle: [year, make, model, unit?.variant].filter(Boolean).join(' ') || row.stockNumber || 'Vehicle deal',
      make,
      model,
      year,
      vin: (row.vin || unit?.vin || '').toUpperCase(),
      stockNumber: row.stockNumber || unit?.stockNumber || '',
      dealNumber: row.deal_number || row.dealNumber || row.export_reference || ownerLead?.deal_number || '',
      purchaseDate: row.completed_at || row.createdAt || null,
      deliveryDate: deliv?.completedAt || deliv?.delivery_date || deliv?.when || ownerLead?.delivery_date || null,
      salePriceCents: typeof row.sale_price_cents === 'number' ? row.sale_price_cents : null,
      salesperson: row.owner_name || ownerLead?.owner_name || 'Unassigned',
      status: statusLabel,
      statusRaw: row.status || 'registered',
      appraisalId: row.appraisal_id ? String(row.appraisal_id) : null,
      leadId: lid,
      purchased: row.status === 'completed',
    });
  }

  for (const row of feedSales.filter(r => r.status !== 'cancelled')) {
    const lid = String(row.leadId || '');
    const isCustomer = customerIdSet.has(lid) || (lead.deal_id && lid === String(lead.deal_id));
    if (!includeBusiness && !isCustomer) continue;
    const ownerLead = leadById.get(lid) || (lead.deal_id && lid === String(lead.deal_id) ? lead : null);
    const resolvedLid = ownerLead ? String(ownerLead._id) : lid;
    const meta = businessLeadMeta.get(resolvedLid);
    const make = row.make || ownerLead?.vehicle_make || '';
    const model = row.model || ownerLead?.vehicle_model || '';
    rawRecords.push({
      id: `dms:${row._id}`,
      origin: 'dms_feed',
      priority: 3,
      scope: isCustomer ? 'customer' : 'business',
      buyerName: ownerLead?.customer_name || meta?.name || lead.customer_name || 'Customer',
      businessName: meta?.businessName || ownerLead?.business_name || null,
      vehicle: [make, model].filter(Boolean).join(' ') || row.stockNumber || 'DMS Sale',
      make,
      model,
      year: null,
      vin: (row.vin || '').toUpperCase(),
      stockNumber: row.stockNumber || '',
      dealNumber: row.externalId || '',
      purchaseDate: row.date || null,
      deliveryDate: ownerLead?.delivery_date || null,
      salePriceCents: typeof row.revenueCents === 'number' ? row.revenueCents : null,
      salesperson: row.ownerName || ownerLead?.owner_name || 'Unassigned',
      status: 'Completed',
      statusRaw: 'completed',
      appraisalId: null,
      leadId: resolvedLid,
      purchased: true,
    });
  }

  for (const row of allLeadRows) {
    const lid = String(row._id);
    const isCustomer = customerIdSet.has(lid);
    if (!includeBusiness && !isCustomer) continue;
    const stages = (row.stage_history || []).filter(e => e.to === 'sold').sort((a, b) => +new Date(b.at) - +new Date(a.at));
    const at = (row.booran_edited_fields?.includes('sold_at') && row.sold_at) ? row.sold_at : (row.status === 'sold' ? (row.sold_at || stages[0]?.at || row.last_activity_at || row.created_at) : null);
    if (!at) continue;
    const meta = businessLeadMeta.get(lid);
    const delivs = deliveryByLead.get(lid) || [];
    const completedDeliv = delivs.find(d => d.status === 'completed');
    const make = row.vehicle_make || '';
    const model = row.vehicle_model || '';
    rawRecords.push({
      id: `lead:${lid}`,
      origin: 'lead_sale',
      priority: 1,
      scope: isCustomer ? 'customer' : 'business',
      buyerName: row.customer_name || meta?.name || 'Customer',
      businessName: row.business_name || meta?.businessName || null,
      vehicle: [make, model].filter(Boolean).join(' ') || 'Vehicle Sale',
      make,
      model,
      year: row.vehicle_year || null,
      vin: (row.vehicle_vin || row.vin || '').toUpperCase(),
      stockNumber: row.stock_number || '',
      dealNumber: row.deal_number || '',
      purchaseDate: at,
      deliveryDate: completedDeliv?.completedAt || row.delivery_date || null,
      salePriceCents: null,
      salesperson: row.owner_name || 'Unassigned',
      status: completedDeliv ? 'Delivered' : 'Sold',
      statusRaw: 'sold',
      appraisalId: null,
      leadId: lid,
      purchased: true,
    });
  }

  // Deduplicate matching sales across DMS feed, Sales Floor deals, and Sold leads
  const result = [];
  const aliases = new Map();
  const leadAliases = new Map();
  for (const item of rawRecords.sort((a, b) => b.priority - a.priority || (Date.parse(b.purchaseDate || 0) || 0) - (Date.parse(a.purchaseDate || 0) || 0))) {
    const day = item.purchaseDate && Number.isFinite(+new Date(item.purchaseDate)) ? dayKey(item.purchaseDate) : 'undated';
    const identities = [
      item.vin && `vin:${item.vin}`,
      item.stockNumber && `stock:${item.stockNumber.toUpperCase()}`,
    ].filter(Boolean).map(k => `${day}:${k}`);
    const leadKey = item.leadId ? `${day}:lead:${item.leadId}` : null;
    const related = leadKey ? (leadAliases.get(leadKey) || []) : [];
    const matched = identities.map(k => aliases.get(k)).find(Boolean)
      || related.find(prev => item.priority === 1 || (prev.priority !== item.priority && (!identities.length || !prev.hasVehicle)));
    if (matched) {
      for (const field of ['salePriceCents', 'vin', 'stockNumber', 'dealNumber', 'make', 'model', 'year', 'deliveryDate', 'appraisalId', 'businessName']) {
        if ((matched.item[field] == null || matched.item[field] === '') && item[field] != null && item[field] !== '') {
          matched.item[field] = item[field];
        }
      }
      if (item.year && matched.item.make && matched.item.model && !String(matched.item.vehicle).includes(String(item.year))) {
        matched.item.vehicle = [matched.item.year, matched.item.make, matched.item.model].filter(Boolean).join(' ');
      }
      if (matched.item.status !== 'Delivered' && item.status === 'Delivered') matched.item.status = 'Delivered';
      for (const k of identities) aliases.set(k, matched);
      matched.hasVehicle ||= identities.length > 0;
      if (leadKey) leadAliases.set(leadKey, [...new Set([...related, matched])]);
      continue;
    }
    const entry = { item, priority: item.priority, hasVehicle: identities.length > 0 };
    result.push(item);
    for (const k of identities) aliases.set(k, entry);
    if (leadKey) leadAliases.set(leadKey, [...related, entry]);
  }

  result.sort((a, b) => (Date.parse(b.purchaseDate || 0) || 0) - (Date.parse(a.purchaseDate || 0) || 0));

  const purchased = result.filter(i => i.purchased);
  const priced = purchased.filter(i => typeof i.salePriceCents === 'number');
  const lifetimeSpendCents = purchased.length === 0 ? 0 : (priced.length ? priced.reduce((sum, i) => sum + i.salePriceCents, 0) : null);

  return {
    items: result.map(({ priority, purchased, ...rest }) => rest),
    summary: {
      totalVehiclesPurchased: purchased.length,
      totalDeals: result.length,
      lifetimeSpendCents,
      pricedPurchasesCount: priced.length,
      lastPurchaseDate: purchased[0]?.purchaseDate || null,
      customerPurchasesCount: purchased.filter(i => i.scope === 'customer').length,
      businessPurchasesCount: purchased.filter(i => i.scope === 'business').length,
    },
  };
}

function installCustomerProfile(router, database, inventoryDatabase) {
  // ── GET /leads/:id/history ────────────────────────────────────────────────
  router.get('/leads/:id/history', route(async (req, res) => {
    const { raw, lead, leadId, site } = await resolveLeadAccess(req, database);
    const includeBusiness = req.query.includeBusiness !== 'false';

    const customerLeadIds = [leadId, ...(lead.merged_lead_ids || []).map(String)];
    const bizEntries = await collectCustomerBusinesses(raw, lead);
    const bizIds = bizEntries.map(e => String(e.business._id));

    const businessLeadMeta = new Map();
    const businessLeadIds = [];
    if (bizIds.length) {
      const [links, legacyBizLeads] = await Promise.all([
        raw.collection('customer_businesses').find({ dealership: siteMatch(site), business_id: { $in: bizIds } }).toArray(),
        raw.collection('leads').find({ dealership_name: siteMatch(site), business_id: { $in: bizIds }, merged_into: { $exists: false } }).limit(200).toArray(),
      ]);
      const bizNameMap = new Map(bizEntries.map(e => [String(e.business._id), e.business.name]));
      for (const l of links) {
        const lid = String(l.lead_id);
        if (!customerLeadIds.includes(lid)) {
          businessLeadIds.push(lid);
          businessLeadMeta.set(lid, { businessName: bizNameMap.get(String(l.business_id)) || null });
        }
      }
      for (const l of legacyBizLeads) {
        const lid = String(l._id);
        if (!customerLeadIds.includes(lid) && !businessLeadMeta.has(lid)) {
          businessLeadIds.push(lid);
          businessLeadMeta.set(lid, { name: l.customer_name, businessName: bizNameMap.get(String(l.business_id)) || l.business_name || null });
        }
      }
    }

    const allLeadIds = [...new Set([...customerLeadIds, ...(includeBusiness ? businessLeadIds : [])])];
    const objectIds = allLeadIds.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));

    const [allLeadRows, deals, feedSales, deliveries, appraisalsCount, serviceBookings] = await Promise.all([
      raw.collection('leads').find({ dealership_name: siteMatch(site), _id: { $in: objectIds } }).toArray(),
      raw.collection('deals').find({
        dealership: siteMatch(site),
        $or: [
          { lead_id: { $in: allLeadIds } },
          ...(includeBusiness && bizIds.length ? [{ business_id: { $in: bizIds } }] : []),
        ],
      }).sort({ completed_at: -1, createdAt: -1 }).limit(100).toArray(),
      raw.collection('dp_sales_events').find({
        dealership: siteMatch(site),
        leadId: { $in: [...allLeadIds, ...(lead.deal_id ? [String(lead.deal_id)] : [])] },
      }).sort({ date: -1 }).limit(100).toArray(),
      raw.collection('deliveries').find({
        dealership: siteMatch(site),
        lead_id: { $in: allLeadIds },
      }).sort({ when: -1, createdAt: -1 }).limit(100).toArray(),
      raw.collection('appraisals').countDocuments({ dealership: siteMatch(site), lead_id: { $in: customerLeadIds } }),
      raw.collection('service_bookings').find({ dealership: siteMatch(site), lead_id: { $in: customerLeadIds } }).sort({ starts_at: -1 }).limit(20).toArray(),
    ]);

    let stockMap = new Map();
    const stockKeys = [...new Set(deals.map(d => d.stock_key).filter(id => id && ObjectId.isValid(String(id))))].map(id => new ObjectId(String(id)));
    if (stockKeys.length && inventoryDatabase) {
      try {
        const invDb = await inventoryDatabase(req);
        const stockRows = await invDb.collection('vehicles').find({ _id: { $in: stockKeys } }).toArray();
        stockMap = new Map(stockRows.map(v => [String(v._id), v]));
      } catch { /* ignore if inventory unavailable */ }
    }

    const timeline = buildHistoryTimeline({
      lead, allLeadRows, deals, feedSales, deliveries, stockMap, businessLeadMeta, includeBusiness,
    });

    res.json({
      success: true,
      data: {
        summary: timeline.summary,
        items: timeline.items,
        hasLinkedBusiness: bizEntries.length > 0,
        linkedBusinesses: bizEntries.map(e => ({ id: String(e.business._id), name: e.business.name, role: e.link.role })),
        appraisalsCount,
        deliveriesCount: deliveries.length,
        notesCount: Array.isArray(lead.diary_entries) ? lead.diary_entries.length : 0,
        serviceBookings: serviceBookings.map(b => ({
          id: String(b._id),
          startsAt: b.starts_at,
          vehicle: b.vehicle || 'Service booking',
          status: b.status || 'booked',
          reference: b.reference || '',
        })),
      },
    });
  }));

  // ── GET /leads/:id/business ───────────────────────────────────────────────
  router.get('/leads/:id/business', route(async (req, res) => {
    if (!ALLOWED_ROLES_WRITE(req.user)) fail(403, 'A sales or manager account is required.');
    const { raw, lead } = await resolveLeadAccess(req, database);
    res.json({ success: true, data: await buildBusinessPayload(raw, lead, req.user) });
  }));

  // ── GET /leads/:id/business/search ────────────────────────────────────────
  router.get('/leads/:id/business/search', route(async (req, res) => {
    if (!ALLOWED_ROLES_WRITE(req.user)) fail(403, 'A sales or manager account is required.');
    const { raw, site } = await resolveLeadAccess(req, database);
    const term = string(req.query.search, 'Search', { max: 100 });
    const rx = term ? { $regex: escapeRegex(term), $options: 'i' } : null;

    const [bizDocs, legacyLeads] = await Promise.all([
      raw.collection('businesses').find({
        dealership: siteMatch(site),
        ...(rx ? { $or: [{ name: rx }, { abn: rx }] } : {}),
      }).sort({ name: 1 }).limit(25).toArray(),
      raw.collection('leads').find({
        dealership_name: siteMatch(site),
        merged_into: { $exists: false },
        business_name: rx ? { $regex: escapeRegex(term), $options: 'i' } : { $type: 'string', $ne: '' },
      }, { projection: { business_name: 1, business_id: 1 } }).limit(100).toArray(),
    ]);

    const combined = new Map();
    for (const b of bizDocs) {
      combined.set(String(b._id), { _id: String(b._id), name: b.name, abn: b.abn || '', industry: b.industry || '' });
    }
    for (const l of legacyLeads) {
      const name = l.business_name?.trim();
      if (!name) continue;
      const bId = String(l.business_id || businessId(site, name));
      if (!combined.has(bId)) combined.set(bId, { _id: bId, name, abn: '', industry: '' });
    }
    res.json({ success: true, data: [...combined.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20) });
  }));

  // ── GET /leads/:id/business/people-search ─────────────────────────────────
  router.get('/leads/:id/business/people-search', route(async (req, res) => {
    if (!ALLOWED_ROLES_WRITE(req.user)) fail(403, 'A sales or manager account is required.');
    const { db, leadId, site } = await resolveLeadAccess(req, database);
    const term = string(req.query.search, 'Search', { max: 100 });
    const rx = term ? { $regex: escapeRegex(term), $options: 'i' } : null;
    const rows = await db.collection('leads').find({
      _id: { $ne: new ObjectId(leadId) },
      dealership_name: siteMatch(site),
      merged_into: { $exists: false },
      ...(rx ? { $or: [{ customer_name: rx }, { customer_phone: rx }, { customer_email: rx }] } : {}),
    }).sort({ customer_name: 1 }).limit(20).toArray();
    res.json({ success: true, data: rows.map(serializeLead) });
  }));

  // ── POST /leads/:id/business/attach ───────────────────────────────────────
  router.post('/leads/:id/business/attach', route(async (req, res) => {
    if (!ALLOWED_ROLES_WRITE(req.user)) fail(403, 'A sales or manager account is required.');
    const { raw, lead, leadId, site } = await resolveLeadAccess(req, database);
    const body = req.body || {};
    const now = new Date().toISOString();

    let biz = null;
    if (body.businessId) {
      const bId = string(body.businessId, 'Business ID', { required: true, max: 64 });
      biz = await raw.collection('businesses').findOne({ _id: bId, dealership: siteMatch(site) });
      if (!biz) {
        const legacyLead = await raw.collection('leads').findOne({ dealership_name: siteMatch(site), business_id: bId, merged_into: { $exists: false } });
        if (legacyLead?.business_name) {
          const { _id: _omit, ...bizInsert } = {
            _id: bId, dealership: site, name: legacyLead.business_name.trim(),
            abn: '', industry: '', phone: '', email: '', address: '', notes: '',
            createdAt: now, updatedAt: now, createdBy: req.user.id,
          };
          biz = { _id: bId, ...bizInsert };
          await raw.collection('businesses').findOneAndUpdate({ _id: bId }, { $setOnInsert: bizInsert }, { upsert: true });
        }
      }
      if (!biz) fail(404, 'Business not found at this dealership.');
    } else {
      const fields = businessFields(body, true);
      const bId = businessId(site, fields.name);
      biz = await raw.collection('businesses').findOneAndUpdate(
        { _id: bId, dealership: siteMatch(site) },
        {
          $set: { ...fields, dealership: site, updatedAt: now },
          $setOnInsert: { createdAt: now, createdBy: req.user.id },
        },
        { upsert: true, returnDocument: 'after' },
      ) || { _id: bId, dealership: site, ...fields };
    }

    // Bootstrap existing legacy business link on the lead first so attaching a second business doesn't drop the first.
    if (lead.business_name?.trim()) {
      const legacyId = String(lead.business_id || businessId(site, lead.business_name));
      if (legacyId !== String(biz._id)) {
        const legacyExist = await raw.collection('customer_businesses').findOne({ dealership: siteMatch(site), lead_id: leadId, business_id: legacyId });
        if (!legacyExist) {
          await raw.collection('businesses').findOneAndUpdate(
            { _id: legacyId, dealership: siteMatch(site) },
            { $setOnInsert: { dealership: site, name: lead.business_name.trim(), abn: '', industry: '', createdAt: now, createdBy: req.user.id } },
            { upsert: true },
          );
          await raw.collection('customer_businesses').findOneAndUpdate(
            { _id: linkKey(site, leadId, legacyId) },
            { $setOnInsert: { dealership: site, lead_id: leadId, business_id: legacyId, role: 'Contact', is_primary: true, createdAt: lead.created_at || now, updatedAt: now, createdBy: req.user.id } },
            { upsert: true },
          );
        }
      }
    }

    const existingLinksCount = await raw.collection('customer_businesses').countDocuments({ dealership: siteMatch(site), lead_id: leadId });
    const role = body.role !== undefined ? (safeStr(body.role, 100) || 'Contact') : 'Contact';
    const isPrimary = body.isPrimary !== undefined ? Boolean(body.isPrimary) : existingLinksCount === 0;

    if (isPrimary) {
      await raw.collection('customer_businesses').updateMany(
        { dealership: siteMatch(site), business_id: String(biz._id), lead_id: { $ne: leadId } },
        { $set: { is_primary: false, updatedAt: now } },
      );
    }

    const lId = linkKey(site, leadId, biz._id);
    await raw.collection('customer_businesses').findOneAndUpdate(
      { _id: lId },
      {
        $set: { dealership: site, lead_id: leadId, business_id: String(biz._id), role, is_primary: isPrimary, updatedAt: now },
        $setOnInsert: { createdAt: now, createdBy: req.user.id },
      },
      { upsert: true },
    );

    await syncLeadBusinessSummary(raw, leadId, site);
    const updatedLead = await raw.collection('leads').findOne({ _id: lead._id });
    res.status(201).json({
      success: true,
      data: {
        business: await buildBusinessPayload(raw, updatedLead || lead, req.user),
        lead: serializeLead(updatedLead || lead),
      },
    });
  }));

  // ── PATCH /leads/:id/business/:businessId ─────────────────────────────────
  router.patch('/leads/:id/business/:businessId', route(async (req, res) => {
    if (!ALLOWED_ROLES_WRITE(req.user)) fail(403, 'A sales or manager account is required.');
    const { raw, lead, leadId, site } = await resolveLeadAccess(req, database);
    const bId = string(req.params.businessId, 'Business ID', { required: true, max: 64 });
    const body = req.body || {};
    const now = new Date().toISOString();

    let biz = await raw.collection('businesses').findOne({ _id: bId, dealership: siteMatch(site) });
    if (!biz && lead.business_name?.trim() && String(lead.business_id || businessId(site, lead.business_name)) === bId) {
      const bizInsert = { dealership: site, name: lead.business_name.trim(), abn: '', industry: '', createdAt: now, createdBy: req.user.id };
      biz = { _id: bId, ...bizInsert };
      await raw.collection('businesses').findOneAndUpdate({ _id: bId }, { $setOnInsert: bizInsert }, { upsert: true });
    }
    if (!biz) fail(404, 'Linked business not found.');

    const bizPatch = businessFields(body, false);
    if (Object.keys(bizPatch).length) {
      await raw.collection('businesses').findOneAndUpdate(
        { _id: bId, dealership: siteMatch(site) },
        { $set: { ...bizPatch, updatedAt: now } },
      );
      if (bizPatch.name) {
        await raw.collection('leads').updateMany(
          { dealership_name: siteMatch(site), business_id: bId },
          { $set: { business_name: bizPatch.name, updatedAt: new Date() } },
        );
      }
    }

    const existingLink = await raw.collection('customer_businesses').findOne({ dealership: siteMatch(site), lead_id: leadId, business_id: bId });
    const linkPatch = { updatedAt: now };
    if (body.role !== undefined) linkPatch.role = safeStr(body.role, 100) || 'Contact';
    if (body.isPrimary !== undefined) {
      linkPatch.is_primary = Boolean(body.isPrimary);
      if (linkPatch.is_primary) {
        await raw.collection('customer_businesses').updateMany(
          { dealership: siteMatch(site), business_id: bId, lead_id: { $ne: leadId } },
          { $set: { is_primary: false, updatedAt: now } },
        );
      }
    }

    if (existingLink) {
      await raw.collection('customer_businesses').findOneAndUpdate({ _id: existingLink._id }, { $set: linkPatch });
    } else {
      await raw.collection('customer_businesses').findOneAndUpdate(
        { _id: linkKey(site, leadId, bId) },
        {
          $set: { dealership: site, lead_id: leadId, business_id: bId, role: linkPatch.role || 'Contact', is_primary: linkPatch.is_primary ?? true, updatedAt: now },
          $setOnInsert: { createdAt: now, createdBy: req.user.id },
        },
        { upsert: true },
      );
    }

    await syncLeadBusinessSummary(raw, leadId, site);
    const updatedLead = await raw.collection('leads').findOne({ _id: lead._id });
    res.json({
      success: true,
      data: {
        business: await buildBusinessPayload(raw, updatedLead || lead, req.user),
        lead: serializeLead(updatedLead || lead),
      },
    });
  }));

  // ── DELETE /leads/:id/business/:businessId ────────────────────────────────
  router.delete('/leads/:id/business/:businessId', route(async (req, res) => {
    if (!ALLOWED_ROLES_WRITE(req.user)) fail(403, 'A sales or manager account is required.');
    const { raw, lead, leadId, site } = await resolveLeadAccess(req, database);
    const bId = string(req.params.businessId, 'Business ID', { required: true, max: 64 });

    const matches = await raw.collection('customer_businesses').find({ dealership: siteMatch(site), lead_id: leadId, business_id: bId }).toArray();
    for (const row of matches) {
      await raw.collection('customer_businesses').deleteOne({ _id: row._id });
    }
    const remainingLinks = await raw.collection('customer_businesses').find({ dealership: siteMatch(site), lead_id: leadId }).toArray();

    if (remainingLinks.length) {
      await syncLeadBusinessSummary(raw, leadId, site);
    } else {
      const legacyId = lead.business_name?.trim() ? String(lead.business_id || businessId(site, lead.business_name)) : null;
      if (legacyId === bId || String(lead.business_id || '') === bId) {
        await raw.collection('leads').findOneAndUpdate(
          { _id: lead._id, dealership_name: siteMatch(site) },
          { $set: { business_name: '', business_id: null, updatedAt: new Date() } },
        );
      }
    }

    const updatedLead = await raw.collection('leads').findOne({ _id: lead._id });
    res.json({
      success: true,
      data: {
        business: await buildBusinessPayload(raw, updatedLead || lead, req.user),
        lead: serializeLead(updatedLead || lead),
      },
    });
  }));

  // ── POST /leads/:id/business/:businessId/people ───────────────────────────
  router.post('/leads/:id/business/:businessId/people', route(async (req, res) => {
    if (!ALLOWED_ROLES_WRITE(req.user)) fail(403, 'A sales or manager account is required.');
    const { db, raw, lead, leadId, site } = await resolveLeadAccess(req, database);
    const bId = string(req.params.businessId, 'Business ID', { required: true, max: 64 });
    const body = req.body || {};
    const now = new Date().toISOString();

    let biz = await raw.collection('businesses').findOne({ _id: bId, dealership: siteMatch(site) });
    if (!biz && lead.business_name?.trim() && String(lead.business_id || businessId(site, lead.business_name)) === bId) {
      const bizInsert = { dealership: site, name: lead.business_name.trim(), abn: '', industry: '', createdAt: now, createdBy: req.user.id };
      biz = { _id: bId, ...bizInsert };
      await raw.collection('businesses').findOneAndUpdate({ _id: bId }, { $setOnInsert: bizInsert }, { upsert: true });
    }
    if (!biz) fail(404, 'Business not found at this dealership.');

    const role = body.role !== undefined ? (safeStr(body.role, 100) || 'Contact') : 'Contact';
    const isPrimary = Boolean(body.isPrimary);

    let targetLead = null;
    if (body.existingLeadId) {
      const targetId = string(body.existingLeadId, 'Person ID', { required: true, max: 64 });
      if (!ObjectId.isValid(targetId)) fail(400, 'Invalid customer ID.');
      targetLead = await db.collection('leads').findOne({ _id: new ObjectId(targetId), dealership_name: siteMatch(site), merged_into: { $exists: false } });
      if (!targetLead) fail(404, 'Selected customer is unavailable.');
    } else {
      const name = string(body.name, 'Person name', { required: true, max: 160 });
      const rawPhone = string(body.phone, 'Mobile number', { max: 40 });
      const email = body.email ? cleanEmail(body.email) : '';
      if (!rawPhone && !email) fail(400, 'Provide a mobile number or email for this person.');
      let formattedPhone = '';
      if (rawPhone) {
        try { formattedPhone = normalisePhone(rawPhone); }
        catch { formattedPhone = formatToPlus61(rawPhone); }
      }
      const created = createLead({
        name,
        phone: formattedPhone,
        email,
        dealership: site,
        business_name: biz.name,
        source: 'Walk-in Showroom',
        owner_name: req.user.name,
        status: 'new_lead',
      }, req.user);
      created.owner_id = req.user.role === 'sales_consultant' ? req.user.id : null;
      created.owner_name = req.user.role === 'sales_consultant' ? req.user.name : 'Unassigned';
      created.business_id = String(biz._id);
      const outcome = await createUniqueLead(raw, created, req.user);
      if (outcome.duplicate) throw duplicateError(outcome, req.user);
      targetLead = outcome.lead;
    }

    const targetId = String(targetLead._id);
    if (isPrimary) {
      await raw.collection('customer_businesses').updateMany(
        { dealership: siteMatch(site), business_id: bId, lead_id: { $ne: targetId } },
        { $set: { is_primary: false, updatedAt: now } },
      );
    }

    const lId = linkKey(site, targetId, bId);
    await raw.collection('customer_businesses').findOneAndUpdate(
      { _id: lId },
      {
        $set: { dealership: site, lead_id: targetId, business_id: bId, role, is_primary: isPrimary, updatedAt: now },
        $setOnInsert: { createdAt: now, createdBy: req.user.id },
      },
      { upsert: true },
    );

    if (!targetLead.business_id) {
      await syncLeadBusinessSummary(raw, targetId, site);
    }

    const updatedLead = await raw.collection('leads').findOne({ _id: lead._id });
    res.status(201).json({
      success: true,
      data: {
        business: await buildBusinessPayload(raw, updatedLead || lead, req.user),
        lead: serializeLead(updatedLead || lead),
      },
    });
  }));
}

module.exports = { installCustomerProfile, businessFields };
