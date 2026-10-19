/**
 * Booran Motors Live Inventory CSV Ingestion Engine
 * 
 * Automates the ingestion of Pentana inventory CSV files into the
 * booran_inventory_tracker MongoDB database.
 * 
 * Features:
 * - Normalizes dealerships, branch codes, and rooftop metadata (e.g. South Morang Hyundai, South Morang Kia)
 * - Correctly handles Pentana CSV quirks (duplicate 'age' columns, missing year in new vehicle exports, MY codes)
 * - Calculates financial and holding metrics (accumulatedHoldingCost, daily holding rate)
 * - Deterministically generates action items for aging capital traps (>90 DIS)
 * - Preserves live showroom soft-holds so staff reservations are never overwritten
 * - Writes structured execution summaries to the feedlogs collection
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
if (typeof dns.setServers === 'function') {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch (_) {}
}
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const CANONICAL_ROOFTOPS = [
  {
    rooftopId: 'southmorangkia',
    name: 'South Morang Kia',
    location: 'South Morang, VIC',
    franchise: 'Kia',
    clusterId: 'cluster-hyundai-metro',
    clusterName: 'Booran Hyundai Metro Cluster',
    pentanaBranchCodes: ['70', 'SMKIA', 'KIA'],
    generalManager: 'Nathan Cole',
    dealerPrincipal: 'David Booran',
    dailyHoldingCostRate: 0.0003,
    pentanaSourceSystem: 'eraPower',
    websiteUrl: 'https://www.southmorangkia.com.au',
  },
  {
    rooftopId: 'southmoranghyundai',
    name: 'South Morang Hyundai',
    location: 'South Morang, VIC',
    franchise: 'Hyundai',
    clusterId: 'cluster-hyundai-metro',
    clusterName: 'Booran Hyundai Metro Cluster',
    pentanaBranchCodes: ['40', 'MILLPK', 'SMORAN'],
    generalManager: 'Nathan Cole',
    dealerPrincipal: 'David Booran',
    dailyHoldingCostRate: 0.0003,
    pentanaSourceSystem: 'EraNet',
    websiteUrl: 'https://www.southmoranghyundai.com.au',
  },
  {
    rooftopId: 'boorancheltenham',
    name: 'Booran Cheltenham',
    location: 'Cheltenham, VIC',
    franchise: 'Multi-Franchise',
    clusterId: 'cluster-cheltenham',
    clusterName: 'Booran Cheltenham Cluster',
    pentanaBranchCodes: ['01', 'CHELT', 'CHELTI', 'CHELTH', 'SOCH', 'YYARD', 'IYARD', 'KYARD', 'SYARD', 'TRANSIT', 'DUE', 'SKODA', 'HYARD'],
    generalManager: 'Brett Harrison',
    dealerPrincipal: 'Paul Booran',
    dailyHoldingCostRate: 0.0003,
    pentanaSourceSystem: 'eraPower',
    websiteUrl: 'https://www.boorancheltenham.com.au',
  },
  {
    rooftopId: 'cranbournehyundai',
    name: 'Cranbourne Hyundai',
    location: 'Cranbourne, VIC',
    franchise: 'Hyundai',
    clusterId: 'cluster-hyundai-metro',
    clusterName: 'Booran Hyundai Metro Cluster',
    pentanaBranchCodes: ['20', 'CRANHOL', 'CRAN', 'CYCRANHOL', 'CRCH', 'CYDB'],
    generalManager: 'Sarah Jenkins',
    dealerPrincipal: 'David Booran',
    dailyHoldingCostRate: 0.0003,
    pentanaSourceSystem: 'eraPower',
    websiteUrl: 'https://www.cranbournehyundai.com.au',
  },
  {
    rooftopId: 'berwickmg',
    name: 'Berwick MG Hyundai',
    location: 'Berwick, VIC',
    franchise: 'MG / Hyundai',
    clusterId: 'cluster-hyundai-metro',
    clusterName: 'Booran Hyundai Metro Cluster',
    pentanaBranchCodes: ['90', 'BWHY', 'BWMG', 'BWCY', 'HYDB', 'HYDC', 'MGDB', 'MGCRANHOL'],
    generalManager: "Liam O'Connor",
    dealerPrincipal: 'David Booran',
    dailyHoldingCostRate: 0.0003,
    pentanaSourceSystem: 'eraPower',
    websiteUrl: 'https://www.berwickmg.com.au',
  },
];

function resolveRooftop(rawBranch, rawRooftopName) {
  const branch = String(rawBranch || '').trim();
  const clean = String(rawRooftopName || '').toLowerCase().replace(/[\s\-_]/g, '');

  if (branch === '70' || clean.includes('southmorangkia')) {
    return {
      rooftopId: 'southmorangkia',
      rooftopName: 'South Morang Kia',
      branchCode: '70',
      clusterId: 'cluster-hyundai-metro',
    };
  }
  if (branch === '40' || clean.includes('southmoranghyundai') || clean === 'southmorang') {
    return {
      rooftopId: 'southmoranghyundai',
      rooftopName: 'South Morang Hyundai',
      branchCode: '40',
      clusterId: 'cluster-hyundai-metro',
    };
  }
  if (branch === '01' || clean.includes('cheltenham')) {
    return {
      rooftopId: 'boorancheltenham',
      rooftopName: 'Booran Cheltenham',
      branchCode: '01',
      clusterId: 'cluster-cheltenham',
    };
  }
  if (branch === '20' || clean.includes('cranbourne')) {
    return {
      rooftopId: 'cranbournehyundai',
      rooftopName: 'Cranbourne Hyundai',
      branchCode: '20',
      clusterId: 'cluster-hyundai-metro',
    };
  }
  if (branch === '90' || clean.includes('berwick')) {
    return {
      rooftopId: 'berwickmg',
      rooftopName: 'Berwick MG Hyundai',
      branchCode: '90',
      clusterId: 'cluster-hyundai-metro',
    };
  }

  return {
    rooftopId: (clean || 'general').toLowerCase(),
    rooftopName: rawRooftopName || 'Booran Motors',
    branchCode: branch || '00',
    clusterId: 'cluster-general',
  };
}

function determineAgingBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 45) return '31-45';
  if (days <= 60) return '46-60';
  if (days <= 90) return '61-90';
  return '90+';
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

function extractYear(rawYear, description) {
  let yr = parseInt(rawYear || '0', 10);
  if (yr > 0 && yr < 100) yr += 2000;
  if (yr >= 1990 && yr <= 2040) return yr;

  if (description) {
    const myMatch = description.match(/\bMY(\d{2})\b/i);
    if (myMatch) return 2000 + parseInt(myMatch[1], 10);

    const yearMatch = description.match(/\b(20\d{2})\b/);
    if (yearMatch) return parseInt(yearMatch[1], 10);
  }

  return new Date().getFullYear();
}

function findCsvDir(customDir) {
  if (customDir && fs.existsSync(customDir)) return customDir;
  const candidates = [
    path.resolve(__dirname, '../csv_data'),
    path.resolve(__dirname, '../csv_data '),
    path.resolve(process.cwd(), 'csv_data'),
    path.resolve(process.cwd(), 'csv_data '),
    path.resolve(__dirname, '../../booran-sales-floor-backend/csv_data'),
    path.resolve(__dirname, '../../booran-sales-floor-backend/csv_data '),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function syncCsvData(options = {}) {
  const startTime = Date.now();
  const uri = process.env.MONGODB_URI_BOORAN;
  if (!uri) throw new Error('MONGODB_URI_BOORAN is not defined in environment.');

  const csvDir = findCsvDir(options.csvDir);
  if (!csvDir) {
    console.warn('⚠️  No csv_data directory found. Skipping CSV ingestion.');
    return { success: false, reason: 'csv_data directory not found' };
  }

  console.log('====================================================');
  console.log('🚗 Starting Booran Motors CSV Ingestion Engine');
  console.log(`📂 Source Directory: ${csvDir}`);
  console.log('====================================================');

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();

  try {
    // ── 1. Ensure Canonical Rooftops ──────────────────────────
    console.log('\n[1/3] Verifying and updating canonical rooftops...');
    for (const rooftop of CANONICAL_ROOFTOPS) {
      await db.collection('rooftops').updateOne(
        { rooftopId: rooftop.rooftopId },
        { $set: { ...rooftop, updatedAt: new Date() } },
        { upsert: true }
      );
    }
    console.log(`   ✅ ${CANONICAL_ROOFTOPS.length} rooftops synchronized in booran_inventory_tracker.`);

    // ── 2. Read and Parse CSVs ────────────────────────────────
    console.log('\n[2/3] Processing CSV files...');
    const files = fs.readdirSync(csvDir).filter(f => f.endsWith('.csv'));
    console.log(`   Found ${files.length} CSV files to process.`);

    const allVehicles = [];
    const actionItemsToUpsert = [];
    let totalRowsProcessed = 0;

    for (const file of files) {
      const filePath = path.join(csvDir, file);
      const filename = path.basename(file, '.csv');
      const parts = filename.split('_');
      const fileBranch = parts[0] || '';
      const fileRooftop = parts[1] || '';
      const fileFranchise = parts[2] || '';
      const fileCategory = parts[3] || 'Used';

      const rooftopInfo = resolveRooftop(fileBranch, fileRooftop);

      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length <= 1) continue;

      const rawHeaders = parseCsvLine(lines[0]);
      // Detect column indices safely, handling duplicate Pentana headers
      const headerMap = {};
      rawHeaders.forEach((h, idx) => {
        const cleanH = h.toLowerCase().trim();
        if (headerMap[cleanH] === undefined) {
          headerMap[cleanH] = [idx];
        } else {
          headerMap[cleanH].push(idx);
        }
      });

      for (let i = 1; i < lines.length; i++) {
        totalRowsProcessed++;
        const row = parseCsvLine(lines[i]);
        if (!row.length || !row.some(Boolean)) continue;

        const getVal = (names) => {
          for (const name of names) {
            const indices = headerMap[name];
            if (indices) {
              // If duplicate columns exist (e.g. Pentana 'age' columns), pick non-empty value
              for (const idx of indices) {
                const val = (row[idx] || '').trim();
                if (val) return val;
              }
            }
          }
          return '';
        };

        const stockNumber = getVal(['stock no', 'stock#', 'stockno', 'stock_no']);
        if (!stockNumber) continue;

        const rawAge = getVal(['age']);
        const age = parseInt(rawAge || '0', 10);
        const listPrice = parseFloat(getVal(['list price', 'price', 'advertised price']) || '0');
        const description = getVal(['description']);
        const carline = getVal(['carline', 'model']);
        const rego = getVal(['reg no', 'fa', 'rego', 'plate']);
        const colour = getVal(['colour', 'color']);
        const odometer = parseInt(getVal(['odometer', 'odo', 'km']) || '0', 10);
        const loc = getVal(['loc', 'dest loc']);
        const rawStatus = (getVal(['status']) || '').toUpperCase();
        const openRoPo = getVal(['open ro/po', 'open_ro_po']);
        const dealNumber = getVal(['deal', 'deal no']);

        const year = extractYear(getVal(['year']), description);
        const make = fileFranchise === 'ALLMAKES'
          ? (carline.split(' ')[0] || 'Unknown')
          : (fileFranchise || 'Unknown');
        const model = carline || description.split(' ')[0] || 'Vehicle';

        const dateInStock = new Date();
        dateInStock.setDate(dateInStock.getDate() - age);

        const holdingCostRate = 0.0003;
        const totalStockCost = listPrice;
        const holdingCostPerDay = Math.round(totalStockCost * holdingCostRate);
        const accumulatedHoldingCost = Math.round(holdingCostPerDay * age);

        let status = 'IN-STOCK';
        if (rawStatus === 'WHOLESALE') status = 'WHOLESALE';
        else if (rawStatus) status = rawStatus;

        const isOver90 = age > 90;
        let actionReason = '';
        let recommendedAction = 'NONE';

        if (isOver90) {
          actionReason = `Capital trap: ${age} DIS exceeds 90-day wholesale threshold. $${accumulatedHoldingCost} holding cost consumed.`;
          recommendedAction = 'WHOLESALE';
        } else if (age > 60 && fileCategory === 'New') {
          actionReason = `Aging new unit (${age} DIS). Margin compression requires price review.`;
          recommendedAction = 'PRICE';
        }

        let category = fileCategory;
        if (rawStatus === 'DEMO') category = 'Demo';
        else if (rawStatus === 'LOANER') category = 'Loaner';

        const vehicleDoc = {
          stockNumber,
          vin: stockNumber,
          rooftopId: rooftopInfo.rooftopId,
          rooftopName: rooftopInfo.rooftopName,
          branchCode: rooftopInfo.branchCode,
          clusterId: rooftopInfo.clusterId,
          franchise: fileFranchise,
          rego,
          year,
          make,
          model,
          variant: description,
          description,
          colour,
          odometer,
          category,
          vehicleCost: totalStockCost,
          totalStockCost,
          advertisedPrice: listPrice > 0 ? listPrice : null,
          holdingCostPerDay,
          accumulatedHoldingCost,
          status,
          dateInStock,
          daysInStock: age,
          agingBucket: determineAgingBucket(age),
          frontlineReady: status !== 'WHOLESALE' && status !== 'DEAL PEND',
          hasOpenRoPo: openRoPo === 'Y',
          destLoc: loc,
          dealNumber,
          recommendedAction,
          actionReason,
          pentanaSource: 'eraPower',
          updatedAt: new Date(),
        };

        allVehicles.push(vehicleDoc);

        if (isOver90 || recommendedAction !== 'NONE') {
          actionItemsToUpsert.push({
            stockNumber,
            vin: stockNumber,
            vehicleTitle: `${year} ${make} ${model}`,
            actionType: recommendedAction,
            rooftopId: rooftopInfo.rooftopId,
            rooftopName: rooftopInfo.rooftopName,
            targetRooftopName: '',
            reason: actionReason,
            impactMetric: isOver90 ? `Free up $${Math.round(totalStockCost)} capital` : 'Align market pricing',
            priority: isOver90 ? 'high' : 'medium',
            status: 'open',
            updatedAt: new Date(),
          });
        }
      }
    }

    console.log(`   ✅ Parsed ${allVehicles.length} vehicles from CSV files.`);

    // ── 3. Bulk Upsert into MongoDB ───────────────────────────
    console.log('\n[3/3] Synchronizing with MongoDB...');
    const batchSize = 250;
    let upsertedCount = 0;
    let modifiedCount = 0;

    await db.collection('vehicles').createIndex({ stockNumber: 1 }, { unique: true, background: true });

    for (let i = 0; i < allVehicles.length; i += batchSize) {
      const batch = allVehicles.slice(i, i + batchSize);
      const ops = batch.map((vehicle) => {
        // Exclude softHold from update so active staff reservations are preserved
        const setDoc = { ...vehicle };
        delete setDoc.softHold;

        return {
          updateOne: {
            filter: { stockNumber: vehicle.stockNumber },
            update: {
              $set: setDoc,
              $setOnInsert: {
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        };
      });

      const res = await db.collection('vehicles').bulkWrite(ops, { ordered: false });
      upsertedCount += res.upsertedCount || 0;
      modifiedCount += res.modifiedCount || 0;
    }

    // Sync Action Items
    let actionsUpserted = 0;
    if (actionItemsToUpsert.length > 0) {
      await db.collection('actionitems').createIndex({ stockNumber: 1, actionType: 1 }, { background: true });

      const actionOps = actionItemsToUpsert.map((item) => {
        const setDoc = { ...item };
        delete setDoc.status; // Preserve existing resolutions or in-progress status

        return {
          updateOne: {
            filter: { stockNumber: item.stockNumber, actionType: item.actionType },
            update: {
              $set: setDoc,
              $setOnInsert: {
                status: 'open',
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        };
      });

      for (let i = 0; i < actionOps.length; i += batchSize) {
        const batch = actionOps.slice(i, i + batchSize);
        const res = await db.collection('actionitems').bulkWrite(batch, { ordered: false });
        actionsUpserted += (res.upsertedCount || 0) + (res.modifiedCount || 0);
      }
    }

    const durationMs = Date.now() - startTime;
    const totalInDb = await db.collection('vehicles').countDocuments();
    const openActionsCount = await db.collection('actionitems').countDocuments({ status: 'open' });

    // Record in feedlogs
    const logDoc = {
      feedType: 'CSV_INGESTION',
      scheduledWindow: 'Automated CSV Import',
      status: 'SUCCESS',
      totalPentanaRows: totalRowsProcessed,
      totalWebsiteRows: allVehicles.length,
      reconciledCount: allVehicles.length,
      quarantinedCount: 0,
      newArrivalsCount: upsertedCount,
      soldExitsCount: 0,
      priceChangesCount: modifiedCount,
      durationMs,
      notes: `Successfully ingested ${allVehicles.length} vehicles from ${files.length} CSVs. New: ${upsertedCount}, Updated: ${modifiedCount}. Open action items: ${openActionsCount}.`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection('feedlogs').insertOne(logDoc);

    console.log('\n====================================================');
    console.log('🎉 CSV Ingestion Complete!');
    console.log(`⏱️  Duration: ${durationMs}ms`);
    console.log(`📦 New Vehicles Inserted: ${upsertedCount}`);
    console.log(`🔄 Existing Vehicles Updated: ${modifiedCount}`);
    console.log(`🎯 Total Vehicles in DB: ${totalInDb}`);
    console.log(`⚡ Action Items Synced: ${actionsUpserted}`);
    console.log('====================================================\n');

    return {
      success: true,
      filesProcessed: files.length,
      vehiclesProcessed: allVehicles.length,
      inserted: upsertedCount,
      updated: modifiedCount,
      totalInDb,
      actionsSynced: actionsUpserted,
      durationMs,
    };
  } finally {
    await client.close();
  }
}

function startCsvWatcher(options = {}) {
  const csvDir = findCsvDir(options.csvDir);
  if (!csvDir) {
    console.warn('⚠️  No csv_data directory found to watch.');
    return null;
  }

  let isSyncing = false;
  let syncScheduled = false;
  let debounceTimer = null;
  const debounceMs = options.debounceMs || 2500;

  const triggerSync = async (reason = 'file change') => {
    if (isSyncing) {
      syncScheduled = true;
      return;
    }
    isSyncing = true;
    try {
      console.log(`\n🔄 [CSV Watcher] Change detected (${reason}), running automated CSV sync...`);
      await syncCsvData({ csvDir });
    } catch (err) {
      console.error('❌ [CSV Watcher] Auto-sync failed:', err.message);
    } finally {
      isSyncing = false;
      if (syncScheduled) {
        syncScheduled = false;
        triggerSync('queued changes');
      }
    }
  };

  console.log(`👀 [CSV Watcher] Monitoring directory for changes: ${csvDir}`);
  let watcher = null;
  try {
    watcher = fs.watch(csvDir, (eventType, filename) => {
      if (!filename || filename.endsWith('.csv')) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          triggerSync(`event ${eventType} on ${filename || 'csv'}`);
        }, debounceMs);
      }
    });
  } catch (err) {
    console.warn('⚠️ [CSV Watcher] Could not attach fs.watch:', err.message);
  }

  const intervalMinutes = options.intervalMinutes || parseInt(process.env.CSV_SYNC_INTERVAL_MINUTES || '30', 10);
  let interval = null;
  if (intervalMinutes > 0) {
    const ms = intervalMinutes * 60 * 1000;
    interval = setInterval(() => {
      triggerSync(`periodic interval (${intervalMinutes}m)`);
    }, ms);
    if (interval.unref) interval.unref();
  }

  return {
    csvDir,
    watcher,
    interval,
    stop: () => {
      if (watcher) watcher.close();
      if (interval) clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const isWatch = args.includes('--watch') || args.includes('-w');
  const customDir = args.find((a) => !a.startsWith('-'));

  syncCsvData({ csvDir: customDir })
    .then(() => {
      if (isWatch) {
        startCsvWatcher({ csvDir: customDir });
        console.log('📡 CSV Watcher active. Press Ctrl+C to stop watching.');
      } else {
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('❌ Ingestion failed:', err);
      process.exit(1);
    });
}

module.exports = { syncCsvData, startCsvWatcher, resolveRooftop, CANONICAL_ROOFTOPS };
