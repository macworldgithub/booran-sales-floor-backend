const fs = require('node:fs');
const path = require('node:path');
const { formatToPlus61 } = require('./phone');

const SUPABASE_URL = process.env.FLWUP_SUPABASE_URL || 'https://nzpuhnqobsffhcqejmgv.supabase.co';
const SUPABASE_ANON_KEY = process.env.FLWUP_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56cHVobnFvYnNmZmhjcWVqbWd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2ODQ1ODEsImV4cCI6MjEwMDI2MDU4MX0.BzvzYsh8oR3itpaoO3T-dRP7FHpRxedi6QgmSsRXB8k';

const ROOFTOPS = [
  { id: '4fbf1047-efa1-4330-9936-b268132e14dc', name: 'BYD South Morang', code: 'BOORAN-BYD' },
  { id: '5913033a-1474-448f-b15c-53668ffe3d5e', name: 'Chery South Morang', code: 'BOORAN-CHERY' },
  { id: '94d1383a-8ceb-4e36-8950-ccac5ef2e69f', name: 'South Morang Hyundai', code: 'BOORAN-HYUNDAI' },
  { id: '4b26f732-f51d-4665-9269-214024aac866', name: 'South Morang Kia', code: 'BOORAN-KIA' },
];

function parseJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const clean = token.trim().replace(/^Bearer\s+/i, '');
  const parts = clean.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function isTokenValid(token) {
  const payload = parseJwt(token);
  if (!payload || !payload.exp) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp - nowSec > 120; // At least 2 minutes remaining
}

async function refreshSupabaseToken(refreshToken) {
  if (!refreshToken) throw new Error('No refresh_token available');
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken.trim() }),
  });
  if (!res.ok) throw new Error(`Refresh failed: HTTP ${res.status}`);
  return res.json();
}

async function loginSupabase(email, password) {
  if (!email || !password) throw new Error('Email and password required for login');
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password: password.trim() }),
  });
  if (!res.ok) throw new Error(`Login failed: HTTP ${res.status}`);
  return res.json();
}

function updateEnvFile(updates) {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  try {
    let content = fs.readFileSync(envPath, 'utf8');
    for (const [key, val] of Object.entries(updates)) {
      const reg = new RegExp(`^${key}=.*$`, 'm');
      if (reg.test(content)) {
        content = content.replace(reg, `${key}=${val}`);
      } else {
        content += `\n${key}=${val}`;
      }
      process.env[key] = val;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    console.warn('Could not update .env file:', err.message);
  }
}

async function getValidFlwupToken(forcedToken) {
  if (forcedToken && typeof forcedToken === 'string' && isTokenValid(forcedToken)) {
    return forcedToken.trim().replace(/^Bearer\s+/i, '');
  }

  const existing = process.env.FLWUP_TOKEN;
  if (existing && isTokenValid(existing)) {
    return existing.trim().replace(/^Bearer\s+/i, '');
  }

  // Attempt refresh token
  const refreshToken = process.env.FLWUP_REFRESH_TOKEN;
  if (refreshToken) {
    try {
      const refreshed = await refreshSupabaseToken(refreshToken);
      if (refreshed.access_token) {
        updateEnvFile({
          FLWUP_TOKEN: refreshed.access_token,
          FLWUP_REFRESH_TOKEN: refreshed.refresh_token || refreshToken,
        });
        return refreshed.access_token;
      }
    } catch (e) {
      console.warn('Refresh token failed, trying password login:', e.message);
    }
  }

  // Attempt email & password login
  const email = process.env.FLWUP_EMAIL;
  const password = process.env.FLWUP_PASSWORD;
  if (email && password) {
    const authData = await loginSupabase(email, password);
    if (authData.access_token) {
      updateEnvFile({
        FLWUP_TOKEN: authData.access_token,
        FLWUP_REFRESH_TOKEN: authData.refresh_token || '',
      });
      return authData.access_token;
    }
  }

  // If existing is expired but we have no other choice, return it
  if (existing) return existing.trim().replace(/^Bearer\s+/i, '');
  throw new Error('No FLWUP credentials or token configured.');
}

async function fetchRooftopDashboard(rooftopId, token) {
  const baseUrl = process.env.FLWUP_BASE || 'https://flwup.com.au';
  const url = `${baseUrl}/api/dashboard?rooftop_id=${encodeURIComponent(rooftopId)}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-rooftop-id': rooftopId,
      'user-agent': 'Mozilla/5.0 (compatible; booran-flwup-sync/1.0)',
      accept: 'application/json, text/plain, */*',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch dashboard for rooftop ${rooftopId}: HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Synchronize FLWUP leads from dashboard API into MongoDB
 */
async function syncFlwupLeads(db, options = {}) {
  const startTime = Date.now();
  const token = await getValidFlwupToken(options.forcedToken);

  const rooftopsToSync = options.rooftopId
    ? ROOFTOPS.filter((r) => r.id === options.rooftopId)
    : ROOFTOPS;

  let totalDeals = 0;
  let totalUpserted = 0;
  let totalModified = 0;
  const rooftopResults = [];

  for (const rooftop of rooftopsToSync) {
    try {
      console.log(`📡 Fetching FLWUP dashboard for ${rooftop.name} (${rooftop.id})...`);
      const data = await fetchRooftopDashboard(rooftop.id, token);
      const deals = Array.isArray(data.deals) ? data.deals : [];
      console.log(`   Found ${deals.length} deals in FLWUP for ${rooftop.name}`);

      if (deals.length === 0) {
        rooftopResults.push({ rooftop: rooftop.name, deals: 0, inserted: 0, updated: 0 });
        continue;
      }

      totalDeals += deals.length;

      const batchSize = 500;
      let rooftopUpserted = 0;
      let rooftopModified = 0;

      for (let i = 0; i < deals.length; i += batchSize) {
        const batch = deals.slice(i, i + batchSize);
        const ops = batch.map((deal) => {
          const rawPhone = deal.customer_phone;
          const formattedPhone = formatToPlus61(rawPhone);

          const setDoc = {
            dealership_id: rooftop.id,
            dealership_name: rooftop.name,
            dealer_code: rooftop.code,
            owner_name: deal.rep?.full_name || 'Unassigned',
            source: 'FLWUP Dashboard',
            customer_name: (deal.customer_name || 'Anonymous Prospect').trim(),
            customer_phone: formattedPhone,
            customer_email: (deal.customer_email || '').trim().toLowerCase(),
            vehicle_make: (deal.vehicle_make || 'Unknown').trim(),
            vehicle_model: (deal.vehicle_model || '').trim(),
            vehicle_year: deal.vehicle_year || null,
            status: ['new_lead', 'following_up', 'sold', 'lost', 'returned'].includes(deal.status)
              ? deal.status
              : 'following_up',
            created_at: deal.created_at || new Date().toISOString(),
            sold_at: deal.sold_at || null,
            score: typeof deal.score === 'number' ? deal.score : undefined,
            tier: deal.tier || undefined,
            score_reasons: Array.isArray(deal.score_reasons) ? deal.score_reasons : undefined,
            channels: deal.channels || undefined,
            last_activity_at: deal.last_activity_at || undefined,
            had_contact_opportunity: true,
            updatedAt: new Date(),
          };

          // Remove undefined values
          Object.keys(setDoc).forEach((k) => setDoc[k] === undefined && delete setDoc[k]);

          return {
            updateOne: {
              filter: { deal_id: deal.id },
              update: {
                $set: setDoc,
                $setOnInsert: {
                  deal_id: deal.id,
                  ai_status: 'active',
                  diary_entries: [
                    {
                      date: new Date().toISOString(),
                      author: 'FLWUP Sync',
                      note: `Synced from FLWUP Dashboard (${rooftop.name})`,
                    },
                  ],
                  createdAt: new Date(),
                },
              },
              upsert: true,
            },
          };
        });

        const res = await db.collection('leads').bulkWrite(ops, { ordered: false });
        rooftopUpserted += res.upsertedCount || 0;
        rooftopModified += res.modifiedCount || 0;
      }

      totalUpserted += rooftopUpserted;
      totalModified += rooftopModified;
      rooftopResults.push({
        rooftop: rooftop.name,
        deals: deals.length,
        inserted: rooftopUpserted,
        updated: rooftopModified,
      });
      console.log(`   ✅ ${rooftop.name}: ${rooftopUpserted} new, ${rooftopModified} updated`);
    } catch (err) {
      console.error(`   ❌ Failed to sync ${rooftop.name}:`, err.message);
      rooftopResults.push({ rooftop: rooftop.name, error: err.message });
    }
  }

  const durationMs = Date.now() - startTime;
  const totalInDb = await db.collection('leads').countDocuments();

  // Record in feedlogs
  const logDoc = {
    feedType: 'FLWUP_LEADS_SYNC',
    scheduledWindow: 'FLWUP Dashboard API',
    status: rooftopResults.some((r) => r.error) && totalDeals === 0 ? 'ERROR' : 'SUCCESS',
    totalPentanaRows: totalDeals,
    totalWebsiteRows: totalDeals,
    reconciledCount: totalDeals,
    quarantinedCount: 0,
    newArrivalsCount: totalUpserted,
    soldExitsCount: 0,
    priceChangesCount: totalModified,
    durationMs,
    notes: `Synced ${totalDeals} leads from FLWUP dashboard across ${rooftopsToSync.length} rooftops (${totalUpserted} new, ${totalModified} updated). Total in DB: ${totalInDb}. Numbers normalized to +61 format.`,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    await db.collection('feedlogs').insertOne(logDoc);
  } catch (logErr) {
    console.warn('Could not write feedlog:', logErr.message);
  }

  return {
    success: true,
    rooftopsProcessed: rooftopsToSync.length,
    dealsProcessed: totalDeals,
    inserted: totalUpserted,
    updated: totalModified,
    totalInDb,
    durationMs,
    rooftopResults,
  };
}

module.exports = {
  syncFlwupLeads,
  getValidFlwupToken,
  ROOFTOPS,
};
