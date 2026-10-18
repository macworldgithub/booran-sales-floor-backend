# Booran Sales Floor API

Express API for the Next.js sales-floor frontend. Supports Vercel's Node.js function entry point at `api/index.js` and a standalone local server.

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

## Lists

Leads, inventory, actions, appointments and feed logs return `pagination: { page, limit, total, totalPages }`. Pages and limits are bounded; limits are capped at 100. Sort fields are allowlisted and all paginated sorts include an `_id` tie breaker. Search strings are escaped as literal text. Appointment queries accept ISO `from`/`to` boundaries (exclusive end) and visit `type`; global feed logs support `status` and `search`.

## Tests

`npm test` covers literal search, malformed pagination, stable/allowlisted sorts, location queries, cross-site write rejection, scoped ID updates/aggregates, password hashing, and migration identity/conflict protection. HTTP checks additionally verified both logins, cookie flags, unauthenticated rejection, cross-location access, forged location filters, global-feed denial, CSRF protection in the frontend proxy, and logout revocation. Business records were not modified by these smoke checks.
