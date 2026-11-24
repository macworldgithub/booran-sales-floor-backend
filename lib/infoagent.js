'use strict';

/**
 * InfoAgent NEVDIS Vehicle Data Client for Booran Sales Floor
 */

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

function getConfig() {
  return {
    clientId: process.env.INFOAGENT_CLIENT_ID || '',
    clientSecret: process.env.INFOAGENT_CLIENT_SECRET || '',
    baseUrl: (process.env.INFOAGENT_BASE_URL || 'https://api.dev.infoagent.com.au').replace(/\/+$/, ''),
    authUrl: (process.env.INFOAGENT_AUTH_URL || 'https://api.dev.infoagent.com.au/auth/v1/token/oauth').replace(/\/+$/, ''),
    timeoutMs: parseInt(process.env.INFOAGENT_TIMEOUT_MS || '10000', 10)
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.clientId && config.clientSecret);
}

/**
 * Retrieves cached or fresh OAuth2 Bearer token
 */
async function getAccessToken() {
  const config = getConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error('InfoAgent credentials not configured.');
  }

  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60000) {
    return tokenCache.accessToken;
  }

  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(config.authUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`InfoAgent auth failed: HTTP ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  const token = data.access_token || data.token;
  if (!token) {
    throw new Error('InfoAgent token endpoint returned no access_token.');
  }

  tokenCache = {
    accessToken: token,
    expiresAt: now + ((data.expires_in || 3600) * 1000)
  };

  return token;
}

/**
 * Normalizes live InfoAgent NEVDIS response
 */
function normalizeResponse(raw, requestedPlate, requestedState) {
  if (!raw || !raw.result || raw.result.responseCode !== 'SUCCESS') {
    return null;
  }

  const vehicle = raw.result.vehicles?.[0];
  if (!vehicle) return null;

  const ident = vehicle.identification || {};
  const ext = vehicle.extendedData || {};
  const age = vehicle.vehicleAge || {};
  const rego = vehicle.registration || {};
  const stolen = vehicle.stolenInfo || {};
  const wovr = vehicle.writtenOffInfo || {};

  const stolenIncidents = Array.isArray(stolen.incidents) ? stolen.incidents : [];
  const wovrIncidents = Array.isArray(wovr.incidents) ? wovr.incidents : [];

  const isStolen = stolenIncidents.length > 0 || Boolean(stolen.isStolen);
  const isWrittenOff = wovrIncidents.length > 0 || Boolean(wovr.isWrittenOff);

  const warnings = [];
  if (isWrittenOff) {
    const code = wovrIncidents[0]?.writtenOffCode || 'RECORDED_ON_WOVR';
    warnings.push(`WRITTEN-OFF ALERT: Vehicle recorded on WOVR register (${code})`);
  }
  if (isStolen) {
    const jur = stolenIncidents[0]?.jurisdiction || ident.state || 'AU';
    warnings.push(`POLICE STOLEN ALERT: Vehicle reported stolen in jurisdiction ${jur}`);
  }

  const regoStatus = String(rego.status || '').toUpperCase() || 'UNKNOWN';
  if (regoStatus.includes('EXPIRED') || regoStatus.includes('UNREGISTERED')) {
    warnings.push(`REGISTRATION ALERT: Vehicle registration is ${regoStatus}`);
  }

  const year = typeof age.yearOfManufacture === 'number' ? age.yearOfManufacture : null;
  const make = (ext.makeDescription || ext.makeCode || '').trim();
  const model = (ext.modelDescription || ext.modelCode || '').trim();

  return {
    rego: (ident.plate || requestedPlate || '').toUpperCase(),
    state: (ident.state || requestedState || 'VIC').toUpperCase(),
    vin: (ident.vin || '').toUpperCase(),
    make,
    model,
    year,
    compliancePlate: age.compliancePlate || null,
    bodyType: ext.bodyType || '',
    vehicleType: ext.vehicleType || '',
    colour: ext.colour || '',
    engineNumber: ext.engineNumber || '',
    registration: {
      status: regoStatus,
      expiryDate: rego.expiryDate || null
    },
    riskFlags: {
      isStolen,
      isWrittenOff,
      stolenIncidents,
      writtenOffIncidents: wovrIncidents
    },
    warnings,
    source: 'InfoAgent NEVDIS'
  };
}

/**
 * Looks up vehicle by Plate + State via InfoAgent NEVDIS
 */
async function lookupVehicle({ rego, state = 'VIC' }) {
  const config = getConfig();
  const token = await getAccessToken();

  const response = await fetch(`${config.baseUrl}/nevdis/v1/vehicle-report`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      plate: String(rego).trim().toUpperCase(),
      state: String(state).trim().toUpperCase(),
      products: [
        'VEHICLE_AGE',
        'EXTENDED_DATA',
        'HIGH_PERFORMANCE_INFO',
        'REGISTRATION',
        'STOLEN_INFO',
        'WRITTEN_OFF_INFO'
      ]
    }),
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`InfoAgent lookup failed: HTTP ${response.status} - ${errorText}`);
  }

  const raw = await response.json();
  return normalizeResponse(raw, rego, state);
}

/**
 * Looks up vehicle by VIN via InfoAgent NEVDIS
 */
async function lookupByVin({ vin }) {
  const config = getConfig();
  const token = await getAccessToken();

  const response = await fetch(`${config.baseUrl}/nevdis/v1/vehicle-report`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      vin: String(vin).trim().toUpperCase(),
      products: [
        'VEHICLE_AGE',
        'EXTENDED_DATA',
        'HIGH_PERFORMANCE_INFO',
        'REGISTRATION',
        'STOLEN_INFO',
        'WRITTEN_OFF_INFO'
      ]
    }),
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`InfoAgent VIN lookup failed: HTTP ${response.status} - ${errorText}`);
  }

  const raw = await response.json();
  return normalizeResponse(raw);
}

module.exports = {
  isConfigured,
  lookupVehicle,
  lookupByVin,
  normalizeResponse,
  getConfig
};
