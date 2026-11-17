const { isActiveLead } = require('./followup-policy');

const ENGAGEMENT_POLICY = Object.freeze({ version: '2026-11-17', windowDays: 14, unansweredDays: 7, unansweredCount: 2,
  fastReplyHours: 24, quietDays: 10, multipleInteractions: 2, weights: { sms: 3, notes: 2, engagement: 1 }, buyingAt: 3, losingAt: -2 });
const DAY = 86400000;
const sent = row => row.direction !== 'inbound' && ['queued', 'sent', 'delivered', 'success'].includes(row.status);
const positive = /\b(ready to buy|ready to purchase|hot prospect|hot buyer|appointment (?:set|booked|confirmed)|booked (?:an? )?(?:appointment|test drive)|finance (?:discussed|approved|requested)|wants? to buy|keen to (?:buy|purchase))\b/i;
const negative = /\b(not interested|bought elsewhere|purchased elsewhere|price (?:is )?too high|too expensive|do not contact|don'?t contact)\b/i;
const highIntent = new Set(['test_drive_booked', 'finance_requested', 'appointment_booked', 'enquiry_form']);
const engagementKinds = new Set(['site_visit', 'vehicle_view', 'video_viewed', 'configurator', 'enquiry', 'enquiry_form', 'follow_up', ...highIntent]);
const automated = /^(?:customer|mobile message|dealersocket(?: import)?|nextgate|nexgate|system|sales floor|sms campaign|connex(?: import)?)$/i;

function assessEngagement({ lead, messages = [], appointments = [], events = [], linkedVehicles = [], now = new Date() }) {
  if (!isActiveLead(lead) || lead.sms_campaign?.active === false || !linkedVehicles.length) return null;
  const policy = ENGAGEMENT_POLICY, end = +now, start = end - policy.windowDays * DAY;
  messages = [...new Map(messages.map(row => [`${row.direction || 'outbound'}:${row.provider_message_id || row._id || `${row.created_at}:${row.body}`}`, row])).values()];
  const validAt = at => Number.isFinite(Date.parse(at)) && Date.parse(at) <= end;
  const recent = at => validAt(at) && Date.parse(at) >= start;
  const outbound = messages.filter(sent), incoming = messages.filter(row => row.direction === 'inbound' && row.event_type !== 'unsubscribe' && recent(row.created_at));
  const attempts = outbound.filter(row => recent(row.created_at));
  const matches = new Map(), replySpeeds = [];
  for (const reply of incoming) {
    const original = outbound.find(row => reply.original_message_id && row.provider_message_id === reply.original_message_id ||
      reply.original_custom_ref && String(row._id) === reply.original_custom_ref);
    if (!original || !validAt(original.created_at)) continue;
    const delay = (Date.parse(reply.created_at) - Date.parse(original.created_at)) / 60000;
    if (delay < 0) continue;
    const key = String(original._id);
    if (!matches.has(key) || delay < matches.get(key)) matches.set(key, delay);
  }
  for (const delay of matches.values()) replySpeeds.push(delay);
  replySpeeds.sort((a, b) => a - b);
  const overdueAttempts = attempts.filter(row => Date.parse(row.created_at) <= end - policy.unansweredDays * DAY && !matches.has(String(row._id)));
  const smsScore = incoming.length ? policy.weights.sms : overdueAttempts.length >= policy.unansweredCount ? -policy.weights.sms : 0;
  const responded = attempts.filter(row => matches.has(String(row._id))).length;
  const sms = { key: 'sms', score: smsScore, reason: incoming.length ? `${incoming.length} customer SMS repl${incoming.length === 1 ? 'y' : 'ies'} in 14 days` :
    overdueAttempts.length >= policy.unansweredCount ? `${overdueAttempts.length} unanswered SMS aged at least 7 days` : 'No decisive SMS response signal',
    metrics: { outboundCount: attempts.length, replyCount: incoming.length, respondedCount: responded,
      responseRate: attempts.length ? Math.round(responded / attempts.length * 100) : null,
      medianResponseMinutes: replySpeeds.length ? Math.round((replySpeeds[Math.floor((replySpeeds.length - 1) / 2)] + replySpeeds[Math.ceil((replySpeeds.length - 1) / 2)]) / 2) : null,
      repliesWithin24Hours: replySpeeds.filter(delay => delay <= policy.fastReplyHours * 60).length, unansweredAfter7Days: overdueAttempts.length },
    evidence: [...attempts, ...incoming].map(row => ({ id: String(row._id), at: row.created_at, direction: row.direction || 'outbound', originalMessageId: row.original_message_id || null })) };

  const notes = (lead.diary_entries || []).filter(note => recent(note.date) && typeof note.note === 'string' && (!note.kind || note.kind === 'note') &&
    (['sales_consultant', 'manager', 'sales_manager', 'general_manager', 'dealer_principal', 'super_admin'].includes(note.author_role) ||
      !note.author_role && note.author && !automated.test(note.author))).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const noteEvidence = notes.map(note => ({ at: note.date, authorId: note.author_id || null, author: note.author,
    sentiment: negative.test(note.note) ? 'negative' : (positive.test(note.note) || /^hot[.!\s]*$/i.test(note.note.trim())) && !/\b(?:not (?:yet )?(?:ready|keen)|no (?:appointment|finance))\b/i.test(note.note) ? 'positive' : 'neutral', excerpt: note.note.slice(0, 1000) }));
  const decisive = noteEvidence.find(note => note.sentiment !== 'neutral');
  const notesScore = decisive ? (decisive.sentiment === 'positive' ? policy.weights.notes : -policy.weights.notes) :
    !notes.length && attempts.length >= policy.unansweredCount ? -policy.weights.notes : 0;
  const noteSignal = { key: 'notes', score: notesScore, reason: decisive ? `Most recent decisive salesperson note: ${decisive.sentiment}` :
    notesScore < 0 ? 'No salesperson notes in 14 days after multiple SMS contacts' : 'No decisive recent salesperson note',
    metrics: { recentNotes: notes.length, positiveNotes: noteEvidence.filter(note => note.sentiment === 'positive').length,
      negativeNotes: noteEvidence.filter(note => note.sentiment === 'negative').length }, evidence: noteEvidence };

  const allEvents = [...events,
    ...messages.filter(row => row.direction === 'inbound' && row.event_type !== 'unsubscribe').map(row => ({ id: String(row.provider_message_id || row._id), at: row.created_at, type: 'follow_up', source: 'SMS' })),
    ...(lead.engagement_events || []),
    ...(lead.diary_entries || []).filter(note => engagementKinds.has(note.kind)).map(note => ({ id: note.request_id, at: note.date, type: note.kind, source: 'Good Showroom' })),
    ...appointments.filter(row => ['Booked', 'Completed'].includes(row.status)).map(row => ({ id: String(row._id), at: row.createdAt, type: row.type === 'Test Drive' ? 'test_drive_booked' : 'appointment_booked', source: 'Good Showroom' })),
  ].filter(event => engagementKinds.has(event.type) && validAt(event.at));
  const unique = [...new Map(allEvents.map(event => [event.id ? `${event.source}:${event.id}` : `${event.source}:${event.type}:${event.at}`, event])).values()];
  const activeEvents = unique.filter(event => recent(event.at)), last = unique.map(event => Date.parse(event.at)).sort((a, b) => b - a)[0];
  const hasIntent = activeEvents.some(event => highIntent.has(event.type));
  const quiet = Number.isFinite(last) && end - last >= policy.quietDays * DAY;
  const engagementScore = activeEvents.length >= policy.multipleInteractions || hasIntent ? policy.weights.engagement : quiet ? -policy.weights.engagement : 0;
  const engagement = { key: 'engagement', score: engagementScore, reason: engagementScore > 0 ? hasIntent ? 'Recent high-intent customer action' : 'Multiple customer interactions in 14 days' :
    engagementScore < 0 ? 'Previous customer engagement has been quiet for at least 10 days' : 'No decisive customer engagement signal',
    metrics: { recentInteractions: activeEvents.length, highIntent: hasIntent, lastEngagementAt: Number.isFinite(last) ? new Date(last).toISOString() : null }, evidence: unique };
  const signals = [sms, noteSignal, engagement].map(signal => ({ ...signal, evidenceCount: signal.evidence.length,
    evidence: signal.evidence.sort((a, b) => Date.parse(b.at || b.created_at || 0) - Date.parse(a.at || a.created_at || 0)).slice(0, 200) }));
  const score = signals.reduce((sum, signal) => sum + signal.score, 0);
  const state = score >= policy.buyingAt ? 'buying' : score <= policy.losingAt ? 'losing' : 'neutral';
  return { policyVersion: policy.version, policy, computedAt: now.toISOString(), score, state,
    label: state === 'buying' ? 'Close to Buying' : state === 'losing' ? 'Close to Losing' : 'Neutral', linkedVehicles, signals };
}
module.exports = { assessEngagement, ENGAGEMENT_POLICY, engagementKinds };
