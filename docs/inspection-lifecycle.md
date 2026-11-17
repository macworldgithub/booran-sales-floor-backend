# Inspection lifecycle extension

Internal drives now record start/finish times, authenticated driver, odometer readings, distance, duration and notes. Only one drive can be active per appraisal. Start request IDs and finish payloads support identical retries; conflicting repeats fail. Revision checks protect concurrent writes, and existing customer/site ownership applies to every endpoint. This is a vehicle checkout log, not background GPS tracking.

When registering a deal without an explicit appraisal, the only active customer appraisal is linked automatically. Multiple candidates require an explicit choice. `withoutAppraisal: true` records a deliberate no-trade choice. `PATCH /leads/:id/deals/:dealId/appraisal` accepts an appraisal ID and current deal revision; exported, signed or closed deals cannot change trade linkage. Related appraisal PPSR follows the link; valuation/cost visibility remains role-controlled.

Managers can record an already signed contract through `POST /leads/:id/deals/:dealId/contract` with `requestId`, `reference`, `signedAt` and `mediaId`. The attachment must be a ready private `contract` upload belonging to the same customer/site. PDF and image contracts are limited to 20 MB; PDFs are private downloads, excluded from public media/SMS sharing. The contract retains the deal's appraisal ID. Identical retries return the existing contract; replacements are rejected. Recording a document does not sign an agreement, complete a deal, submit to a DMS or automatically book delivery.

`GET /inspection-services` returns configuration-presence booleans only. External damage AI, Rego and PPSR provider setup is deferred at the user's request. Existing provider interfaces and inventory VIN fallback remain available; no simulated provider results are generated.

The web release adds drive controls, signed-document upload, appraisal relinking, prospect/deal registration lookup, deal PPSR controls and contract/drive visibility in Customer360. No native app source or binaries are included in this extension.

Validation: 168 backend tests passed, including HTTP scope, retry/conflict, manager-only contract and private-attachment checks. Complete source-media migration, external wholesaler-directory extraction, provider-specific contract synchronisation and actual-device acceptance remain outstanding. This change does not certify full iAppraise replacement. Deployment remains a separate release step.
