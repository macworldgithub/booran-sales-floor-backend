const {test}=require('node:test'),assert=require('node:assert/strict');
const {processVideoJobs}=require('../lib/video-jobs');
test('video renders run with bounded parallelism and retain independent success/failure state',async()=>{
  const rows=[{_id:'one',status:'processing'},{_id:'two',status:'processing'},{_id:'three',status:'processing'}];let limit,active=0,peak=0;
  const collection={find(){return{sort(){return this;},limit(value){limit=value;return this;},async toArray(){return rows.slice(0,limit);}};},async findOneAndUpdate(query,update){const row=rows.find(row=>row._id===query._id&&(!query.processing_lease||row.processing_lease===query.processing_lease));if(!row)return null;Object.assign(row,update.$set);return{...row};}};
  await processVideoJobs({collection:()=>collection},{},{concurrency:2,render:async row=>{active++;peak=Math.max(peak,active);await new Promise(setImmediate);active--;if(row._id==='two')throw Object.assign(new Error('Fixture encoding failure'),{status:503});return{branded_at:new Date().toISOString()};}});
  assert.equal(peak,2);assert.equal(rows[0].status,'ready');assert.equal(rows[1].status,'processing_failed');assert.equal(rows[2].status,'processing');
});
