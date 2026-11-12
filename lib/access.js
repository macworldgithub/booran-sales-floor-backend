const { locationCondition, isAllLocations } = require('./query');
const { accountSites, canAccessSite } = require('./roles');
const FIELDS = {
  leads: 'dealership_name', customer_messages: 'dealership_name', message_media: 'dealership_name',
  vehicles: 'rooftopName', actionitems: 'rooftopName', rooftops: 'name', appointments: 'dealership',
  deals: 'dealership', deliveries: 'dealership', appraisals: 'dealership', sales_tasks: 'dealership', attendance: 'dealership', sales_alerts: 'dealership', lead_merge_requests: 'dealership',
  integration_sync: 'dealership', lead_email_receipts: 'dealership',
};
const OWNERS = { leads: 'owner_id', appointments: 'consultant_id', deals: 'owner_id', deliveries: 'owner_id', appraisals: 'owner_id', sales_tasks: 'assignee_id', attendance: 'user_id', sales_alerts: 'owner_id' };

function scopeQuery(user, collection, query = {}) {
  const visible = collection === 'vehicles' ? [{ salesFloorHidden: { $ne: true } }] : [];
  if (user.role === 'super_admin') return visible.length ? { $and: [query, ...visible] } : query;
  if (collection === 'actionitems' && user.role === 'sales_consultant') {
    return { $and: [query, { _id: { $exists: false } }] };
  }
  const field = FIELDS[collection];
  // Unknown/global collections fail closed for a site account.
  const sites = accountSites(user);
  if (!field || !sites.length) return { $and: [query, { _id: { $exists: false } }] };
  if (user.role === 'contractor' && nameIsPrivate(collection)) {
    if (collection === 'deliveries') return { $and: [query, { $or: sites.map(site => ({ [field]: locationCondition(site) })) }, { 'accessories.contractor_id': user.id }] };
    return { $and: [query, { _id: { $exists: false } }] };
  }
  const filters = [query, sites.length === 1 ? { [field]: locationCondition(sites[0]) } : { $or: sites.map(site => ({ [field]: locationCondition(site) })) }, ...visible];
  if (user.role === 'sales_consultant' && OWNERS[collection]) filters.push({ [OWNERS[collection]]: user.id });
  return { $and: filters };
}

function nameIsPrivate(collection) {
  return !['rooftops', 'attendance'].includes(collection);
}

function assertSiteWrite(user, collection, document, partial = false) {
  if (user.role === 'super_admin') return;
  const field = FIELDS[collection];
  if (field && partial && !Object.keys(document).some((key) => key === field || key.startsWith(`${field}.`))) return;
  if (!field || !canAccessSite(user, document[field])) {
    const error = new Error('You do not have access to this location.');
    error.status = 403;
    throw error;
  }
}

/** All reads, aggregates and writes share the same server-owned location boundary. */
function scopedDatabase(db, user, requestedSite) {
  if (!user) throw new Error('An authenticated user is required.');
  return {
    collection(name) {
      const collection = db.collection(name);
      const scoped = (query = {}) => {
        const authorised = scopeQuery(user, name, query);
        if (isAllLocations(requestedSite) || !FIELDS[name]) return authorised;
        return { $and: [authorised, { [FIELDS[name]]: locationCondition(requestedSite) }] };
      };
      return {
        find: (query = {}, options) => collection.find(scoped(query), options),
        findOne: (query = {}, options) => collection.findOne(scoped(query), options),
        countDocuments: (query = {}) => collection.countDocuments(scoped(query)),
        updateMany: (query, update, options) => {
          assertSiteWrite(user, name, update.$set || {}, true);
          return collection.updateMany(scoped(query), update, options);
        },
        aggregate: (pipeline = []) => collection.aggregate([{ $match: scoped() }, ...pipeline]),
        insertOne: (document) => {
          assertSiteWrite(user, name, document);
          return collection.insertOne(document);
        },
        findOneAndUpdate: (query, update, options) => {
          assertSiteWrite(user, name, update.$set || {}, true);
          return collection.findOneAndUpdate(scoped(query), update, options);
        },
      };
    },
  };
}
module.exports = { scopeQuery, assertSiteWrite, scopedDatabase };
