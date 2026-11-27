# South Morang BYD Virtual Yard feed

This integration runs independently of the Harmony Virtual Yard scraper. It imports
only records whose source dealership/location/yard is exactly `BYD South Morang`
or `South Morang BYD` (ignoring spaces and punctuation). Ambiguous sites, other
dealerships and rows without a verifiable site are excluded. Vehicle make alone
never establishes dealership ownership. Test drives are saved as source details
on their matching imported enquiry; they do not create CRM bookings or send SMS.

## Access and provider limits

Confirm the signed-in South Morang portal URL and obtain provider approval for
automated exports. A session cookie does not establish permission to bypass a
device block. Use Virtual Yard's supported API/export instead if required by the
provider. This adapter uses the same read-only datatable format as the existing
scraper; API migration requires the provider's actual lead/test-drive schema.

Requests run serially, at least five seconds apart, with at most 100 rows per
page and 500 requests per UTC day, across restarts. These are protective local
limits, not provider-approved quotas and not a guarantee against blocking.
Lower the budget or increase the interval to meet the provider's limits.
There are no automatic request retries. Rate limits respect Retry-After with a
minimum 24-hour cooldown. Device blocks and authentication failures latch a
persistent pause until an operator explicitly resumes. Session changes and
deployments do not clear it. No proxy rotation or verification bypass is used.

## Private configuration

Keep the real session out of Git, logs and frontend configuration. Configure:

```dotenv
VIRTUALYARD_DATA_DIR=/var/www/booran/shared/virtualyard
VIRTUALYARD_PORTAL_URL=https://dealers.virtualyard.com.au/VERIFIED-SOUTH-MORANG-PORTAL/
VIRTUALYARD_DELAY_MS=5000
VIRTUALYARD_DAILY_LIMIT=500
VIRTUALYARD_PAGE_SIZE=100
```

Store `session.json` under the data directory, owner `booran`, mode `0600`, with
the structure `{"cookie":"PHPSESSID=..."}`. Directory permissions should be `0700`.
Only the actual PHP session cookie is needed, not Stripe or analytics cookies.
The job loads the existing backend `.env` for the Booran database connection.

## Install and operate

Install the two `deploy/booran-virtualyard.*` unit files into `/etc/systemd/system`.
Create the shared directory before starting the service. The timer is daily at
20:30 UTC (01:30 Pakistan, 07:30 Melbourne during daylight saving).

```sh
systemctl daemon-reload
# Start only after source scope and provider access are confirmed:
systemctl start booran-virtualyard.service
systemctl enable --now booran-virtualyard.timer
journalctl -u booran-virtualyard.service -n 30
```

For a paused provider block, first resolve the block with Virtual Yard, then
stop the timer and explicitly resume as the Booran user. A resume does not bypass
a provider Retry-After time or daily request budget:

```sh
systemctl stop booran-virtualyard.timer
cd /var/www/booran/current/backend
sudo -u booran node scripts/sync-virtualyard.js --resume
# Enable the timer only after the manual sync succeeds.
```

`npm run sync:virtualyard -- --status` prints only operational metadata.
The private lock prevents concurrent manual/scheduled jobs. A stale lock is
recovered only when its process no longer exists. `last-success.json` is replaced
only after a complete, validated fetch and successful import. No missing source
record deletes or retires a CRM customer. A failed import can be safely rerun.

## Import behaviour

Source IDs are namespaced to this integration and dealership. Booran's existing
transactional identity matching merges matching identities or queues conflicts
for manager review. Repeat imports refresh `external.virtualyard` only, preserving
staff notes, phone/email edits, allocation, workflow status and consent. New
records start unassigned with AI messaging off. Upstream status, salesperson,
contact details and test drives remain available in the source reference.

Managers see feed status in Leads → Lead feed, email & Lost SMS settings.
The existing site-scoped status API returns counts and errors, never cookies.
For an approved export transformed into this adapter's version-1 scoped schema:

```sh
npm run sync:virtualyard -- --file /private/south-morang.json
npm run sync:virtualyard -- --file /private/south-morang.json --apply
```

The first command validates scope without connecting to MongoDB or Virtual Yard.
