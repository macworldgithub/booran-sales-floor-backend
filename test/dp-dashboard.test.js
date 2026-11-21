const { test } = require('node:test');
const assert = require('node:assert/strict');
const { windowFor, defaultSettings } = require('../lib/dp/common');
const { salesEvents, salesMetrics } = require('../lib/dp/sales');
const { serviceMetrics } = require('../lib/dp/service');
const { inventoryMetrics } = require('../lib/dp/inventory');
const { serviceInput, settingsInput } = require('../lib/dp/validation');
const { validateSales, importSales, pullSales } = require('../lib/dp/connectors');
const now = new Date('2026-11-20T03:00:00Z'), range = windowFor({period:'mtd'},now), at = '2026-11-10T01:00:00Z';
const lead = {_id:'lead',dealership_name:'Site A',created_at:'2026-11-02T00:00:00Z',status:'sold',sold_at:at,owner_id:'rep',owner_name:'Rep',vehicle_make:'Hyundai',vehicle_model:'Tucson'};
test('DP reporting supports Melbourne MTD/YTD and validates full-year custom ranges',()=>{
  assert.equal(range.from,'2026-10-31T13:00:00.000Z');assert.equal(range.days,20);
  assert.equal(windowFor({period:'ytd'},now).first,'2026-01-01');
  assert.equal(windowFor({period:'custom',from:'2026-03-01',to:'2026-11-20'},now).days,265);
  for(const query of [{period:'custom',from:'2026-02-31',to:'2026-03-01'},{period:'custom',from:'2020-01-01',to:'2026-11-20'},{period:'custom',from:'2026-11-20',to:'2026-11-21'}])assert.throws(()=>windowFor(query,now),error=>error.status===400);
});
test('DMS and local sales deduplicate without inventing missing gross and include directly Sold prospects',()=>{
  const deal={_id:'deal',lead_id:'lead',dealership:'Site A',status:'completed',completed_at:at,owner_id:'rep',gross_cents:10000,vin:'VIN123'};
  const events=salesEvents({leads:[lead],deals:[deal],vehicles:[],feedSales:[{_id:'dms',dealership:'Site A',date:at,status:'completed',leadId:'lead',vin:'VIN123',grossCents:12000,units:1}]});
  assert.equal(events.length,1);assert.equal(events[0].grossCents,12000);
  const result=salesMetrics(events,[lead],{...defaultSettings(),monthlyUnitsTarget:30},range);
  assert.equal(result.units,1);assert.equal(result.grossCents,12000);assert.equal(result.financialCoverage,100);assert.equal(result.conversion,100);
  const direct=salesMetrics(salesEvents({leads:[lead],deals:[],feedSales:[],vehicles:[]}),[lead],defaultSettings(),range);
  assert.equal(direct.units,1);assert.equal(direct.grossCents,null);assert.equal(direct.financialCoverage,0);assert.equal(direct.signal,'unknown');
});
test('weighted service KPIs use source samples, distinguish missing from zero and evaluate thresholds',()=>{
  const records=[{date:'2026-11-10',department:'Service',csiPoints:900,csiResponses:10,productiveHours:8,availableHours:10,repairHours:4,repairs:2,revenueCents:50000,retainedCustomers:7,eligibleCustomers:10},
    {date:'2026-11-11',department:'Warranty',csiPoints:50,csiResponses:1,claimsOpened:2,claimsClosed:1,claimCycleHours:48,claimCycleSamples:1}];
  const result=serviceMetrics(records,[],defaultSettings().serviceTargets,range);
  assert.equal(result.csi,86.36);assert.equal(result.technicianEfficiency,80);assert.equal(result.averageRepairHours,2);assert.equal(result.claimCycleDays,2);assert.equal(result.retention,70);assert.equal(result.health,'red');
  const empty=serviceMetrics([],[],defaultSettings().serviceTargets,range);assert.equal(empty.csi,null);assert.equal(empty.revenueCents,null);assert.equal(empty.health,'unknown');
  const zero=serviceMetrics([{date:'2026-11-10',department:'Service',revenueCents:0}],[],defaultSettings().serviceTargets,range);assert.equal(zero.revenueCents,0);
});
test('inventory categories, book-value coverage, days supply and aging actions use real stock and sales',()=>{
  const vehicles=[{_id:'one',rooftopName:'Site A',make:'Hyundai',model:'Tucson',category:'New',status:'In Stock',vehicleCost:10000,daysInStock:95},
    {_id:'two',rooftopName:'Site A',make:'Hyundai',model:'Tucson',category:'Used',status:'In Stock',daysInStock:40},
    {_id:'sold',rooftopName:'Site A',status:'Sold',vehicleCost:5000,daysInStock:12}];
  const events=[{at:'2026-11-10T00:00:00Z',category:'New',make:'Hyundai',model:'Tucson',units:1}];
  const result=inventoryMetrics(vehicles,events,[],defaultSettings(),range,now);
  assert.equal(result.units,2);assert.equal(result.valueCents,1000000);assert.equal(result.valueCoverage,50);assert.equal(result.daysSupply,60);
  assert.equal(result.categories.find(row=>row.category==='Used').daysSupply,null);assert.equal(result.aging.length,1);assert.match(result.aging[0].action,/wholesale/);
});

test('sales reconciliation preserves multiple real vehicles for one customer and enriches incomplete feed financials',()=>{
  const deals=['VIN1','VIN2'].map((vin,index)=>({_id:'deal'+index,lead_id:'lead',dealership:'Site A',status:'completed',completed_at:at,vin,gross_cents:10000}));
  const events=salesEvents({leads:[lead],deals,vehicles:[],feedSales:[{_id:'feed',dealership:'Site A',date:at,vin:'VIN1',status:'completed',units:1}]},now);
  assert.equal(events.length,2);assert.equal(events.find(row=>row.vin==='VIN1').grossCents,10000);
  const metrics=salesMetrics(events,[lead],defaultSettings(),range);
  assert.equal(metrics.units,2);assert.equal(metrics.wins,1);assert.equal(metrics.closeRatio,100);
  const historical=windowFor({period:'custom',from:'2026-11-01',to:'2026-11-05'},now);
  assert.equal(salesMetrics([], [{...lead,sold_at:null}],defaultSettings(),historical).conversionNumerator,0);
});

test('unknown inventory dates remain unknown rather than fabricating zero-day stock or carrying costs',()=>{
  const result=inventoryMetrics([{_id:'unknown',rooftopName:'Site A',status:'In Stock',vehicleCost:10000}],[],[],defaultSettings(),range,now);
  assert.equal(result._rows[0].days,null);assert.equal(result._rows[0].carryingCents,null);
  assert.equal(result.buckets.find(row=>row.label==='Unknown age').units,1);
  assert.equal(result.buckets[0].units,0);
});

test('observed inventory turnover requires 30 complete site balances and daily captures are retry-safe',async()=>{
  const {inventoryTurn,captureInventorySnapshot}=require('../lib/dp/snapshots'),{shiftDay}=require('../lib/dp/common');
  const rows=Array.from({length:30},(_,index)=>({date:shiftDay(range.today,-index),dealership:'Site A',units:index%2?10:20}));
  assert.equal(inventoryTurn(rows.slice(1),['Site A'],range.today,15).annualizedTurn,null);
  assert.equal(inventoryTurn(rows,['Site A','Site B'],range.today,15).snapshotDays,0);
  const result=inventoryTurn(rows,['Site A'],range.today,15);assert.equal(result.averageInventory,15);assert.equal(result.annualizedTurn,12.17);
  const writes=[],records={vehicles:[{_id:'one',rooftopName:'Site A',status:'In Stock'},{_id:'two',rooftopName:'Site A',status:'Sold'},{_id:'three',rooftopName:'Site A',status:'In Stock'}],deals:[{stock_key:'three'}],rooftops:[{name:'Site A'},{name:'Site B'}]};
  const db={collection:name=>({find:()=>({limit:()=>({toArray:async()=>records[name]||[]})}),bulkWrite:async rows=>writes.push(rows)})};
  await captureInventorySnapshot(db,db,now);await captureInventorySnapshot(db,db,now);
  assert.equal(writes[0][0].updateOne.update.$set.units,1);assert.equal(writes[0][1].updateOne.update.$set.units,0);
  assert.equal(writes[0][0].updateOne.filter._id,writes[1][0].updateOne.filter._id);
});
test('service and settings validation enforce real denominators, integer money and safe custom metric definitions',()=>{
  assert.equal(serviceInput({date:'2026-11-10',department:'Service',csiPoints:900,csiResponses:10}).csiPoints,900);
  for(const input of [{csiPoints:50},{csiPoints:101,csiResponses:1},{retainedCustomers:2,eligibleCustomers:1},{repairHours:2,repairs:0},{revenueCents:1.2}])assert.throws(()=>serviceInput({date:'2026-11-10',department:'Service',...input}),error=>error.status===400);
  assert.throws(()=>settingsInput({daysSupplyMin:90,daysSupplyMax:30}),error=>error.status===400);
  assert.throws(()=>settingsInput({customKpis:[{title:'Unsafe',metric:'$where',direction:'above',target:1}]}),error=>error.status===400);
});
test('sales imports validate complete batches before writing and retain deterministic identity for retries',async()=>{
  const records=[{externalId:'x',site:'Site A',date:at,grossCents:-1000}],writes=[];
  const db={collection:()=>({bulkWrite:async operations=>writes.push(operations)})};
  await importSales(db,records,['Site A'],'manager');await importSales(db,records,['Site A'],'manager');
  assert.equal(writes[0][0].updateOne.filter._id,writes[1][0].updateOne.filter._id);
  await assert.rejects(importSales(db,[...records,{...records[0],site:'Other tenant'}],['Site A'],'manager'),error=>error.status===403);
  assert.equal(writes.length,2);assert.throws(()=>validateSales([{...records[0],revenueCents:1.5}],['Site A']),error=>error.status===400);
});
test('optional DMS feed follows bounded cursors without forwarding tokens on redirects or allowing foreign sites',async()=>{
  const pages=[],writes=[];const db={collection:()=>({bulkWrite:async rows=>writes.push(rows)})};
  const result=await pullSales(db,['Site A'],'manager',{DP_DMS_FEED_URL:'https://dms.example.test/sales',DP_DMS_FEED_TOKEN:'fixture-token'},async(url,options)=>{
    pages.push({url,options});return Response.json({records:[{externalId:'sale-'+pages.length,site:'Site A',date:at}],nextCursor:pages.length===1?'page-two':null});
  });
  assert.equal(result.processed,2);assert.equal(pages[1].url.searchParams.get('cursor'),'page-two');assert.equal(pages[0].options.redirect,'error');assert.equal(writes.length,1);
  await assert.rejects(pullSales(db,['Site A'],'manager',{DP_DMS_FEED_URL:'http://bad.test',DP_DMS_FEED_TOKEN:'secret'}),error=>error.status===503);
});
