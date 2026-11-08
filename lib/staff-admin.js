const { ObjectId } = require('mongodb');
const { hashPassword } = require('./password');
const { ROLES, accountSites } = require('./roles');
const { isAllLocations, LOCATION_GROUPS } = require('./query');
const { string } = require('./records');
const { route, fail } = require('./workflow-route');

const staffRoles = ROLES.filter(role => role !== 'super_admin');
const staffFilter = { role: { $in: staffRoles } };
const projection = { name: 1, email: 1, role: 1, site: 1, allowedSites: 1, viewCost: 1, active: 1 };

function staffAccount(user) {
  return {
    id: String(user._id), name: user.name, email: user.email, role: user.role,
    site: user.site, allowedSites: accountSites(user), viewCost: user.viewCost === true, active: user.active === true,
  };
}

async function staffSites(crm, inventory) {
  const locations = await Promise.all([crm, inventory].map(db =>
    db.collection('rooftops').find({}, { projection: { name: 1 } }).toArray()));
  const sites = new Map();
  for (const { name } of locations.flat()) {
    if (typeof name === 'string' && !isAllLocations(name) && name.trim() !== '*') {
      sites.set(name.trim().toLowerCase(), name.trim());
    }
  }
  for (const [group, ...members] of Object.values(LOCATION_GROUPS)) {
    if (members.some(site => sites.has(site.toLowerCase()))) sites.set(group.toLowerCase(), group);
  }
  return sites;
}

function permissions(body, sites) {
  if (!staffRoles.includes(body.role)) fail(400, 'Choose a staff role.');
  if (!Array.isArray(body.allowedSites) || !body.allowedSites.length || body.allowedSites.length > sites.size) {
    fail(400, 'Choose at least one dealership.');
  }
  const canonicalSite = value => sites.get(string(value, 'Dealership', { required: true }).toLowerCase());
  const allowedSites = [...new Set(body.allowedSites.map(canonicalSite))];
  const site = canonicalSite(body.site);
  if (!site || allowedSites.includes(undefined) || !allowedSites.includes(site)) {
    fail(400, 'Choose valid dealerships and include the home dealership in site access.');
  }
  if (body.viewCost !== undefined && typeof body.viewCost !== 'boolean') fail(400, 'Invalid cost permission.');
  return { role: body.role, site, allowedSites, viewCost: body.role === 'sales_consultant' && body.viewCost === true };
}

function installStaffAdmin(router, getCrm, getInventory) {
  const admin = handler => route(async (req, res) => {
    if (req.user.role !== 'super_admin') fail(403, 'Super admin access is required.');
    const [crm, inventory] = await Promise.all([getCrm(), getInventory()]);
    await handler(req, res, crm.collection('users'), await staffSites(crm, inventory));
  });

  router.get('/admin/staff', admin(async (req, res, users, sites) => {
    const accounts = await users.find(staffFilter, { projection }).sort({ name: 1, email: 1 }).toArray();
    res.json({ success: true, data: { accounts: accounts.map(staffAccount), sites: [...sites.values()].sort(), roles: staffRoles } });
  }));

  router.post('/admin/staff', admin(async (req, res, users, sites) => {
    const email = string(req.body.email, 'Email', { required: true, max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
    const name = string(req.body.name, 'Name', { required: true });
    const password = req.body.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 256 || !password.trim()) {
      fail(400, 'Use a password between 12 and 256 characters.');
    }
    const access = permissions(req.body, sites);
    const account = { email, name, ...access, active: true, passwordHash: await hashPassword(password), createdAt: new Date() };
    try {
      const result = await users.insertOne(account);
      res.status(201).json({ success: true, data: staffAccount({ ...account, _id: result.insertedId }) });
    } catch (error) {
      if (error.code === 11000) fail(409, 'An account already uses that email.');
      throw error;
    }
  }));

  router.patch('/admin/staff/:id', admin(async (req, res, users, sites) => {
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Staff account not found.');
    const account = await users.findOneAndUpdate(
      { _id: new ObjectId(req.params.id), ...staffFilter },
      { $set: permissions(req.body, sites) },
      { projection, returnDocument: 'after' },
    );
    if (!account) fail(404, 'Staff account not found.');
    res.json({ success: true, data: staffAccount(account) });
  }));
}

module.exports = { installStaffAdmin };
