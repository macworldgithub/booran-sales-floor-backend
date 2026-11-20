# Sales CRM lead and prospect redesign

Implements the web/backend functionality in the November 2026
Booran_Sales_CRM_Redesign_Dev_Summary.pdf. No native-app changes or deployment.

## UI and operation

The manager Today dashboard and PULSE use the same reporting workspace.
Salespeople see the workspace in My sales day, restricted to their assigned
customers. Contractors cannot use these reporting or action APIs.
Priority view puts actionable customer cards first; Performance view expands
the conversion dashboard. Both layouts work in the mobile browser.

Green identifies hot opportunities, red identifies risk, and blue is in play.
Cards include phone dialling, SMS conversation handoff, contact outcome logging,
Mark handled, manager Step in, Move stage, appointment booking, appointment
outcomes, and editable opportunity/payment signals.

The operational summary reports the current workload independently of the
selected lead cohort. The performance dashboard offers today, week, month or a
custom 1–90 day period, plus source, vehicle type and salesperson filters.
Metric and funnel drill-downs use the same source calculations.
Managers retain Export PULSE report as a CSV containing aggregate metrics,
pipeline values, daily trends and definitions; customer contact details are
not included. Source values are escaped against spreadsheet formulas.

## Metric mapping

| Requirement | Source and implementation |
| --- | --- |
| Speed to first contact, source/hour segments | Earliest valid call attempt, personal SMS/email or legacy first_contact_at after original enquiry creation. Median minutes and internet leads under five minutes; Melbourne source/hour segmentation. |
| Contact rate | Unique customers with a connected call, logged email reply or inbound SMS reply associated with a conversation, divided by created customers. |
| Lead-to-appointment rate | Unique contacted customers with a recorded appointment divided by contacted customers. Repeat bookings do not inflate the numerator. Confirmation status is retained. |
| Appointment show rate | Unique contacted customers with an attended appointment divided by unique contacted customers with a booking. Cancelled/no-show bookings remain in the denominator. |
| Appointment-to-sale rate | Completed sales explicitly linked to an attended appointment, divided by shown customers. Sales without a link are reported as a data-quality gap. |
| Lead-to-sale conversion | Customers with completed deals or a canonical CRM/DMS sold outcome divided by customers created in the period. |
| SLA / unactioned ageing | Current active customers with no recorded contact attempt/reply past the configured first-response SLA, plus overdue explicit next actions. Age and last contact are visible. |
| Risk / opportunity scoring | Payment and finance shortfalls, first-response breaches, overdue actions, stalled contact and existing engagement assessments; finance/trade-in intent, repeat VDP views and upcoming appointments. Every risk has an explanation and rule-based next step. |
| Videos and engagement | Accepted/sent video messages and dated public-video view events, including identifiable pasted video links. Missing telemetry is not inferred from lifetime view counters. |
| Pipeline | Known deal prices or recorded opportunity values by opportunity, at-risk, in-play and sold stage; missing prices are counted separately. |
| Trends | Prior-period metrics, dated daily cohorts, a contact/conversion chart and an accessible data table. Aggregate snapshots persist in crm_report_snapshots, including co-located state support. |

Conversion metrics use unique customers created in the chosen period, observed
through its end or the current time. Each daily trend point is evaluated at
that day's end. Source/rep attribution uses the customer's current canonical
source and assignment. Imported/merged duplicates are excluded.
Unknown creation/contact timestamps and missing appointment links are visible.
An undated legacy sold outcome counts only in a current report; it is never
retroactively invented for an earlier reporting period.

## Reliable actions

POST /api/crm/leads/:id/contact records call/email outcomes after they happen.
A telephone link does not claim that a call connected. Notes, imports, stage
changes, assignments and automated trade-in invitations do not create contact
credits. SMS uses the existing audited sending workflow, not a new sender.

Lead actions handled, step-in, stage and signals have a request ID, revision
check, actor and diary audit. Retries reuse the original action. Mark handled
temporarily suppresses an unchanged card for four hours; fresh evidence
reopens it, and SLA counts are not erased. Step in notifies the salesperson
without changing assignment. Sales still use the deal workflow and losses
still require manager review. Stage history is retained for new CRM changes.

PATCH /api/crm/appointments/:id records confirmation, attendance, no-show or
cancellation. Future attendance and conflicting terminal outcomes are rejected.
POST /api/crm/deals/:id/appointment links a deal only to a same-customer,
same-dealership attended appointment before the deal; managers only.

## Data and runtime

The backend reads canonical CRM customers, appointments, deals, saved messages,
video records/events and existing imported engagement signals. Existing
DealerSocket/DMS imports remain the source of canonical external customer
and sold information. This feature does not invent external provider access.
Email open rates remain unavailable without delivery/open telemetry. Website
signals are used when already supplied as dated engagement_events or existing
engagement assessments; there is no simulated website activity.

Queries project only reporting fields, filter non-contact diary entries in
Mongo, batch related-record reads, share in-flight requests and use a bounded
15-second account/scope cache. Successful mutations invalidate that cache.
Limits reject oversized reports explicitly rather than returning partial rates.
Browser polling runs every 30 seconds while visible and refreshes after
mutations/resume; aborted or obsolete scope responses cannot replace new data.
Run the existing npm run init:state on the next authorised deployment for the
added media-event and aggregate-snapshot query indexes.

## Release and pilot

The PDF supplies two alternative visual concepts. The implementation combines
them as Priority and Performance views using the supplied mockups; no Figma
account is needed to use the finished interface. Stakeholder preference and
the proposed South Morang pilot/adoption study remain business rollout steps.
Production deployment and live provider/telemetry validation are separate from
this code-only implementation and have not been performed.
