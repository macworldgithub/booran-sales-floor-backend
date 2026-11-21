const { ObjectId } = require('mongodb');
const { canonicalLead, siteMatch } = require('./lead-identity');

// Reviews can outlive a normal CRM merge. Resolve candidate aliases for display
// without writing on GET or treating a different surviving customer as approved.
async function mergeReviewState(scoped, raw, review, session) {
  const leads = scoped.collection('leads'), options = { session }, memo = new Map();
  const sameSite = lead => lead?.dealership_name?.trim().toLowerCase() === review.dealership.trim().toLowerCase();
  const canonical = id => {
    if (!ObjectId.isValid(id)) return Promise.resolve(null);
    const key = String(id);
    if (!memo.has(key)) memo.set(key, canonicalLead(leads, { _id: new ObjectId(key), dealership_name: siteMatch(review.dealership) }, options).then(lead => sameSite(lead) ? lead : null));
    return memo.get(key);
  };
  const incomingId = review.incoming?._id;
  const existing = ObjectId.isValid(incomingId) ? await leads.findOne({ _id: new ObjectId(String(incomingId)), dealership_name: siteMatch(review.dealership) }, options) : null;
  const link = !existing && incomingId ? await raw.collection('lead_source_links').findOne({ _id: String(incomingId), dealership: siteMatch(review.dealership) }, options) : null;
  const alreadyLinked = Boolean(existing?.merged_into || link);
  const incomingPrimary = alreadyLinked ? await canonical(existing?._id || link.lead_id) : null;
  // MongoDB does not support parallel operations on the same transaction session.
  const resolved = [];
  if (session) { for (const id of review.candidate_ids || []) resolved.push(await canonical(id)); }
  else resolved.push(...await Promise.all((review.candidate_ids || []).map(canonical)));
  const candidates = [...new Map([...resolved, incomingPrimary].filter(Boolean).map(lead => [String(lead._id), lead])).values()];
  return { candidates, existing, alreadyLinked, incomingPrimary };
}
module.exports = { mergeReviewState };
