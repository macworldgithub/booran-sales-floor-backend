// Prepare and review a dry run before --apply. Never invoked by deployment.
require('dotenv').config({ quiet: true });
const fs = require('node:fs'), path = require('node:path');
const { MongoClient, BSON: { EJSON } } = require('mongodb');
const { phoneKey } = require('../lib/phone');
const { withMobileLock, mergeIntoPrimary, siteMatch } = require('../lib/lead-identity');
function groups(leads) {
    const parents = leads.map((_, index) => index), phones = new Map(), emails = new Map(), buckets = new Map();
    const root = index => parents[index] === index ? index : (parents[index] = root(parents[index]));
    const join = (a, b) => { parents[root(b)] = root(a); };
    for (const [index, lead] of leads.entries()) {
        const site = lead.dealership_name.toLowerCase();
        for (const value of [lead.customer_phone, ...(lead.alternate_phones || [])]) {
            const phone = phoneKey(value);
            if (!phone)
                continue;
            const key = `${site}:${phone}`;
            if (phones.has(key))
                join(index, phones.get(key));
            else
                phones.set(key, index);
        }
        const email = lead.customer_email?.trim().toLowerCase();
        if (email) {
            const key = `${site}:${email}`, prior = emails.get(key);
            if (prior !== undefined) {
                const a = phoneKey(lead.customer_phone), b = phoneKey(leads[prior].customer_phone);
                if (!a || !b || a === b)
                    join(index, prior);
            }
            else
                emails.set(key, index);
        }
    }
    for (const [index, lead] of leads.entries()) {
        const key = root(index);
        if (!buckets.has(key))
            buckets.set(key, []);
        buckets.get(key).push(lead);
    }
    return [...buckets.values()].filter(rows => rows.length > 1).map(rows => rows.sort((a, b) => Number(Boolean(b.assigned_by || b.booran_edited_fields?.length)) - Number(Boolean(a.assigned_by || a.booran_edited_fields?.length)) ||
        Date.parse(a.created_at || a.createdAt || 0) - Date.parse(b.created_at || b.createdAt || 0) || String(a._id).localeCompare(String(b._id))));
}
async function run() {
    const value = flag => process.argv[process.argv.indexOf(flag) + 1], site = process.argv.includes('--site') ? value('--site') : 'South Morang Hyundai';
    const apply = process.argv.includes('--apply'), backup = process.argv.includes('--backup') ? value('--backup') : '';
    if (apply && (!backup || !path.isAbsolute(backup)))
        throw Error('Applying requires --backup ABSOLUTE_PRIVATE_FILE. Omit --apply for a dry run.');
    const client = await MongoClient.connect(process.env.MONGODB_URI_FLWUP);
    try {
        const db = require('../lib/lead-state').withLeadState(client.db()), rows = await db.collection('leads').find({ dealership_name: siteMatch(site), merged_into: { $exists: false } }).toArray();
        const plan = groups(rows), summary = { site, groups: plan.length, secondaries: plan.reduce((count, group) => count + group.length - 1, 0), dryRun: !apply };
        if (!apply) {
            console.log(JSON.stringify(summary));
            return;
        }
        const ids = plan.flat().map(row => String(row._id)), linked = {};
        for (const collection of ['sales_tasks', 'deals', 'appraisals', 'deliveries', 'sales_alerts', 'customer_messages', 'message_media', 'lead_source_links'])
            linked[collection] = await db.collection(collection).find({ lead_id: { $in: ids } }).toArray();
        linked.appointments = await db.collection('appointments').find({ leadId: { $in: [...ids, ...plan.flat().map(row => row.deal_id).filter(Boolean)] } }).toArray();
        linked.lead_merge_requests = await db.collection('lead_merge_requests').find({ dealership: site, $or: [{ 'incoming._id': { $in: plan.flat().map(row => row._id) } }, { candidate_ids: { $in: ids } }] }).toArray();
        linked.lead_email_receipts = await db.collection('lead_email_receipts').find({ merge_request_id: { $in: linked.lead_merge_requests.map(row => row._id) } }).toArray();
        fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
        fs.writeFileSync(backup, EJSON.stringify({ createdAt: new Date(), site, groups: plan, linked }), { flag: 'wx', mode: 0o600 });
        let merged = 0;
        const skipped = [];
        for (const group of plan) {
            let primary = group[0];
            for (const candidate of group.slice(1)) {
                try {
                    primary = await withMobileLock(db, site, primary.customer_phone, async (session) => {
                        const latest = await db.collection('leads').findOne({ _id: primary._id, merged_into: { $exists: false }, process_revision: primary.process_revision ?? null }, { session });
                        const secondary = await db.collection('leads').findOne({ _id: candidate._id, merged_into: { $exists: false }, process_revision: candidate.process_revision ?? null }, { session });
                        if (!latest || !secondary)
                            throw Error('concurrent_change');
                        return mergeIntoPrimary(db, latest, secondary, { id: 'duplicate-fold', name: 'Approved duplicate fold' }, session);
                    }, primary.customer_email);
                    merged++;
                }
                catch (error) {
                    skipped.push({ id: String(candidate._id), reason: error.status === 409 ? 'Review conflict or concurrent change' : error.message === 'concurrent_change' ? error.message : 'Merge failed; inspect private backup and retry dry run' });
                }
            }
        }
        console.log(JSON.stringify({ ...summary, merged, skipped, backupWritten: true }));
    }
    finally {
        await client.close();
    }
}
if (require.main === module)
    run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { groups };
