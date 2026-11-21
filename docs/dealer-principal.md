# Dealer Principal live dashboard

Implemented from `Good_Showroom_DP_Live_Dashboard_Scope.pdf` inside Sales Floor. The owner clarified that the separate Warranty Evidence portal is **not linked**: service observations use Sales Floor data. This feature uses no warranty-portal credentials or session files.

## Staff training

1. Sign in with a management account and choose **Dealer Principal** under Group Management. Dealer Principal accounts land here by default unless a URL explicitly requests another tab.
2. Choose a dealership or **Group · all authorised sites**, then MTD, YTD or custom dates. Dates use Australia/Melbourne with daylight saving. Inventory is current even for a historical sales period.
3. **Sales performance** shows sold units and target pace, recorded gross and average gross, conversion, close ratio, trends and salesperson ranking. Select a sales headline or **View sales** for paginated source records, then **Open customer** for the existing CRM record.
4. **Inventory issues & opportunities** shows aging, category days supply, demand/supply opportunities, value, stock turn and carrying costs. **View all aged stock** opens searchable records; **Open vehicle** opens the existing inventory workspace. Suggestions do not automatically change prices.
5. **Multi-site benchmarking** compares sites. Selecting a site drills into its report. Single-site accounts cannot see foreign sites.
6. **Service matrix** shows department health, CSI, claims and cycle time, technician efficiency, repair time, revenue and retention. Existing service bookings are shown separately from measured performance.
7. **Record service data** stores one observation per site/date/department. Enter averages with sample counts. Leave unknown measures blank; use 0 only for an observed zero. Saving updates that entry and preserves its revision history. To correct values, load the same entry and save; after a conflict, reload before reapplying changes.
8. **Targets & setup** saves a single site's unit and service targets, visible modules and custom KPI targets. Money targets are labelled AUD cents. The gross target applies to the reporting period and is not automatically prorated between MTD/YTD. Group unit/gross targets are available only when every selected site has configured targets.
9. **Export report** downloads scoped site/department CSV metrics and definitions. Exports are dealership confidential; unknown values remain unavailable.

The dashboard refreshes every 15 seconds while visible, on resume and after successful application mutations. The server cache lasts five seconds and includes account/role/site permissions and report filters. Switching site, dates or account immediately hides the previous financial scope. Errors show a retry control; existing figures for the same scope remain visible.

## Roles and onboarding

Existing `dealer_principal`, `general_manager`, `sales_manager`, `manager` and `super_admin` roles may access the dashboard. Group managers use existing `allowedSites`; site managers use one permitted site. Sales consultants and contractors cannot use reporting, financial drilldowns, settings, imports or service-entry endpoints. This extends the existing account system.

Super admins can use **Targets & setup → Onboard a dealership** to register a rooftop in both CRM and stock catalogues. This never grants permissions. Assign account access separately in **Staff & Allocation**. Configure the site's targets and ensure imports use its canonical dealership name.

## Persistence and metric definitions

Sources are the existing CRM (`MONGODB_URI_FLWUP`) and inventory (`MONGODB_URI_BOORAN`), with the existing server-enforced site boundaries. New logical CRM collections:

| Collection | Purpose |
| --- | --- |
| `dp_settings` | One revision-protected target/widget/KPI configuration per site |
| `dp_service_entries` | Daily departmental measurements, author and prior revisions |
| `dp_sales_events` | Optional external DMS sales upserted by site/external ID |
| `dp_inventory_snapshots` | Observed daily stock balances for average-stock turnover |

With `LEAD_STATE_COLLECTION`, these use the existing co-location adapter and `gs:<collection>:` ID namespaces in that physical collection. The normal application-state initialiser creates their indexes. No separate database is required.

| Metric | Definition and limits |
| --- | --- |
| Units sold | Completed local deals, optional completed DMS sales and dated Sold CRM outcomes, reconciled by site/day/VIN, stock number or linked customer where vehicle information is absent. Different cars for one customer remain separate units. DMS values take precedence; matching local deals enrich missing financials. Records lacking common references stay distinct: correct source identifiers rather than guess matches. |
| Gross / average | Recorded gross cents / units with recorded gross. Financial coverage shows known units; unknown gross is unavailable. Partial gross is labelled recorded gross. Gross-target alerts require complete coverage. |
| Conversion | Received-period enquiries with a Sold outcome before period end / received-period enquiries. A current Sold status lacking an outcome date counts only in a report ending today, not as a proven historical conversion. |
| Close ratio | Unique won customer/opportunity outcomes / (won outcomes + approved losses in the period). Several cars for one linked customer count as one won outcome. |
| Variance / pace | Comparison with the immediately preceding period of equal length. Unit target pace uses elapsed calendar days against configured monthly/yearly targets. |
| Days supply | Current available stock / (latest 30 Melbourne calendar days' unit sales / 30), overall and by category. No sales velocity means unavailable days supply. |
| Inventory turn | Last 30 days' unit sales / average of 30 daily observed balances, annualized by 365/30. All selected sites need all 30 observations. The separately labelled current-stock velocity proxy uses today's stock. This is unit turnover, not audited COGS/book-value turnover. |
| Stock age / value | Existing arrival date or recorded days and stock cost. Unknown dates have an Unknown age bucket; missing costs reduce value coverage. Completed/sold/wholesale/hidden stock is excluded. |
| Carrying cost | Existing holding-cost policy (floorplan and recorded paid leads), with coverage. The configurable annual-rate forecast is separately labelled, not an accounting charge. |
| Hot models | At least 3 recent active enquiries and demand more than twice stock, or stock below minimum days supply against recent model sales. |
| CSI | Sum of score × responses / total responses. |
| Technician efficiency | Total productive hours / available hours × 100. |
| Repair time | Total repair hours / repair count. |
| Claim cycle | Total cycle hours / sampled claims / 24. |
| Retention | Retained customers / eligible customers × 100. |
| Health | Red if a recorded targeted measure fails; green only when all targeted measures are recorded and pass; otherwise unavailable unless a recorded measure fails. Missing individual metrics stay unavailable. Group service thresholds use common defaults; sites use saved thresholds. |

The standalone API captures current-day stock balances at startup and hourly, overwriting the same site/date ID. It never reconstructs prior dates from current stock. History begins when this release runs. A serverless deployment needs an equivalent scheduled trusted capture job. Missing worker days keep actual turnover unavailable until 30 complete daily observations exist. Bounded source reads fail visibly rather than silently truncating reports.

## Optional DMS connector and API

Existing Sales Floor CRM and inventory are the default live connectors. Additional DMS access is optional and requires a real provider-approved API/export; this release does not imply provider access has been provisioned.

Configure server-only `DP_DMS_FEED_URL` (HTTPS) and `DP_DMS_FEED_TOKEN`, then use **Data sources & metric definitions → Refresh optional DMS feed**. The request sends a Bearer token, `sites`, `limit=500` and optional `cursor`. Response: `{ "records": [...], "nextCursor": null | "opaque cursor" }`. Redirects, repeating cursors and oversized bodies/pages/batches are rejected. The complete export is validated before writes. The provider must return only sites authorised in the current report; foreign-site rows reject the batch.

Managers may POST `/api/dp/sales/import?rooftop=<site>` with `{ "records": [...] }`. Each row requires `externalId`, `site`, `date` (ISO timestamp); optional `status` (`completed`/`cancelled`), `units` (default 1), `grossCents`, `revenueCents`, `leadId`, `ownerId`, `ownerName`, `stockNumber`, `vin`, `make`, `model`, `category`. Money uses integer AUD cents; negative gross is allowed. Site/externalId retries update the same record. Cancelling an external sale removes that source record from totals; an independently still-completed local sale remains until its own source is corrected.

Read endpoints: GET `/api/dp/dashboard`, `/api/dp/drilldown`, with `rooftop`, `period=mtd|ytd|custom`, `from`, `to`. Details add `kind=sales|inventory|service`, `page`, `limit`, `search`, optional `aging=true`. Other routes: PATCH `/api/dp/settings`, GET/PUT `/api/dp/service-entry`, POST `/api/dp/sales/sync`, super-admin-only POST `/api/dp/sites`. Existing session, origin/CSRF checks, rate limits and private no-store policy apply. Service saves require a request UUID and current revision; retry the unchanged request after a lost response.

## Administrator handover

This change does not deploy or relocate infrastructure. **Australian hosting/data residency remains a deployment requirement and cannot be certified by application code.** Before release, confirm Australian regions for web/API, databases, media, replicas and backups; review subprocessors, exports, log destinations and dealership retention/access policies; use existing TLS, secret storage, least-privilege database users and backups; run application-state index initialisation and release health checks/rollback. Installing the dashboard alone does not establish Privacy Act compliance.

After a future authorised deployment, validate DP and single-site manager access, group/site reconciliation and foreign-site denial; compare a known sale to its source; configure site targets; use an isolated service observation with unequal CSI sample sizes; retry a save and confirm one record; confirm missing measures remain unavailable; check CSV, refresh and desktop/tablet layout. Use disposable fixtures or an approved test site, not existing customer mutations. Automated tests for this release use synthetic data only.

## Expansion

Modules are registered in `lib/dp/validation.js` and a frontend renderer registry. Per-site settings select modules and up to 12 custom KPI thresholds from named metrics without arbitrary expressions. New departments work through daily service entries. Extend with scoped collections, validated connectors, typed response fields and a registered renderer. The PDF's parts/wholesale, F&I, lifecycle and AI items remain future roadmap datasets; current rule-based alerts are not presented as AI.
