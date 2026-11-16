# Booran appraisal workspace and iAppraise migration

The Sales Floor webapp uses `/api/appraisals`, `/api/appraisal-partners` and the existing customer-linked inspection, deal, PPSR, media and delivery workflows. Managers maintain partner contacts and wholesale valuations. Consultants can access their own appraisals and private inspection photographs. Contractors cannot access the appraisal workspace. Valuation requests are recorded internally; no outbound wholesaler messages or purchases are executed by these endpoints.

## Historical preservation

`scripts/prepare-iappraise-csv.py` preserves every original header and row from the account CSV, including blanks and repeated rows. The CSV has no upstream appraisal IDs, so each record is identified by the source file hash and row number. This is a snapshot archive, not a customer merge or a complete inspection export. The source CSV bytes are retained on disk. Department mappings are explicit; records without a recognised department retain their source group dealership and are not guessed into a brand silo.

`scripts/prepare-iappraise-contacts.py` preserves the Permissions table contacts as dealer staff contacts. It does not create login accounts, copy passwords, or grant source permissions in Sales Floor. Source role and PPSR permission remain historical data. These staff contacts must not be described as an external wholesaler directory.

```sh
python3 scripts/prepare-iappraise-csv.py /private/report.csv /private/csv-bundle
python3 scripts/prepare-iappraise-contacts.py /private/contacts.json /private/contacts-bundle
node scripts/import-iappraise.js /private/csv-bundle/manifest.json
node scripts/import-iappraise.js /private/contacts-bundle/manifest.json
# After reviewing the dry-run counts:
IAPPRAISE_ARCHIVE_DIR=/var/www/booran/shared/iappraise-archive node scripts/import-iappraise.js --apply /private/csv-bundle/manifest.json
IAPPRAISE_ARCHIVE_DIR=/var/www/booran/shared/iappraise-archive node scripts/import-iappraise.js --apply /private/contacts-bundle/manifest.json
```

Set `IAPPRAISE_ARCHIVE_DIR` in the backend runtime environment as well, so managers can retrieve migrated media through authenticated archive endpoints. Keep it outside release directories. Copy and back up the archive together with MongoDB and `/var/www/booran/shared/media`. New customer media already uses persistent server storage through the existing authenticated chunk-upload flow.

Version 1 manifests contain `expectedRecords`, explicit `expectedCounts` for `appraisal`, `dealer` and `wholesaler`, and a `records` array. Each row has `kind`, original `sourceId`, scoped `dealership`, `dataPath`, SHA-256 and optional `media`. Each attachment has its original `id`, `name`, relative `path`, byte `size` and SHA-256. Dealer/wholesaler records also include explicit `partner` fields (`name`, `company`, `email`, `phone`, `licence`, `notes`, `active`). `sourceFiles` can preserve original report bytes with their path, checksum and size.

If `LEAD_STATE_COLLECTION` is already configured to an existing operational collection, archive and partner records share that storage using separate `gs:iappraise_archive:` and `gs:appraisal_partners:` ID prefixes and mandatory `gs_state_kind` predicates. The importer, API and index initializer use the same mapping. This avoids creating collections on clusters at their collection limit and leaves pre-existing integration checkpoints untouched. Keep the existing physical collection setting; changing it would hide previously stored integration state. Query the logical collections through `withLeadState` in maintenance/reconciliation scripts as well.

The importer validates all files and counts before applying database writes, rejects escaping paths and symlinks outside the bundle, streams media checksum verification, and keeps raw JSON and original bytes. It writes immutable archive versions, batches database inserts, and uses stable partner IDs with insert-only updates so reruns do not overwrite staff edits. Interrupted imports can be rerun with the same manifest. A corrupt archived file fails verification rather than being silently ignored. Raw archive lists exclude full customer snapshots; a manager must open a scoped record to read them. Source URLs are never treated as local files or fetched automatically.

## Source completeness

The verified CSV snapshot contained 17,621 appraisal rows. It excludes inspection photographs/videos, damage maps, full offer history, detailed PPSR documents, service books and the external wholesaler contact directory. The visible Permissions table contained 68 staff/dealer contacts. The iTender screen reported that it was not enabled on this account. These are separate, explicit coverage limits; none of the import commands certifies an iAppraise replacement or decommissions that service.

Before final cutover, reconcile upstream appraisal IDs and record counts, every attachment and its bytes, wholesaler records, final offers, customer/deal associations and access boundaries. Use the existing app in parallel until that reconciliation is complete. Do not merge by registration alone or equate a CSV final-price column with the complete history of wholesale offers.

## Backups and deployment

`node scripts/snapshot-data.js /var/www/booran/backups/new-directory` creates private gzip EJSON exports and index metadata from both configured databases. This is a sequential logical backup, not a point-in-time transactional snapshot. A successful manifest is written only after all collection exports finish. Back up persistent media separately. Deployment uses the existing release/symlink procedure in `deploy.sh`, preserves the previous release and rolls back code on a failed health check. The migration adds archive/contact records and does not remove existing business records.

## Provider dependencies

Rego lookup, PPSR, AI damage assessment, SMS drafting and DMS submission use the pre-existing configured HTTPS adapters. They report unavailable services rather than fabricate results. Live VirtualYard/eraPower mappings, provider credentials and integration acceptance tests remain prerequisites for replacing those external workflows. The scope also requires manager acceptance and mobile-device validation; a web deployment does not release native binaries.
