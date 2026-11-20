const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { route, fail } = require('./workflow-route');
const { isManager, canAccessSite } = require('./roles');
const { serializeLead, string } = require('./records');
const { reference } = require('./lead-allocation');
const { dayKey, shiftDay, isActiveLead } = require('./followup-policy');
const { calendarDay, periodWindow } = require('./pulse');
const hash = value => createHash('sha256').update(value).digest('hex');
const at = value => value ? +new Date(value) : NaN;
const iso = value => Number.isFinite(value) ? new Date(value).toISOString() : null;
const sent = row => row.direction !== 'inbound' && !['trade-in-automation','system'].includes(row.user_id) && ['queued','accepted','sent','delivered','success'].includes(row.status);
const contactKinds = new Set(['call','call_connected','call_attempt','sms_sent','email_sent','customer_reply','email_reply']);
const connected = event => event.kind === 'call_connected' || event.kind === 'customer_reply' || event.kind === 'email_reply' || event.kind === 'call' && ['connected','successful'].includes(event.outcome);
const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? Math.round(numerator / denominator * 1000) / 10 : null });
const median = values => values.length ? (values.sort((a,b)=>a-b)[Math.floor((values.length-1)/2)] + values[Math.ceil((values.length-1)/2)]) / 2 : null;
const active = lead => isActiveLead(lead) && (lead.source_active ?? lead.sms_campaign?.active) !== false && !lead.merged_into;
const makeId = value => { if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail(400,'Invalid record ID.'); return new ObjectId(value); };
const limits = { leads: 50000, messages: 200000, appointments: 50000, deals: 50000, message_media: 50000 };
const caches = new Map(), inFlight = new Map();
function reportWindow(query, now = new Date()) {
  let from, to;
  if (query.from || query.to) {
    if (!query.from || !query.to) fail(400,'Choose both reporting dates.');
    from = calendarDay(query.from).$gte; to = calendarDay(query.to).$lt;
  } else if (query.date) {
    const range = calendarDay(query.date); from=range.$gte; to=range.$lt;
  } else ({from,to}=periodWindow(['today','week','month'].includes(query.period)?query.period:'today',now));
  const days = Math.round((Date.parse(shiftDay(dayKey(new Date(at(to)-1)),1)+'T12:00:00Z')-Date.parse(dayKey(from)+'T12:00:00Z'))/86400000);
  if (at(from)>=at(to) || days<1 || days>90 || at(from)>+now) fail(400,'Choose a reporting period of 1–90 days starting no later than today.');
  const previousFrom=calendarDay(shiftDay(dayKey(from),-days)).$gte;
  return {from,to,previousFrom,days,asOf:iso(Math.min(+now,at(to))),timezone:'Australia/Melbourne'};
}
function evidence(lead, messages, appointments, deals, media, end) {
  const origins=[lead.created_at,lead.source_created_at,lead.createdAt].map(at).filter(Number.isFinite);
  const origin=origins.length?Math.min(...origins):NaN;
  messages=[...new Map(messages.map(row=>[(row.direction||'outbound')+':'+(row.provider_message_id||row._id),row])).values()];
  const events=[...(lead.crm_contacts || []),...(lead.diary_entries || []).filter(row=>contactKinds.has(row.kind)).map(row=>({...row,at:row.date}))];
  const valid = value => Number.isFinite(at(value)) && at(value)>=origin && at(value)<=end;
  const attempts=events.filter(row=>valid(row.at) && contactKinds.has(row.kind)).map(row=>at(row.at));
  // A legacy first_contact_at is an attempt, never proof of a successful contact.
  if (valid(lead.first_contact_at)) attempts.push(at(lead.first_contact_at));
  for (const message of messages) if (sent(message) && valid(message.created_at)) attempts.push(at(message.created_at));
  const successful=events.filter(row=>connected(row) && valid(row.at)).map(row=>at(row.at));
  for (const message of messages) if (message.direction==='inbound' && message.event_type !== 'unsubscribe' && valid(message.created_at) && (message.original_message_id || message.original_custom_ref || messages.some(out=>sent(out) && at(out.created_at)<=at(message.created_at)))) successful.push(at(message.created_at));
  const sales=deals.filter(row=>row.status==='completed' && valid(row.completed_at));
  const booked=appointments.filter(row=>['Test Drive','Showroom Visit','Walk-in'].includes(row.type) && valid(row.createdAt || row.when));
  const shows=booked.filter(row=>['Completed','Shown'].includes(row.status) && valid(row.shown_at || row.when));
  const showIds=new Set(shows.map(row=>String(row._id)));
  const saleFromShow=sales.some(row=>showIds.has(String(row.appointment_id)));
  const latestContact=Math.max(...attempts,...successful);
  const mediaByToken=new Map(media.filter(row=>row.status==='ready' && row.visibility!=='private').map(row=>[row.share_token,row]));
  const videoMessages=messages.filter(row=>sent(row) && valid(row.created_at) && ((row.attachments || []).some(file=>file.content_type?.startsWith('video/')) ||
    [...mediaByToken].some(([token,file])=>token && file.content_type?.startsWith('video/') && String(row.body || '').includes('/media/'+token))));
  return {origin,firstAttempt:Math.min(...attempts),latestContact,contacted:successful.length>0,booked,shows,sales,saleFromShow,videoMessages};
}
function priority(lead, ev, now, settings) {
  const flags=lead.crm_signals || {}, reasons=[], intent=[];
  if (Number.isSafeInteger(flags.deposit_cents) && Number.isSafeInteger(flags.required_deposit_cents) && flags.deposit_cents<flags.required_deposit_cents) reasons.push({key:'payment_mismatch',text:'Deposit is below the required amount',next:'Confirm the outstanding deposit and payment arrangements.',weight:100});
  if (Number.isSafeInteger(flags.finance_approved_cents) && Number.isSafeInteger(flags.opportunity_value_cents) && flags.finance_approved_cents<flags.opportunity_value_cents) reasons.push({key:'finance_shortfall',text:'Finance approval is below the agreed vehicle value',next:'Discuss the finance shortfall and available options.',weight:95});
  const internet=!/walk[ -]?in|service|referral/i.test(lead.source || '');
  const slaDue=ev.origin+(settings.firstResponseMinutes || 15)*60000;
  const uncontacted=!Number.isFinite(ev.firstAttempt);
  const breach=uncontacted && !ev.contacted && Number.isFinite(ev.origin) && +now>slaDue;
  if (breach) reasons.push({key:'first_response_sla',text:'First response SLA breached',next:'Call the customer now; record the outcome or send a personal SMS.',weight:90});
  const due=at(lead.next_action?.due_at);
  if (lead.next_action?.status==='open' && due<+now && lead.next_action_review?.status!=='pending' && lead.loss_review?.status!=='pending') reasons.push({key:'followup_overdue',text:'Scheduled follow-up is overdue',next:lead.next_action.title || 'Complete the promised follow-up and record the outcome.',weight:85});
  if (Number.isFinite(ev.latestContact) && +now-ev.latestContact>(settings.followUpHours || 72)*3600000 && !(lead.next_action?.status==='open' && due>+now) && !ev.booked.some(row=>['Booked','Confirmed'].includes(row.status) && at(row.when)>+now)) reasons.push({key:'stalled',text:'No recent customer contact',next:'Reconnect with the customer and agree on a next step.',weight:65});
  if (lead.engagement_assessment?.state==='losing') reasons.push({key:'losing',text:'Customer engagement indicates risk of loss',next:'Review the recent responses and address the customer’s concerns.',weight:70});
  const signals=(lead.engagement_events || []).filter(row=>at(row.at)<=+now && at(row.at)>=+now-14*86400000);
  if (flags.finance_started || signals.some(row=>['finance_requested','finance_started'].includes(row.type))) intent.push('Finance started');
  if (flags.trade_in || lead.trade_in || lead.tradeIn || signals.some(row=>row.type==='trade_in')) intent.push('Trade-in interest');
  if (signals.filter(row=>['vehicle_view','vdp_view'].includes(row.type)).length>=2) intent.push('Repeated vehicle views');
  if (lead.engagement_assessment?.state==='buying') intent.push('Strong customer engagement');
  if (ev.booked.some(row=>['Booked','Confirmed'].includes(row.status) && at(row.when)>=+now)) intent.push('Upcoming appointment');
  reasons.sort((a,b)=>b.weight-a.weight);
  const state=reasons.length?'at_risk':intent.length?'opportunities':'in_play';
  const key=hash(JSON.stringify([String(lead._id),lead.status,ev.latestContact,lead.next_action,flags,reasons.map(row=>row.key),intent]));
  const handled=lead.crm_handled?.key===key && at(lead.crm_handled.until)>+now;
  return {state,reasons,intent,score:reasons[0]?.weight || (intent.length?40+intent.length:10),suggestedNext:reasons[0]?.next || (intent.length?'Call to confirm the customer’s plans and arrange an appointment.':'Agree on the next follow-up with the customer.'),
    key,handled,firstResponse:{targetMinutes:settings.firstResponseMinutes || 15,internetGoalMinutes:internet?5:null,breached:breach,dueAt:iso(slaDue),ageMinutes:Number.isFinite(ev.origin)?Math.max(0,Math.floor((+now-ev.origin)/60000)):null},
    lastContactAt:iso(ev.latestContact),minutesSinceContact:Number.isFinite(ev.latestContact)?Math.max(0,Math.floor((+now-ev.latestContact)/60000)):null};
}
function summarize(rows) {
  const contacted=rows.filter(row=>row.ev.contacted),booked=contacted.filter(row=>row.ev.booked.length),shown=booked.filter(row=>row.ev.shows.length),sold=rows.filter(row=>row.ev.sales.length);
  const response=rows.map(row=>row.ev.firstAttempt-row.ev.origin).filter(Number.isFinite).map(ms=>Math.max(0,ms/60000));
  return {leads:rows.length,contacted:contacted.length,appointments:booked.length,confirmedAppointments:booked.filter(row=>row.ev.booked.some(appt=>appt.confirmed || appt.status==='Confirmed')).length,shows:shown.length,sales:sold.length,
    firstResponse:{medianMinutes:median(response),samples:response.length,internetUnder5:ratio(rows.filter(row=>!/walk[ -]?in|service|referral/i.test(row.lead.source || '') && Number.isFinite(row.ev.firstAttempt) && row.ev.firstAttempt-row.ev.origin<300000).length,rows.filter(row=>!/walk[ -]?in|service|referral/i.test(row.lead.source || '')).length)},
    contactRate:ratio(contacted.length,rows.length),appointmentRate:ratio(booked.length,contacted.length),showRate:ratio(shown.length,booked.length),
    closeRate:ratio(shown.filter(row=>row.ev.saleFromShow).length,shown.length),conversion:ratio(sold.length,rows.length),
    videosSent:rows.reduce((sum,row)=>sum+row.ev.videoMessages.length,0)};
}
function buildReport(data, window, settings={}, now=new Date()) {
  const group=(rows,key)=>{const out=new Map();for(const row of rows){const value=key(row);if(!out.has(value))out.set(value,[]);out.get(value).push(row);}return out;};
  const messages=group(data.messages,row=>row.lead_id),appointments=group(data.appointments,row=>String(row.leadId)),deals=group(data.deals,row=>row.lead_id),media=group(data.media,row=>row.lead_id);
  const withOutcome=(lead,ev,cutoff)=>{
    if(lead.status==='sold'&&!ev.sales.length){const known=[lead.sold_at,...(lead.stage_history||[]).filter(event=>event.to==='sold').map(event=>event.at)].map(at).filter(Number.isFinite);const soldAt=known.length?Math.min(...known):cutoff>=+now?+now:NaN;if(Number.isFinite(soldAt)&&soldAt>=ev.origin&&soldAt<=cutoff)ev.sales.push({_id:'lead-status:'+lead._id,lead_id:String(lead._id),status:'completed',completed_at:iso(soldAt),source:'lead_status'});}return ev;
  };
  const all=data.leads.map(lead=>{const id=String(lead._id),ev=evidence(lead,messages.get(id)||[],appointments.get(id)||appointments.get(lead.deal_id)||[],deals.get(id)||[],media.get(id)||[],at(window.asOf));withOutcome(lead,ev,at(window.asOf));return {lead,ev,...priority(lead,ev,now,settings)};});
  const cohort=all.filter(row=>row.ev.origin>=at(window.from) && row.ev.origin<at(window.to));
  const previous=all.filter(row=>row.ev.origin>=at(window.previousFrom) && row.ev.origin<at(window.from)).map(row=>({...row,ev:evidence(row.lead,messages.get(String(row.lead._id))||[],appointments.get(String(row.lead._id))||[],deals.get(String(row.lead._id))||[],media.get(String(row.lead._id))||[],at(window.from)-1)}));
  const live=all.filter(row=>active(row.lead));
  const current=summarize(cohort),prior=summarize(previous.map(row=>({...row,ev:withOutcome(row.lead,row.ev,at(window.from)-1)})));
  const segment=key=>[...group(cohort,key)].map(([name,rows])=>({name,...summarize(rows)})).sort((a,b)=>b.leads-a.leads || a.name.localeCompare(b.name));
  const stages=['opportunities','at_risk','in_play','sold'].map(stage=>{
    const rows=stage==='sold'?cohort.filter(row=>row.ev.sales.length):live.filter(row=>row.state===stage);
    const priced=rows.map(row=>{
      const candidates=(deals.get(String(row.lead._id))||[]).filter(deal=>deal.status===(stage==='sold'?'completed':'registered'));
      if(candidates.some(deal=>Number.isSafeInteger(deal.sale_price_cents)))return candidates.reduce((sum,deal)=>sum+(Number.isSafeInteger(deal.sale_price_cents)?deal.sale_price_cents:0),0);
      return Number.isSafeInteger(row.lead.crm_signals?.opportunity_value_cents)?row.lead.crm_signals.opportunity_value_cents:null;
    });
    return {stage,count:rows.length,valueCents:priced.filter(value=>value!==null).reduce((a,b)=>a+b,0),valuedLeads:priced.filter(value=>value!==null).length};
  });
  const daily=[];
  for(let i=0;i<window.days;i++){const date=shiftDay(dayKey(window.from),i),end=Math.min(at(calendarDay(date).$lt)-1,at(window.asOf));if(end<at(window.from))break;
    const rows=cohort.filter(row=>dayKey(row.ev.origin)===date).map(row=>({...row,ev:evidence(row.lead,messages.get(String(row.lead._id))||[],appointments.get(String(row.lead._id))||[],deals.get(String(row.lead._id))||[],media.get(String(row.lead._id))||[],end)}));
    daily.push({date,...summarize(rows.map(row=>({...row,ev:withOutcome(row.lead,row.ev,end)})))});
  }
  const scopedMessages=data.messages.filter(row=>at(row.created_at)>=at(window.from) && at(row.created_at)<at(window.to));
  const sentVideos=all.flatMap(row=>row.ev.videoMessages).filter(row=>at(row.created_at)>=at(window.from) && at(row.created_at)<at(window.to));
  const sentMedia=new Map();for(const row of sentVideos){for(const file of row.attachments || [])if(file.content_type?.startsWith('video/'))sentMedia.set(String(file.id),row);for(const file of data.media)if(file.lead_id===row.lead_id && file.share_token && file.status==='ready' && file.visibility!=='private' && String(row.body||'').includes('/media/'+file.share_token))sentMedia.set(String(file._id),row);}
  const watched=new Set((data.mediaEvents || []).filter(row=>sentMedia.has(row.media_id) && row.event==='view' && at(row.created_at)>=at(window.from) && at(row.created_at)<at(window.to)).map(row=>row.media_id)).size;
  const report={window,computedAt:now.toISOString(),settings:{firstResponseMinutes:settings.firstResponseMinutes || 15,followUpHours:settings.followUpHours || 72,conversionTarget:settings.conversionTarget || 15,monthlyTarget:settings.monthlyTarget || 10},
    metrics:current,previous:prior,daily,stages,
    operations:{active:live.length,unactioned:live.filter(row=>!Number.isFinite(row.ev.firstAttempt) && !row.ev.contacted).length,overdue:live.filter(row=>row.firstResponse.breached || row.reasons.some(r=>r.key==='followup_overdue')).length,
      opportunities:stages[0].count,atRisk:stages[1].count,inPlay:stages[2].count,handled:live.filter(row=>row.handled).length,
      stepIns7d:all.reduce((sum,row)=>sum+(row.lead.crm_actions || []).filter(event=>event.action==='step_in' && at(event.at)>=+now-7*86400000 && at(event.at)<=+now).length,0)},
    engagement:{videoMessages:sentVideos.length,videoViewRate:ratio(watched,sentMedia.size),emailOpenRate:null,websiteSignalsAvailable:all.some(row=>(row.lead.engagement_events || []).some(event=>['vehicle_view','vdp_view','site_visit'].includes(event.type))),
      deliveredMessages:scopedMessages.filter(row=>row.direction!=='inbound' && row.status==='delivered').length},
    segments:{source:segment(row=>row.lead.source || 'Unknown'),hour:segment(row=>new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Melbourne',hour:'2-digit',hourCycle:'h23'}).format(new Date(row.ev.origin))+':00'),
      salesperson:segment(row=>row.lead.owner_name || 'Unassigned'),vehicleType:segment(row=>row.lead.vehicle_category || row.lead.vehicle_type || 'Unknown')},
    definitions:{cohort:'Conversion metrics use customers created in the selected period, observed through the selected period end. Funnel counts are unique customers; repeat bookings do not inflate rates. Recorded CRM/DMS sold outcomes supplement completed deals. Undated legacy sold outcomes are included only for current reports, never backdated into historical periods. Sales can occur without an appointment, and only explicitly linked attended appointments count toward the close rate.',
      operations:'Priority and pipeline cards show the current active workload. Sold and conversion counts use the selected lead cohort.',
      response:'First response includes recorded call attempts, personal SMS/email and legacy first_contact_at. Notes, imports, automated invitations and assignments are excluded. Successful contact requires a connected call or customer reply.',
      videoViews:'Video view rate is the share of identifiable videos sent during this period with a recorded view during the same period. Email opens and website signals require source telemetry; missing data is not estimated.'},
    dataQuality:{salesFromLeadStatus:cohort.filter(row=>row.ev.sales.some(sale=>sale.source==='lead_status')).length,missingCreationDates:all.filter(row=>!Number.isFinite(row.ev.origin)).length,legacyShows:data.appointments.filter(row=>row.status==='Completed' && !row.shown_at).length,appointmentsWithoutContact:all.filter(row=>!row.ev.contacted && row.ev.booked.length).length,unlinkedSales:data.deals.filter(row=>row.status==='completed' && !row.appointment_id).length}};
  return {report,all,cohort};
}
async function bounded(collection,query,projection,limit,label) {
  const rows=await collection.find(query,{projection}).limit(limit+1).toArray();
  if(rows.length>limit)fail(503,'The '+label+' report is too large. Narrow the reporting period or salesperson filter.');
  return rows;
}
async function fetchReport(req,database) {
  if(req.user.role==='contractor')fail(403,'Sales reporting requires a sales account.');
  const now=new Date(),window=reportWindow(req.query,now),staff=string(req.query.staff,'Salesperson');
  if(staff && (!isManager(req.user)||!/^[a-f0-9]{24}$/i.test(staff)))fail(403,'A manager must select a valid salesperson.');
  const key=JSON.stringify([req.user.id,req.user.role,req.user.allowedSites,req.user.site,req.query.rooftop,staff,req.query.source,req.query.vehicleType,window.from,window.to]);
  if(caches.get(key)?.until>+now)return caches.get(key).data;
  if(inFlight.has(key))return inFlight.get(key);
  const work=(async()=>{
    const db=await database(req),query={merged_into:{$exists:false},...(staff?{owner_id:staff}:{}),
      $or:[{created_at:{$gte:window.previousFrom,$lt:window.to}},{createdAt:{$gte:window.previousFrom,$lt:window.to}},{source_created_at:{$gte:window.previousFrom,$lt:window.to}},{created_at:{$gte:new Date(window.previousFrom),$lt:new Date(window.to)}},{createdAt:{$gte:new Date(window.previousFrom),$lt:new Date(window.to)}},{status:{$in:['new_lead','following_up','returned']},$or:[{source_active:true},{source_active:{$in:[null]},'sms_campaign.active':{$ne:false}}]}]};
    if(req.query.source){const source=string(req.query.source,'Source');query.source=source==='Unknown'?{$in:[null,'']}:source;}
    if(req.query.vehicleType){const kind=string(req.query.vehicleType,'Vehicle type');query.$and=[kind==='Unknown'?{vehicle_type:{$in:[null,'']},vehicle_category:{$in:[null,'']}}:{$or:[{vehicle_type:kind},{vehicle_category:kind}]}];}
    const projection=Object.fromEntries(['_id','deal_id','customer_name','customer_phone','customer_email','dealership_name','owner_id','owner_name','vehicle_make','vehicle_model','vehicle_type','vehicle_category','status','source','created_at','createdAt','source_created_at','sold_at','first_contact_at','last_activity_at','source_active','sms_campaign.active','next_action','loss_review.status','next_action_review.status','trade_in','tradeIn','process_revision','crm_contacts','crm_signals','crm_actions','crm_handled','crm_intervention','stage_history','engagement_events','engagement_assessment.state'].map(name=>[name,1]));
    projection.diary_entries={$filter:{input:{$ifNull:['$diary_entries',[]]},as:'entry',cond:{$in:['$$entry.kind',[...contactKinds]]}}};
    const leads=await bounded(db.collection('leads'),query,projection,limits.leads,'lead');
    const ids=leads.map(row=>String(row._id));
    const data={leads,messages:[],appointments:[],deals:[],media:[],mediaEvents:[]};
    for(let i=0;i<ids.length;i+=500){
      const batch=ids.slice(i,i+500),apptIds=leads.slice(i,i+500).flatMap(row=>[String(row._id),row.deal_id].filter(Boolean));
      const [messages,appointments,deals,media]=await Promise.all([
        bounded(db.collection('customer_messages'),{lead_id:{$in:batch},created_at:{$lte:window.asOf}},{lead_id:1,status:1,direction:1,event_type:1,body:1,created_at:1,user_id:1,provider_message_id:1,original_message_id:1,original_custom_ref:1,attachments:1},limits.messages,'message'),
        bounded(db.collection('appointments'),{leadId:{$in:apptIds}},{leadId:1,status:1,type:1,when:1,createdAt:1,confirmed:1,shown_at:1,confirmed_at:1},limits.appointments,'appointment'),
        bounded(db.collection('deals'),{lead_id:{$in:batch}},{lead_id:1,status:1,createdAt:1,completed_at:1,appointment_id:1,sale_price_cents:1},limits.deals,'deal'),
        bounded(db.collection('message_media'),{lead_id:{$in:batch},content_type:{$regex:'^video/'}},{lead_id:1,content_type:1,status:1,visibility:1,share_token:1,last_viewed_at:1,views:1},limits.message_media,'video'),
      ]);
      const mediaIds=media.map(row=>String(row._id));
      if(mediaIds.length)data.mediaEvents.push(...await bounded((await database()).collection('media_events'),{media_id:{$in:mediaIds},created_at:{$gte:window.from,$lt:window.to}},{media_id:1,event:1,created_at:1},200000,'video engagement'));
      data.messages.push(...messages);data.appointments.push(...appointments);data.deals.push(...deals);data.media.push(...media);
      if(data.messages.length>limits.messages)fail(503,'Narrow the reporting period or salesperson filter.');
    }
    const requested=req.query.rooftop && !['All Locations','all','South Morang'].includes(req.query.rooftop)?req.query.rooftop:req.user.site;
    const settings=canAccessSite(req.user,requested)?await (await database()).collection('pulse_settings').findOne({_id:String(requested).toLowerCase()}):null;
    const result=buildReport(data,window,settings || {},now);
    const raw=await database();
    await raw.collection('crm_report_snapshots').findOneAndUpdate({_id:hash(key)},{$set:{user_id:req.user.id,dealership:req.query.rooftop || req.user.site,window,metrics:result.report.metrics,daily:result.report.daily,computedAt:result.report.computedAt}},{upsert:true});
    for(const [storedKey,value] of caches)if(value.until<Date.now())caches.delete(storedKey);
    if(caches.size>=12)caches.delete(caches.keys().next().value);
    caches.set(key,{until:Date.now()+15000,data:result});return result;
  })().finally(()=>inFlight.delete(key));inFlight.set(key,work);return work;
}
const filters=new Set(['all','active','unactioned','overdue','opportunities','at_risk','in_play','leads','contacted','appointments','shows','sales','appointment_sales','videos','handled']);
function drillRows(result,filter) {
  if(!filters.has(filter))fail(400,'Choose a valid CRM report filter.');
  if(filter==='videos')return result.all.filter(row=>row.ev.videoMessages.some(message=>at(message.created_at)>=at(result.report.window.from) && at(message.created_at)<at(result.report.window.to)));
  if(filter==='appointment_sales')return result.cohort.filter(row=>row.ev.contacted && row.ev.booked.length && row.ev.shows.length && row.ev.saleFromShow);
  if(['leads','contacted','appointments','shows','sales'].includes(filter))return result.cohort.filter(row=>filter==='leads' || filter==='contacted'&&row.ev.contacted || filter==='appointments'&&row.ev.contacted&&row.ev.booked.length || filter==='shows'&&row.ev.contacted&&row.ev.booked.length&&row.ev.shows.length || filter==='sales'&&row.ev.sales.length || filter==='videos'&&row.ev.videoMessages.length);
  return result.all.filter(row=>active(row.lead) && (filter==='all' || filter==='active' || filter==='unactioned'&&!Number.isFinite(row.ev.firstAttempt)&&!row.ev.contacted || filter==='overdue'&&(row.firstResponse.breached || row.reasons.some(r=>r.key==='followup_overdue')) || filter==='handled'&&row.handled || row.state===filter));
}
function publicRow(row) {
  return {lead:serializeLead(row.lead),state:row.state,reasons:row.reasons,intent:row.intent,score:row.score,suggestedNext:row.suggestedNext,key:row.key,handled:row.handled,firstResponse:row.firstResponse,lastContactAt:row.lastContactAt,minutesSinceContact:row.minutesSinceContact,
    revision:row.lead.process_revision ?? null,intervention:row.lead.crm_intervention || null,signals:row.lead.crm_signals || {},appointments:row.ev.booked.map(item=>({id:String(item._id),when:item.when,status:item.status,confirmed:!!item.confirmed,shownAt:item.shown_at})),deals:row.ev.sales.filter(item=>ObjectId.isValid(String(item._id))).map(item=>({id:String(item._id),appointmentId:item.appointment_id?String(item.appointment_id):null}))};
}
function installCrmReport(router,database) {
  router.get('/crm/report',route(async(req,res)=>res.json({success:true,data:(await fetchReport(req,database)).report})));
  router.get('/crm/report/leads',route(async(req,res)=>{
    const filter=req.query.filter || 'all',result=await fetchReport(req,database),{page,limit,skip}=require('./query').pageQuery(req.query,'workflow');
    let rows=drillRows(result,filter);
    if(req.query.handled!=='true' && ['all','opportunities','at_risk','in_play'].includes(filter))rows=rows.filter(row=>!row.handled);
    const search=String(req.query.search || '').trim().toLowerCase();if(search)rows=rows.filter(row=>[row.lead.customer_name,row.lead.customer_phone,row.lead.vehicle_make,row.lead.vehicle_model].some(value=>String(value||'').toLowerCase().includes(search)));
    rows.sort((a,b)=>b.score-a.score || at(a.lastContactAt || a.lead.created_at)-at(b.lastContactAt || b.lead.created_at) || String(a.lead._id).localeCompare(String(b.lead._id)));
    res.json({success:true,data:rows.slice(skip,skip+limit).map(publicRow),pagination:{page,limit,total:rows.length,totalPages:Math.ceil(rows.length/limit)}});
  }));
  const context=async req=>{
    if(req.user.role==='contractor')fail(403,'A sales account is required.');
    const db=await database(req),lead=await db.collection('leads').findOne({...reference(req.params.id),merged_into:{$exists:false}});
    if(!lead)fail(404,'Customer not found.');return {db,lead};
  };
  async function mutation(req,res,kind,change) {
    const {db,lead}=await context(req),requestId=req.body.requestId;
    if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(requestId))fail(400,'Include a valid action request ID.');
    const fingerprint=hash(JSON.stringify([kind,req.body]));
    const previous=(lead.crm_actions || []).find(row=>row.id===requestId);
    if(previous){if(previous.fingerprint!==fingerprint)fail(409,'This request ID belongs to a different action.');return res.json({success:true,data:serializeLead(lead)});}
    if(req.body.revision!==(lead.process_revision ?? null))fail(409,'The customer changed. Refresh before saving.');
    const now=new Date().toISOString(),update=await change(lead,now);
    const action={id:requestId,action:kind,at:now,by:req.user.id,by_name:req.user.name,fingerprint};
    update.$push={...update.$push,crm_actions:action,diary_entries:{kind:'crm_'+kind,author:req.user.name,author_id:req.user.id,author_role:req.user.role,date:now,note:update.note}};
    delete update.note;update.$set={...update.$set,updatedAt:new Date()};update.$inc={process_revision:1};
    const row=await db.collection('leads').findOneAndUpdate({_id:lead._id,process_revision:lead.process_revision ?? null,'crm_actions.id':{$ne:requestId}},update,{returnDocument:'after'});
    if(!row)fail(409,'The customer changed. Refresh before saving.');
    caches.clear();
    if(kind==='step_in')await require('./crm-updates').notify(await database(),row,'manager_intervention',requestId);
    res.json({success:true,data:serializeLead(row)});
  }
  router.post('/crm/leads/:id/contact',route(async(req,res)=>mutation(req,res,'contact',(lead,now)=>{
    if(!['connected','no_answer','voicemail','sent','replied'].includes(req.body.outcome)||!['call','email'].includes(req.body.channel))fail(400,'Choose a valid contact channel and outcome.');
    if(req.body.channel==='call'&&!['connected','no_answer','voicemail'].includes(req.body.outcome) || req.body.channel==='email'&&!['sent','replied'].includes(req.body.outcome))fail(400,'Choose an outcome for this contact channel.');
    const note=string(req.body.notes,'Contact notes',{required:true,max:2000});
    const kind=req.body.channel==='call'?'call':req.body.outcome==='replied'?'email_reply':'email_sent';
    return {$set:{last_activity_at:now,last_activity_by:req.user.id},$push:{crm_contacts:{id:req.body.requestId,kind,outcome:req.body.outcome,at:now,by:req.user.id,notes:note}},note:req.body.channel+' · '+req.body.outcome+': '+note};
  })));
  router.post('/crm/leads/:id/handled',route(async(req,res)=>mutation(req,res,'handled',(lead,now)=>{
    const note=string(req.body.notes,'Resolution notes',{required:true,max:2000});
    if(typeof req.body.key!=='string'||!/^[a-f0-9]{64}$/.test(req.body.key))fail(400,'Refresh this priority card before resolving it.');
    return {$set:{crm_handled:{key:req.body.key,at:now,until:new Date(at(now)+4*3600000).toISOString(),by:req.user.id}},note:'Priority handled: '+note};
  })));
  router.post('/crm/leads/:id/step-in',route(async(req,res)=>{
    if(!isManager(req.user))fail(403,'Only managers can step in.');
    return mutation(req,res,'step_in',(lead,now)=>({$set:{crm_intervention:{by:req.user.id,name:req.user.name,at:now}},note:'Manager stepped in: '+string(req.body.notes,'Manager notes',{required:true,max:2000})}));
  }));
  router.post('/crm/leads/:id/stage',route(async(req,res)=>mutation(req,res,'stage',(lead,now)=>{
    if(!['new_lead','following_up','returned'].includes(req.body.status))fail(400,'Use the deal workflow for a sale and manager review for a loss.');
    if(lead.loss_review?.status==='pending'||['sold','lost'].includes(lead.status))fail(409,'Resolve the existing deal or loss review before moving this customer.');
    return {$set:{status:req.body.status},$addToSet:{booran_edited_fields:'status'},$push:{stage_history:{from:lead.status,to:req.body.status,at:now,by:req.user.id}},note:'Stage changed to '+req.body.status+': '+string(req.body.notes,'Stage notes',{required:true,max:2000})};
  })));
  router.post('/crm/leads/:id/signals',route(async(req,res)=>mutation(req,res,'signals',(lead,now)=>{
    const signals={...lead.crm_signals};
    for(const name of ['deposit_cents','required_deposit_cents','finance_approved_cents','opportunity_value_cents'])if(Object.hasOwn(req.body,name)){const value=req.body[name];if(value!==null&&(!Number.isSafeInteger(value)||value<0||value>1000000000))fail(400,'Enter valid non-negative amounts.');signals[name]=value;}
    for(const name of ['finance_started','trade_in'])if(Object.hasOwn(req.body,name)){if(typeof req.body[name]!=='boolean')fail(400,'Choose valid intent signals.');signals[name]=req.body[name];}
    return {$set:{crm_signals:signals},note:'Opportunity and payment information updated: '+string(req.body.notes,'Signal notes',{required:true,max:2000})};
  })));
  router.patch('/crm/appointments/:id',route(async(req,res)=>{
    if(req.user.role==='contractor')fail(403,'A sales account is required.');
    const db=await database(req),row=await db.collection('appointments').findOne({_id:makeId(req.params.id)});
    if(!row)fail(404,'Appointment not found.');
    if(!['Confirmed','Completed','No Show','Cancelled'].includes(req.body.status))fail(400,'Choose a valid appointment outcome.');
    if(row.status===req.body.status)return res.json({success:true,data:row});
    if(['Completed','Cancelled','No Show'].includes(row.status))fail(409,'This appointment already has an outcome.');
    if(['Completed','No Show'].includes(req.body.status) && at(row.when)>Date.now())fail(409,'A future appointment cannot be marked attended.');
    const now=new Date().toISOString(),changed=await db.collection('appointments').findOneAndUpdate({_id:row._id,status:row.status},{$set:{status:req.body.status,...(req.body.status==='Confirmed'?{confirmed:true,confirmed_at:now}:{}),...(req.body.status==='Completed'?{shown_at:now}:{}),updatedAt:now},$push:{status_history:{status:req.body.status,at:now,by:req.user.id}}},{returnDocument:'after'});
    if(!changed)fail(409,'The appointment changed. Refresh before saving.');caches.clear();res.json({success:true,data:changed});
  }));
  router.post('/crm/deals/:id/appointment',route(async(req,res)=>{
    if(!isManager(req.user))fail(403,'Only managers can link a sale.');
    const db=await database(req),deal=await db.collection('deals').findOne({_id:makeId(req.params.id)});
    if(!deal)fail(404,'Deal not found.');
    const appointment=await db.collection('appointments').findOne({_id:makeId(req.body.appointmentId),leadId:deal.lead_id,status:'Completed'});
    if(!appointment || appointment.dealership!==deal.dealership || at(appointment.shown_at || appointment.when)>at(deal.completed_at || deal.createdAt))fail(409,'Choose an attended appointment for this customer before the sale.');
    if(deal.appointment_id && String(deal.appointment_id)!==String(appointment._id))fail(409,'This deal already belongs to another appointment.');
    const changed=await db.collection('deals').findOneAndUpdate({_id:deal._id,appointment_id:deal.appointment_id || null},{$set:{appointment_id:String(appointment._id),appointment_linked_by:req.user.id,appointment_linked_at:new Date().toISOString()}});
    if(!changed)fail(409,'The deal changed. Refresh before linking its appointment.');
    caches.clear();res.json({success:true});
  }));
}
module.exports={installCrmReport,reportWindow,evidence,priority,summarize,buildReport,drillRows,publicRow,caches};
