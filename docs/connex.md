# South Morang Hyundai Connex

This connector implements section 5 of `South_Morang_Hyundai_Manager_Dashboard_Developer_Notes.md`, using the supplied 37-second walkthrough and the 23-page FMB 26-033 bulletin. It uses the dealership's authorized portal UI. It is not Hyundai's native approved-LMS integration: the bulletin lists Autoplay, DealerStudio and INDIQATOR. No undocumented Salesforce API or bypass of hidden contact details is used.

## Staff workflow

- Daily overview → Current allocation and review tools → **Hyundai Connex**: source status/type/salesperson/date/search filters, saved and pinned personal views, bulk updates, source export import, hidden contacts, overdue acceptance, 3-day and 6-week escalation views, merge review, source errors and salesperson mappings.
- Open a linked customer → **Hyundai Connex**: accept and reveal details, send the assigned salesperson, set Sales Qualified with the opportunity's exact dealer sub-status, refresh, share an explicit note and inspect queued/failed actions. Normal customer notes remain private unless explicitly shared here.
- Allocate with the existing customer allocation control. Subsequent allocation and first staff activity are queued back to Connex. Only **Salesperson in charge** changes; **Opportunity Owner** is preserved.
- Record sales in the normal workflow. Losses require manager approval and a mandatory reason. The loss-request/review UI captures the exact Connex category before approval, which automatic closure retains. Staff can also choose a category on the customer or bulk action. The full approved reason is included in comments; **LMS Lost** is the fallback for older reviews without a category.
- Historical records establish a baseline at their first pull. Importing historical outcomes does not bulk-close or accept opportunities in Connex.

## Runtime and credentials

Set the backend-only `CONNEX_*` variables in `.env.example`. Keep credentials out of Git, frontend variables, logs and HTTP responses. Set a persistent, private session path outside release directories, owned by the application user (directory 0700, file 0600). Install Google Chrome from its official distribution, or supply a compatible Chromium executable. `playwright-core` is pinned; it does not download browsers during deployment.

Start with `CONNEX_ENABLED=true`, `CONNEX_WRITEBACK_ENABLED=false`. As the application user, run:

```
node scripts/sync-connex.js --dry-run
node scripts/sync-connex.js --dry-run <opportunity-id>
```

These checks read the portal and print counts/presence flags, never customer contacts. Enable writeback after reviewing the workflow. The worker runs every 30 seconds, discovers All Opportunities every five minutes and refreshes source details in batches (default 20), with a six-hour detail refresh. Email notifications and manually pasted links receive priority by resetting their read checkpoint. Forward Connex notifications to either configured South Morang lead inbox; there is no separate mailbox password. Direct canonical Connex opportunity links are recognized in text/HTML notifications. Other notification formats remain in email review or require the manager's opportunity link.

The worker requires a persistent Node process; request-only serverless hosting does not run this scheduler. Expiry encountered during a detail run signs in again and resumes the original record. Multi-factor prompts and CAPTCHA block sign-in and appear as connection errors; they are not bypassed.

Open **My Connex email and SMS alerts** to opt in to new-lead notifications and daily 3-day/6-week escalation digests. Delivery uses the authenticated staff account email or their explicitly entered mobile, the existing Hostinger SMTP account and approved SMS sender. Preferences default off. Historical imports do not produce new-lead notifications, source/ownership access is checked and daily digests are deduplicated. Uncertain/interrupted deliveries require checking the provider; they are not blindly resent. The notification timer runs separately every minute.

Manual sync resumes backfill and retries failed reads; it does not reset all successful checkpoints. A full refresh remains an explicit API option. Transient worker failures retry after 30 seconds; authentication failures wait 15 minutes to avoid repeated rejected sign-ins. Discovery errors are separate from detail-read errors, so a failed source list does not stop the saved detail queue. Phase, retry time and sanitized error codes are visible. Source milestone scans batch reads and only rewrite changed baselines. Shutdown closes the browser before the database pool.

Live investigation also found PM2 repeatedly restarting the backend at its 512 MB RSS limit during discovery. The backend now limits its V8 old heap to 256 MB so garbage collection runs before that process limit. Notification scans skip work when no staff have opted in and only fetch owners for linked source records.

The source worker uses a separate four-connection database pool so dashboard/import activity cannot exhaust its connections. Each native list has a 90-second scan budget; a spinner with no newly discovered IDs yields a partial list after 20 passes, allowing saved detail work to continue. Neither timeout nor spinner fallback marks history complete.

Unchanged candidate fingerprints and ordering do not trigger individual database round trips. A single bulk seen-time checkpoint records discovery for those rows; changed/new rows still receive individual verified refresh checkpoints.

Discovery reads the **3. Open** view first, then **All Opportunities**, deduplicating IDs. This prioritizes active enquiries even when the full list is capped. A failed view retains other discovered enquiries. Complete historical coverage still requires an authoritative count/export; the manager can upload source IDs from a Connex CSV export for verified retrieval beyond the list cap.

## Data integrity and recovery

All opportunities are checked against **South Morang Hyundai / H3752V** before import. Stable Salesforce opportunity IDs drive upserts. Nonempty source contacts fill records; staff-edited fields, staff allocations and pending loss review are protected. Repeated notification emails do not create empty customer records. Existing mobile collisions use the manager merge-review flow, retaining source links after a merge. Other lead feeds remain unchanged.

Short 15-character references normalize to the same checksum-validated 18-character identity used by portal links, preventing a second customer from being created for the alternate reference format. See [Salesforce ID field documentation](https://developer.salesforce.com/docs/platform/object-reference/guide/field-types.html).

Queue, candidate, baseline, mapping and synchronization documents live in the existing logical `integration_sync` collection and support `LEAD_STATE_COLLECTION` co-location. A persisted Mongo lease prevents concurrent workers. Writes have stable request IDs, bounded retries and post-save source verification. Stale allocations/outcomes are checked before execution. Interrupted/uncertain notes require checking Connex before posting again; the worker does not blindly resend them. Errors contain no credentials or raw browser traces.

Only an exact final source list count marks list coverage complete. A `50+`/truncated list is visibly incomplete and never causes CRM deletions. Partial detail failures are counted separately. Missing source records are not retired automatically. Acceptance is due by the end of the next Melbourne business day, skipping weekends and published Victorian holidays for 2026/2027. Managers can add or override dates under **Business-day calendar**. The official source has not confirmed the 2027 AFL Grand Final holiday; the UI makes that gap visible. Escalations use 3 and 42 elapsed days. The 4-day stale view uses a confirmed source Last Modified timestamp; missing timestamps are not assumed stale.

Bulk updates accept up to 50 source references, retain per-record authorization and sale/loss approval gates, and return per-record queue errors. Source-reference idempotency survives a lost bulk response. Saved filters and their default pin belong to the authenticated user. The main CRM source dropdown now includes Connex and continues matching linked Connex enquiries after a merge.

## Official API access findings

The dealer account exposes the portal's lead/account/profile workflow, not API application administration or an issued integration credential. Public searches did not locate an Australian HMCA developer contract or an authorized API client for this account. The bulletin describes approved provider activation, not an open API enrollment process. We have not substituted an unrelated Hyundai/global Connex hostname or reused a restricted browser token as an API token.

Salesforce documents that API calls require **API Enabled** permission and that Lightning sessions do not provide API access: [API requirements](https://developer.salesforce.com/docs/atlas.en-us.api.meta/service/implementation_considerations.htm), [session restrictions](https://developer.salesforce.com/docs/platform/salesforce-pages-developers-guide/guide/pages-variables-global-api.html). A genuine native connection therefore remains dependent on Hyundai issuing/approving the relevant API application and access. Portal workflow completion does not constitute Hyundai approved-LMS enrollment.

The 14 November server dry run successfully read a revealed Finance opportunity with all five customer/contact/vehicle/salesperson presence checks. All Opportunities returned 2,000 distinct references, but the portal did not expose an exact final count, so historical list coverage remains explicitly unconfirmed. Discovery is sorted newest first and detail reads prioritize those opportunities. Confirm older history against a Connex export or an approved provider feed before claiming a complete historical migration.

## Verification limits

Live inspection confirmed sign-in, masked and revealed records, All Opportunities, Accept/Update/Close/New Note controls, salesperson lookup separation, available status and loss-reason choices. Existing source records were not changed during this inspection. Fixture tests cover CRM idempotency, reveal/update, protected edits, duplicate phones, authentication/scope, approval gates, queues and retries. A real write must still be confirmed against a designated disposable Connex opportunity; a production customer must not be used merely as a test.
