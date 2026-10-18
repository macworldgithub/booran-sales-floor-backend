const ALLOWED_SORTS = {
  leads: ['created_at', 'customer_name', 'status', 'dealership_name'],
  vehicles: ['daysInStock', 'totalStockCost', 'make', 'model', 'stockNumber', 'createdAt'],
  actions: ['createdAt', 'priority', 'actionType', 'stockNumber'],
  logs: ['createdAt'],
  appointments: ['when', 'createdAt'],
};

function text(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function escapeRegex(value) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function integer(value, fallback, maximum) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, maximum) : fallback;
}

function pageQuery(query, collection, defaultSort) {
  const page = integer(query.page, 1, 1000000);
  const limit = integer(query.limit, 20, 100);
  const sortBy = ALLOWED_SORTS[collection].includes(query.sortBy) ? query.sortBy : defaultSort;
  return { page, limit, skip: (page - 1) * limit, sort: { [sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 } };
}

module.exports = { text, escapeRegex, pageQuery };
