// Nexgate client shared by the export CLI and Sales Floor reconciliation.
const path = require('node:path');
const CUSTOMER_URL = "https://customer-api-public.prod.trade.au.csnglobal.net/api/v1/customer";
const REFRESH_URL = "https://public-seamless-api.prod.trade.au.csnglobal.net/carsales/v3/Token/refresh";
const DEALERSHIPS = [
  ["South Morang Kia New", "dd12b80a-3007-8c7d-26e4-87d378a03f43"],
  ["South Morang Kia Used", "9bed642e-b19c-6e35-ff35-fe96c727c30e"],
  ["South Morang Hyundai", "6ef15536-687c-9a6d-cbaa-d3f3dc2b1e98"],
  ["South Morang Hyundai Used", "a5f988d7-207d-0369-ff9f-28af166bf036"],
  ["South Morang Chery", "c36715d8-c304-7d4d-61f7-e01936c03c65"],
];

function loadLocalNexgateEnvironment() {
  if (process.env.NEXGATE_TOKEN) return;
  try { process.loadEnvFile(path.join(__dirname, '..', '..', 'booran-leads', '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function send(url, token, body, userId, timeout) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/plain, */*",
    origin: "https://app.nexgate.ai",
    referer: "https://app.nexgate.ai/",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (userId !== undefined) headers.userid = userId;

  try {
    return await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const host = new URL(url).hostname;
    const code = error.cause?.code || error.code || error.name;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new Error(`DNS lookup failed for ${host} (${code})`, { cause: error });
    }
    throw new Error(`HTTPS request to ${host} failed (${code})`, { cause: error });
  }
}

async function readJson(response, action) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${action} failed (HTTP ${response.status})`);
  }
  return response.json();
}

function createClient(token, { userId = process.env.NEXGATE_USER_ID, sellerGuid: configuredSellerGuid = process.env.NEXGATE_SELLER_GUID, timeout = 60_000 } = {}) {
  let refreshInFlight;

  async function refreshToken() {
    const claims = jwtClaims(token);
    const authTokenIdentifier = claims?.AuthTokenIdentifier || claims?.RefreshToken;
    const sellerGuid = claims?.SellerGuid || configuredSellerGuid;
    if (!authTokenIdentifier) throw new Error("Token cannot be refreshed. Set a current NEXGATE_TOKEN.");

    const response = await send(REFRESH_URL, token, {
      authTokenIdentifier,
      ...(sellerGuid ? { sellerGuid } : {}),
    }, undefined, timeout);
    const result = await readJson(response, "Token refresh");
    const refreshedToken = result?.tokenSummary?.token;
    if (typeof refreshedToken !== "string" || !refreshedToken) {
      throw new Error("Token refresh did not return a bearer token");
    }
    token = refreshedToken;
  }

  function refresh() {
    refreshInFlight ??= refreshToken().finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  }

  function searchUserId(body, requestToken) {
    if (body === undefined) return undefined;
    return userId || jwtClaims(requestToken)?.UserIdentifier || "";
  }

  return async function request(url, action, body) {
    const expiresAt = jwtClaims(token)?.exp;
    if (expiresAt && expiresAt * 1000 - Date.now() < 60_000) await refresh();

    const requestToken = token;
    let response = await send(url, requestToken, body, searchUserId(body, requestToken), timeout);
    if (response.status === 401) {
      await response.body?.cancel();
      if (token === requestToken) await refresh();
      response = await send(url, token, body, searchUserId(body, token), timeout);
    }
    return readJson(response, action);
  };
}

function customerLeads(customer) {
  return [customer.lead, ...(customer.otherLeads || [])].filter(Boolean);
}

async function addComments(request, customer) {
  let unavailable = 0;
  for (const lead of customerLeads(customer)) {
    let latestLead;
    if (customer.id && lead.id) {
      const url = `${CUSTOMER_URL}/${encodeURIComponent(customer.id)}/leads/${encodeURIComponent(lead.id)}`;
      try {
        const details = await request(url, "Lead details");
        latestLead = details?.latestLead;
      } catch {
        // The search record is still usable if the details request fails.
      }
    }
    if (latestLead && latestLead.id === lead.id) {
      lead.comments = latestLead.comments ?? null;
    } else {
      lead.comments ??= null;
      unavailable++;
    }
  }
  customer.comments = customer.lead?.comments ?? null;
  return unavailable;
}

async function fetchDealership(request, name, sellerIdentifier, size, includeComments, { since, deadline = Infinity, pageLimit = Infinity, onPage } = {}) {
  const customers = [];
  const seenPages = new Set();

  let oldPages = 0;
  // Search pages are customer rows. A row can hold multiple enquiries.
  for (;;) {
    if (Date.now() > deadline) throw new Error("Nexgate search exceeded its time budget");
    const from = customers.length;
    const page = await request(`${CUSTOMER_URL}/search`, `Customer search at offset ${from}`, {
      sellerIdentifier,
      keyword: null,
      from,
      size,
      filters: {},
      sortField: "leadCreatedDate",
      sortDirection: 1,
      isRestrictedUser: false,
    });
    if (!Array.isArray(page?.customers)) throw new Error(`Missing customer results at offset ${from}`);
    if (page.customers.length === 0) break;

    const pageKey = JSON.stringify(page.customers.map(customer => customer.id).sort());
    if (seenPages.has(pageKey)) throw new Error(`Search returned a repeated page at offset ${from}`);
    seenPages.add(pageKey);
    customers.push(...page.customers);
    if (onPage) await onPage(page.customers);
    // The feed is mostly newest-first, with some out-of-order rows. Read two
    // entirely older pages before stopping and overlap successive sweeps.
    if (since && page.customers.every(customer => customerLeads(customer).length &&
      customerLeads(customer).every(lead => Date.parse(lead.leadCreatedDate) < since))) oldPages++;
    else oldPages = 0;
    if (oldPages === 2 || seenPages.size >= pageLimit) break;
    if (Math.floor(customers.length / 500) > Math.floor(from / 500)) {
      console.error(`  Retrieved ${customers.length} customers so far`);
    }
  }

  let unavailableCommentCount = 0;
  if (includeComments) {
    if (customers.length > 0) console.error(`  Fetching lead comments for ${customers.length} customers…`);
    const concurrency = 5;
    for (let start = 0; start < customers.length; start += concurrency) {
      const batch = customers.slice(start, start + concurrency);
      const unavailable = await Promise.all(batch.map(customer => addComments(request, customer)));
      unavailableCommentCount += unavailable.reduce((total, count) => total + count, 0);
    }
    if (unavailableCommentCount) console.error(`  Could not verify comments for ${unavailableCommentCount} leads`);
  }

  const leadCount = customers.reduce((total, customer) => total + customerLeads(customer).length, 0);
  return {
    name,
    sellerIdentifier,
    customerCount: customers.length,
    leadCount,
    ...(includeComments ? { unavailableCommentCount } : {}),
    customers,
  };
}

module.exports = { createClient, fetchDealership, customerLeads, DEALERSHIPS, loadLocalNexgateEnvironment };
