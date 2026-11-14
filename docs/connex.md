# South Morang Hyundai Connex

This connector implements section 5 of `South_Morang_Hyundai_Manager_Dashboard_Developer_Notes.md`, using the supplied 37-second walkthrough and the 23-page FMB 26-033 bulletin. It uses the dealership's authorized portal UI. It is not Hyundai's native approved-LMS integration: the bulletin lists Autoplay, DealerStudio and INDIQATOR. No undocumented Salesforce API or bypass of hidden contact details is used.

## Staff workflow

- Daily overview → Current allocation and review tools → **Hyundai Connex**: pull leads, paste an opportunity link, inspect hidden contacts, overdue acceptance, 3-day and 6-week escalation views, merge review, source errors and salesperson mappings.
- Open a linked customer → **Hyundai Connex**: accept and reveal details, send the assigned salesperson, set Sales Qualified with the opportunity's exact dealer sub-status, refresh, share an explicit note and inspect queued/failed actions. Normal customer notes remain private unless explicitly shared here.
- Allocate with the existing customer allocation control. Subsequent allocation and first staff activity are queued back to Connex. Only **Salesperson in charge** changes; **Opportunity Owner** is preserved.
- Record sales in the normal workflow. Losses require the existing manager approval and mandatory reason. New sold/approved-loss milestones queue Closed Won/Closed Lost; staff can also send those outcomes explicitly. The full approved loss reason is included in comments, with Connex category **LMS Lost** unless an explicit valid category is provided by the API.
- Historical records establish a baseline at their first pull. Importing historical outcomes does not bulk-close or accept opportunities in Connex.

## Runtime and credentials

Set the backend-only `CONNEX_*` variables in `.env.example`. Keep credentials out of Git, frontend variables, logs and HTTP responses. Set a persistent, private session path outside release directories, owned by the application user (directory 0700, file 0600). Install Google Chrome from its official distribution, or supply a compatible Chromium executable. `playwright-core` is pinned; it does not download browsers during deployment.

Start with `CONNEX_ENABLED=true`, `CONNEX_WRITEBACK_ENABLED=false`. As the application user, run:

```
node scripts/sync-connex.js --dry-run
node scripts/sync-connex.js --dry-run <opportunity-id>
```

These checks read the portal and print counts/presence flags, never customer contacts. Enable writeback after reviewing the workflow. The worker runs every 30 seconds, discovers All Opportunities every five minutes and refreshes source details in batches (default 20), with a six-hour detail refresh. Email notifications and manually pasted links receive priority by resetting their read checkpoint. Forward Connex notifications to either configured South Morang lead inbox; there is no separate mailbox password. Direct canonical Connex opportunity links are recognized in text/HTML notifications. Other notification formats remain in email review or require the manager's opportunity link.

The worker requires a persistent Node process; request-only serverless hosting does not run this scheduler. Multi-factor prompts and CAPTCHA block sign-in and appear as connection errors; they are not bypassed.

## Data integrity and recovery

All opportunities are checked against **South Morang Hyundai / H3752V** before import. Stable Salesforce opportunity IDs drive upserts. Nonempty source contacts fill records; staff-edited fields, staff allocations and pending loss review are protected. Repeated notification emails do not create empty customer records. Existing mobile collisions use the manager merge-review flow, retaining source links after a merge. Other lead feeds remain unchanged.

Queue, candidate, baseline, mapping and synchronization documents live in the existing logical `integration_sync` collection and support `LEAD_STATE_COLLECTION` co-location. A persisted Mongo lease prevents concurrent workers. Writes have stable request IDs, bounded retries and post-save source verification. Stale allocations/outcomes are checked before execution. Interrupted/uncertain notes require checking Connex before posting again; the worker does not blindly resend them. Errors contain no credentials or raw browser traces.

Only an exact final source list count marks list coverage complete. A `50+`/truncated list is visibly incomplete and never causes CRM deletions. Partial detail failures are counted separately. Missing source records are not retired automatically. Acceptance is due by the end of the next Melbourne weekday; the helper supports an excluded-date calendar, but public-holiday configuration is not exposed in this version. Escalations use 3 and 42 elapsed days.

The 14 November server dry run successfully read a revealed Finance opportunity with all five customer/contact/vehicle/salesperson presence checks. All Opportunities returned 2,000 distinct references, but the portal did not expose an exact final count, so historical list coverage remains explicitly unconfirmed. Discovery is sorted newest first and detail reads prioritize those opportunities. Confirm older history against a Connex export or an approved provider feed before claiming a complete historical migration.

## Verification limits

Live inspection confirmed sign-in, masked and revealed records, All Opportunities, Accept/Update/Close/New Note controls, salesperson lookup separation, available status and loss-reason choices. Existing source records were not changed during this inspection. Fixture tests cover CRM idempotency, reveal/update, protected edits, duplicate phones, authentication/scope, approval gates, queues and retries. A real write must still be confirmed against a designated disposable Connex opportunity; a production customer must not be used merely as a test.
