const {ObjectId}=require('mongodb');
const {route,fail}=require('./workflow-route');
const {isManager,accountSites,canAccessSite,allocationOnly}=require('./roles');
const {calendarDay}=require('./pulse');
const {dayKey,isActiveLead}=require('./followup-policy');
const {fetchWorkdayData,buildWorkdayMetrics}=require('./workday-metrics');
const {fetchReport}=require('./crm-report');
const {LOCATION_GROUPS,locationCondition,isAllLocations,pageQuery}=require('./query');
const {serializeLead}=require('./records');
const {shareUrl}=require('./customer-messages');
const {buildDailyDiary}=require('./daily-diary');
const fields=['customersUpdated','videosAdded','videosSent','nextActionsSet','tasksCompleted'];
const stamp=value=>value?+new Date(value):NaN;
const successful=row=>row.direction!=='inbound'&&!['system','trade-in-automation'].includes(row.user_id)&&['queued','accepted','sent','delivered','success'].includes(row.status);
const trafficLight=(done,target)=>!target?'grey':done>=target?'green':done>0?'amber':'red';
function ownerAt(lead,asOf,people) {
 const history=(lead.diary_entries || []).flatMap(note=>{
  const legacy=/^Assigned to (.+)\.$/.exec(note.note || '');
  if(note.kind!=='assignment'&&!legacy&&note.note!=='Returned to the unassigned queue.')return [];
  const matches=legacy?people.filter(person=>person.name?.trim().toLowerCase()===legacy[1].trim().toLowerCase()):[];
  return [{at:stamp(note.date),id:note.assignee_id?String(note.assignee_id):matches.length===1?String(matches[0]._id||matches[0].id):null}];
 }).filter(event=>Number.isFinite(event.at)&&event.at<=asOf).sort((a,b)=>a.at-b.at);
 if(history.length)return history.at(-1).id;
 if(stamp(lead.assigned_at)>asOf)return null;
 return lead.owner_id || null;
}
function dailyTraffic(input,date,now=new Date()) {
 const bounds=calendarDay(date),start=stamp(bounds.$gte),end=Math.min(stamp(bounds.$lt)-1,+now);
 const inDay=value=>stamp(value)>=start&&stamp(value)<=end;
 const leads=input.leads.filter(lead=>!lead.merged_into);
 const byLead=new Map(leads.map(lead=>[String(lead._id),lead]));
 const leadIds=new Set(byLead.keys());
 input={...input,messages:input.messages.filter(row=>leadIds.has(String(row.lead_id))),media:input.media.filter(row=>leadIds.has(String(row.lead_id))),deals:input.deals.filter(row=>leadIds.has(String(row.lead_id)))};
 const aliases=new Map(leads.flatMap(lead=>[String(lead._id),lead.deal_id].filter(Boolean).map(id=>[String(id),String(lead._id)])));
 // Workday activity remains an event count; required coverage is a customer count.
 const activity=buildWorkdayMetrics({...input,leads:leads.map(lead=>({...lead,diary_entries:(lead.diary_entries||[]).filter(note=>stamp(note.date)<=end),activity_events:(lead.activity_events||[]).filter(event=>stamp(event.date)<=end),
  ...(stamp(lead.last_activity_at)>end?{last_activity_at:null}:{}),...(stamp(lead.next_action?.recorded_at)>end || ['awaiting_approval','cancelled'].includes(lead.next_action?.status)?{next_action:null}:{})})),
  tasks:input.tasks.filter(task=>['open','completed'].includes(task.status)&&(!Number.isFinite(stamp(task.createdAt))||stamp(task.createdAt)<=end)).map(task=>({...task,completion_events:(task.completion_events||[]).filter(event=>stamp(event.date)<=end),...(stamp(task.completed_at)>end?{status:'open',completed_at:null}:{})})),
  media:input.media.filter(row=>stamp(row.created_at)<=end),messages:input.messages.filter(row=>stamp(row.created_at)<=end&&successful(row)),deals:input.deals.filter(row=>stamp(row.completed_at)<=end)},date);
 const source=new Map(input.staff.filter(person=>!allocationOnly(person)).map(person=>[String(person._id||person.id),person]));
 const updates=new Set(activity.members.flatMap(row=>row.customerIds?.customersUpdated || []));
 const added=new Set(input.media.filter(row=>inDay(row.created_at)&&row.status==='ready'&&row.visibility!=='private'&&row.content_type?.startsWith('video/')).map(row=>String(row.lead_id)));
 const files=new Map(input.media.filter(row=>row.status==='ready'&&row.visibility!=='private'&&row.content_type?.startsWith('video/')).map(row=>[row.share_token,row]));
 const prefix=shareUrl({share_token:''});
 const sent=new Set(input.messages.filter(row=>inDay(row.created_at)&&successful(row)&&(
  (row.attachments||[]).some(file=>file.content_type?.startsWith('video/'))||
  (String(row.body||'').match(/https?:\/\/[^\s<>"']+/g)||[]).some(url=>{
   if(!url.startsWith(prefix))return false;
   const token=/^[a-f0-9]{64}(?=$|[.,!?;:)\]?#])/.exec(url.slice(prefix.length))?.[0];
   return token&&files.get(token)?.lead_id===row.lead_id;
  }))).map(row=>String(row.lead_id)));
 const scheduled=new Set(),scheduleDates=new Map();
 const schedule=(leadId,recorded,due,status)=>{
  if(!leadId||!inDay(recorded)||!Number.isFinite(stamp(due))||stamp(due)<=stamp(recorded)||!['open','completed','Booked','Confirmed','Completed','No Show'].includes(status))return;
  const canonical=aliases.get(String(leadId));if(!canonical)return;scheduled.add(canonical);scheduleDates.set(canonical,due);
 };
 for(const lead of leads)schedule(lead._id,lead.next_action?.recorded_at,lead.next_action?.due_at,lead.next_action?.status || 'open');
 for(const task of input.tasks)if(task.kind==='next_action')schedule(task.lead_id,task.createdAt,task.due_at,task.status);
 for(const appointment of input.appointments || []){
  const history=(appointment.status_history||[]).filter(event=>Number.isFinite(stamp(event.at))).sort((a,b)=>stamp(a.at)-stamp(b.at));
  const status=history.length?history.filter(event=>stamp(event.at)<=end).at(-1)?.status||'Booked':appointment.status;
  schedule(appointment.leadId,appointment.createdAt,appointment.when,status);
  const id=aliases.get(String(appointment.leadId)),lead=byLead.get(id);
  if(!id||!inDay(appointment.createdAt)||!Number.isFinite(stamp(appointment.when))||stamp(appointment.when)<=stamp(appointment.createdAt)||!['Booked','Confirmed','Completed','No Show'].includes(status))continue;
  const actor=String(appointment.created_by || appointment.consultant_id || ownerAt(lead,stamp(appointment.createdAt),input.staff)),person=activity.members.find(person=>person.id===actor);
  if(person){person.nextActionsSet++;activity.totals.nextActionsSet++;person.events.push({kind:'nextActionsSet',at:appointment.createdAt,leadId:id,customer:lead.customer_name||'Customer',detail:'Follow-up appointment booked'});person.events.sort((a,b)=>stamp(b.at)-stamp(a.at));person.events=person.events.slice(0,50);}
 }
 const cohort=leads.filter(lead=>{
  if(!isActiveLead(lead)&&!(stamp(lead.lost_at || lead.loss_review?.reviewed_at)>end))return false;
  const dates=[lead.created_at,lead.source_created_at,lead.createdAt].map(stamp).filter(Number.isFinite);
  const created=dates.length?Math.min(...dates):NaN;
  const assignedToday=inDay(lead.assigned_at)||(lead.diary_entries||[]).some(note=>inDay(note.date)&&(note.kind==='assignment'&&note.assignee_id||/^Assigned to .+\.$/.test(note.note||'')));
  return (created>=start&&created<=end)||assignedToday;
 }).map(lead=>{
  const id=String(lead._id),owner=ownerAt(lead,end,input.staff);
  const coverage={customersUpdated:updates.has(id),videosAdded:added.has(id),videosSent:sent.has(id),nextActionsSet:scheduled.has(id)};
  const missing=Object.keys(coverage).filter(key=>!coverage[key]);
  const created=[lead.created_at,lead.source_created_at,lead.createdAt].map(stamp).filter(Number.isFinite);
  return {id,name:lead.customer_name || 'Customer',dealership:lead.dealership_name || '',ownerId:owner,ownerName:owner?(source.get(owner)?.name || lead.owner_name || 'Salesperson unavailable'):'Unassigned',
   createdToday:created.length>0&&inDay(Math.min(...created)),allocatedToday:inDay(lead.assigned_at)||(lead.diary_entries||[]).some(note=>note.kind==='assignment'&&inDay(note.date)&&note.assignee_id),
   coverage,missing,fullyCovered:coverage.videosSent&&coverage.nextActionsSet,followUpDue:scheduleDates.get(id)||null};
 }).filter(customer=>!input.viewerId || customer.ownerId===input.viewerId);
 const people=new Map(activity.members.map(member=>[member.id,member]));
 for(const customer of cohort)if(customer.ownerId&&!people.has(customer.ownerId))people.set(customer.ownerId,{id:customer.ownerId,name:customer.ownerName,events:[],...Object.fromEntries([...fields,'sales'].map(field=>[field,0]))});
 const taskRows=input.tasks.filter(task=>{
  const lead=byLead.get(aliases.get(String(task.lead_id)));
  return (!lead || isActiveLead(lead))&&['open','completed'].includes(task.status)&&task.resolution!=='Loss approved by manager'&&stamp(task.createdAt || task.due_at)<=end&&(
  stamp(task.due_at)<stamp(bounds.$lt)&&(!task.completed_at || stamp(task.completed_at)>=start || task.status==='open') ||
  (task.completion_events||[]).some(event=>inDay(event.date)) || inDay(task.completed_at)
 );}).map(task=>{
  const completed=task.status==='completed'&&stamp(task.completed_at)<=end || (task.completion_events||[]).some(event=>stamp(event.date)<=end)&&!(task.status==='open'&&date===dayKey(now));
  return {id:String(task._id),leadId:task.lead_id||null,memberId:task.assignee_id||null,title:task.title||'Follow-up task',dueAt:task.due_at||null,complete:completed,
   customer:byLead.get(String(task.lead_id))?.customer_name||'Customer'};
 });
 const makeProgress=(customers,tasks,counts)=>{
  const target=Object.fromEntries(fields.map(field=>[field,field==='tasksCompleted'?tasks.length:customers.length]));
  const done=Object.fromEntries(fields.map(field=>[field,field==='tasksCompleted'?tasks.filter(task=>task.complete).length:customers.filter(customer=>customer.coverage[field]).length]));
  const signals=Object.fromEntries(fields.map(field=>[field,trafficLight(done[field],target[field])]));
  return {newCustomers:customers.length,fullyCovered:customers.filter(customer=>customer.fullyCovered).length,coveragePercent:customers.length?Math.round(customers.filter(customer=>customer.fullyCovered).length/customers.length*100):null,
   coverageSignal:trafficLight(customers.filter(customer=>customer.fullyCovered).length,customers.length),
   targets:target,coverage:done,signals:{...signals,sales:'grey'},counts,
   allGreen:Object.values(signals).some(signal=>signal!=='grey')&&Object.values(signals).every(signal=>signal==='green'||signal==='grey')};
 };
 const losses=leads.filter(lead=>lead.loss_review?.status==='approved'&&inDay(lead.loss_review.reviewed_at)).map(lead=>({id:String(lead._id),leadId:String(lead._id),memberId:ownerAt(lead,stamp(lead.loss_review.reviewed_at),input.staff),name:lead.customer_name||'Customer',kind:'loss',at:lead.loss_review.reviewed_at,missing:[]}));
 const diary=buildDailyDiary({...input,newCustomers:cohort},date,now).filter(row=>!input.viewerId || row.memberId===input.viewerId);
 const includeDiary=(progress,items)=>({...progress,counts:{...progress.counts,diaryItems:items.length},
  targets:{...progress.targets,diaryItems:items.length},coverage:{...progress.coverage,diaryItems:items.filter(row=>row.complete).length},
  signals:{...progress.signals,diaryItems:trafficLight(items.filter(row=>row.complete).length,items.length)}});
 const members=[...people.values()].map(person=>{
  const customers=cohort.filter(customer=>customer.ownerId===person.id),tasks=taskRows.filter(task=>task.memberId===person.id);
  const dailyDiary=diary.filter(row=>row.memberId===person.id);
  const progress=includeDiary(makeProgress(customers,tasks,Object.fromEntries([...fields,'sales'].map(field=>[field,person[field]||0]))),dailyDiary);
  return {id:person.id,name:person.name,...progress,counts:{...progress.counts,lost:losses.filter(row=>row.memberId===person.id).length},signals:{...progress.signals,lost:'grey'},diary:{total:dailyDiary.length,outstanding:dailyDiary.filter(row=>!row.complete).length,carriedForward:dailyDiary.filter(row=>row.carriedForward).length},events:person.events || []};
 }).sort((a,b)=>a.name.localeCompare(b.name));
 const summary=includeDiary(makeProgress(cohort,taskRows,activity.totals),diary);
 summary.counts={...summary.counts,lost:losses.length};summary.signals.lost='grey';
 const sales=input.deals.filter(deal=>deal.status==='completed'&&inDay(deal.completed_at)).flatMap(deal=>{
  const person=members.find(person=>person.id===String(deal.owner_id)||!deal.owner_id&&person.name===deal.owner_name);
  return person?[{id:String(deal._id),memberId:person.id,leadId:String(deal.lead_id),name:byLead.get(String(deal.lead_id))?.customer_name||'Customer',kind:'sale',at:deal.completed_at,missing:[]}]:[];
 });
 // Directly marking a prospect Sold is also a sale; a completed deal for that
 // same customer/day already represents it and must not be counted twice.
 const soldCustomers=new Set(sales.map(row=>aliases.get(row.leadId)||row.leadId));
 for(const lead of leads){
  const events=(lead.stage_history||[]).filter(event=>event.to==='sold'&&inDay(event.at)).sort((a,b)=>stamp(b.at)-stamp(a.at));
  const editedSoldAt=lead.booran_edited_fields?.includes('sold_at')&&lead.sold_at?(inDay(lead.sold_at)?lead.sold_at:null):undefined;
  const at=editedSoldAt!==undefined?editedSoldAt:(events[0]?.at || (lead.status==='sold'&&inDay(lead.sold_at)?lead.sold_at:null)),id=String(lead._id);
  if(!at||soldCustomers.has(id))continue;
  const owner=ownerAt(lead,stamp(at),input.staff),person=members.find(person=>person.id===owner);
  if(!person || input.viewerId&&person.id!==input.viewerId)continue;
  sales.push({id:'sold:'+id,memberId:person.id,leadId:id,name:lead.customer_name||'Customer',kind:'sale',at,missing:[]});
  person.counts.sales++;summary.counts.sales++;
 }
 return {date,today:dayKey(now),timezone:'Australia/Melbourne',computedAt:now.toISOString(),members,summary,
  dailyUnassigned:cohort.filter(customer=>!customer.ownerId).length,
  definitions:{cohort:'Customers first created or allocated in this Melbourne workday. A later same-day reassignment moves the required coverage to the final recipient. Old customers with only activity today do not create a new-customer target.',
   coverage:'Daily new coverage requires a video sent and a next follow-up scheduled on the selected workday for each new/allocated customer. Duplicate actions for one customer cannot cover another customer.',
   lights:'Green: all required coverage complete. Amber: some coverage complete. Red: none complete. Grey: no applicable workload. Sales is an event count with no invented daily target.',
   counts:'Diary Items includes due appointments, follow-ups, carry-forward work and new/allocated customers for the selected Melbourne day. A new customer already represented by a diary item is not added twice. Next Action Set keeps unique daily-new customer coverage. Lost counts manager-approved losses. Sold includes completed deals and directly marked Sold prospects, without double counting the same outcome.',
   priorities:'Unassigned, pending approvals and SLA queues show current operational priorities, independently of the selected historical workday.'},
  _customers:cohort,_tasks:taskRows,_sales:sales,_losses:losses,_diary:diary};
}
async function staffFor(req,database) {
 const query={active:true,...(isManager(req.user)?{role:{$in:['super_admin','dealer_principal','general_manager','sales_manager','manager','sales_consultant']}}:{_id:new ObjectId(req.user.id)})};
 const staff=await (await database()).collection('users').find(query,{projection:{name:1,role:1,site:1,allowedSites:1,allocation_only:1}}).toArray();
 const requested=isAllLocations(req.query.rooftop)?null:locationCondition(req.query.rooftop),filter=requested&&new RegExp(requested.$regex,requested.$options);
 return staff.filter(person=>accountSites(person).flatMap(site=>LOCATION_GROUPS[site.toLowerCase()] || [site]).some(site=>canAccessSite(req.user,site)&&(!filter||filter.test(site))));
}
const pending=async(db,manager)=>{
 if(!manager)return {total:0,loss:0,dates:0,consent:0,merges:0};
 const [loss,dates,consent,merges]=await Promise.all(['loss_review','next_action_review','consent_review'].map(field=>db.collection('leads').countDocuments({merged_into:{$exists:false},[field+'.status']:'pending'})).concat(db.collection('lead_merge_requests').countDocuments({status:'open'})));
 return {total:loss+dates+consent+merges,loss,dates,consent,merges};
};
async function loadFresh(req,database) {
 if(!isManager(req.user)&&req.user.role!=='sales_consultant')fail(403,'A sales account is required.');
 const now=new Date(),date=req.query.date || dayKey(now);
 calendarDay(date);if(date>dayKey(now))fail(400,'Choose today or an earlier Melbourne workday.');
 const db=await database(req),todayReq={user:req.user,query:{rooftop:req.query.rooftop,date:dayKey(now)}};
 const [data,people,current,approvals]=await Promise.all([fetchWorkdayData(db,date),staffFor(req,database),fetchReport(todayReq,database),pending(db,isManager(req.user))]);
 data.appointments=await db.collection('appointments').find({$or:[{createdAt:calendarDay(date)},{when:{$lt:calendarDay(date).$lt},status:{$in:['Booked','Confirmed','Completed','No Show']}}]},{projection:{_id:1,leadId:1,createdAt:1,when:1,status:1,status_history:1,consultant_id:1,created_by:1,type:1,notes:1}}).toArray();
 const seen=new Set(data.leads.flatMap(lead=>[String(lead._id),lead.deal_id].filter(Boolean)));
 const missing=[...new Set(data.appointments.map(row=>row.leadId).filter(id=>id&&!seen.has(String(id))).map(String))];
 if(missing.length)data.leads.push(...await db.collection('leads').find({$or:[{_id:{$in:missing.filter(ObjectId.isValid).map(id=>new ObjectId(id))}},{deal_id:{$in:missing}}],merged_into:{$exists:false}}).toArray());
 const report=dailyTraffic({...data,staff:people,viewerId:isManager(req.user)?null:req.user.id},date,now);
 const active=current.all.filter(row=>row.state!=='inactive'&&isActiveLead(row.lead)&&(row.lead.source_active??row.lead.sms_campaign?.active)!==false);
 const unassigned=active.filter(row=>!row.lead.owner_id),overdue=active.filter(row=>row.firstResponse.breached);
 report.priorities={unassigned:isManager(req.user)?unassigned.length:0,approvals,overdue:overdue.length,asOf:current.report.computedAt};
 report._queues={unassigned,overdue};
 return report;
}
const trafficCache=new Map(),trafficInFlight=new Map();
async function load(req,database){
 if(!isManager(req.user)&&req.user.role!=='sales_consultant')fail(403,'A sales account is required.');
 const key=JSON.stringify([req.user.id,req.user.role,req.user.allowedSites,req.user.site,req.query.rooftop,req.query.date||dayKey()]);
 if(trafficCache.get(key)?.until>Date.now())return trafficCache.get(key).data;
 if(trafficInFlight.has(key))return trafficInFlight.get(key);
 const task=loadFresh(req,database).then(data=>{for(const [stored,value] of trafficCache)if(value.until<Date.now())trafficCache.delete(stored);if(trafficCache.size>=12)trafficCache.delete(trafficCache.keys().next().value);trafficCache.set(key,{until:Date.now()+5000,data});return data;}).finally(()=>trafficInFlight.delete(key));
 trafficInFlight.set(key,task);return task;
}
function installDailyTraffic(router,database) {
 router.get('/daily-traffic',route(async(req,res)=>{
  const {_customers,_tasks,_sales,_queues,_losses,_diary,...report}=await load(req,database);
  res.json({success:true,data:report});
 }));
 router.get('/daily-traffic/actions',route(async(req,res)=>{
  const report=await load(req,database),metric=req.query.metric || 'coverage',member=req.query.member;
  if(member&&!report.members.some(person=>person.id===member))fail(404,'Salesperson not found in this scope.');
  if(!['coverage','all',...fields,'sales','lost'].includes(metric))fail(400,'Choose a valid traffic metric.');
  let rows;
  if(metric==='tasksCompleted')rows=report._tasks.filter(task=>!task.complete&&(!member||task.memberId===member)).map(task=>({...task,kind:'task',missing:['tasksCompleted']}));
  else if(metric==='sales')rows=report._sales.filter(row=>!member||row.memberId===member);
  else if(metric==='lost')rows=report._losses.filter(row=>!member||row.memberId===member);
  else rows=report._customers.filter(customer=>(!member||customer.ownerId===member)&&(metric==='all'?customer.missing.length>0:metric==='coverage'?!customer.fullyCovered:!customer.coverage[metric])).map(customer=>({...customer,leadId:customer.id,kind:'customer',missing:metric==='coverage'?customer.missing.filter(field=>['videosSent','nextActionsSet'].includes(field)):metric==='all'?customer.missing:[metric]}));
  if(metric==='all')rows.push(...report._tasks.filter(task=>!task.complete&&(!member||task.memberId===member)).map(task=>({...task,kind:'task',missing:['tasksCompleted']})));
  rows.sort((a,b)=>String(a.name||a.customer||a.title||'').localeCompare(String(b.name||b.customer||b.title||''))||String(a.id).localeCompare(String(b.id)));
  const {page,limit,skip}=pageQuery(req.query,'workflow');
  res.json({success:true,data:rows.slice(skip,skip+limit),pagination:{page,limit,total:rows.length,totalPages:Math.ceil(rows.length/limit)}});
 }));
 router.get('/daily-traffic/customers',route(async(req,res)=>{
  const report=await load(req,database),member=req.query.member;
  if(member&&!report.members.some(person=>person.id===member))fail(404,'Salesperson not found in this scope.');
  const rows=report._customers.filter(customer=>!member||customer.ownerId===member).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const {page,limit,skip}=pageQuery(req.query,'workflow');
  res.json({success:true,data:rows.slice(skip,skip+limit),pagination:{page,limit,total:rows.length,totalPages:Math.ceil(rows.length/limit)}});
 }));
 router.get('/daily-traffic/diary',route(async(req,res)=>{
  const report=await load(req,database),member=req.query.member;
  if(member&&!report.members.some(person=>person.id===member))fail(404,'Salesperson not found in this scope.');
  const rows=report._diary.filter(row=>!member||row.memberId===member);
  const {page,limit,skip}=pageQuery(req.query,'workflow');
  res.json({success:true,data:rows.slice(skip,skip+limit),pagination:{page,limit,total:rows.length,totalPages:Math.ceil(rows.length/limit)}});
 }));
 router.get('/daily-traffic/queue',route(async(req,res)=>{
  const report=await load(req,database),kind=req.query.kind || 'unassigned';
  if(!['unassigned','overdue'].includes(kind))fail(400,'Choose an assignment or SLA queue.');
  if(kind==='unassigned'&&!isManager(req.user))fail(403,'Manager access is required.');
  const rows=[...report._queues[kind]].sort((a,b)=>(b.firstResponse.ageMinutes||0)-(a.firstResponse.ageMinutes||0)||String(a.lead._id).localeCompare(String(b.lead._id)));
  const {page,limit,skip}=pageQuery(req.query,'workflow');
  res.json({success:true,data:rows.slice(skip,skip+limit).map(row=>({lead:serializeLead(row.lead),ageMinutes:row.firstResponse.ageMinutes,dueAt:row.firstResponse.dueAt})),pagination:{page,limit,total:rows.length,totalPages:Math.ceil(rows.length/limit)}});
 }));
  router.get('/daily-traffic/pdf',route(async(req,res)=>{
   const report=await load(req,database);
   const {renderDailyPulseHtml,generateDailyPulsePdf}=require('./daily-pulse-pdf');
   const options={userName:req.user?.name,userRole:req.user?.role};
   if(req.query.format==='html'){
    const html=renderDailyPulseHtml(report,options);
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.send(html);
   }
   try{
    const pdfBuffer=await generateDailyPulsePdf(report,options);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="daily-pulse-wrap-' + report.date + '.pdf"');
    res.setHeader('Content-Length',pdfBuffer.length);
    return res.send(pdfBuffer);
   }catch(err){
    console.warn('PDF generation failed, falling back to HTML:',err.message);
    const html=renderDailyPulseHtml(report,options);
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.send(html);
   }
  }));
}
module.exports={dailyTraffic,trafficLight,ownerAt,load,installDailyTraffic,trafficCache};
