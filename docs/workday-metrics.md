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

Counts remain raw daily activity. The response also includes `targets`, `coverage` and `signals` for the five process columns. The daily customer workload is the distinct set of customers allocated to the salesperson, created for them, actioned by them, or linked to their due tasks on the selected Melbourne date. It is not the entire active pipeline. Customers updated, videos added, videos sent and next actions are green only when each customer in that workload is covered. Multiple videos/messages/actions for the same customer do not satisfy another customer's requirement. Due tasks include overdue open work and tasks completed that day; every required task must be complete. No-work/no-task cells are neutral. Sales has no target or red/green signal.

Example: four customers updated and four video messages to only three customers remains red at `3/4 customers covered`. It turns green after the fourth customer is covered. Summary indicators aggregate coverage and targets, not raw event counts.

The `events` list contains the latest 50 available events for each person, dated and linked to the customer where access permits. Counts use the full selected-day dataset, not just those 50 display items. All queries retain existing dealership and staff scope. Existing event author IDs are preferred; legacy names resolve only to one eligible staff member, with ownership fallback for older records without an actor field. For an explicitly allocation-only manager, genuine customer activity is attributed to the responsible salesperson at that event time. The original author remains in the customer audit history. Allocation itself creates workload and an allocation event, not customer-update credit. New allocation diary entries retain the recipient ID/name, and legacy `Assigned to Name.` entries resolve only to a unique salesperson.

## Allocating managers

An account with `allocation_only: true` retains its manager permissions but is excluded from lead-recipient lists, Connex/DealerSocket automatic salesperson mapping and salesperson metric rows. Other managers are unaffected. Manual allocations still route directly to the selected salesperson and subsequent source refreshes preserve them.

The guarded repair command is read-only by default:

```
node scripts/fix-allocation-only.js --manager "Quoc Truong" --site "South Morang Hyundai"
```

Adding `--apply --backup /absolute/private/backup.json` marks that manager allocation-only and returns only active imported defaults owned by them to the unassigned queue. Explicit allocations, edited owner fields, pending loss reviews, other dealerships, merged records and sold/lost outcomes are preserved. A private ownership backup is required before any mutation. Per-lead transactions and revision checks preserve concurrent staff changes, and repeating the repair does not duplicate audit entries. The script never guesses a salesperson when none has been allocated.

Direct customer edits now append compact `activity_events` records on the customer. Merging transfers this history. Task completion transitions append `completion_events`; an idempotent repeat does not rewrite the completion date. These fields preserve future historical reporting without another collection. Older totals rely on existing diary/message/media/task/deal history; events that were never recorded cannot be reconstructed. Reassignment may affect attribution on older records that lack an original actor/owner snapshot.
