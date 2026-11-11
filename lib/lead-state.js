// Optional co-location of integration state when a hosted cluster has no
// collection capacity. Logical collections retain separate ID namespaces.
const KINDS = new Set(['lead_mobile_keys', 'lead_merge_requests', 'lead_source_links', 'lead_email_receipts', 'integration_sync']);
const MAPPED = Symbol('leadStateDatabase');
function withLeadState(db, physical = process.env.LEAD_STATE_COLLECTION) {
  if (!physical || db[MAPPED]) return db;
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(physical) || KINDS.has(physical)) throw new Error('Choose an existing operational collection for lead state.');
  return new Proxy(db, { get(target, property) {
    if (property === MAPPED) return true;
    if (property !== 'collection') {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return name => {
      if (!KINDS.has(name)) return target.collection(name);
      const collection = target.collection(physical), prefix = `gs:${name}:`;
      const encode = id => `${prefix}${id}`;
      const decode = row => row ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'gs_state_kind')
        .map(([key, value]) => [key, key === '_id' ? String(value).slice(prefix.length) : value])) : row;
      const idCondition = value => value && typeof value === 'object' && !(value instanceof Date)
        ? Object.fromEntries(Object.entries(value).map(([operator, argument]) => [operator, Array.isArray(argument) ? argument.map(encode) : operator === '$exists' ? argument : encode(argument)])) : encode(value);
      const translate = query => Object.fromEntries(Object.entries(query || {}).map(([key, value]) => [key,
        key === '_id' ? idCondition(value) : ['$and', '$or', '$nor'].includes(key) ? value.map(translate) : value]));
      const scope = query => ({ ...translate(query), gs_state_kind: name });
      const cursor = value => new Proxy(value, { get(current, key) {
        if (key === 'toArray') return async () => (await current.toArray()).map(decode);
        const method = current[key];
        return typeof method === 'function' ? (...args) => { const result = method.apply(current, args); return result === current ? cursor(current) : result; } : method;
      } });
      return {
        find: (query, options) => cursor(collection.find(scope(query), options)),
        findOne: async (query, options) => decode(await collection.findOne(scope(query), options)),
        countDocuments: (query, options) => collection.countDocuments(scope(query), options),
        findOneAndUpdate: async (query, update, options) => decode(await collection.findOneAndUpdate(scope(query), update, options)),
        updateOne: (query, update, options) => collection.updateOne(scope(query), update, options),
        updateMany: (query, update, options) => collection.updateMany(scope(query), update, options),
        indexes: async () => (await collection.indexes()).map(index => ({ ...index, key: Object.fromEntries(Object.entries(index.key).filter(([key]) => key !== 'gs_state_kind')) })),
        createIndexes: specs => collection.createIndexes(specs.map(spec => ({ ...spec,
          key: { gs_state_kind: 1, ...spec.key }, name: `gs_state_${spec.name}` }))),
      };
    };
  } });
}
module.exports = { withLeadState };
