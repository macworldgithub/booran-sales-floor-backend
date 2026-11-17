const {test}=require('node:test');
const assert=require('node:assert/strict');
const {groups}=require('../scripts/fold-duplicates');
const {phoneKey}=require('../lib/phone');
test('duplicate fold groups mobile and landline formats, email fallbacks and alternate numbers while retaining site boundaries',()=>{
  const site='South Morang Hyundai',lead=(id,phone,email,extra={})=>({_id:id,dealership_name:site,customer_phone:phone,customer_email:email,created_at:'2026-01-01T00:00:00Z',...extra});
  const plan=groups([lead('a','0412345678','one@example.test'),lead('b','+61412345678','',{assigned_by:'manager'}),lead('c','','one@example.test'),
    lead('d','03 9000 0000','landline@example.test'),lead('e','+61 3 9000 0000',''),lead('f','0412345678','',{dealership_name:'South Morang Kia'}),
    lead('g','0499999999','',{alternate_phones:['0412345678']}),lead('h','0488888888','one@example.test')]);
  assert.equal(plan.length,2);assert.equal(plan[0][0]._id,'b');assert.deepEqual(plan[0].map(row=>row._id).sort(),['a','b','c','g']);
  assert.deepEqual(plan[1].map(row=>row._id).sort(),['d','e']);assert.equal(phoneKey('03 9000 0000'),'61390000000');
});
