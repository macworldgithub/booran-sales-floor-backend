const { locationCondition, isAllLocations } = require('./query');
const FIELDS = { leads: 'dealership_name', vehicles: 'rooftopName', actionitems: 'rooftopName', rooftops: 'name', appointments: 'dealership' };

function scopeQuery(user, collection, query = {}) {
  if (user.role === 'super_admin') return query;
  const field = FIELDS[collection];
  // Unknown/global collections fail closed for a site account.
  if (!field || !user.site) return { $and: [query, { _id: { $exists: false } }] };
  const allowed = { [field]: locationCondition(user.site) };
  return { $and: [query, allowed] };
}

function assertSiteWrite(user, collection, document, partial = false) {
  if (user.role === 'super_admin') return;
  const field = FIELDS[collection];
  if (field && partial && !Object.keys(document).some((key) => key === field || key.startsWith(`${field}.`))) return;
  const condition = locationCondition(user.site);
  if (!field || typeof document[field] !== 'string' || !new RegExp(condition.$regex, condition.$options).test(document[field])) {
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
