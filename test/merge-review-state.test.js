const {test}=require('node:test'),assert=require('node:assert/strict'),{ObjectId}=require('mongodb');
const {mergeReviewState}=require('../lib/merge-review-state');
test('merge candidate lookups use a transaction session sequentially, including retired alias chains',async()=>{
 const site='Fixture dealership',session={},primary={_id:new ObjectId(),dealership_name:site},alias={_id:new ObjectId(),dealership_name:site,merged_into:null},second={_id:new ObjectId(),dealership_name:site};alias.merged_into=String(primary._id);
 const rows=[primary,alias,second];let active=0,peak=0;
 const db={collection:()=>({findOne:async(query,options)=>{assert.equal(options.session,session);peak=Math.max(peak,++active);await new Promise(setImmediate);active--;return rows.find(row=>String(row._id)===String(query._id))||null;}})};
 const result=await mergeReviewState(db,db,{dealership:site,incoming:{},candidate_ids:[String(alias._id),String(primary._id),String(second._id)]},session);
 assert.equal(peak,1);assert.equal(result.candidates.length,2);assert.equal(result.candidates[0],primary);
});
