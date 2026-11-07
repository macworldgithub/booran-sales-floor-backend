const { isAllLocations, locationCondition } = require('./query');

const MANAGERS = ['super_admin', 'dealer_principal', 'general_manager', 'sales_manager', 'manager'];
const ROLES = [...MANAGERS, 'sales_consultant', 'contractor'];
const isManager = (user) => MANAGERS.includes(user?.role);
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

module.exports = { ROLES, isManager, canViewCost, accountSites, canAccessSite };
