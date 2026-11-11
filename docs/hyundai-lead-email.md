# South Morang Hyundai inbound lead email

Create `SMHYNew@goodshowroom.com` and `SMHYUsed@goodshowroom.com` in the domain's Hostinger email administration. VPS access alone does not provision hosted mailboxes. Add their passwords securely to the shared backend environment as `HYUNDAI_INBOUND_NEW_PASSWORD` and `HYUNDAI_INBOUND_USED_PASSWORD`, then reload the backend with the normal deployment procedure. Do not put credentials into Git or the frontend environment.

The standalone backend polls INBOX every 60 seconds using TLS on port 993 at `imap.hostinger.com`. Usernames default to the addresses above; override with `HYUNDAI_INBOUND_NEW_USER`, `HYUNDAI_INBOUND_USED_USER` or `HYUNDAI_INBOUND_IMAP_HOST` if necessary. The Manager Dashboard's **Lead feed and email status** reports mailbox setup, connectivity and the latest source snapshot.

Emails create unassigned South Morang Hyundai prospects tagged New or Used. Labelled customer name, mobile, email and vehicle fields are extracted from the text; the original subject and up to 5,000 characters of text are retained in notes. Unrecognised templates retain the enquiry for manual review. Email bodies must identify the customer explicitly; the sender's address is not assumed to be the customer's address.

The first poll imports existing INBOX messages, up to 50 per inbox per cycle. Imports use the email Message-ID for replay protection. Existing customer mobiles create manager merge reviews instead of duplicate customers. Messages over 10 MB produce a review receipt; review the original mailbox message manually. Polling never deletes, moves or marks messages as read. The checkpoint advances only after a durable receipt/import; UID validity changes restart scanning with message replay protection.

As an alternative to IMAP, a trusted email provider can POST to `/api/integrations/inbound-email/new` or `/used` with `Authorization: Bearer <HYUNDAI_INBOUND_EMAIL_SECRET>` (at least 32 random characters). JSON fields: `messageId` (required, stable), `subject`, `text`, `date` and optional `to` (must match the selected inbox). Keep this secret in server-side provider settings. Successful responses distinguish `imported` and `merge_review`; repeating the same message returns the existing receipt.

Verify with one synthetic email to each inbox after provisioning, then check the unassigned prospect, New/Used tag, captured details and mailbox connection status. Reprocessing the same Message-ID must not create another customer. Do not enable forwarding that loops messages back to these inboxes.
