# SMHY scope implementation — 16 November 2026

Implemented from `SMHY_Comprehensive_Dev_Update_Scope_16Nov2026.md`. This release is code only, prepared on `feat/smhy-16nov-scope`. No deployment, production migration, mailbox access or real Connex opportunity updates were performed. The branch is excluded from Vercel Git deployments; `main` remains unchanged. [Vercel branch deployment controls](https://vercel.com/docs/project-configuration/git-configuration).

| Scope | Implementation |
| --- | --- |
| 1 / 5: duplicate backlog | `scripts/fold-duplicates.js` plans same-site mobile/phone matches, including alternate numbers and Australian landlines, with email as a fallback when phone identities do not conflict. Primary selection prefers edited/allocated cards, then oldest source date. The default is read-only. Applying requires an exclusive private EJSON backup of leads and related work. Transactions and revision checks skip concurrent changes; repeat runs ignore tombstones. |
| 1 / 5: future ingestion | Nextgate, DealerSocket, Connex, website email and external intake share identity locks. A unique compatible imported identity attaches to the primary with source aliases, missing details and history. Conflicting identities, shared numbers and manual duplicate creation require manager review. Email-only matches also work. Merged card URLs resolve to the primary. Consent opt-outs survive merges. |
| 1 / 2 / 4: Save Next Action | Contact note, next action, task and previous-task completion save transactionally. Request IDs make a lost-response retry safe. Out-of-window future dates save as pending requests instead of returning a validation error. Past dates remain invalid. |
| 2: follow-up clocks | Source enquiry age drives the clock, not import or reassignment time: first three calendar days allow three-day scheduling, the following five allow five-day scheduling, then unrestricted future dates. All boundaries use Melbourne time. Optional stored `followup_limit_days` caps the early window. A later choice automatically requests review. |
| 1 / 2 / 7: Today and diary | Tomorrow's tasks remain in the diary but leave My Sales Day. Completed and awaiting-approval actions leave open task lists; approved later dates reopen only as future diary tasks. Rejected dates create a due task for choosing a replacement. Pulse attention and prospect overdue logic exclude pending/completed/future work. |
| 3: managers | Legacy allocation-only flags no longer block manager recipients or self-assignment. Individual and bulk reassignment retain future next actions. Pending and open tasks, linked deals and appointments follow the current lead owner. Explicit “call customer myself” remains a deliberate manager-owned task. |
| 3 / 8: consent | Customer-profile changes include a reason and audit entry. Opt-out immediately blocks SMS and AI drafting. Staff requests to restore contact wait for manager approval; rejecting an opt-out request does not silently restore contact. |
| 3 / 4: notes and losses | Notes store the authenticated author and role; note retries do not duplicate history. Legacy profile notes infer a role only from an unambiguous same-site account. Every lead source uses the same loss-category list and manager review workflow; Connex retains its compatible category field for outbound sync. |
| 6: video | Upload chunks increase from 256 KiB to 2 MiB (100 MiB takes 50 chunks instead of 400). Chunk retries retain byte identity; completion retries reuse the upload. Two renders run concurrently with bounded FFmpeg threads. Stale render recovery is five minutes instead of fifteen. Ready uploads attach automatically. Record/upload-video tasks finish when ready; send/share-video tasks finish after successful submission. Unrelated calls, approval-pending work and tasks created after the event are preserved. |
| 6: view tracking | A unique viewer-session event updates the media count, customer history and last-viewed timestamp, then records a deduplicated in-app alert and uses the existing opt-in Expo push channel when configured. |
| 5: Connex contact release | Masked open enquiries are preserved first, then accepted/allocated inside Connex to the configured contact-release manager. A unique eligible Mark can be matched by default, or a manager is selected explicitly in the UI using exact Connex salesperson mappings. Revealed details are re-imported while the platform's salesperson ownership is preserved on subsequent refreshes. Source writes must already be enabled. Missing/ambiguous mapping remains visible as a retryable failure rather than losing the masked enquiry. |
| 7: usability | Wider fixed-width table columns and wrapping, explicit “Customers updated today” completed-activity wording, and My Sales Day due-only queries are paired with the web implementation. Feed sync timestamps no longer count as staff record updates. |
| 8: manager queue | `/manager-approvals` combines date overrides, lost-lead reviews, consent reviews and duplicate merge review. Site scope is enforced. The queue is bounded; resolving the displayed customers exposes remaining work. |
| 8: bulk reassignment | `/leads/bulk-assignment` accepts up to 100 explicitly selected cards and expected owners, returns per-card conflicts, and retains dates/history. The web supports exact current consultant-name filtering, including former staff. |
| 8: activity / next action | Role, author and action filters distinguish manager notes, salesperson notes, video sent and video viewed. A completed action without a replacement shows the next-best-action prompt. Notes and next-action entry use mobile touch controls. |
| 8: duplicate warning | `/crm/duplicate-check` checks phone and email before creation. It discloses customer cards only to their owner or managers, while warning other staff without leaking another salesperson's contacts. |
| 8: video library | Managers explicitly approve generic, customer-free clips. Same-site staff attach an approved clip instantly with a new customer-specific token and separate view counts. Stored video bytes are reused. Managers can withdraw clips from future selection. |

## Local checks

HTTP tests use isolated in-memory fixtures, never the deployed database or messaging providers. Frontend handler tests cover date review/retries, consent, activity filters, duplicate-safe uploads, automatic ready-video attachment and clip approval. The production build is verified locally with Next's supported Webpack builder; the local Windows Turbopack PostCSS worker failed to start. No build was performed on the server.

## Later operational steps — not executed

After a separately requested deployment, initialize the new query indexes through the existing release procedure. Review a duplicate dry run:

```sh
node scripts/fold-duplicates.js --site "South Morang Hyundai"
```

The explicit apply form is:

```sh
node scripts/fold-duplicates.js --site "South Morang Hyundai" --apply --backup /absolute/private/smhy-duplicates-before.json
```

The backup contains customer data and must remain private. Review skipped conflicts in the manager queue. The old allocating-manager repair script belongs to the earlier scope and must not be rerun for this release.

Verify the contact-release manager's exact Connex contact mapping, source-write configuration and a safe opportunity after deployment. Verify push delivery using a registered device with push enabled. File-transfer speed depends on the connection and FFmpeg capacity; no live performance or live source-write claim is made for this undeployed change.
