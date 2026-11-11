const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createClient, fetchDealership, customerLeads, DEALERSHIPS } = require('./nexgate-client');
const { formatToPlus61 } = require('./phone');
const { recordAlert } = require('./lead-alerts');
const { upsertImportedLeads } = require('./lead-identity');

const HOUR = 60 * 60 * 1000;
const LOOKBACK = 24 * HOUR;
const DEALERS = new Map(DEALERSHIPS.map(([name, id]) => [id, ({
  'South Morang Kia New': 'South Morang Kia',
  'South Morang Kia Used': 'South Morang Kia',
  'South Morang Hyundai Used': 'South Morang Hyundai',
  'South Morang Chery': 'Chery South Morang',
})[name] || name]));
const stageMap = { new: 'new_lead', contacted: 'following_up', sold: 'sold', lost: 'lost', duplicate: 'lost', unworkable: 'lost' };
const str = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validReference = (id) => typeof id === 'string' && /^[\w-]{1,120}$/.test(id);

function leadOperation(seller, customer, lead) {
  const site = DEALERS.get(seller);
  if (!site || !validReference(lead?.id) || !validReference(customer?.id)) return null;
  if (customer.sellerIdentifier && customer.sellerIdentifier !== seller) return null;
  const date = new Date(lead.leadCreatedDate ?? '');
  if (!Number.isFinite(date.getTime())) return null;
  const id = new ObjectId(createHash('sha256').update(`nexgate:${seller}:${lead.id}`).digest('hex').slice(0, 24));
  const now = new Date();
  const phone = str(customer.mobilePhone || customer.homePhone);
  const comments = str(lead.comments, 5000);
  const source = {
    seller_id: seller, customer_id: customer.id, lead_id: lead.id, channel: str(lead.leadSource),
    stage: str(lead.stage), stock_number: str(lead.item?.stockNumber), archived: lead.isArchived === true,
    source_owner: str(lead.allocatedPersonFullName), synced_at: now,
  };
  const currentSource = Object.fromEntries(Object.entries(source).map(([key, value]) => [`nexgate.${key}`, value]));
  if (comments) currentSource['nexgate.comments'] = comments;
  return {
    updateOne: {
      filter: { _id: id },
      update: {
        $set: currentSource,
        // The upstream copy is refreshed separately from the Sales Floor
        // profile, status, notes and allocation, which staff can edit.
        $setOnInsert: {
          deal_id: `NEXGATE-${seller}-${lead.id}`,
          dealership_name: site, dealer_code: 'BOORAN',
          customer_name: [str(customer.firstName), str(customer.lastName)].filter(Boolean).join(' '),
          customer_phone: formatToPlus61(phone), customer_email: str(customer.email, 254),
          vehicle_make: str(lead.item?.make), vehicle_model: str(lead.item?.model) || str(lead.item?.itemDescription),
          status: stageMap[str(lead.stage).toLowerCase()] || 'new_lead',
          owner_name: 'Unassigned', source: 'Nextgate',
          created_at: date.toISOString(), createdAt: date, updatedAt: now,
          follow_ups_sent: 0, diary_entries: [],
        },
      },
      upsert: true,
    },
  };
}

async function importCustomers(db, seller, customers) {
  if (!DEALERS.has(seller) || !Array.isArray(customers)) throw new Error('Invalid Nexgate seller or customer list');
  const operations = new Map();
  let skipped = 0;
  for (const customer of customers) {
    if (!customer || typeof customer !== 'object') { skipped++; continue; }
    for (const lead of customerLeads(customer)) {
      const operation = leadOperation(seller, customer, lead);
      if (operation) operations.set(String(operation.updateOne.filter._id), operation);
      else skipped++;
    }
  }
  const batch = [...operations.values()];
  let inserted = 0;
  for (let offset = 0; offset < batch.length; offset += 250) {
    const chunk = batch.slice(offset, offset + 250);
    try {
      inserted += (await upsertImportedLeads(db, chunk)).upsertedCount;
    } catch (error) {
      // An event and a sweep can both insert a previously unseen lead.
      if (!error.writeErrors?.length || !error.writeErrors.every(item => item.code === 11000)) throw error;
      inserted += error.result?.upsertedCount || 0;
      await upsertImportedLeads(db, error.writeErrors.map(({ index }) => chunk[index]));
    }
  }
  return { leads: batch.length, inserted, skipped };
}

function nexgateService(database, { token = process.env.NEXGATE_TOKEN, makeClient = createClient, fetchDealer = fetchDealership } = {}) {
  let request;
  let fastSyncPending = false;
  const getRequest = () => request ||= makeClient(token.trim(), { timeout: 10_000 });
  return {
    configured: Boolean(token?.trim()),
    async sync() {
      if (!token?.trim()) throw new Error('NEXGATE_TOKEN is not configured');
      const client = getRequest();
      const db = await database();
      const state = db.collection('nexgate_sync');
      const started = Date.now();
      const sellers = await Promise.all(DEALERSHIPS.map(async ([name, seller]) => {
        const lease = randomUUID();
        let checkpoint;
        try {
          checkpoint = await state.findOneAndUpdate(
            { _id: seller, $or: [{ lease_until: { $lte: new Date(started) } }, { lease_until: { $exists: false } }] },
            { $set: { lease, lease_until: new Date(started + 5 * 60 * 1000) } },
            { upsert: true, returnDocument: 'after' },
          );
        } catch (error) {
          if (error.code === 11000) return { seller, busy: true };
          throw error;
        }
        try {
          const since = (checkpoint.last_success?.getTime() || started) - LOOKBACK;
          const result = { leads: 0, inserted: 0, skipped: 0 };
          await fetchDealer(client, name, seller, 50, false, {
            since, deadline: started + 40_000,
            onPage: async customers => {
              const saved = await importCustomers(db, seller, customers);
              for (const field of Object.keys(result)) result[field] += saved[field];
            },
          });
          await state.updateOne({ _id: seller, lease }, { $set: { last_success: new Date(started) } });
          return { seller, ...result };
        } catch (error) {
          console.warn(`Nexgate sync failed for ${name}: ${error.message}`);
          return { seller, failed: true };
        } finally {
          await state.updateOne({ _id: seller, lease }, { $unset: { lease: '', lease_until: '' } });
        }
      }));
      return { success: !sellers.some(row => row.failed), sellers };
    },
    async pollLatest() {
      if (fastSyncPending || !token?.trim()) return;
      fastSyncPending = true;
      try {
        const db = await database();
        const results = await Promise.allSettled(DEALERSHIPS.map(async ([name, seller]) => {
          const { customers } = await fetchDealer(getRequest(), name, seller, 20, false, { pageLimit: 1, deadline: Date.now() + 15000 });
          return importCustomers(db, seller, customers);
        }));
        if (results.some(result => result.status === 'rejected')) console.warn('One or more Nextgate live polls failed; the hourly sweep will retry.');
      } finally {
        fastSyncPending = false;
      }
    },
    async receive({ sellerIdentifier, customer, lead }) {
      const operation = leadOperation(sellerIdentifier, customer, lead);
      if (!operation) {
        throw Object.assign(new Error('Invalid Nexgate lead event.'), { status: 400 });
      }
      const db = await database();
      const result = await importCustomers(db, sellerIdentifier, [{ ...customer, lead, otherLeads: [] }]);
      const comment = str(lead.comments, 5000);
      if (comment) {
        const row = await db.collection('leads').findOne(operation.updateOne.filter);
        if (row) await recordAlert(db, row, `nextgate:${lead.id}`, comment).catch(() => {});
      }
      return result;
    },
  };
}

function authorised(req, secret) {
  if (!secret || secret.length < 24) return false;
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  const received = createHash('sha256').update(req.get('authorization') || '').digest();
  return timingSafeEqual(expected, received);
}

function installNexgate(router, service, afterSync) {
  router.get('/jobs/nexgate', async (req, res) => {
    if (!authorised(req, process.env.CRON_SECRET)) return res.status(401).json({ success: false, error: 'Unauthorised job request.' });
    try {
      const result = await service.sync();
      if (afterSync) await afterSync().catch(() => console.warn('Aged lead alert sweep failed.'));
      res.status(result.success ? 200 : 502).json(result);
    } catch {
      res.status(503).json({ success: false, error: 'Nextgate sync is unavailable.' });
    }
  });
  router.post('/integrations/nexgate/leads', async (req, res) => {
    if (!authorised(req, process.env.NEXGATE_WEBHOOK_SECRET)) return res.status(401).json({ success: false, error: 'Unauthorised lead event.' });
    try {
      res.json({ success: true, data: await service.receive(req.body) });
    } catch (error) {
      const badRequest = error.status === 400;
      res.status(badRequest ? 400 : 503).json({ success: false, error: badRequest ? error.message : 'Nextgate ingestion is unavailable.' });
    }
  });
}

module.exports = { importCustomers, leadOperation, nexgateService, installNexgate, HOUR };
