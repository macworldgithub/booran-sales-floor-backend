const { pageQuery } = require('./query');

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = [400, 403, 404, 409, 422, 503].includes(error.status) ? error.status : 500;
      if (status === 500) console.error('Sales workflow request failed:', error.message);
      res.status(status).json({ success: false, error: status === 500 ? 'Unable to complete this request.' : error.message });
    }
  };
}

async function list(collection, req, query, sortBy = 'createdAt') {
  const { page, limit, skip, sort } = pageQuery(req.query, 'workflow', sortBy);
  const [data, total] = await Promise.all([
    collection.find(query).sort(sort).skip(skip).limit(limit).toArray(),
    collection.countDocuments(query),
  ]);
  return { success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

module.exports = { fail, route, list };
