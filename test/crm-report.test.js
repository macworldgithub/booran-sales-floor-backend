const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildReport,reportWindow,drillRows,evidence,priority,active,isLeadOver60Days}=require('../lib/crm-report');
const {isLeadOver60Days:isPolicyLeadOver60Days}=require('../lib/followup-policy');
const now=new Date('2026-11-20T01:00:00Z'),window=reportWindow({date:'2026-11-20'},now);
function fixture(){
 const leads=[
  {_id:'a',dealership_name:'South Morang Hyundai',created_at:'2026-11-19T23:00:00Z',source:'Internet',status:'sold',owner_name:'Isaac',crm_contacts:[{kind:'call',outcome:'no_answer',at:'2026-11-19T23:02:00Z'},{kind:'call',outcome:'connected',at:'2026-11-19T23:04:00Z'}]},
  {_id:'b',dealership_name:'South Morang Hyundai',created_at:'2026-11-19T23:00:00Z',source:'Internet',status:'new_lead',diary_entries:[{kind:'note',date:'2026-11-19T23:01:00Z',note:'Imported note'}],crm_signals:{deposit_cents:10000,required_deposit_cents:50000}},
  {_id:'c',dealership_name:'South Morang Hyundai',created_at:'2026-11-19T23:00:00Z',source:'Internet',status:'following_up',crm_signals:{opportunity_value_cents:3500000}},
  {_id:'d',dealership_name:'South Morang Hyundai',created_at:'2026-11-18T23:00:00Z',source:'Internet',status:'lost',crm_contacts:[{kind:'call',outcome:'connected',at:'2026-11-18T23:03:00Z'}]},
 ];
 const appointments=[
  {_id:'a-show',leadId:'a',type:'Test Drive',createdAt:'2026-11-19T23:10:00Z',when:'2026-11-20T00:00:00Z',shown_at:'2026-11-20T00:00:00Z',status:'Completed'},
  {_id:'c-booked',leadId:'c',type:'Showroom Visit',createdAt:'2026-11-19T23:10:00Z',when:'2026-11-21T00:00:00Z',status:'Confirmed',confirmed:true},
  {_id:'c-repeat',leadId:'c',type:'Test Drive',createdAt:'2026-11-19T23:12:00Z',when:'2026-11-22T00:00:00Z',status:'Booked'},
 ];
 const messages=[{_id:'c-send',lead_id:'c',status:'sent',created_at:'2026-11-19T23:08:00Z'},{_id:'c-reply',lead_id:'c',direction:'inbound',event_type:'inbound',created_at:'2026-11-19T23:09:00Z'},
  {_id:'a-video',lead_id:'a',status:'delivered',created_at:'2026-11-19T23:15:00Z',attachments:[{id:'video-a',content_type:'video/mp4'}]}];
 return {leads,appointments,messages,deals:[{_id:'deal-a',lead_id:'a',status:'completed',appointment_id:'a-show',completed_at:'2026-11-20T00:30:00Z',sale_price_cents:3000000}],media:[],
  mediaEvents:[{media_id:'video-a',event:'view',created_at:'2026-11-20T00:40:00Z'}]};
}
test('CRM metrics use successful contacts and unique customer funnels, with explicitly linked close rates',()=>{
 const {report,cohort}=buildReport(fixture(),window,{},now),m=report.metrics;
 assert.equal(m.leads,3);assert.equal(m.contacted,2);assert.equal(m.contactRate.value,66.7);
 assert.equal(m.appointments,2);assert.equal(m.appointmentRate.value,100);assert.equal(m.confirmedAppointments,1);
 assert.equal(m.shows,1);assert.equal(m.showRate.value,50);assert.equal(m.closeRate.value,100);
 assert.equal(m.conversion.value,33.3);assert.equal(m.firstResponse.medianMinutes,5);assert.equal(m.firstResponse.samples,2);
 assert.equal(report.previous.leads,1);assert.equal(report.previous.firstResponse.medianMinutes,3);
 assert.equal(report.engagement.videoViewRate.value,100);
 assert.equal(report.operations.atRisk,1);assert.equal(report.operations.unactioned,1);
 assert.equal(drillRows({report,cohort,all:cohort},'contacted').length,m.contacted);
 assert.equal(report.stages.find(row=>row.stage==='sold').valueCents,3000000);
});
test('CRM contact evidence excludes notes, imports, automated sends, unmatched inbound enquiries and future timestamps',()=>{
 const lead={created_at:'2026-11-19T23:00:00Z',diary_entries:[{kind:'note',date:'2026-11-19T23:01:00Z'}],crm_contacts:[{kind:'call',outcome:'connected',at:'2026-11-21T00:00:00Z'}]};
 const ev=evidence(lead,[{_id:'auto',status:'queued',user_id:'trade-in-automation',created_at:'2026-11-19T23:03:00Z'},{_id:'initial',direction:'inbound',created_at:'2026-11-19T23:04:00Z'}],[],[],[],+now);
 assert.equal(ev.contacted,false);assert.equal(ev.firstAttempt,Infinity);
 const empty=buildReport({leads:[],messages:[],appointments:[],deals:[],media:[]},window,{},now).report;
 assert.equal(empty.metrics.contactRate.value,null);assert.equal(empty.metrics.firstResponse.medianMinutes,null);
});
test('CRM priority distinguishes payment risk and high intent and reopens after handling expires or evidence changes',()=>{
 const lead=fixture().leads[1],ev=evidence(lead,[],[],[],[],+now);
 let row=priority(lead,ev,now,{});
 assert.equal(row.state,'at_risk');assert.equal(row.reasons[0].key,'payment_mismatch');assert.equal(row.firstResponse.breached,true);
 lead.crm_handled={key:row.key,until:'2026-11-20T02:00:00Z'};assert.equal(priority(lead,ev,now,{}).handled,true);
 lead.crm_signals.deposit_cents=50000;assert.equal(priority(lead,ev,now,{}).handled,false);
 lead.crm_signals.finance_started=true;lead.first_contact_at='2026-11-19T23:01:00Z';
 assert.equal(priority(lead,evidence(lead,[],[],[],[],+now),now,{}).state,'opportunities');
});
test('CRM historical contact and video telemetry are not inferred from current counters or duplicate messages',()=>{
 const data=fixture();data.messages.push({...data.messages[0]});data.media=[{_id:'video-a',lead_id:'a',views:25,last_viewed_at:'2026-11-22T01:00:00Z'}];
 let result=buildReport(data,window,{},now);assert.equal(result.report.metrics.contacted,2);assert.equal(result.report.engagement.videoViewRate.value,100);
 data.mediaEvents=[];result=buildReport(data,window,{},now);assert.equal(result.report.engagement.videoViewRate.value,0);
 data.deals[0].appointment_id=null;assert.equal(buildReport(data,window,{},now).report.metrics.closeRate.value,0);
});
test('CRM reporting windows validate input and use Melbourne DST boundaries',()=>{
 const october=reportWindow({from:'2026-10-03',to:'2026-10-05'},now);
 assert.equal(october.days,3);assert.equal(october.from,'2026-10-02T14:00:00.000Z');assert.equal(october.to,'2026-10-05T13:00:00.000Z');
 assert.throws(()=>reportWindow({from:'2026-01-01',to:'2026-11-20'},now),/1–90/);
 assert.throws(()=>reportWindow({from:'2026-11-21',to:'2026-11-22'},now));
 assert.throws(()=>reportWindow({date:'2026-02-30'},now));
});
test('canonical sold outcomes count once and undated outcomes are not invented for historical periods',()=>{
 const data=fixture();data.deals=[];let result=buildReport(data,window,{},now);
 assert.equal(result.report.metrics.sales,1);assert.equal(result.report.dataQuality.salesFromLeadStatus,1);
 data.leads[0].sold_at='2026-11-21T00:00:00Z';result=buildReport(data,window,{},now);assert.equal(result.report.metrics.sales,0);
 const prior=reportWindow({date:'2026-11-19'},now);data.leads[3].status='sold';result=buildReport(data,prior,{},now);assert.equal(result.report.metrics.sales,0);
});
test('an agreed future follow-up does not create a stalled-contact alert before it is due',()=>{
 const lead={_id:'future',status:'following_up',created_at:'2026-11-14T00:00:00Z',first_contact_at:'2026-11-15T00:00:00Z',next_action:{title:'Customer requested next week',status:'open',due_at:'2026-11-24T00:00:00Z'}};
 const ev=evidence(lead,[],[],[],[],+now);
 assert.equal(priority(lead,ev,now,{}).state,'in_play');
 lead.next_action.due_at='2026-11-19T00:00:00Z';
 assert.equal(priority(lead,ev,now,{}).state,'at_risk');
 assert.ok(priority(lead,ev,now,{}).reasons.some(reason=>reason.key==='followup_overdue'));
});
test('leads over 60 days old are marked not active and have all actions removed', () => {
  const oldDate = new Date(+now - 65 * 86400000).toISOString();
  const oldLead = {
    _id: 'old-1',
    dealership_name: 'South Morang Hyundai',
    created_at: oldDate,
    source: 'Internet',
    status: 'new_lead',
    next_action: { title: 'Old follow-up', status: 'open', due_at: oldDate }
  };
  const ev = evidence(oldLead, [], [], [], [], +now);
  assert.equal(isLeadOver60Days(oldLead, ev.origin, now), true);
  assert.equal(isPolicyLeadOver60Days(oldLead, now), true);
  assert.equal(active(oldLead, ev.origin, now), false);

  const prio = priority(oldLead, ev, now, {});
  assert.equal(prio.state, 'inactive');
  assert.equal(prio.reasons.length, 0);
  assert.equal(prio.intent.length, 0);
  assert.equal(prio.score, 0);
  assert.equal(prio.suggestedNext, '');
  assert.equal(prio.firstResponse.breached, false);
  assert.equal(prio.handled, true);

  const data = fixture();
  data.leads.push(oldLead);
  const result = buildReport(data, window, {}, now);
  assert.equal(result.report.operations.active, 2);
  assert.equal(drillRows(result, 'active', now).some(row => row.lead._id === 'old-1'), false);
  assert.equal(drillRows(result, 'at_risk', now).some(row => row.lead._id === 'old-1'), false);
  assert.equal(drillRows(result, 'overdue', now).some(row => row.lead._id === 'old-1'), false);
  assert.equal(drillRows(result, 'inactive', now).some(row => row.lead._id === 'old-1'), true);
});
