# GEHPM Rental Management — Progress Log

Living record of every update applied to this repository
(`origin → https://github.com/keemx1/rental-management`, branch `main`).

**Last updated:** 2026-10-25 · app version `v63` · SW cache `gutenberg-v64-irmanage`

---

## How updates flow

1. Implement the change (display-only changes never touch calculations unless the fix is the point).
2. Run both verification suites (below) — a change only ships when they pass.
3. Record the update in this file (Completed) and move planned items as they land.
4. Commit to `main`; push when requested.

---

## Verification suites

Run from the repo root (server must be up on port `3003`):

| Suite | Command | Covers |
|---|---|---|
| Dashboard metrics | `node tests/test_dashboard_metrics.js` | 37 assertions — every dashboard card equals its drilldown rows; arrears/progress invariants |
| Report formatting | `node tests/test_report_formatting.js` | 148 assertions — Excel layout (widths, wrapping, frozen headers, print titles, number formats, totals reconcile), PDF orientation, in-app report styles |
| Tenancy permanence | `node tests/test_tenancy_history.js` | 50 assertions — two tenants re-letting one unit: previous tenancy's records never deleted/merged/relinked, finalized exit invoice immutable, archive shows complete per-tenancy payment history |
| Financial integrity | `node tests/test_financial_integrity.js` | 27 assertions — payments rejected against incomplete/non-existent/vacant tenancies at app AND database level, re-linking blocked, delete archives instead of destroying, RESTRICT constraints, origin + audit trail |

Sample generated reports land in `scratch/report_samples/` (ignored by git).

---

## Completed updates

### 1. Rent balance & unit display fixes
- Rent reminders and message previews now read the **tenant profile balance**
  (`summary.balance`) instead of a stale/incorrect figure — William Chege's
  message preview now shows the exact account balance (Arrears + current rent − payments).
- Unit fallback: `unit_label || tenant_code`, so accounts without a unit
  label (e.g. `SS7`) always display a house/unit.

### 2. SMS delivery fixes
- Bytewave SMS gateway token/authentication fixed — outbound SMS sends succeed again.

### 3. Console flash fix
- Removed the task that flashed the console on run; app boots cleanly.

### 4. Caddy reverse proxy restored
- `Caddy` running again (ports 80/443); `rental.quantumcode.co.ke` → HTTPS 200.
- Auto-start registered as scheduled task `CaddyProxyAutoStart` (logon trigger,
  guarded by a port-443 check in `Caddy/start_caddy.ps1`) and test-ran successfully.

### 5. Dashboard Command Center rework (app `v61`)
- Every card is now **derived from the database** with shared predicates, so a
  card's count always equals the records behind it:
  - Total tenants / Vacant (reserved bookings excluded) / Overdue (live rent
    rule, not the stale status column) / Due in 7 days / Collected MTD /
    Pending payments / Total arrears (full balance breakdown).
- New **Collection Progress** panel: expected vs collected vs outstanding for
  the billing period, with progress bar and collection percentage.
- **Click-through drilldowns**: every card and the progress panel open a modal
  listing the underlying records (vacant, overdue, due-7-days, pending,
  arrears, revenue, progress) via `GET /api/dashboard/drilldown/:kind`
  (whitelisted kinds, 400 on unknown); tenant names link to their accounts.
- Dashboard refreshes immediately after a rollover run (plus the existing 30s poll).
- Fixed the ExcelJS no-op: header repetition now writes `printTitlesRow`
  (the old `repeatRows` property was silently dropped on save).

### 6. System-wide report formatting (app `v62`) — "Professional display & readability"
Applies to **all** reports: Outstanding Balances, Unpaid Units, Deposits & New
Tenants, Vacancy, Payments, Collection (2 sheets), Monthly Standard, Enhanced
Monthly (11 sheets incl. Landlord/Commission/Reconciliation), Water Bill PDF,
Management Expenses PDF, Work Order PDF, and every in-app report table.

**Excel (all workbooks):**
- Column widths auto-fit content; text wraps (tenant names, apartments, units);
  row heights auto-adjust (merged banners measured across their full width).
- Frozen header panes on compact reports; repeating column headings on every
  printed page (verified as `_xlnm.Print_Titles` inside the generated files).
- Consistent money number formats (`#,##0.##`), bold/grey standard headers,
  A4 print setup — fit-to-width, landscape for wide tables, portrait for narrow.
- Previously unformatted sheets now covered (Deposits & New Tenants, Vacancy,
  Payments Report, all landlord sheets with their coloured headers preserved).
- Compact letterheads (140pt → 70pt logo rows); title merges fixed to span the
  real grid (`A:H`→`A:J`, `A:E`→`A:F`).
- Fixed `sendExcelReport` ReferenceError that broke the collection report's
  WhatsApp-send mode (moved to shared `services/excelStream.js`).
- Removed the duplicated "Unpaid Units" label in the Enhanced summary grid.

**PDF (every generated PDF):**
- Shared print rules injected at generation: repeating table heads, rows never
  split across pages, exact print colours, **10mm print-safe margins**
  (was 0 — content bled to the paper edge).
- Landscape A4 for wide reports: Water Bill Report, Management Expenses
  Report, Work Order register (verified `841.9 × 595.9` pt page boxes).

**In-app / browser print:**
- `.cyber-table` was referenced by 24 report tables but **never defined** — now
  styled: consistent headers, zebra rows, `overflow-wrap: anywhere` for long
  names, min-width so the existing scroll wrappers engage on phones instead of
  crushing columns.
- New print stylesheet: `window.print()` on the Management Expenses report now
  prints only that report (app chrome hidden) on A4 landscape with visible
  borders and repeating headings.

### 7. Repository housekeeping (this commit)
- Verification suites promoted from ignored `scratch/` to tracked `tests/`.
- `.gitignore`: runtime document store (`backend/storage/documents/`),
  WhatsApp session keys (`backend/whatsapp/sessions*`), sample report output
  and one-off debug scripts no longer enter the repo; 43 generated PDFs that
  had been tracked are removed from version control.
- First commit bundling all pending work: offline sync engine (`sync-engine`,
  `offline-*`, `mpesa-parse`, `water-anomaly`, `agreement-scan`), new routes
  (commissions, inspections, payment arrangements, settings, SMS, sync), letter
  services + official stamp/signature, tenant agreements, landlord sheets,
  water bill report, migration scripts, PWA icons, `multer` dependency.

### 8. Tenancy-scoped financial history — permanent per-occupancy records (app `v63`)
Unit history and tenancy history are now fully separated: the unit can be
reused, but every completed tenancy keeps its own permanent financial and exit
records. Nothing belonging to a previous tenant is ever deleted, merged or
relinked when a new tenant takes the same unit.

- **Tenancy binding:** `tenancy_id` (→ `tenancy_archive.id`) added to
  `payments, penalties, documents, water_invoices, deposit_applications,
  credit_allocations, message_logs, tenancy_agreements, inspections,
  maintenance_charges` (migration `backend/scripts/migrate-tenancy-ids.js`,
  backfilled). `NULL` = current live tenancy; a value = permanently bound to
  one completed tenancy. Sealing happens automatically at vacate/archive.
- **Re-let no longer destroys history:** `resetTenancyFinancials` used to
  `DELETE FROM payments/penalties` on every new occupancy (the old code wiped
  the previous tenant's money rows outright). It now seals any un-stamped
  strays to the previous tenancy's archive instead — nothing is deleted.
- **Both re-let paths start clean:** the reservation-activation path
  (`activateFutureTenancy`) previously ADDED the new tenant's booking amounts
  on top of the previous tenant's leftover `deposit_paid/rent_paid/credit`
  counters (a real merge bug). It now resets all financial fields to fresh
  values and applies only the new tenancy's own figures.
- **Live views isolated:** every tenant-scoped balance/query (reconcile,
  statements, penalties, deposit applications, water meter reading, first-payment
  detection, rollover, profile) filters to `tenancy_id IS NULL` — the incoming
  tenant can never see, inherit or be recalculated from the previous tenancy's
  rows. Payment/revenue ledgers keep ALL rows (money received is real) but show
  the HISTORICAL tenant's name via the archive join.
- **Finalized exit invoices are immutable:** server refuses edit/delete with
  409; the UI now shows a "Finalized — permanent record" notice instead of
  Edit/Delete buttons (Download/Send remain).
- **Closed tenancies are permanent:** archive deletion refused (409) when the
  tenancy has a finalized exit invoice or bound financial rows; unit deletion
  refused while it anchors history; unit/tenant code cannot be changed
  (it anchors the whole history); sealed payments can never be deleted or
  re-approved (409).
- **Archive = complete history:** archive detail now merges the snapshot with
  live rows bound to that tenancy — late-recorded payments appear in the
  right tenancy, document chips become real downloads, and the deposit refund
  is matched to that exact tenancy (archive_id) instead of the reused unit code.

### 9. Financial integrity: ghost-record elimination + DB-level validation & audit (app `v63`)
Investigation traced every ghost/orphan class, then eliminated it and built
constraints so it cannot recur.

**Traced findings (production audit):**
- **"Ledger IE" / "Ledger OC"** = test-tenant codes `LEDGER-IE` ("Inv New") and
  `LEDGER-OC` ("Occ New") from an admin test run on 2026-10-14: created,
  archived, then hard-deleted — leaving detached message logs/receipts. The
  full `LEDGER-*` family (38 codes) is preserved in `audit_log` as the
  traceable origin; the tenants themselves are gone.
- Mariana House itself had **no orphan payments** — its ghosts were detached
  documents (ME6/MD1 exit invoices, MA9 invoice) and old detached receipts.
- Root causes: `ON DELETE CASCADE` on payments/penalties (history vanished on
  tenant delete), `SET NULL` on documents/message_logs (history detached),
  no validation on payment creation, blank archives from vacating identity-less
  rows, and `logLedgerEntry` inserting payments with zero validation.

**Eliminated (backend/scripts/cleanup-ghost-records.js, ran with --apply):**
- 8 exit-invoice + 13 invoice documents re-attached to their real tenancies
  (incl. Mariana's ME6/MD1/MA9 records)
- 376 orphan receipt registry rows purged (no payment/register/tenant — legacy
  bootstrap batch + deleted test payments); full list preserved in
  `audit_log (orphan_receipts_purged)`, PDF files untouched on disk
- 385 test-fixture message logs purged (LEDGER-/SA5FIX/CARE2/ADVR families),
  sample preserved in `audit_log (test_message_logs_purged)`
- 6 tenants stuck with `status=''` reconciled from live data
- blank archive #59 (test record "TENAN") deleted
- Remaining by design: 59 non-receipt business documents without a linkable
  tenant (work orders/statements/reports) and 1,401 non-fixture detached
  message logs — reported, not destroyed (informational residue).

**Prevention — application layer:**
- `validateTenancyForFinancials()` enforces: tenant exists + has a person
  (non-blank name) + is not Vacant + linked to an existing property. Applied
  in `createPayment` (covers manual entry, M-Pesa parsing, offline sync),
  `approvePayment` (a Pending payment whose tenant left can no longer be
  approved → no receipt, no allocation, no WhatsApp confirmation),
  `ensureReceiptPdf` (belt: logs `receipt_blocked` audit), and rewritten
  `logLedgerEntry` (now goes through createPayment + audit).
- Incomplete-tenancy rejections return HTTP 409 with a clear reason; missing
  units return 404.
- Payment origin recorded: `payments.source` = manual | mpesa_parse | booking
  | ledger_adjustment, set by each entry path.
- Vacating an identity-less unit with no financial history now REFUSES
  (`NOTHING_TO_ARCHIVE`) instead of writing a blank archive record.
- Deleting a tenant now **archives the complete tenancy** (identity + payments
  snapshot + sealing) and keeps the unit row as a Vacant placeholder — returns
  `{archived: true, archive_id}`. Only truly empty placeholders are hard-deleted.

**Prevention — database level (`migrate-financial-integrity.js`, ran on prod):**
- All financial FKs switched/added to `ON DELETE RESTRICT` (payments,
  penalties, tenancy_agreements, documents, message_logs, water_invoices,
  exit_invoices, deposit_refunds, and *.tenancy_id → tenancy_archive) — a
  tenant or tenancy row that anchors history can never be deleted under it.
- BEFORE INSERT triggers on payments/penalties/exit_invoices/deposit_refunds
  reject records whose tenant is missing, nameless, vacant or property-less;
  any UPDATE that rewrites `tenant_code` is rejected outright (re-linking
  history is impossible). Water invoices use a lenient variant (vacant-unit
  caretaker billing is legitimate).
- AFTER INSERT/UPDATE triggers write `audit_log` rows
  (`financial_record_inserted`, `financial_payment_approved`) carrying origin,
  tenant, amount, reference and tenancy id — every financial record now has a
  database-enforced, traceable origin.

---

## Open items / next

- **Device acceptance pass (human):** open `scratch/report_samples/` samples on
  a phone, desktop and laptop; confirm Excel/PDF open read-only without any
  manual formatting. Automated checks cover structure; this confirms look-and-feel.
- **Enhanced summary label:** the duplicated "Unpaid Units" row was blanked on
  the left column. If that slot was meant to show another figure, name it and
  it will be restored.
- **By design, documented:** the Overdue card (58) and Total Arrears row count
  (59) differ by one account whose balance is charges-only with rent fully
  paid — correctly overdue-excluded but arrears-included.
- Push cadence: green suite → commit → push to `main` when requested.

---

## Changelog index

| # | Update | App version |
|---|---|---|
| 1 | Rent balance & unit display fixes | — |
| 2 | Bytewave SMS token fix | — |
| 3 | Console flash removal | — |
| 4 | Caddy restore + auto-start | — |
| 5 | Dashboard Command Center (DB cards, drilldowns, collection progress) | v61 |
| 6 | System-wide report formatting (Excel/PDF/in-app) | v62 |
| 7 | Repo housekeeping: tracked test suites, gitignore, pending-work commit | v62 |
| 8 | Tenancy-scoped financial history: permanent per-occupancy records | v63 |
| 9 | Ghost-record elimination + DB-level validation, RESTRICT FKs, origin audit | v63 |
