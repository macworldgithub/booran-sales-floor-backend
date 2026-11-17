# Inventory holding cost and prospect engagement

Implements `Booran_Inventory_Holding_Costs_and_Engagement_Note.md` (17 November 2026).

## Holding cost

`vehicleCost * 0.075 * (Melbourne stock calendar days / 365) + Carsales enquiries * 80 + Drive.com enquiries * 50`.

Interest is calculated without rounding the daily amount first. Displayed components and the final total are rounded to cents. Lead rates are ex GST. The stock date takes precedence over an old DIS snapshot; sold stock stops at its completed-deal date where available, otherwise its final stored DIS. Missing vehicle cost produces an incomplete total, never an advertised-price substitution or a fabricated zero. CSV imports use explicit cost columns and retain an existing verified cost when a feed omits it.

The billing ledger reads Nextgate snapshots and merged source references, deduplicated by seller ID plus Nextgate lead ID. Historical enquiries still accrue even when the prospect is sold or lost. Only recognised Carsales and Drive.com source names qualify; SMS connect, Call connect, AutoTrader and other sources are excluded. Counts are segmented by source and the provider's recorded lead type. Missing upstream types are labelled `Unspecified`. Rates do not depend on the type. Replays and merged CRM rows do not double-charge the same enquiry.

Vehicle joins require the same dealership and an exact stock number or valid VIN, or an explicit inventory/deal stock key. Matching model names are insufficient. Ambiguous or unmatched units are not guessed. The integration checkpoint records distinct paid enquiries, matched and unmatched counts. Enquiries for vehicles no longer in current inventory therefore remain unmatched rather than becoming charges against a different unit.

`accumulatedHoldingCost` remains the API's compatible total field; `holdingCostBreakdown` contains interest, source counts/rates, lead-type segments, Nextgate reference evidence, reconciliation time and warnings. Inventory stats use the recalculated stored totals. Inventory Action Advisory and generated price/wholesale actions use the same total. The existing 90 DIS wholesale and 60 DIS new-stock review thresholds remain. A holding cost that consumes the available gross margin also flags a capital trap; this uses the recorded potential gross, falling back to advertised price minus vehicle cost when both are known. Existing resolved/in-progress inventory actions retain their workflow status.

Used-car stock-to-online lead time remains separate. It is calculated only from an actual available-online/first-online date. Unknown online dates display `Not recorded` and never affect holding cost.

## Engagement

Only active, non-merged prospects linked to a verified inventory unit receive an assessment. Inactive DealerSocket snapshots, sold and lost prospects have no indicator. Current salesperson/dealership access is applied again when reading vehicle prospect lists and summaries.

The stored versioned policy uses a 14-day window, 7-day unanswered-SMS age, 24-hour fast-response measure, 10-day quiet threshold, and the requested weights: SMS ±3, human notes ±2, overall engagement ±1. Totals >=3 are `Close to Buying`; <=-2 are `Close to Losing`; -1 through 2 are neutral with no icon.

* SMS: successful outgoing attempts and received replies, deduplicated by provider message identity. A reply gives +3; at least two unanswered attempts aged >=7 days give -3. Failed sends, future records and unsubscribe events are excluded from reply credit. Response rate uses correlated outgoing attempts; median speed uses the first correlated reply. An unmatched reply remains positive evidence but does not invent a response time.
* Notes: the most recent decisive dated human note in 14 days. Explicit buying/appointment/finance intent gives +2; not interested, bought elsewhere or price-too-high language gives -2. Automated import/message diary entries are excluded, and negated buying intent is not positive. No human notes after multiple SMS contacts gives -2. Missing or undated history is not manufactured.
* Overall engagement: observed Good Showroom video views, recorded website/configurator/enquiry/follow-up events, dated Nextgate enquiries and provider engagement events, received SMS follow-ups and booked/completed appointments. Multiple interactions or a high-intent event give +1. Previous activity quiet for >=10 days gives -1. A new customer reply resets silence; outgoing attempts alone are not customer engagement. Absent history remains neutral.

Existing Good Showroom video events and SMS records are used directly. Nextgate imports preserve creation date, stock/VIN, lead type and any explicit typed `engagementEvents` supplied by the provider (`id`, `at`, `type`); unsupported or undated events are ignored. Site/configurator interactions that have never been recorded cannot be inferred from a lead's sync timestamp.

`leads.engagement_assessment` stores the policy, weighted signals, measurements, capped raw evidence, fingerprint and computed time. Original SMS/diary/events remain available in their existing collections. The latest 30 changed assessment summaries are retained in `engagement_history`; unchanged refreshes do not duplicate history. List APIs return compact explanations, while scoped `GET /api/leads/:id/engagement` returns the full current audit and change summaries.

## Refresh and UI

An initial reconciliation runs on server startup, then every 15 minutes. Successful customer/inventory updates, new inbound SMS and public video events schedule a coalesced rebuild, rate-limited to one fleet refresh per five minutes. The job is single-flight, scans CRM records in batches of 100 and uses a separate two-connection database lane; page reads do not rebuild the fleet. Calendar interest is also calculated at read time, so crossing Melbourne midnight does not depend on an inventory feed rerun. No new MongoDB collection is required.

The web app replaces `Holding Cost Eaten`, displays the full cost breakdown and separate used-car lead time, and shows engagement on lead cards/tables, customer profiles, inventory cards/tables and vehicle details. Vehicle details list the accessible active prospects and their expandable score explanations beside the inventory advisory. Cost breakdowns retain existing cost permissions.

Validation covers formula rounding, DST stock days, sold cutoffs, source exclusions, alias deduplication, exact/site-scoped vehicle joins, scoring boundaries, missing history, recent versus old messages, negative/negated notes, audit persistence and current-owner/cost access. Desktop and mobile browser checks exercise cost details, scores and customer navigation without sending SMS or changing live customer records.

## Historical Nextgate metadata backfill

Run `node scripts/backfill-inventory-nextgate.js --refresh` from a prepared backend release before activation. It re-reads only paid enquiries matched to current inventory, using the existing authenticated customer/lead detail endpoint with two workers. It validates each returned lead ID and enriches existing direct/merged references with creation date, lead type, VIN and dated engagement metadata. It does not create customers, change their contact details, reassign leads, or alter workflow statuses. The final refresh materialises the new costs and scores. Progress and final counts contain no customer details; failed or concurrently changed references are reported for retry. Nextgate's observed `leadType` values (for example DEMO) remain source data; unspecified types are displayed honestly rather than inferred from a channel name. Undated cumulative upstream SMS/call/appointment counters are not treated as activity in the last 14 days.

Automatic holding-cost actions created by this policy are retired if their threshold stops being met, and reopened if it returns. A manager's manual resolution and in-progress work are preserved. The automated marker is cleared on manual action edits.

Reconciliation uses a compact bulk metadata cursor for the complete billing ledger, then loads diaries and SMS histories in batches of 100 only for active matched prospects and prior assessments requiring cleanup. Historical closed source references still accrue charges but do not attach engagement to a previous vehicle. Only current open source opportunities, explicit stock links, and registered deals supply engagement associations. This separates historical billing from current buying intent and avoids per-page history scans across the full CRM population.
