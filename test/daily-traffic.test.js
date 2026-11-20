const {test}=require('node:test'),assert=require('node:assert/strict');
const {dailyTraffic,trafficLight}=require('../lib/daily-traffic');
const date='2026-11-20',now=new Date('2026-11-20T05:00:00Z'),at='2026-11-20T01:00:00Z';
const staff=[{_id:'a',name:'Alice',role:'sales_consultant'},{_id:'b',name:'Bob',role:'sales_consultant'},{_id:'c',name:'Charlie',role:'sales_consultant'}];
function input(){
 return {staff,leads:[
  {_id:'a1',customer_name:'A One',owner_id:'a',created_at:'2026-11-19T23:00:00Z',diary_entries:[{author_id:'a',date:at,note:'Customer update'}]},
  {_id:'a2',customer_name:'A Two',owner_id:'a',created_at:'2026-11-19T23:00:00Z',next_action:{author_id:'a',recorded_at:at,due_at:'2026-11-21T01:00:00Z',status:'open',title:'Call'}},
  {_id:'b1',customer_name:'B One',owner_id:'b',created_at:'2026-11-01T01:00:00Z',assigned_at:at,assigned_by:'m'},
  {_id:'u1',customer_name:'Unassigned',created_at:'2026-11-19T23:00:00Z'},
  {_id:'old',owner_id:'a',created_at:'2026-10-01T00:00:00Z',diary_entries:[{author_id:'a',date:at,note:'Existing customer update'}]},
 ],media:[{_id:'v1',lead_id:'a1',user_id:'a',status:'ready',content_type:'video/mp4',created_at:at}],
 messages:[{_id:'m1',lead_id:'a1',user_id:'a',status:'sent',created_at:at,attachments:[{content_type:'video/mp4',id:'v1'}]}],tasks:[],deals:[],appointments:[]};
}

test('approved Lost prospects leave active targets and have a unique daily loss count attributed to their salesperson',()=>{
 const data=input(); Object.assign(data.leads[0],{status:'lost',lost_at:at,loss_review:{status:'approved',reviewed_at:at}});
 data.tasks.push({_id:'closed-task',lead_id:'a1',assignee_id:'a',status:'open',due_at:at,createdAt:at});
 const report=dailyTraffic(data,date,now),alice=report.members.find(row=>row.id==='a');
 assert.equal(alice.newCustomers,1);assert.equal(alice.counts.lost,1);assert.equal(alice.signals.lost,'grey');
 assert.equal(report.summary.counts.lost,1);assert.equal(report._losses[0].leadId,'a1');
 assert.equal(report._tasks.length,0);assert.equal(report._diary.length,0);
});
test('traffic lights distinguish complete, partial, missing and no-workload states',()=>{
 assert.equal(trafficLight(0,0),'grey');assert.equal(trafficLight(0,2),'red');assert.equal(trafficLight(1,2),'amber');assert.equal(trafficLight(2,2),'green');
});
test('daily-new targets exclude existing-customer activity and partial actions do not imply complete customer coverage',()=>{
 const result=dailyTraffic(input(),date,now),alice=result.members.find(row=>row.id==='a'),bob=result.members.find(row=>row.id==='b'),charlie=result.members.find(row=>row.id==='c');
 assert.equal(alice.newCustomers,2);assert.equal(alice.counts.customersUpdated,2);
 assert.equal(alice.coverage.videosSent,1);assert.equal(alice.signals.videosSent,'amber');
 assert.equal(alice.coverage.nextActionsSet,1);assert.equal(alice.signals.nextActionsSet,'amber');
 assert.equal(alice.fullyCovered,0);assert.equal(alice.coverageSignal,'red');
 assert.equal(bob.newCustomers,1);assert.equal(bob.signals.videosSent,'red');
 assert.equal(charlie.newCustomers,0);assert.equal(charlie.signals.videosSent,'grey');assert.equal(charlie.signals.sales,'grey');
 assert.equal(result.summary.newCustomers,4);assert.equal(result.dailyUnassigned,1);
});
test('coverage is unique per customer, includes unassigned daily work and reaches green only when both actions are complete',()=>{
 const data=input();
 data.messages.push({...data.messages[0],_id:'duplicate'});
 let result=dailyTraffic(data,date,now);assert.equal(result.members[0].coverage.videosSent,1);
 data.leads[0].next_action={author_id:'a',recorded_at:at,due_at:'2026-11-21T00:00:00Z',status:'open'};
 data.media.push({...data.media[0],_id:'v2',lead_id:'a2'});
 data.messages.push({...data.messages[0],_id:'m2',lead_id:'a2',attachments:[{id:'v2',content_type:'video/mp4'}]});
 result=dailyTraffic(data,date,now);
 assert.equal(result.members[0].coverageSignal,'green');assert.equal(result.members[0].coveragePercent,100);
 assert.equal(result.summary.fullyCovered,2);assert.equal(result.summary.coveragePercent,50);assert.equal(result.summary.coverageSignal,'amber');
});
test('future, failed or inbound messages and unapproved schedules do not satisfy required coverage',()=>{
 const data=input();data.messages[0].status='failed';
 data.messages.push({...data.messages[0],status:'sent',direction:'inbound'}, {...data.messages[0],status:'queued',created_at:'2026-11-20T10:00:00Z'});
 data.leads[1].next_action.status='awaiting_approval';
 const result=dailyTraffic(data,date,now);assert.equal(result.members[0].coverage.videosSent,0);assert.equal(result.members[0].coverage.nextActionsSet,0);
});
test('same-day reassignment moves coverage to the final owner without changing the historical workday',()=>{
 const data=input();data.leads=[{_id:'a1',customer_name:'Assigned',owner_id:'b',created_at:'2026-11-01T00:00:00Z',diary_entries:[
  {kind:'assignment',assignee_id:'a',date:'2026-11-19T01:00:00Z'},
  {kind:'assignment',assignee_id:'b',date:at},
 ]}];
 let result=dailyTraffic(data,date,now);assert.equal(result.members[0].newCustomers,0);assert.equal(result.members[1].newCustomers,1);assert.equal(result.members[1].coverage.videosSent,1);
 result=dailyTraffic({...data,messages:[],media:[]},'2026-11-19',now);assert.equal(result.members[0].newCustomers,1);assert.equal(result.members[1].newCustomers,0);
});
test('future appointments created on the workday schedule the follow-up and overdue tasks keep an independent target',()=>{
 const data=input();data.appointments=[{leadId:'a1',createdAt:at,when:'2026-11-21T00:00:00Z',status:'Confirmed'}];
 data.tasks=[{_id:'task',assignee_id:'a',lead_id:'old',status:'open',due_at:'2026-11-19T00:00:00Z'}];
 const result=dailyTraffic(data,date,now);
 assert.equal(result.members[0].fullyCovered,1);assert.equal(result.members[0].targets.tasksCompleted,1);assert.equal(result.members[0].signals.tasksCompleted,'red');
});


test('appointment aliases cover the canonical customer and tasks due later today are daily work',()=>{
 const data=input();data.leads[0].deal_id='socket-alias';
 data.appointments=[{leadId:'socket-alias',createdAt:at,when:'2026-11-21T01:00:00Z',status:'Booked'}];
 data.tasks=[{_id:'later',assignee_id:'a',lead_id:'old',createdAt:at,due_at:'2026-11-20T09:00:00Z',status:'open'},
 {_id:'future',assignee_id:'a',lead_id:'old',createdAt:'2026-11-20T10:00:00Z',due_at:'2026-11-20T11:00:00Z',status:'open'}];
 const report=dailyTraffic(data,date,now);assert.equal(report.members[0].fullyCovered,1);assert.equal(report.members[0].targets.tasksCompleted,1);assert.equal(report.members[0].counts.nextActionsSet,2);
});

test('a salesperson historical view cannot create another salesperson row from assignment history',()=>{
 const data=input();data.viewerId='a';data.staff=[staff[0]];data.leads=[{_id:'a1',owner_id:'a',owner_name:'Alice',assigned_at:at,created_at:'2020-01-01T00:00:00Z',diary_entries:[
 {kind:'assignment',assignee_id:'b',date:'2026-11-19T01:00:00Z'},{kind:'assignment',assignee_id:'a',date:at}]}];
 const report=dailyTraffic(data,'2026-11-19',now);assert.equal(report.summary.newCustomers,0);assert.equal(report.members.length,1);assert.equal(report.members[0].id,'a');
});

test('daily sales drilldowns retain all sales even beyond the 50-event activity preview',()=>{
 const data=input();data.deals=Array.from({length:55},(_,i)=>({_id:'sale-'+i,lead_id:'a1',owner_id:'a',status:'completed',completed_at:new Date(Date.parse(at)+i*1000).toISOString()}));
 const report=dailyTraffic(data,date,now);assert.equal(report.summary.counts.sales,55);assert.equal(report._sales.length,55);assert.equal(report.members[0].events.length,50);
});


test('pending date overrides do not earn schedule credit or add due task workload',()=>{
 const data=input();data.leads[1].next_action.status='awaiting_approval';data.tasks=[{_id:'pending',kind:'next_action',assignee_id:'a',lead_id:'a2',createdAt:at,due_at:at,status:'awaiting_approval'}];
 const report=dailyTraffic(data,date,now);assert.equal(report.members[0].counts.nextActionsSet,0);assert.equal(report.members[0].coverage.nextActionsSet,0);assert.equal(report.members[0].targets.tasksCompleted,0);
});


test('completed appointments retain schedule credit and later cancellations do not rewrite earlier workdays',()=>{
 const data=input();data.appointments=[{leadId:'a1',createdAt:at,when:'2026-11-20T03:00:00Z',status:'Completed'}];
 assert.equal(dailyTraffic(data,date,now).members[0].fullyCovered,1);
 data.appointments[0].status='Cancelled';data.appointments[0].status_history=[{status:'Cancelled',at:'2026-11-21T01:00:00Z'}];
 assert.equal(dailyTraffic(data,date,new Date('2026-11-22T01:00:00Z')).members[0].fullyCovered,1);
 data.appointments[0].status_history[0].at='2026-11-20T04:00:00Z';assert.equal(dailyTraffic(data,date,now).members[0].fullyCovered,0);
});
