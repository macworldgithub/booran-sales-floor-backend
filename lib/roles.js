const { isAllLocations, locationCondition } = require('./query');

const MANAGERS = ['super_admin', 'dealer_principal', 'general_manager', 'sales_manager', 'manager'];
const ROLES = [...MANAGERS, 'sales_consultant', 'contractor'];
const isManager = (user) => MANAGERS.includes(user?.role);
// Managers may receive their own leads under the 16 November scope. Legacy
// allocation_only flags remain readable without blocking manager self-assignment.
const allocationOnly = user => !isManager(user) && (user?.allocation_only === true || user?.allocationOnly === true);
const canReceiveLeads = user => Boolean(user && ROLES.includes(user.role) && user.role !== 'contractor' && !allocationOnly(user));
const canViewCost = (user) => isManager(user) || user?.viewCost === true;

function accountSites(user) {
  const sites = user?.allowedSites ?? [user?.site];
  return Array.isArray(sites) ? [...new Set(sites.filter(site => typeof site === 'string' && !isAllLocations(site) && site !== '*'))] : [];
}

function canAccessSite(user, site) {
  return user?.role === 'super_admin' || (typeof site === 'string' && accountSites(user).some(allowed => {
    const { $regex, $options } = locationCondition(allowed);
    return new RegExp($regex, $options).test(site);
  }));
}

module.exports = { ROLES, isManager, allocationOnly, canReceiveLeads, canViewCost, accountSites, canAccessSite };
