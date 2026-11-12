# Workday activity metrics

`GET /api/daily-oversight?rooftop=...&queuePage=1&date=YYYY-MM-DD` returns a `workday` object alongside the existing current pipeline/allocation response. Omitting `date` selects the current Melbourne calendar day. Date boundaries use `Australia/Melbourne`, including daylight-saving changes. A workday here is the selected local calendar date, midnight to the following midnight; fixed opening-hour cutoffs are not imposed.

The web dashboard uses `workday.members` and `workday.totals` for its KPI table:

| Field | Definition |
| --- | --- |
| `customersUpdated` | Distinct customers with a recorded CRM update or successful outgoing SMS by that person on the selected date. Multiple updates to the same customer count once. |
| `videosAdded` | Ready, non-private video uploads created on the selected date, attributed to their uploader. |
| `videosSent` | Successful outgoing messages created on the selected date with a video attachment or a valid same-customer Booran video link. An older video sent today counts as sent today, not as a new upload. |
| `nextActionsSet` | Next-action tasks created on the selected date, with a fallback to the lead's dated next action for older records. The current lead snapshot is not counted twice when a task records the same action. |
| `tasksCompleted` | Tasks completed by that person on the selected date. Completion history survives reopening; repeated same-day completions of one task by one person count once. Automatic closure following a manager-approved loss does not count as salesperson task activity. |
| `sales` | Completed deals whose completion timestamp is on the selected date, attributed to their recorded owner. |

Counts are raw daily activity, without an all-active-prospects denominator or invented daily quotas. Staff rows with no workday events show zero. Current pipeline status, overdue work, unassigned prospects, loss reviews and monthly sales remain available separately from the workday table.

The `events` list contains the latest 50 available events for each person, dated and linked to the customer where access permits. Counts use the full selected-day dataset, not just those 50 display items. All queries retain existing dealership and staff scope. Existing event author IDs are preferred; legacy names resolve only to one eligible staff member, with ownership fallback for older records without an actor field.

Direct customer edits now append compact `activity_events` records on the customer. Merging transfers this history. Task completion transitions append `completion_events`; an idempotent repeat does not rewrite the completion date. These fields preserve future historical reporting without another collection. Older totals rely on existing diary/message/media/task/deal history; events that were never recorded cannot be reconstructed. Reassignment may affect attribution on older records that lack an original actor/owner snapshot.
