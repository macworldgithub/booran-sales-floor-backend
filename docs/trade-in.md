# Trade-in follow-up

Implemented for the web app and backend. Native mobile is excluded. The optional
financial incentive is excluded until its amount and terms are approved.

## Activation after a future deployment

Use the persistent VPS and existing private media storage, CRM database and SMS
provider. The standalone server checks opportunities every minute. Serverless
hosts need a trusted scheduler calling app.locals.tradeIns.sweep().

Set TRADE_IN_PUBLIC_URL to the HTTPS web app origin, without /trade-in.
Generate a random TRADE_IN_TOKEN_SECRET of at least 32 characters. Keep it stable
across restarts; rotating it invalidates invitation links.
Set TRADE_IN_SMTP_USER and TRADE_IN_SMTP_PASSWORD to the approved outgoing
Hostinger mailbox for emails (SMTP port 465 with TLS).
Never commit real passwords or secrets.

In Appraisals → Vehicle buying → Automation, choose one dealership, enable
the required triggers and choose SMS, email or both. Set TRADE_IN_SEND_ENABLED
to true only when automatic customer contact is ready. Both gates must be on
to send. The default is off. A missing provider leaves its channel queued;
a missing customer contact is marked unavailable.

Sales/losses before activation are excluded. Completed sales explicitly marked
no-trade qualify, together with legacy deals without an appraisal or trade
details. An unknown trade decision is excluded. Approved losses qualify once
per loss review. Customer opt-outs and a shared 30-day contact cap apply to all
triggers. No incentive is promised.

## Service booking feed

Managers can add or cancel bookings in the web workspace. To connect a booking
provider, set a dedicated TRADE_IN_SERVICE_WEBHOOK_SECRET (32+ random characters)
and comma-separated exact dealership names in TRADE_IN_SERVICE_SITES.

The provider must POST JSON to /api/webhooks/trade-in/service-bookings using
an Authorization header with Bearer followed by the secret. Example payload:

    {
      "reference": "SERVICE-123",
      "dealership": "South Morang Hyundai",
      "startsAt": "2026-12-01T09:00:00+11:00",
      "customerName": "Example Customer",
      "phone": "+61400000000",
      "email": "customer@example.com",
      "vehicle": "Hyundai Tucson",
      "status": "booked"
    }

An existing leadId may replace customer details. Reference plus dealership
identifies the booking; retries update it. Updates and cancellations need that
reference, dealership, startsAt and status. A reference cannot be moved to
another customer. Customer matching reuses the existing identity checks;
conflicting contacts go through the existing merge review.

No connection to an external booking vendor is presumed. The provider must
be configured to send this feed. Send current bookings daily and cancellations
promptly. Only booked records observed in the past seven days and scheduled
three Melbourne calendar days ahead qualify. Cancellations/reschedules are
rechecked before dispatch. Managers receive an in-platform notification.

## Customer submissions and valuations

Signed invitations expire after 14 days. The public form exposes no customer
contact details. Uploads are private and bound to the invitation and customer:
ten photos maximum, at most 2 MB each. The browser compresses supported large
photos. Guided views cover front, right, rear, left and interior/cabin.
At least one finished photo is required. Incomplete uploads can be removed
and attempted again.

Submission is idempotent: one invitation creates one appraisal in the existing
valuation queue. A worker repairs interrupted submissions. Different submitted
vehicle details on the same invitation are rejected. Appraisals and media
follow customer assignment and merges.

Managers can record a valuation or select a wholesale offer. The signed-in
valuer and timestamp are recorded with an audit history. Sales staff see the
customer amount (gross less internal buffer) and valuer identity. Gross/buffer
and wholesale offers stay manager-only. Stale revision changes are rejected.

Vehicle buying → Lost-deal calls has phone links, feedback reason and manager
notes, also saved to the customer diary. Retrying the same call request does
not duplicate that entry.

## Delivery recovery

Mongo channel claims prevent concurrent workers from sending the same attempt.
Provider queued means accepted, so the invitation is not resent. Ambiguous or
interrupted provider attempts become unknown and require provider inspection
before manual recovery. Consult customer_messages and the provider first.
The invitation list shows channel states. No outbound message is sent while
TRADE_IN_SEND_ENABLED is false.
