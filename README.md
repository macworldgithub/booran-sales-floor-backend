# Booran Sales Floor API

Express API for the Next.js sales-floor frontend. Supports Vercel's Node.js function entry point at `api/index.js` and a standalone local server.

## Production VPS

The VPS deployment uses a dedicated `booran` system account, a separate PM2 process list, and Nginx. Booran listens on loopback ports 4101 for the web app and 4103 for the backend. Nginx serves the four public names with HTTPS.

| Service | Public hostnames |
| --- | --- |
| Web | `booran-sales-floor.goodshowroom.com`, `www.booran-sales-floor.goodshowroom.com` |
| API | `booran-sales-floor-backend.goodshowroom.com`, `www.booran-sales-floor-backend.goodshowroom.com` |

Provision Node.js 22, PM2, Nginx, Certbot, Git, curl and flock. Clone the backend and web repos under `/var/www/booran/repositories` using their repo names. Store the backend secrets in `/var/www/booran/shared/backend.env` owned by `booran` with mode 0600. Populate the two MongoDB URLs, SMS credentials, Nextgate credentials and webhook secret as applicable. The PM2 configuration supplies the runtime ports, public origins, internal API URL and MongoDB media storage.

If Nginx reports that the server name hash bucket is too small for the API alias, set `server_names_hash_bucket_size 128;` once in the shared `http` context before enabling the Booran site.

```bash
sudo -u booran -H bash /var/www/booran/repositories/booran-sales-floor-backend/deploy.sh
sudo pm2 startup systemd -u booran --hp /var/www/booran
sudo bash /var/www/booran/current/backend/deploy/install-nginx.sh http
# After all four DNS names resolve to this VPS:
sudo bash /var/www/booran/current/backend/deploy/install-nginx.sh tls
```

The release script fetches both main branches, installs locked dependencies, builds the Next.js standalone output, initializes MongoDB indexes, and switches the current symlink. It checks the API, web and web proxy before saving PM2. It restores the previous release if a health check fails. Set `BOORAN_FETCH=false` to deploy local main refs supplied via Git bundles when the VPS has no GitHub credentials. Keep at least the previous release directory. Install `deploy/logrotate.conf` under `/etc/logrotate.d/booran-sales-floor` for the application logs.

Use `deploy.sh --prepare-only` to build without switching PM2, then `deploy.sh --activate <release-path>` to initialize the database and activate that build.

Check the four HTTPS hosts after activation. For each API hostname request `/api/health`. For each web hostname request `/` and `/api/health`. Use the native app repo separately for Android and iOS releases.

## Nextgate lead queue

The Nextgate export CLI and backend share one Carsales client. The South Morang Kia new and used feeds map to South Morang Kia, the Hyundai new and used feeds map to South Morang Hyundai, and the Chery feed maps to Chery South Morang. Each upstream enquiry has a stable key based on its seller and lead ID. Reconciliation updates source details while retaining Sales Floor assignments, notes and edited customer details.

Run these commands from the backend directory.

```sh
npm run init:state
node scripts/import-nexgate.js --dry-run ../booran-leads/nexgate-leads.json
node scripts/import-nexgate.js --apply ../booran-leads/nexgate-leads.json
npm run sync:nexgate
```

The export file contains customer data. A snapshot run defaults to validation and requires `--apply` to import. Run the import against the intended CRM database. With no file, the sync command pulls the latest provider changes. Configure `NEXGATE_TOKEN` and any required `NEXGATE_USER_ID` and `NEXGATE_SELLER_GUID`. The standalone server and sync CLI can load the sibling `booran-leads/.env` when the backend has no token. Set credentials on the Vercel backend project for serverless use. The standalone server runs a sweep at startup and hourly. Vercel calls `GET /api/jobs/nexgate` at the top of each hour and needs a plan that supports hourly cron and a separate `CRON_SECRET`.

The hourly job overlaps the last successful search by 24 hours. Each seller has an independent MongoDB lease and checkpoint. Import the export to seed older data. Monitor the per-seller response for failures and check the workspace provider token if authentication fails.

For event-driven arrival, connect the approved Nextgate feed or relay to `POST /api/integrations/nexgate/leads` with `Authorization: Bearer <NEXGATE_WEBHOOK_SECRET>`. Use different random values of at least 24 characters for the job and webhook secrets. The relay adapts the provider payload to this shape.

```json
{
  "sellerIdentifier": "<configured seller UUID>",
  "customer": { "id": "<provider customer ID>", "firstName": "Example", "lastName": "Prospect", "mobilePhone": "0412345678", "email": "example@example.com" },
  "lead": { "id": "<provider lead ID>", "leadCreatedDate": "2026-11-07T08:00:00Z", "leadSource": "carsales", "stage": "New" }
}
```

The endpoint saves the enquiry before acknowledging the event. On the first page of Leads, managers see new records on the next five-second refresh. A standalone deployment can optionally set `NEXGATE_LIVE_POLL_MS=15000` to check the newest page of each feed between hourly sweeps. Use this when a push feed is unavailable and the provider permits the polling frequency.

The Leads list accepts `source`, `channel`, `assignment`, `owner`, `status`, `dealership`, `search`, `page` and `limit`. Dealer principals, general managers, sales managers and legacy managers can assign, reassign or return enquiries to the queue. Recipients must have an active Sales Floor account with access to the enquiry's dealership. The service applies the same restriction to direct record access and related bookings, inspections, deals and deliveries. Consultants only receive records allocated to their account ID.

## Phase 2 configuration

Run `npm run init:state` before deployment to create workflow indexes, including the uniqueness constraints for live stock deals and handover bookings. Use a MongoDB replica set for transactional allocation and duplicate merges.

New accounts use `dealer_principal`, `general_manager`, `sales_manager`, `sales_consultant` or `contractor`. The existing `manager` account for `southmorang@booran.com` has the same allocation permissions as the management roles. A record with `site: "South Morang"` covers the configured South Morang dealership group. Other accounts can use an exact dealership name or an explicit `allowedSites` array. Super admins have group access. Set `viewCost: true` only for staff permitted to see cost figures.

To add staff, pass a private JSON array to `node scripts/seed-accounts.js <accounts.json>` and supply a temporary `INITIAL_ACCOUNT_PASSWORD`. Each row has `email`, `name`, `role`, `site` and optional `allowedSites` and `viewCost`. The command preserves existing accounts. Keep the file and password outside version control.

PULSE uses Melbourne calendar days and manager-configurable targets per dealership. Managers can set a site geofence in PULSE. Contractors sign in to Delivery Centre, where they see their assigned accessory jobs and can finish work with an on-site photo. Inspection and licence photos use authenticated URLs. Mobile SMS supports attachments up to three minutes for video, draft approval, site senders and human takeover. Configure `MOBILEMESSAGE_SENDERS_JSON` with a verified sender for each dealership when using site-specific senders.

External calls use the configured HTTPS adapter and a bearer token. Rego lookup first checks scoped Booran inventory. The following adapters require a deployed service and credentials to make live calls.

| Adapter environment prefix | Request | Response |
| --- | --- | --- |
| `REGO_LOOKUP` | `rego`, `state` | `vin`, `make`, `model`, `year` |
| `PPSR` | `vin`, `requestId` | `status` (`clear` or `encumbered`), `reference` |
| `INSPECTION_AI` | Base64 `photo`, `contentType`, `instruction` | `condition` and `notes` for staff review |
| `SMS_DRAFT` | `question`, approved `knowledge`, `instruction` | `draft` |
| `BOORAN_DMS` | `requestId`, `dealership`, `customer`, `deal` | `reference` |

Set the corresponding `_URL` and `_TOKEN` values. PPSR and DMS adapters must honour the supplied idempotency key. A manager can configure approved dealer and OEM knowledge through `PATCH /api/ai-knowledge` with the dealership and knowledge text. AI SMS drafts require explicit staff review before sending, and a staff send pauses AI for that customer. Push alerts require `EXPO_PUSH_ENABLED=true`, configured Expo credentials, and device opt-in in the app.

## Setup

Use Node.js 22. Run `npm ci`, copy `.env.example` to `.env`, and set `MONGODB_URI_FLWUP` and `MONGODB_URI_BOORAN`. Each URI must include its intended database name. Run `npm start` for the local API on port 5001.

To provision the requested accounts, temporarily set `INITIAL_ACCOUNT_PASSWORD` in your shell to the agreed initial password and run `npm run seed:accounts`. Remove that shell variable afterwards. This creates missing accounts without resetting existing passwords or roles.

| Account | Role | Access |
| --- | --- | --- |
| devs@omnisuiteai.com | super_admin | All locations and global feed logs |
| southmorang@booran.com | manager | South Morang dealership group only |

The accounts have already been provisioned in the database configured in this workspace. Re-run provisioning when deploying against a different database.

## Session and access controls

Passwords use independently salted scrypt hashes with constant-time verification. Sessions contain random 256-bit tokens; only token hashes are stored in MongoDB. Cookies are HttpOnly, SameSite=Lax, and Secure on Vercel/production. Sessions expire after eight hours, are checked against an active user on every API request, and are deleted at logout. Login throttling is stored in MongoDB so it works across serverless instances. TTL indexes clean expired sessions and throttling records.

The Next.js frontend proxies API requests on its own origin and forwards the cookie. The backend denies business data without a session. Site scopes are server-owned and combined with every query using AND, including direct IDs, search, statistics, aggregates, bookings, and writes. Site users cannot move records to another location. Global organisation and feed-log endpoints require super admin access. Do not implement role changes in the browser.

## Database collections and migration

Accounts, sessions, login throttles, and bookings use dedicated `users`, `sessions`, `login_attempts`, and `appointments` collections in `flwup_crm`. Account emails are unique. TTL indexes expire sessions and throttle records; appointment indexes support date and location queries. The previous shared `dashboards` storage is no longer used by the running API.

For a database using the earlier shared storage:

1. Stop writes to the old backend during the migration.
2. Run `npm run migrate:state` to review the migration without writing data.
3. Run `node scripts/migrate-app-state.js --apply`, then deploy the updated backend.

The migration preserves record IDs, password hashes, active sessions, and bookings. It corrects the South Morang email to `southmorang@booran.com`, checks for conflicts before writing, and does not overwrite unrelated records. The legacy documents remain as a backup. `app_migrations` records completion so later runs cannot restore a session that was already revoked. Expired sessions and throttles are skipped. Set `LEGACY_APP_STATE_COLLECTION` only if the old documents are in a collection other than `dashboards`; the previous `APP_STATE_COLLECTION` variable is accepted by the migration script for compatibility, and is not used by the API.

This migration has already been applied to the database configured in this workspace. `seed:accounts` also checks the migration before provisioning missing users, so it preserves existing credentials.

## Vercel

Create a separate project rooted at `booran-sales-floor-backend`, framework Other, Node.js 22. Set both MongoDB URIs. The existing `vercel.json` routes requests to `api/index.js`. Configure the frontend's server-only `API_URL` to this deployment's `/api` URL. Deploy the backend before the updated frontend.

`ALLOWED_ORIGINS` is an optional comma-separated list for direct browser requests; the frontend's same-origin proxy does not need it. Requests with an unapproved Origin cannot perform writes. Responses containing business data use `private, no-store`. MongoDB pools and in-flight connection promises are reused; failed connections can retry.

Before opening a deployment to staff, run `npm test` and `npm run check`, then verify account access over HTTPS. Health checks at `/api/health` return 503 when either database is unavailable.

## Customer SMS and photo/video sharing

Customer360 uses Mobile Message, following the Delivery Centre integration. Configure `MOBILEMESSAGE_USERNAME`, `MOBILEMESSAGE_PASSWORD` (or `MOBILEMESSAGE_API_KEY`) and `MOBILEMESSAGE_SENDER_ID` (or `MOBILEMESSAGE_FROM`) in the backend Vercel project. The sender must already be approved on that provider account. Credentials stay on the backend. See the [Mobile Message API documentation](https://mobilemessage.com.au/api-documentation).

Each send is stored in `customer_messages` with its customer ID, dealership, verified staff identity, recipient, complete SMS body, attached media and provider acceptance state. The customer diary also receives the attempt. Repeating a request ID returns the existing attempt; concurrent requests cannot send it twice. Queued means accepted by Mobile Message, rather than delivered to a handset. Failed and unconfirmed sends remain visible; check the provider before repeating an unconfirmed send.

Incoming replies are read through authenticated `GET /v1/inbound` when customer history refreshes, with a 15-second successful-sync cache. This preserves the provider account's existing Delivery Centre webhook. Only replies whose original provider ID/custom reference and sending phone match this lead's Sales Floor outgoing records are saved. Unmatched/shared-account messages are excluded. Replies still attach to the original lead after its mobile number changes. Provider IDs deduplicate repeated/overlapping reads, and each new reply is logged in the customer diary. Inbox reads paginate, begin from the earliest Sales Floor send on first sync, and subsequently overlap the last successful UTC day. Failures preserve saved history, display a warning and leave the sync checkpoint unchanged so a later refresh retries. No additional provider credentials or Vercel environment variables are needed.

Opening customer history now checks Mobile Message's documented `GET /v1/messages` endpoint for outstanding sends and stores the returned sent/delivered/failed/cancelled state. Lookups validate both the message ID and recipient, use a bounded request budget, and briefly cache successful checks. A provider outage preserves the last known status and displays a warning. The open customer card refreshes every five seconds without clearing an unsent draft. No messages are resent during status checks.

SMS history reads only this app's `customer_messages` collection. Delivery Centre and Lead Centre stores are not queried. Older Booran messages remain available after changing the lead's mobile number because they retain the lead ID and original recipient. Customer360 provides Add number / Edit number controls; saved numbers are validated and normalised to Australian mobile format. Sending is disabled while a number is being edited, and editing is disabled while a send is being confirmed.

`MEDIA_STORAGE_BACKEND=auto` saves files on local disk on a normal backend server and in the existing CRM MongoDB database on Vercel. You can explicitly select `local` or `mongodb`. MongoDB uploads use immutable 2 MB binary documents in `message_media_chunks`, with safe identical retries and completion checks. No AWS account or additional storage credentials are needed. Local files use `MEDIA_STORAGE_DIR=storage/media` and are ignored by Git.

Set `BACKEND_PUBLIC_URL=http://localhost:5001` for local development. Before sending customer links, replace it with the publicly reachable HTTPS URL of the backend server. Localhost links work only on the same computer. The backend serves each completed upload through an unguessable `/api/media/:token` URL, without a staff login. Only share media intended for the recipient; anyone with the link can open it. Links remain valid while the database record and local file exist.

Supported formats are JPEG, PNG, WebP, GIF, HEIC/HEIF, MP4, MOV and WebM, up to 100 MB per file and five attachments per SMS. Authenticated uploads use 2 MB binary chunks through the same-origin frontend proxy. The backend bounds each chunk, checks customer/dealership access, verifies offsets and completed size, and finalises the uploaded file only after all bytes are present. Retrying an identical chunk is safe; changed or overlapping chunks are rejected. Public downloads support byte ranges for video seeking. Only completed files are served; staging files are private.

Vercel media links open a real Booran photo/video viewer. File bytes are read from MongoDB in responses of at most 2 MB, within Vercel's payload limits. Photos are assembled in the recipient's browser; videos support byte-range seeking. Both can be downloaded. Only completed uploads are public through unguessable share tokens. These links contain the actual file, with no simulated upload. See [Vercel function payload limits](https://vercel.com/docs/functions/limitations). Set `BACKEND_PUBLIC_URL` to the public backend origin in production; the existing Vercel backend URL is the default on Vercel.

Back up both the database and media directory together. Abandoned uploads remain under `staging/`; remove them only when no uploads are active. If a server process was killed while uploading, a `.lock` file can remain for that upload; clear abandoned locks while the server is stopped. Keep `files/` for as long as customer share links must work. Existing uploads from the former cloud implementation must be re-uploaded; this change does not copy remote files.

For larger message libraries, create Mongo indexes on `customer_messages: { lead_id: 1, created_at: -1, _id: -1 }`, `message_media: { lead_id: 1, status: 1, created_at: -1, _id: -1 }`, and a unique sparse index on `message_media: { share_token: 1 }`. Mongo's built-in `_id` uniqueness already enforces send deduplication.

Deploy this backend first, then the frontend. Verify with a test customer and a recipient number you control: send a text, upload a photo and video, send their links, reopen Customer360, and open the links without a staff session. Automated tests use a fake SMS provider and isolated temporary local storage; they do not send live SMS or upload customer data.

## Lists

Leads, inventory, actions, appointments and feed logs return `pagination: { page, limit, total, totalPages }`. Pages and limits are bounded; limits are capped at 100. Sort fields are allowlisted and all paginated sorts include an `_id` tie breaker. Search strings are escaped as literal text. Appointment queries accept ISO `from`/`to` boundaries (exclusive end) and visit `type`; global feed logs support `status` and `search`.

## Tests

`npm test` covers literal search, malformed pagination, stable/allowlisted sorts, location queries, cross-site write rejection, scoped ID updates/aggregates, password hashing, and migration identity/conflict protection. HTTP checks additionally verified both logins, cookie flags, unauthenticated rejection, cross-location access, forged location filters, global-feed denial, CSRF protection in the frontend proxy, and logout revocation. Business records were not modified by these smoke checks.

## Dealership filter boundaries

Specific rooftop filters match the complete dealership name (case-insensitively), rather than a substring. The South Morang account covers the South Morang location group: BYD South Morang, Chery South Morang, South Morang Hyundai, and South Morang Kia. Selecting all removes only the optional list filter; it never removes the account's authorised location boundary. Add any new South Morang franchise to the central location group in `lib/query.js` before enabling its access.

Lead status/owner/search, inventory category/aging/status/make/search, and action type/priority/status/search predicates combine with the selected location. Record and count queries receive the same conditions. Staff totals group each consultant by actual dealership after applying scope. Bookings carry their selected dealership and reject cross-scope lead references or writes.

Filter regression fixtures test individual and combined predicates, empty results, all-status behaviour, exact names versus lookalikes, matching read/count scopes, and the South Morang boundary. Live database re-verification for this change was blocked by DNS timeouts in the implementation environment.

## Write integrity and regression checks

Lead list, detail, search, create, and update responses share one serializer. Writes validate text, enums, nested fields, appointment dates, durations, and linked dealerships. Notes and hold consultant names use the verified account identity. Validation failures return 400; unavailable vehicle transitions return 409.

New vehicle holds are retired. Managers can release an existing hold using its exact reference. Expired holds are shown as available stock. Registered deals mark the unit pending and completed deals mark it sold. Resolving an action records its completion and reopening it clears the completion timestamp.

`test/api.test.js` runs the Express routes, authentication, access scopes, validators, and queries against isolated in-memory storage. It covers login and session expiry, role and site boundaries, filters with pagination totals, Nextgate replay and allocation, deal-pending status, legacy hold release, and appointments.

Hold release requests must send the displayed `holdId` (or `heldAt` for older records). The conditional update matches that exact hold, so a delayed release cannot clear a replacement hold. Deploy the matching frontend with this API change. Empty action updates return 400, cleared lead details stay cleared, malformed stored sessions return 401, and date filters reject impossible calendar days.

Expired-session responses do not clear browser cookies: an older request may complete after a new login, and clearing its cookie would erase the newer session. Explicit logout still revokes the session and clears its cookie. HTTP regression tests reproduce this request ordering. Parser errors retain their 400/415 status and no-store headers; health checks probe both databases independently, and Mongo date values in lead diary entries remain intact in API responses.
