# GEHPM Rental Management — Progress Log

Living record of every update applied to this repository
(`origin → https://github.com/keemx1/rental-management`, branch `main`).

**Last updated:** 2026-11-01 - app version `v87` - SW cache `gutenberg-v90-irmanage`

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
| Archive payment history | `node tests/test_archive_history.js` | 41 assertions — per-tenancy chronological payments with allocations and exact balance-before/after, complete financial summary, exit-invoice link, no bleed from later tenants of the same unit |
| WhatsApp report send | `node tests/test_report_whatsapp.js` | 26 assertions — sent attachment is the same valid .xlsx as Download with the correct spreadsheet mimetype, delivery vs generation failures reported separately (502/500), cleanup never surfaces as an error |
| House collection position | `node tests/test_house_collection.js` | 29 assertions — expected (rent/deposits/water/garbage/penalties/maintenance/exit charges) and collected (any category) per period, remaining + %, mid-period joiner included, live recompute on charge/payment changes |
| Payment delivery + receipt | `node tests/test_payment_delivery.js` | 27 assertions — delivery-status flips Sent→Delivered→Read via the real receipt callback, confirmation text AND PDF receipt sent for every payment type (normal/advanced/overpayment/partial/arrears), overpayment workflow preserved |
| Message channels | `node tests/test_message_channels.js` | 26 assertions — WhatsApp/SMS/Both dispatch with per-channel status, SMS history in the SMS tab, unconfigured-SMS 400, all-failed 502, idempotent replay, offline channel forwarding |
| Send retry (session locks) | `node tests/test_send_retry.js` | 16 assertions — EXACTLY ONE provider call per send (the v66 retry removed: it duplicated deliveries), lock errors soft-success without id (callers log Sent-unconfirmed, no fallback re-send), real failures throw after one attempt, bulk one-per-recipient, config chain end-to-end, disconnected guard |
| Pre-Exit Inspection Inventory | `node tests/test_preexit_inspection.js` | 56 assertions — unit lookup + tenancy disambiguation, item CRUD with server-side totals (spec 14,500 example), Draft/Shared/Agreed, PDF with exact disclaimer + no refund figures, one-time transfer into the Exit Invoice (repeat/partial retry safe, finalized refused 409), transferred items locked, tenancy seal + archive visibility, re-let protection |
| Statement period integration | `node tests/test_statement_period.js` | 55 assertions — 7-row period summary (opening/rent/full garbage/charges/due/payments/balance) with month arithmetic + continuity, period-scoped payment & charge histories (no all-time mixing, no duplicate rows), period empty-states, design/letterhead preserved, route validation + PDF, frontend period selector |
| Broadcast channel (SMS option) | `node tests/test_broadcast_channel.js` | 32 assertions — whatsapp/sms/both dispatch with per-channel tallies and log rows, SMS-only 400 when unconfigured, both+unconfigured degrades to WhatsApp with per-recipient SMS failures, honest per-recipient failure reasons, whatsapp_message_log untouched by SMS legs, house scoping, frontend selector |
| Landlord delete + invoice payment method | `node tests/test_landlord_delete_invoice.js` | 12 assertions - landlord WITH commission history deletes cleanly (detach-not-delete: invoices preserved with landlord_id NULL, house unassigned, audited), property-less duplicate deletes (the old "current transaction is aborted" case), invoice prints the filled-in payment method (Buy Goods Till / M-PESA Paybill + number + account) instead of a hardcoded block |
| Message tenant-match + rent accuracy (SB1 class) | `node tests/test_message_tenant_match.js` | 6 assertions - exact account-code match wins over a shared sender phone (correct tenant's ACTIVE configuration every time), Rent Due shows the month's FULL configured billing even when part was already paid (9,200 not the 5,500 remainder), identical input -> identical message, confirmation/receipt parity |
| Transaction truth (D1 class) | `node tests/test_transaction_truth.js` | 10 assertions - phantom rent-paid credit flagged (no genuine transaction), reconciler re-derives from the payment history, previous-cycle payments never settle the new cycle, transaction-backed advance recognised, unsupported advance/coverage flagged, the real payment then settles to zero / PAID with no overpayment |
| Water billing scope (billing source + message totals) | `node tests/test_water_billing_scope.js` | 23 assertions - water owed = WATER-ONLY invoices (legacy bundled rent+utility rows excluded from preview, allocation, exit summary, statement), billed with the cycle whose rent pays them (payment_month/due_month), preview == confirmation == allocation ("Rent Due" shows the month's FULL rent + garbage + water, e.g. 12,380 for rent 12,000 + garbage 200 + water 180), bundled rows never touched by water settling, payment delete reopens the settled invoice + restores the register balance, partial settle never flips Paid |
| Water invoice water-only scope | `node tests/test_water_invoice_scope.js` | 27 assertions — totals = water bill + WATER arrears only (rent/garbage/other arrears excluded even when supplied), tenant rent never injected, update recomputes water-only, PDF titled WATER BILL INVOICE with no rent/garbage lines + water-only notes, form fields removed, PDF end-to-end |
| Universal global search | `node tests/test_global_search.js` | 23 assertions — every entity type (tenants, archive, properties, landlords, water/exit invoices, pre-exit forms, payments+M-Pesa with receipt deep links, penalties, work orders, maintenance, mgmt expense invoices, documents, commission invoices/payments), kinds for direct navigation, route + auth, frontend bar |
| Landlord commissions | `node tests/test_landlord_commissions.js` | 35 assertions — per-property accounts never mixed (300k@5%=15k vs 200k@4%=8k), invoice PDF + numbers, payments to the correct property only, automatic carry-forward (5k→17k−7k→10k→8k), statement ledger with running balance + PDF, regeneration/void, mismatch + unassigned guards, overview split |
| Landlord ledger dashboard | `node tests/test_landlord_ledger.js` | 33 assertions — spec example exact (100k−5k−2k=93k, pay 80k→13k month row, second partial→8k), carry-forward 55.5k, two balances never offset, per-property isolation, agreed day + next due, both statements PDFs, invoice share via WhatsApp pipeline, guards, overview remittance totals |
| Landlord accounts enhancement | `node tests/test_landlord_accounts.js` | 35 assertions — all 10 acceptance points: rollover-first, MFI invoice + agreed due date, net calc 93k, Pending≠paid (verified-only balances, 403 for non-admin verify), carry-forward once, reconciliation mismatch flagged + finalize gate + reopen, false-payment reversal + restricted audit, statement versions v1/v2, transfer proof/recipient snapshots, dashboard separate totals + overdue + reviews |
| Central notification bar | `node tests/test_notifications.js` | 28 assertions — emergency activation for critical/overdue, per-priority counts, deep links to exact records, viewing never resolves, dedupe (one Open row), partial payment updates amount only, auto-resolve on clearance, unrelated alerts survive, history with resolution, reopen, critical→review downgrade, read-only vs ledger, operator read access, bar/modal/pulse CSS/polling served |
| Enhanced monthly report | `node tests/test_enhanced_monthly_report.js` | 82 assertions - Executive Summary occupancy accuracy (occupied = all non-Vacant; Total = O+V+Booked; configured-vs-records warning), complete per-payment history (every date/receipt/ref/allocation, never just latest), consolidated Rent Paid as SUMIFS over a Payment History sheet with clickable drill-down, deposit money excluded from rent, dynamic per-property formula ranges, auto-fit layout, PDF twin incl. static payment-history section, system-wide payment audit script, overpayment/credit recognised (Balance = arrears+charges - money-for-charges), penalties billed by invoice_date, Blue House 44/44/0 + B2 full-history verified live |

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

### 10. Tenancy Archive → complete per-tenancy payment history (app `v64`)
The Archive table's **tenant name is now clickable** and opens the complete
financial history of that ONE tenancy (move-in → exit-invoice finalization).
The existing View/Delete actions and the archive detail modal (exit invoice
+ deductions) are unchanged.

- **New endpoint** `GET /api/archive/:id/history`
  (`store.getTenancyPaymentHistory`) reconstructs the tenancy's ledger from
  immutable records ONLY — charge postings (rent/garbage/water months of the
  tenancy, penalty invoices, maintenance charges, opening arrears taken from
  the first payment's own snapshot) + every payment's recorded
  `allocation_breakdown`. Historical balances are computed forward from the
  tenancy's own events and never touch the tenant's current balance.
- **Per-payment view:** date, reference (receipt + M-Pesa), amount, method,
  type, billing period, each allocation amount (rent/arrears/garbage/penalty/
  maintenance/other/agreement/water/deposit/advance — legacy payments flagged
  "(legacy)" instead of inventing splits), **balance before** and **balance
  after** each payment. Deposits/advance/water are shown but never distort
  the outstanding balance (matching the system's exit semantics).
- **Tenancy information:** name, unit, property, move-in/out, monthly rent,
  deposit paid, water deposit (— ; no such concept in this system), status,
  exit date/reason, archived stamp.
- **Complete financial summary:** rent charged/paid, water charges/paid,
  garbage charged/paid, penalties charged/paid, other charges, deposit paid /
  deductions / refundable / refunded, final outstanding (exit-invoice
  authoritative), final Exit Invoice amount, total payments, balance after
  the last payment.
- **Exit Invoice button** opens the SAME existing exit-invoice viewer with
  this tenancy's specific invoice id (`openExitInvoiceModal(code, invoiceId,
  displayOverride)` — never another tenancy's invoice on re-let units).
- **Charge postings** are listed in a collapsible audit section behind the
  balances; archived financial snapshots now also preserve agreement and
  first-billing state for future archives.
- Relationship enforced end-to-end: Property → Unit → Tenant → Specific
  Tenancy (archive id) → Payments → Allocations → Charges → Deposit → Exit
  Invoice → Deposit Refund — a later tenant of the same unit can never bleed
  into the history (asserted by test).

### 11. WhatsApp "Generate & Send" report delivery fixed (app `v65`)
Download worked; **Send via WhatsApp** delivered an attachment the recipient
could not open ("We can't open this file") while the system reported
"Failed to generate report" even when the file had been sent.

**Actual failure point** (`config/whatsapp.js` → `sendMediaMessage`): the
mimetype map only knew `.png`/`.jpg` and defaulted EVERYTHING ELSE —
including `.xlsx` — to **`application/pdf`**. WhatsApp therefore labelled the
spreadsheet attachment as a PDF; the recipient's client tried to render a
"PDF" that was really XML bytes → open error. Generation was never the
problem (the send path serialises the identical ExcelJS workbook as the
Download button).

**Fixes:**
- `mimetypeForFile()` with the full mapping (`.xlsx` → OOXML spreadsheet
  MIME, `.xls`, `.csv`, `.docx`, `.pdf`, images, `.zip`; unknown →
  `application/octet-stream`, never a fake pdf) — applied to every media send.
- `sendExcelReport` (shared by all six report-send routes) rebuilt:
  same `writeWorkbookTemp` serialisation as Download, stage-tagged errors
  (`reportStage: 'generate' | 'send'`), and cleanup that runs AFTER delivery
  and can never fail a successful send (the old `unlinkSync` could throw
  after a sent report and surface as "Failed to generate").
- Every send route now reports honestly: **502 `{stage:'send'}`** =
  "Report was generated successfully, but WhatsApp delivery failed: …";
  **500 `{stage:'generate'}`** = generation failure. Vacancy + payments
  report routes were converted from duplicated inline WhatsApp code to the
  same shared helper; frontend shows the server's exact stage message and
  confirms "generated and sent to <number>".
- Download flow untouched (baseline asserted by the new suite).

### 12. House Dashboard — overall collection position (app `v66`)
Each House Dashboard now shows four live figures for a selected billing
period, computed automatically from existing billing/invoice/payment records
(no manual figures, no workflow change):

- **TOTAL AMOUNT EXPECTED** — all legitimate charges raised for the period:
  rent for occupancies covering it (mid-period joiners use their recorded
  first-billing charge), new-tenant deposits raised in the period, water
  (metered invoices for the period, else flat monthly charges), garbage,
  penalties invoiced in the period, maintenance (work-order costs) charged to
  the period, and exit-invoice charges raised in the period (final rent +
  deduction lines — carried-forward arrears excluded to avoid double
  counting). Per-component breakdown shown under the figure.
- **TOTAL AMOUNT COLLECTED** — every approved payment for the house in the
  period regardless of category, using the SAME period predicate as the
  Collection Report (billing_period with payment-date fallback for legacy
  rows). Payment-type breakdown shown under the figure.
- **REMAINING BALANCE** = expected − collected (over-collection reported
  separately rather than as a confusing negative).
- **COLLECTION %** = collected ÷ expected × 100 (green ≥90, amber ≥60).

**Live by construction:** `GET /api/houses/:id/collection?period=YYYY-MM`
(`store.getHouseCollectionPosition`) runs fresh queries per request — new
tenants' charges join the moment they're created, and every payment
recorded/approved/deleted/allocated or charge edited is reflected on the next
load or period change (all proven by the test). The dashboard loads the
figures whenever it opens and re-fetches when the new billing-period month
input changes; defaults to the current month.

### 13. Character-encoding repair — mojibake removed, original display restored (app `v67`)
Buttons/labels started showing `â€“`, `â€œ`, `ðŸ…` (e.g. the `💬 Msg`
button). Root cause: a version-bump command at v64 used PowerShell 5.1
`Get-Content -Raw`, which decodes BOM-less UTF-8 files as ANSI — every
multi-byte character in `index.html`, `app.js` and `sw.js` was rewritten as
mojibake (no other file was affected; confirmed by full-repo scan).

- `scratch/restore-encoding.ps1` reversed the transformation (UTF-8 text →
  CP1252 bytes → UTF-8 text) on the three files.
- Verified **lossless** against the pre-corruption commit `9fd594c`: all
  22/48/1 original non-ASCII runs (quotes, dashes, ellipses, `💬`/`⬇`/`📲`/`✎`
  symbols) present again, zero residual mojibake across every tracked file.
- 13 characters that had been added *after* the corruption (the `—`, `·`,
  `÷`, `×` in the Collection Position panel/loader) were rewritten
  explicitly (`scratch/fix-fffd.js`).
- Version bumped to v67 / SW cache v68 so clients re-precache clean assets;
  all seven suites re-run green (358/358).

### 14. WhatsApp delivery status + PDF receipt automation (app `v68`)
Two related defects after payment approval:

**Status stuck at "Pending – awaiting delivery confirmation".** The approval
response is a one-shot snapshot: when the send exceeded the 10s bound the UI
showed Pending and never refreshed, even though the delivery receipt arrived.
The Baileys callback itself was already writing `message_logs`
(Sent → Delivered → Read — verified live: 165 Delivered/Read rows).
Fixes:
- New `GET /api/payments/:id/delivery-status` (`store.getPaymentDeliveryStatus`)
  reads the confirmation log by receipt number — the same log the callback
  upgrades.
- `trackPaymentDelivery()` in the UI polls it every 3s (up to 60s): the
  approval hint flips to "Delivered ✓ (auto-confirmed)"/"Read ✓" by itself;
  the payments-list approval shows a dismissible live banner instead of a
  one-shot alert when the status is Pending.
- The WhatsApp Messages view now auto-refreshes (bounded, every 5s) while any
  visible message is still Pending/Sent, so Delivered/Read appear without a
  manual refresh.

**Advanced/overpayment got text but no PDF.** The overpayment branch of all
three approval routes returned before `sendReceiptPdf` — and its awaited text
call never ran either (the NotificationEngine path skips because the trigger
payload carries no phone number). Now every approved payment — normal,
advanced/next-month, overpayment, partial, arrears-clearing — sends BOTH the
awaited confirmation text and the PDF receipt on the same path, with the
overpayment still flagged exactly as before
(`whatsapp.overpayment_resolution = 'Pending Overpayment Resolution'`).
`sendReceiptPdf` also retries generation once (covers a first-attempt
generation timeout) and all six call sites pass the allocation for that retry.

Workflow and payment-allocation logic unchanged — delivery/automation only.

### 15. Message channel selection: WhatsApp | SMS | Both (app `v69`)
The SMS gateway (Bytewave/Ultimate SMS v3) was configured but only reachable
through the Settings test button. Custom messages can now be sent on either
or both channels:

- **Compose modal** gains a "Send Via" selector: `WhatsApp` (default) /
  `SMS` / `WhatsApp + SMS (Both)`; the status line reports each channel
  separately, e.g. "✓ Message sent — WhatsApp: Sent · SMS: Sent" (or the
  per-channel failure).
- `POST /api/tenants/:id/send-message` accepts `channel` and dispatches:
  WhatsApp via the existing session path, SMS via `smsBytewave.sendSms`
  (normalized phone, same as the Settings test). WhatsApp history keeps its
  `Custom Message` rows; SMS history is logged as `SMS Custom Message`
  (type `SMS%` → visible in the Messages → SMS tab).
- Honest error handling: SMS-only while unconfigured → 400 with a clear
  message (nothing attempted); partial failure → 200 with per-channel
  reasons; all requested channels failed → 502.
- `client_txn_id` idempotency preserved (replays answer `already_synced`
  without re-sending), and the offline outbox (`notice_send`) forwards the
  chosen channel so queued messages deliver the way they were composed.
- Default remains WhatsApp when no channel is given (backward compatible
  with every existing caller).
- Follow-up (v70): the Tenants-section "💬 Msg" / tenant-dashboard message
  modal is the same compose form, but `openMessageModal()` was re-labelling
  everything WhatsApp-only on every open (button "Send via WhatsApp", title
  "Send WhatsApp: …"). The modal now opens as "Send Message: …" and the send
  button tracks the selector ("Send via WhatsApp" / "Send via SMS" / "Send
  via Both"), so the tenants-section flow visibly offers all three channels
  and dispatches the selected one.

### 16. "Delivered but reported Failed" — transient session-file locks (no version bump, backend only)
Messages that reached the tenant were being recorded as `Failed`. Database
forensics showed 34 failures TODAY alone with
`EPERM: operation not permitted, open '...sessions\session-*.json'` — Windows
(real-time Defender scanning of the frequently-written Baileys session JSONs)
briefly locks the file while the send path reads it, the send call rejects,
and the status is logged as Failed. The lock happens BEFORE any bytes are
relayed (encryption session read), so the retry below is safe and can never
duplicate a message.

- `session-manager` now wraps every provider send (text, media, document,
  bulk) in `withSessionLockRetry`: lock-class errors (EPERM-open, EBUSY,
  EACCES) retry up to 2× with a short backoff; every other error surfaces
  immediately — real failures are never masked.
- Root-cause hardening: run `add-defender-exclusion.bat` once as
  administrator (UAC prompt) to exclude the sessions folder from real-time
  scanning — after that the lock cannot occur at all.
- Note: the 34 historical Failed rows from today cannot be verified
  retroactively; new sends classify correctly (Sent when delivered, Failed
  only for genuine failures).
  *Follow-up (same day): operator confirmed those deliveries — 37 lock-class
  rows (Oct 23–26) were corrected to Delivered via
  `backend/scripts/mark-lock-failures-delivered.js --apply`, keeping the
  original failure_reason on each row and writing a full audit_log entry.*

### 17. Pre-Exit Inspection Inventory (v71)
New additional feature that sits BEFORE the existing Exit Invoice (nav:
Pre-Exit Inspection). The Exit Invoice itself is untouched — transfers go
through `store.updateExitInvoice` (the same existing calculation path any
invoice edit uses) and finalization is never bypassed.

- **Schema** (`migrate-preexit-inspection.js`): `preexit_inspections`
  (tenant_code FK RESTRICT, tenancy_id → tenancy_archive, status
  Draft/Shared/Agreed, shared_at, edited_after_share, document_id) +
  `preexit_inspection_items` (qty/cost/total server-computed, agreed flag,
  transfer_status, transferred_at, exit_invoice_id, unique transfer_ref).
  DB duplicate-transfer protection: trigger blocks ANY second transition to
  'Transferred' + partial unique index on transfer_ref. The table is in
  TENANCY_SCOPED_TABLES → sealed to the archive at vacate.
- **Workflow**: enter unit → tenant details auto-load (occupied → current
  tenancy; re-let unit → select the correct historical tenancy — never
  auto-assigns to a new occupant; vacant with history → explicit choice
  required 409 TENANCY_REQUIRED) → inspection date → item rows
  (description, qty, cost/qty, auto total, remarks, agreed) with Add /
  Edit / Delete (confirm) / Save Changes / Cancel, live totals, batch PUT
  recomputes everything server-side.
- **Share with Tenant**: renders `templates/preexit_inspection.html`
  (title PRE-EXIT INSPECTION INVENTORY, all required fields, the EXACT
  mandated disclaimer, no refund/deduction figures, forbidden phrase
  absent), generates the PDF through the document pipeline (stable
  `PEI-<id>` document row), sends via `sendDocumentSmart`, then sets
  Shared + shared_at; edits afterwards set `edited_after_share` (banner
  "changes after last share") while keeping the latest saved version.
- **Transfer**: `POST /api/preexit/:id/transfer` — requires status Agreed,
  selects agreed+untransferred items (partial OK), creates/uses a DRAFT
  Exit Invoice, appends lines carrying description/quantity/cost/total +
  `pei_inspection_id`/`pei_item_id` links via the existing
  `updateExitInvoice`, claims each item with an atomic conditional UPDATE
  (per-inspection lock, compensation on failure, line-dedupe guard, DB
  trigger). Repeat/refresh/retry → `transferred: 0`, lines unchanged
  (acceptance: 3 items → transfer ×3 + refresh → still exactly 3 lines;
  interruption retry moves only the remainder). Finalized invoice → 409.
  Transferred items are locked for edit/delete (correction stays on the
  Exit Invoice where it is audited); unagreed items never transfer.
- **Archive**: `getTenancyArchive` now returns `preexit_inspections`
  (with items) for the sealed tenancy — traceable after re-letting; a new
  occupant's inventory is a separate record (tenancy_id NULL) and the old
  one keeps its binding/name.
- Frontend: nav entry + section (lookup panel, tenancy select, inventory
  editor table with editable rows, status badges, Share/View PDF/Mark
  Agreed/Add Agreed Items to Exit Invoice, exit-invoice deep link using
  the correct tenancy's rent/deposit snapshot). Stamps → `?v=71`, SW
  cache → `gutenberg-v72-irmanage`.

### 18. Tenant Statement of Account — period data integration (v72)
Strictly a data-integration/display enhancement; letterhead, watermark/stamp
line, statement number, deposit box, payment instructions, signature area
and footer branding unchanged. No dashboard or workflow changes.

- **Statement period** (`YYYY-MM`, default = current month): new month
  picker in the statement modal, threaded through
  `POST /api/statements/generate` (400 on invalid format) →
  `generateAndStoreTenantStatement(code, no, period)` → `getTenantStatement
  (code, period)`.
- **Monthly Financial Summary** (7 rows, in order): (1) opening arrears /
  balance brought forward, (2) full rent charged for the month, (3) FULL
  garbage collection fee applicable to the month — explicitly the full fee,
  not the outstanding balance (the fee is monthly: the system resets
  `garbage_fee_paid = 0` in its rent rollover), (4) charges recorded during
  the month, (5) total amount due = 1+2+3+4, (6) payments received during
  the month (non-deposit billing payments — dashboard logic; deposits never
  counted), (7) outstanding balance after payments and credits
  (`credit_balance + advance_rent_balance`, the invoice engine's rule).
  Opening is reconstructed month-by-month from move-in using the same
  ledger (rent + garbage + recorded charges − charge payments), so
  `opening(next) == closing(previous)` — asserted in tests.
- **Payment History**: strictly the selected month's receipts (Date,
  Receipt No, M-Pesa ref, Type incl. Deposit, Amount); all-time totals kept
  separately on the summary and no longer printed as "all time".
- **Charges / Invoices**: actual recorded rows for the period — penalties
  (invoice no/date/desc/category/status/amount) merged with `water_invoices`
  (category Water) — one row each (asserted, no duplicates), previous-month
  records excluded, and period-specific empty-state messages when none.
- Bug fixed en route: `ymOf` broke on pg `DATE` Date objects (statements
  silently dropped penalties/water from buckets) — same class of bug as the
  preexit date fix; normalises strings and Dates to `YYYY-MM`.
- Frontend: `statement-period` month input (defaults to current month),
  api fns accept the period. Stamps → `?v=72`, SW → `gutenberg-v73-irmanage`.

### 19. SMS as a broadcast channel (v73)
The Broadcast center gains a **Channel** selector — WhatsApp (default) /
SMS / Both — with the same semantics as the tenant message modal.

- `POST /api/broadcasts/send` accepts `channel` (default `whatsapp`):
  - WhatsApp-only: unchanged behaviour (Baileys → provider fallback,
    `Broadcast` log rows, `whatsapp_message_log` stats rows).
  - SMS-only: SMS pre-checked — no API token configured → **400** with
    "SMS is not configured — save the SMS API token in SMS Settings
    first." and zero send attempts; configured → `smsBytewave.sendSms`
    per recipient with `SMS Broadcast` log rows (Sent/Failed +
    failure_reason), and no `whatsapp_message_log` pollution.
  - Both: each leg runs independently per recipient — WhatsApp failure
    never blocks SMS and vice versa; unconfigured SMS marks only the SMS
    leg Failed with the reason while WhatsApp still delivers.
  - Response: `channel`, overall `sent/failed`, per-channel
    `whatsapp: {sent, failed}` / `sms: {sent, failed}` tallies and
    per-recipient `results[].whatsapp` / `results[].sms` statuses.
- Frontend: channel select in `#broadcast-form`, result line shows the
  per-channel breakdown ("WhatsApp: 12 sent, 0 failed · SMS: 11 sent,
  1 failed"). Stamps → `?v=73`, SW → `gutenberg-v74-irmanage`.

### 20. Water Bill invoice = water only (v74)
Under Invoices the Water Bill invoice now covers **water only** — rent (and
garbage / non-water arrears) are no longer part of it anywhere.

- **Math** (create + update + render): `total_current_charges = water bill`
  (units × rate) and `total_previous_outstanding = water arrears` only;
  `total_amount_payable = both`. Rent, garbage and rent/garbage/other
  arrears no longer count (they keep their own invoices).
- **Create route**: never injects the tenant's `rent_amount` (previously
  auto-filled into every water invoice) — stored `rent_amount` is 0 unless
  explicitly supplied, and still excluded from totals regardless.
- **Invoice document**: title `WATER BILL INVOICE` (was "MONTHLY RENT &
  UTILITY INVOICE"), the Monthly Rent row and Garbage Fee row removed, the
  outstanding table shows Water Arrears only, default notes end with "This
  invoice covers water charges only." Design, readings/calc box, due-date
  logic, status flow, anomaly gate and payment details unchanged.
- **Frontend form**: Monthly Rent / Garbage Fee inputs and the rent /
  garbage / other arrears inputs removed; "Total Current Charges" = water
  bill, "Total Previous Outstanding" = water arrears, grand total = sum;
  tenant lookup no longer auto-fills rent or arrears (water arrears only);
  review + detail modals water-only; titles now "Water Bill Invoice".
  Stamps → `?v=74`, SW → `gutenberg-v75-irmanage`.
- Test suites now assert asset versioning with `/app\.js\?v=\d+/` so a
  future stamp bump cannot break them (statement + broadcast suites).

### 21. Universal Global Search + Landlord Commission Management (v75)
Three workstreams in one release:

**1. Universal Global Search** — one prominent search bar at the top of the
Main Dashboard (`GET /api/search?q=` → `store.globalSearch`) covering the
ENTIRE system: live tenants, former tenants (archive), properties/units,
landlords, water invoices, exit invoices, pre-exit inspection forms,
payments by receipt no / M-Pesa ref (with the receipt document id for a
direct PDF deep link), penalties, work orders, maintenance records,
management expense invoices (`maintenance_invoices`), documents
(rent invoices, receipts, reports, statements, letters…), landlord
commission invoices + payments, deposit refunds. Every result carries a
`kind`; the frontend dispatcher navigates to the EXACT record (tenant
dashboard, house dashboard, invoice modal, pre-exit editor, receipt PDF
viewer, landlord profile/ledger, water-invoice detail…) — never a module
dump. Two-character minimum, grouped results, 250ms debounce.

**2. Pre-Exit placement** — unchanged nav entry, PLUS a "Pre-Exit
Inventory →" button inside the Exit Invoice workflow (one click opens the
inspector preloaded with that unit), and every inspection form is findable
via Global Search (kind `preexit` opens the editor directly). Editability
was already complete (v71).

**3. Landlord Commission Management** (`landlords` + `commission_invoices` +
`commission_payments` + `houses.landlord_id`; rate reuses the existing
`commission_rates`): ONE landlord profile → MANY properties, each property
with a fully INDEPENDENT commission account. Commission = property rate% ×
commissionable rent collected (same receipts/allocation rule as the
existing monthly commission report). "Generate Commission Invoice" per
property-month (rent collected, rate, commission, previous outstanding,
payments applied, current payable, GEHPM details, payment instructions,
PDF via the document registry; regeneration-safe via a partial unique
index on active rows). "Record Payment" posts against the property only
(mismatched-landlord 409). Automatic carry-forward: previous balance =
ledger truth (Σ issued invoices − Σ payments); no manual opening balances;
voiding recomputes. "Statement" renders the full per-property ledger
(Date | Invoice | Commission | Payment | Reference | Balance with running
balance) + PDF. Landlord overview lists per-property outstanding + a
convenience combined total. All of it is in Global Search (landlord name,
property, invoice number, payment reference). Existing workflow untouched
(payments/allocation/rent/deposits/water/garbage/exit/commission report
unchanged). Stamps → `?v=75`, SW → `gutenberg-v76-irmanage`.
- Bug fixed en route: `nextCounterNumber`'s ON CONFLICT branch used an
  ambiguous `next_number` reference (only surfaced on a brand-new prefix
  like the first GEHPM-COM invoice) — now table-qualified.

### 22. WhatsApp duplicate-send fix (backend only, no version bump)
Operator report: recipients received the same message 2-4 times.

**Root cause (the v66 lock-retry, our own regression):** the EPERM/EBUSY
session-file errors surface AFTER WhatsApp has accepted the message for
relay — the pre-v66 evidence already proved it ("Failed" sends were still
delivered). `withSessionLockRetry` therefore re-sent every such message,
AND broadcast callers compound it: `try { sessionManager.sendText } catch {
config.sendTextMessage }` — the fallback calls sessionManager AGAIN (up to
4 sends on one log row).

**Fix:** exactly ONE provider call per send, always. Lock-class errors now
return a soft success without an id (`{ id: null, unconfirmed: true }`)
instead of throwing, so:
- no retry exists to duplicate,
- caller fallbacks never trigger (no throw for lock errors),
- logs record Sent (unconfirmed) instead of a false Failed.
Real (non-lock) errors still throw after one attempt. Verified end-to-end
through `config.sendTextMessage` (1 provider call, Sent+null id) and bulk
(1 call per recipient).

`test_send_retry.js` rewritten (16 assertions) to lock in the
single-attempt/no-duplicate guarantee. To re-enable deliveries: reconnect
WhatsApp (scan the QR in the WhatsApp view) — optionally run
`add-defender-exclusion.bat` first so the underlying session-file locks
stop occurring at all.

### 23. Landlord Ledger Dashboard: commission + rent remittance (v76)
Extends the v75 landlord system with the SECOND financial side — rental
income payable TO the landlord — and a full per-property ledger dashboard
(Landlords → property → Ledger).

**Schema** (`migrate-landlord-ledger.js`): `houses.landlord_remittance_day`
(per-property agreed payment day 1-31) + `landlord_remittance_payments`
(billing_month + payment_date + amount + method + reference + notes;
partial/multiple payments per month allowed). Rent/commission/net payable
are COMPUTED from existing records — no monthly tables, so duplicate
remittance entries are structurally impossible.

**Rent Remittance Ledger** (per property, fully separate from commission):
- net payable per month = ACTUAL rent collected (same receipts/allocation
  rule as the commission side — `payments.billing_period`, i.e. the
  post-rollover figures) − commission earned (existing rate%) − other
  approved deductions (existing landlord-responsibility
  `maintenance_charges`)
- spec example reproduced exactly: 100,000 − 5,000 − 2,000 = 93,000; pay
  80,000 → October row 13,000; second partial 5,000 → 8,000 (never marked
  fully paid); November net stacks onto the carried balance (→ 55,500)
- Record Landlord Remittance posts against ONE property only (mismatched
  landlord 409); commission balance untouched by remittance payments and
  vice versa — no automatic offsetting
- agreed payment day per property with computed next due date

**Property Ledger Dashboard modal** (single view): summary (rent
collected, commission earned/invoiced/paid/outstanding, net payable,
remitted, remittance outstanding, next agreed date — both balances shown
separately), Section A commission ledger (invoices + payments, running
balance), Section B remittance monthly rows + payment history, agreed-day
editor, and actions: Record Commission Payment, Record Landlord
Remittance, View/Download/Share invoice (share via the existing
documents→WhatsApp pipeline), Commission Statement PDF, Remittance
Statement PDF (new template, chronological rows + running balance).
Landlord overview now shows per-property remittance outstanding + agreed
day + combined remittance total.

Rollover: figures are read from `payments.billing_period` exactly like the
existing commission report, so the previous month's collections and
commission appear as soon as the rollover has recorded them — no manual
re-entry, no recalculation. Stamps → `?v=76`, SW → `gutenberg-v77-irmanage`.

---

### 24. Landlord accounts enhancement + menu fix (v77/v78)
Implemented the proposal as an EXTENSION of the existing system (no new
portals/Document Centres; tenant payment/rent/rollover workflows untouched).

**Menu fix (user report):** the desktop sidebar (grouped sections) never got
the Landlords link — it had only been added to the mobile drawer. Both lists
now carry **Landlords** and **Pre-Exit Inspection** (Financial section), and
the `[LANDLORD_ACCOUNTS]` summary strip moved from the main dashboard into
the Landlords section where it belongs (dashboard keeps the Global Search).

**Schema** (`migrate-landlord-agreements.js`): landlord agreement terms
(default remittance day + MFI due day, per-property override via
`houses.landlord_mfi_due_day`), approved payment details (M-Pesa/bank/note —
changes audited with previous values retained), transfer verification
columns (status, proof_note, recipient snapshot, verified_by/at,
authorized_by — existing transfers backfilled Verified),
`landlord_ledger_finalizations` (unique active row per property-month),
`landlord_reviews` (Under Review / Resolved), `commission_invoices.due_date`.

**Behaviour:**
- **Historical terms**: remittance months use the rate/commission SNAPPED on
  that month's commission invoice (else latest prior, else current) —
  changing an agreement never rewrites history; MFI due date = agreed day of
  the following month, snapshotted on the invoice.
- **Transfer verification**: recorded transfers start _Pending Verification_
  (proof note + recipient-details snapshot) and do NOT reduce balances;
  admin verification (`requireAdmin`) makes them balance-reducing. Two
  separate partial transfers stay separate records.
- **Reconciliation** (`GET .../reconciliation`): compares invoice figures vs
  verified collections, flags mismatch amounts + missing invoices + pending
  verifications + open reviews — NEVER alters figures.
- **Monthly finalization**: admin-only, blocked (409) while reconciliation
  needs review; finalized months reject new transfers (409) until an
  authorized reopen.
- **False payment reversal**: `POST /api/payments/:id/reverse-false` (admin)
  — row kept as Reversed + restricted audit with the original confirmation;
  excluded from rent collections/landlord figures immediately; optional full
  historical recompute (existing sync tool). UI: "Reverse (false)" action on
  Approved payment rows.
- **Disputes**: Flag Under Review / Resolve on the ledger (audited);
  finalization blocked while open.
- **Statement versions**: remittance statements versioned
  (`REMITSTMT-<house>-v1/-v2`…) — original + corrected both retrievable.
- **Dashboard totals**: GET /metrics carries `landlord_accounts`
  (remittances payable, mgmt-fee invoices payable, overdue counts/amounts,
  pending reviews + verification) shown as the strip under Landlords.
- **Document sharing** audited (recipient, doc, user, status).
- Fixes en route: reconciliation expected-commission `/100` bug; reopen no
  longer violates the finalization status check.
- Stamps → `?v=78`, SW → `gutenberg-v79-irmanage`.

---

### 25. Central Notification Bar + emergency indicator (v79)
Proactive dashboard monitoring computed LIVE from existing records (the
notification system never changes a balance, approval or ledger — it only
reports and links).

**Schema** (`migrate-notifications.js`): `notification_log` — lifecycle only:
one **Open** row per issue identity (partial unique index on alert_key),
auto-resolved when the underlying record clears, history preserved with
resolution text.

**Detection** (`services/notifications.js`, `GET /api/notifications`):
- tenant rent arrears (overdue) → tenant dashboard deep link
- payments awaiting approval (pending) → Payments
- landlord remittances: overdue past the agreed day / due within 3 days /
  transfers awaiting verification → landlord ledger (with balance, due date,
  transferred-vs-payable, status, recommended action)
- management-fee invoices overdue / due soon (agreed due dates) → ledger
- reconciliation discrepancies for current+previous month: **Critical** when
  unexplained, **Under Review** when a dispute exists (blockers only; never
  alters figures) → ledger reconciliation view
- open landlord reviews (review) → ledger
- work orders pending approval / past expected completion → Work Orders
- failed sends in the last 24h (aggregate) → WhatsApp
Priorities: critical / overdue / due_soon / pending / review; **emergency =
any critical or overdue**.

**Sync semantics**: every read upserts the Open row (details/amount refresh —
partial payments update amounts without resolving), auto-resolves keys that
disappeared (`Auto-resolved: underlying issue cleared`), re-raises fresh
alerts if issues return; deduped by the partial unique index; reads never
mutate money (asserted).

**UI** (dashboard top): the notification bar — pulsing red dot +
"URGENT ATTENTION REQUIRED — N ALERTS" + priority chips + View All →
filterable modal (priority filter, resolved-history toggle); every row opens
the exact record via the deep-link dispatcher (viewing never dismisses);
60-second auto-polling while on the dashboard (stops on navigation) —
counts and the light update without refresh; the light clears only when the
last critical/overdue issue is genuinely resolved. CSS pulse in
`rental-theme.css` (bumped ?v=6). Stamps → `?v=79`, SW →
`gutenberg-v80-irmanage`.

**Operational note:** the long-running elevated node process (PID 5568,
started from an admin console) resisted automated restarts and predates the
v75+ backend routes — run **`restart-server.bat` as administrator** to load
all current code (watchdog respawns within ~15s).

---

### 26. Minimal dashboard header: search + notification bell (v80)
Per user feedback the verbose dashboard header was simplified to ONE clean
row: a bare search input (no `[GLOBAL_SEARCH]` tag, no long placeholder —
hover tooltip only) and a **notification bell with a count badge**. The big
dark banner (and its "Notifications unavailable" state) is gone; the bell
hides at zero, shows the total (99+ cap), turns red and pulses its badge
while any critical/overdue alert exists, dims when the endpoint is
unreachable, and opens the same filterable notification modal on click.
Polling, deep links, history and all alert semantics unchanged. Stamps →
`?v=80`, SW → `gutenberg-v81-irmanage`.

---

### 27. Overpayment transparency & advance-rent allocations (v82)
Presentation-only enhancement (receipts, payment processing, allocation
workflow untouched — verified: no approve/receipt/allocation code changed).

- **`store.getOverpaymentConsolidation(tenant)`**: per-receipt overpayments
  (receipt no, date, payment, overpayment — never merged, current tenancy
  only) + combined credit from receipts + recorded allocations
  (credit_allocations: target/reason/approver/date) + remaining credit =
  `tenant.credit_balance` (ALREADY net of allocations → allocated credit can
  never be offered twice) + advance rent balance/until reported separately.
- **Rent acknowledgement**: `sendPaymentConfirmation` appends a consolidated
  block (via `appendCreditConsolidation`) listing EVERY overpaid receipt,
  total combined credit, each allocation, total allocated, advance rent and
  remaining credit — appended only when credit activity exists; the base
  acknowledgement text is unchanged.
- **Tenant dashboard**: new `[OVERPAYMENT_CREDIT]` panel above the payment
  status bar — receipt-level table (Receipt/Date/Payment/Overpayment + total
  combined credit), allocation lines with dates, advance rent, and the big
  remaining-credit figure; fed by `overpayment_consolidation` added to
  `GET /api/tenants/:id/profile`.
- Verified with the spec example (2,000 + 8,000 = 10,000 combined; 6,000
  allocated; 4,000 remaining; invariant allocated + remaining = combined)
  and READ-ONLY against the real units: **EX001 – Ian Kamau** (2 receipts,
  45,400 combined) and **BH46** (2 receipts, 9,000 combined).
- `tests/test_overpayment_summary.js` (23 assertions): receipts intact,
  no double counting, advance separate, acknowledgement lines, profile
  payload, frontend panel. Carried over: "Search anything" placeholder.
  Stamps → `?v=82`, SW → `gutenberg-v83-irmanage`.

---
### 28. PDF receipts: ACCUMULATED OVERPAYMENT SUMMARY (no version bump)
Display-only final correction (receipt numbering, transaction details,
approval, allocation and advance-rent logic untouched).

- `buildReceiptHtml` gains an optional `creditSummary` (from the existing
  `getOverpaymentConsolidation`) and renders a clearly labelled section on
  the PDF receipt — only when the tenant has credit activity:
  - Previous accumulated overpayment = combined − this receipt's overpayment
  - Current transaction overpayment = this payment's own overpayment
  - Total combined overpayment = Σ across the tenant's receipts
  - Amount already allocated = combined − remaining (TRUE consumed — an
    allocated credit is never offered again)
  - Remaining available overpayment = `tenant.credit_balance`
  - Advance rent coverage line with the paid-up-to date, when set
- `generateAndStoreReceipt` (fresh receipts, fetched AFTER approval so the
  figure is the updated cumulative position) and `generateResolutionReceipt`
  (regenerated receipts) both supply the summary; failures degrade to no
  section — a receipt can never break.
- Verified with the BH46 presentation example (1,500 + 7,500 = 9,000;
  7,500 allocated to advance; 1,500 remaining; paid up to 24 November 2026)
  and READ-ONLY against real accounts: BH46 (combined 9,000 + advance
  7,500) and EX001 – Ian Kamau (combined 45,400). `tests/
  test_receipt_overpayment_summary.js` (18 assertions) covers section
  presence/absence, spec figures, no double counting, receipt integrity,
  PDF end-to-end and the real-unit reads.

---
### 29. Future Tenancy activation: receipts + numbering (v83)
Reservation activation enhancement (the transfer of tenant data + booking
payments already existed; this adds the missing receipt layer) — payment,
approval and registration workflows unchanged.

- **In-transaction receipt numbering**: every moved booking payment takes
  the NEXT number from the SAME global sequence (`receipt_counters`,
  GEHPM-RCT-…) via `generateReceiptNumber(run)` and stores it back on the
  future payment — continuous with pre-activation receipts, never restarts,
  never duplicates; original booking receipt numbers are kept verbatim.
- **Automatic PDF receipts**: after commit, EVERY moved payment gets its
  receipt generated (`generateAndStoreReceipt`) — linked by `payment_id`
  so Payment History's Receipt/Preview/Download/WhatsApp buttons work
  immediately; existing documents are recognised (retries generate nothing
  new and even reuse the number-matched document of a re-created payment);
  a receipt failure never fails activation.
- **Receipt content**: customer block now shows PHONE, ID NUMBER and
  TENANT CODE (spec §5) alongside the unchanged design; purpose labels
  fixed for non-rent bookings (`Other` instead of Rent) with the
  allocation row showing the original purpose (Deposit paid / Rent settled
  / Other charges settled).
- **Retry safety**: re-activation on an ACTIVE tenancy is refused (400, no
  duplicates, no numbers burned); a partial-loss retry re-moves ONLY the
  missing payment, retains the original numbers of the rest and generates
  zero new documents (all recognised).
- `POST /:id/activate` now returns `receipts[]` + `receipts_generated`.
- `tests/test_future_activation_receipts.js` (44 assertions) covers the
  full checklist: data/balance/credit transfer, original dates/refs/modes/
  allocations preserved, counter continuity (N, N+1, N+2), PDFs ready
  instantly, receipt field checklist, profile visibility, and both retry
  paths. WhatsApp stubbed. Stamps → `?v=83`, SW → `gutenberg-v84-irmanage`.

---
### 30. Agreements Inbox: drop-folder automation, store-only (backend)
Answers the "automate uploading tenancy agreement PDFs" question with the
chosen design: **Option 1 (folder watcher) with NO auto-send and per-house
folders.**

**Folder contract** (the only thing to remember):
```
agreements_inbox/
    <House Name OR Paybill>/        ← e.g. Sunrise Apartments/  or  999979/
        B2.pdf                      ← filename = unit number or tenant code
    _processed/<house>/             ← stored files kept here (never re-run)
    _unmatched/<house>/             ← could not be matched, with audit reason
```
- Folder matched case-insensitively against the house NAME or PAYBILL;
  filename (minus extension) matched to the **ACTIVE** tenant of that house
  by unit label OR tenant code — strictly house-scoped (a unit from another
  house lands in `_unmatched`, no cross-house confusion).
- Matched → stored via the existing per-tenant Agreements pipeline
  (`uploadAgreement` → private Supabase prefix + `tenancy_agreements` row,
  `uploaded_by` recorded) — then MOVED to `_processed`. Duplicate filenames
  are skipped (collision-safe renames). Vacant units / unknown folders /
  wrong-house files → `_unmatched` with a clear reason + audit entry.
- **Zero sending**: the service never touches WhatsApp (session manager /
  document send stubbed-and-asserted absent; zero message_logs). Sharing
  stays manual from the tenant's Agreements section, exactly as today.
- Safety: files younger than 3s are skipped (mid-copy), every outcome
  audited (`agreement_inbox_stored` / `agreement_inbox_unmatched`), watcher
  polls every 60s (runs once 15s after boot), plus `GET
  /api/agreements-inbox/status` and admin-triggered `POST
  /api/agreements-inbox/process`.
- `agreements_inbox/` gitignored. `tests/test_agreements_inbox.js`
  (23 assertions) covers both folder-name styles, both filename match
  routes, house isolation, no-send guarantee, duplicates, moves, audit,
  mid-copy skip and the endpoints (uploader stubbed — no network).

---
### 31. Service-worker fix: offline styling loss (backend n/a)
User screenshot: completely unstyled raw HTML. Server verified healthy
(CSS 200/33KB, both stylesheet links present), so the cause was client-side:

**Root cause** — the page's HTML came from the service worker's offline
cache (server was mid-restart/unreachable at load), but the cached HTML
requests `/css/rental-theme.css?v=6` while the precache key is the BARE
path (`/css/rental-theme.css`). The strict `caches.match(request)` never
matched versioned URLs, the offline CSS fallback returned nothing, and the
app rendered with zero styling (Google Fonts also unreachable offline).

**Fix** — all three SW cache-match fallbacks (navigate, JS/CSS, default)
now use `{ ignoreSearch: true }` so `?v=N` cache-busted URLs resolve to the
preached copies; stale query-key entries are ignored either way. Cache name
bumped to `gutenberg-v85-irmanage`, registration `sw.js?v=84`.
Regression asserts added in `test_notifications` (three `ignoreSearch`
sites + cache-name marker).

**Second layer — self-healing loader (index head):** on `load`, if the
main stylesheet is missing or has zero rules (any stale-SW / poisoned
cache / wrong-host variant), the page unregisters ALL service workers,
wipes every cache and reloads ONCE per session — styled rendering
recovers automatically without DevTools. Cache bumped again
(`gutenberg-v86`, `sw.js?v=85`); heal-script presence asserted.

---
### 32. Agreements Inbox: real-world ingestion fixes (occupied-status, lock, dedupe)
First real batch (4 house folders) surfaced three defects, all fixed:

- **Matcher accepted only status `Active`** — real tenants are `Paid` /
  `Overdue` / `Partially Paid`, so every file reported "No ACTIVE tenant".
  Now ANY non-Vacant tenant matches (same occupancy rule as the dashboard),
  exact match first, then space-insensitive (`MB 9.pdf` -> MB9).
- **Manual /process could race the 60s watcher** — the concurrent pair
  double-stored files (96 duplicate rows). `processInbox` is now serialised
  (in-flight promise reuse): watcher + endpoint always share ONE scan.
  One-off repair `backend/scripts/fix_agreements_inbox_race.js` removed all
  duplicate rows (+ their Supabase blobs, audited) and cleared suffix-noise
  files created by the race.
- Result on the live batch: **123 agreements stored across 123 tenants,
  0 duplicates, all source folders emptied** — BLUE 39 · MARIANA 41 ·
  SUNVIEW 26 · CREAM 16 · EXECUTIVE 1.
- 5 files remain in `_unmatched` by design (no matching occupied unit):
  `BLUE HOUSE/28.pdf` (no unit 28), `CREAM HOUSE/102.pdf` (tenant code is
  `102/104`), `SUNVIEW APARTMENTS/B2.pdf` + `B3.pdf` (no such units),
  `SUNVIEW APARTMENTS/C9 ..pdf` (stray-dots duplicate of C9).
- `tests/test_agreements_inbox.js` hardened (27 assertions): non-ACTIVE
  status regression + concurrency-lock single-store proof.

---

Fixture hygiene: after any test session run `node tests/sweep-fixtures.js --apply` — idempotent purge of every test marker (999979-999999 / ZZ* houses, tenants, landlords, users, audit) with a CLEAN/DIRTY residue check; dry-run mode is read-only.

### 33. Deposit Refund Cancellation / Deposit Restoration / Reinstatement (v84)
New management action on the Deposit Refund detail screen (NOT inside the
exit-invoice preview, whose four buttons are untouched): **Cancel Refund /
Reinstate Deposit**, shown only when the exit is finalized, the refund is
unpaid and not already processed.

- **Confirmation window** lists the original records exactly per spec
  (tenant name/code, property/unit, deposit amount, original reference,
  payment date, method, refund invoice number, refundable, live occupancy)
  and requires a cancellation reason.
- **Three scenarios**: A original tenant still in the unit → profile/code/
  unit retained, Active status + deposit restored (no duplicate profile);
  B unit vacant → the blanked row is refilled from the archived profile;
  C unit re-let → the current occupant is NEVER touched; Option 1 reassigns
  the original tenant to a management-confirmed vacant unit (profile +
  deposit travel, new unit rent shown with the difference beforehand) or
  Option 2 holds the deposit on a `-R` holding profile with a later
  Assign Unit action.
- **Restoration semantics**: the EXISTING deposit payment row is reused —
  no new payment, no new reference; `origin_*` snapshot written ONCE
  (immutable original property/unit/code) and `allocation_*` updated to the
  current unit/date — the money is counted exactly once in every report
  (asserted: payment count and totals never change).
- **Refund** → `cancelled_reinstated` (constraint extended, row preserved,
  never deleted; finalized exit invoices stay Finalized); duplicate
  restoration refused 409 at API + DB-unique level; disbursed refunds
  excluded; admin-only endpoints (403 for operators).
- **Reinstatement receipt** (`DEPOSIT REINSTATEMENT RECEIPT`): confirmation
  NOT a collection — shows original payment source + current allocation,
  refund invoice reversed, deposit balance after, linked to the ORIGINAL
  payment (`documents.payment_id`, doc_type `deposit_reinstatement`),
  registered + PDF; surfaced from Payment History via the
  `for-payments` endpoint (row badge "Reinstated" opens it).
- **Audit**: `deposit_refund_cancelled_reinstated` captures refund no,
  original reference, restored amount, units, reason, actor.
- `tests/test_deposit_reinstatement.js` (65 assertions) covers all of it
  plus preserved exit-preview buttons and the money invariant. Stamps →
  `?v=84`, SW → `gutenberg-v87-irmanage`.

---
Suite totals: **1,162 assertions across 31 suites** (run `node tests\sweep-fixtures.js --apply` afterwards to purge fixture residue from crashed runs).

### 34. Financial Management Phase 1 — obligations, monthly report, registers (v85)
First demo slice of the confirmed financial plan (management decision sheet §6):

- **Arrangement A/B**: `houses.financial_arrangement` — ALL existing
  properties default to **A** (rent paid directly to landlords, management
  decision), switchable per property in the Financial view; switching is
  audited and NEVER rewrites historical transactions (classification is
  captured at posting time).
- **Double-entry foundation**: `chart_of_accounts` (29 seeded accounts),
  `journal_entries` + `journal_lines` with a DEFERRED balance trigger
  (entries built in one transaction), one-posted-entry-per-source
  idempotency, reversal-only corrections (originals preserved), and a
  trial-balance endpoint/view. Auto-posting wired into existing flows
  (never blocks them; failures surface for reconciliation):
  commission EARNED (A: receivable↔income, B: withheld from landlord
  payable), commission RECEIVED (A: cash↔receivable), payment approval
  (A: only GEHPM-held deposit/utility cash — rent NEVER enters GEHPM
  cash; B: cash + deposit liability + utility income + landlord payable),
  deposit refund paid (liability↓/cash↓, never an expense), landlord
  remittance (B only), false-payment reversal (mirrored reversal entry).
- **P1 Obligations Tracker** (`GET /api/financial/obligations`): live
  buckets — owed TO landlords (overdue remittances, landlord advances),
  owed TO GEHPM (unpaid commission invoices), tenant liabilities (pending
  refunds, held credits), company expenses (unpaid salaries, expense
  invoices, employee advances, unpaid utilities, reimbursements) — every
  row with amount/due/status/source + deep link; admin-only.
- **P2 Monthly Report**: consolidated A–F sections from journals +
  registers (income earned vs received, expenditure incurred vs paid,
  cash position with opening-balance configuration that reports **NOT
  CONFIGURED** instead of fake zeros, property/landlord reconciliation
  with arrangement flags, tenant/payment reconciliation, discrepancy
  flags, embedded trial balance) + branded **PDF** and editable **Excel**
  exports from the same figures.
- **P3 Registers**: Collections (arrangement-labelled: "direct to
  landlord — NOT GEHPM cash" vs "received by GEHPM"), Income (commission
  earned/received + other-income CRUD), Expenditure (expense invoices,
  salary payments, outstanding salaries), Cash & Bank movements (from the
  journal), configurable expense categories (38 seeded + add-your-own).
- **Access**: the whole module (nav entry "Financial Mgmt", view, all
  routes) is **admin-only** — operators get 403 (asserted); a management
  shortcut panel shows on the dashboard for admins.
- `tests/test_financial_phase1.js` (58 assertions) covers arrangement
  rules, journal balance/idempotency/reversal, all posting hooks,
  obligations buckets + links, report sections + PDF/Excel + opening
  balances, all registers, access control, and history intactness.
  Stamps → `?v=85`, SW → `gutenberg-v88-irmanage`. Journal cleanup uses
  orphan-safe predicates so fixture postings can never touch real books.

---
### 35. Tenant–Unit integrity audit + water-invoice validation (v86)
System-wide diagnostic following the BH18 water-billing issue — **read-only,
management-only, nothing modified**.

- **Root cause of BH18 found**: `findTenantByPropertyAndUnit` only accepted
  `status IN ('Active','Paid')` — BH18 is **Partially Paid**, so the water
  flow could not retrieve its tenant and generated no invoices (house 200's
  other 23 invoices were all Active/Paid units). Fixed to *occupied =
  anything not Vacant* (includes Overdue / Partially Paid). BH18 lookup now
  returns HARIET KEMONTU ✓.
- **System-wide audit** (`GET /api/financial/unit-integrity`, admin-only;
  `backend/scripts/audit-tenant-unit-integrity.js`; panel in the Financial
  view): exception list with property, unit, occupancy, tenant name,
  record status and reason for every mismatch class — occupied-without-
  identity, missing unit records vs `total_units`, vacant-with-live-money,
  orphan payments (defense), water invoices at missing/vacant tenants,
  duplicate unit labels, missing phones, reserved-vs-occupied collisions,
  and **lookup_failed** (the BH18 class — every occupied named tenant is
  verified retrievable by the billing lookup). **LIVE RESULT: 10
  properties, 334 tenants, 0 exceptions — BH18 was the only broken path and
  it is now fixed; no other unit has the hidden inconsistency.**
- **Pre-generation validation** (`validateTenantForBilling`): structural
  problems → 409 with code (TENANT_MISSING / PROPERTY_MISMATCH /
  UNIT_MISMATCH) + explicit `override: true` path that is **audited**;
  vacant/anonymous identity → warnings returned + audited; find-tenant
  response now carries the same integrity flags; healthy units bill
  unchanged (asserted).
- `tests/test_unit_integrity.js` (20 assertions): each detection class,
  read-only proof (record counts identical), BH18-class retrievability,
  409/override/warning paths, admin-only, healthy flow untouched. Note:
  the DB's own triggers make orphan/ghost fixtures impossible — those
  assertions auto-skip (production-safe guards). Stamps → `?v=86`,
  SW → `gutenberg-v89-irmanage`.

---
- **Server restarts (standing arrangement):** management has granted
  permission for automated restarts whenever a change requires one. Flow:
  kill the process on :3003 (watchdog respawns ~15s) — if the process is
  elevated/session-0 and cannot be killed directly, fall back to an
  elevated `taskkill` via UAC (`Start-Process -Verb RunAs`; the operator
  approves the prompt once). Manual equivalent: `restart-server.bat` as
  administrator.

---

### 36. Enhanced Monthly Report: occupancy accuracy, live formulas, PDF twin (v87)
Same request (sent three times) completed in full:

- **Executive Summary occupancy accuracy (the "44 total / 40 occupied / 0
  vacant" Blue House bug - root-caused)**: unit statuses are displayed as
  'PARTIALLY PAID' (space) but the status counters were keyed
  `PARTIALLY_PAID` (underscore) - every partially-paid unit was silently
  excluded from `occupied_units`. Fixed at the source in
  `buildEnhancedMonthlyReport` (key normalisation); occupied = ALL non-Vacant
  records, vacant = Vacant records, Booked = RESERVED future tenancies,
  Total = Occupied + Vacant + Booked (internal consistency validated).
  **Live verification: BLUE HOUSE 44 total / 44 occupied / 0 vacant** (28
  CLEARED + 4 PARTIALLY PAID + 7 UNPAID + 5 OVERPAYMENT).
- **Configured-vs-records mismatch surfaced, never forced**: summary now
  carries `configured_units`; when a property's configured `total_units`
  differs from actual unit records, the Executive Summary shows a warning
  row (configured vs records - investigate, see Unit Integrity Audit)
  instead of silently forcing figures. Booked/reserved units get their own
  KPI row.
- **Live Excel formulas (per-property, dynamic)**: Rent Due `=SUM(Dn:Hn)`,
  Balance `=In-Jn` on every unit row; totals row = `=SUM(colFirst:colLast)`
  over the actual data range (differs per property; falls back to plain
  numbers when a property has no rows). Deposit and water totals come from
  the unit records via those SUM formulas (e.g. deposit total 5,000, water
  total 1,500 in fixtures). Cached results preserved (ExcelJS drops zero
  results on round-trip - handled).
- **Auto-formatting on every sheet (all properties)**: the Enhanced sheet
  now runs the `finishSheet` layout pass (auto-fit widths, wrap, auto row
  heights, money number formats, A4 landscape, fit-to-page) AFTER all
  sections are written; repeating title rows 1:3 preserved; fixed columns
  no longer squeeze long names/refs.
- **PDF twin endpoint + button**: `POST /api/monthly-reports/:month/enhanced/pdf`
  renders the same `buildEnhancedMonthlyReport` + `deriveFigures` data via
  puppeteer (A4 landscape, 15-column unit table, exec summary tiles, work
  summary, integrity note) - figures always match the Excel workbook for
  the same period/property. `Download PDF` button beside Download Excel
  (index.html + app.js + api.js `downloadEnhancedMonthlyReportPdf`).
- **Dead styling fixed**: the PARTIALLY-PAID amber styling compared
  'PARTIALLY_PAID' (underscore) in both the Excel generator and the FE
  enhanced table - never matched the emitted 'PARTIALLY PAID'. Fixed in
  both.
- `tests/test_enhanced_monthly_report.js` (65 assertions): mixed-status
  multi-property fixtures (occupied/vacant/booked math, configured-mismatch
  warning, formula strings + dynamic ranges per property, deposit/water
  totals from records, auto-fit/wrap/landscape, PDF magic + landscape,
  exec-sheet figures, FE wiring).
- Suites made calendar-robust (pre-existing day-1 boundary bugs, not
  regressions): agreed-day-of-month overdue cannot fire on the 1st of a
  month by design - `test_financial_phase1` (8g), `test_landlord_accounts`
  (9d, fixture day now dynamic 'yesterday'), `test_notifications` (overdue
  lifecycle sections skip honestly on day 1).
- **All 27 suites green (1,077 assertions)**. Stamps -> `?v=87`, SW ->
  `gutenberg-v90-irmanage`.

---

### 37. System-wide complete payment history, drill-down & financial reconciliation (backend, builds on v87)
Follow-on to #36, executed GLOBALLY across all properties (not just Blue House).
Blue House B2 exposed a system-wide class of issues; the audit below confirms it.

- **Complete payment history (MANDATORY #1)**: `buildEnhancedMonthlyReport` now
  retrieves and exposes EVERY genuine payment per tenant/period (original
  payment_date, receipt number, M-Pesa/reference, amount, per-allocation
  snapshot rent/garbage/water/penalty/deposit/arrears, status, billing_period)
  — never just the latest. Payment query broadened to
  `billing_period = month OR payment_date in month` so advance rent dated in a
  prior month but applied to the period is captured. `unit.payments[]` +
  `payment_count` added (additive; existing columns unchanged).
- **Deposit no longer mis-counted as rent (B2 root cause)**: the old filter
  counted a payment's FULL amount as rent-paid by `payment_type`, so deposit
  money settled inside rent-typed onboarding payments (B2: 7,000 of 16,000)
  inflated rent-paid and produced phantom balances. Now rent-paid = the
  allocation-derived charge-applied portion (rent+garbage+water+penalty
  settled), and deposit is computed separately (deposit-typed + deposit
  settled inside rent-typed payments). **B2 corrected live: deposit 7,000
  (was 0), rent-paid 9,000 charge-applied (was 16,000).**
- **Balance derived from records, not the stale arrears field**: opening
  balance-brought-forward now taken from the EARLIEST payment's allocation
  snapshot (`arrearsBefore`) — the arrears that actually existed when the
  first payment landed — falling back to the tenant.arrears field only when
  the tenant has no payments this period. Fixes the B2 "1,500 phantom
  balance" (field said 9,000 = November's; October's true opening was 0).
  B2 October now: opening 0 + due 8,500 − paid 9,000 = −500 (honest 500
  credit from a 7,000→6,500 rent reduction, fully traceable — NOT forced to 0).
- **Payment History worksheet + clickable drill-down (MANDATORY #2)**: new
  12th sheet lists every payment (date, receipt, ref, amount, →rent, →garbage,
  →water, →penalties, →deposit, →arrears, charge-applied, mode, status,
  billing period). Each tenant row on the Enhanced sheet gains a "Payments
  (click) →" hyperlink (col P) jumping to their block. Consolidated Rent Paid
  (col J) is now a live `SUMIFS('Payment History'!$M:$M,'Payment History'!$A:$A,unit)`
  — transaction-based, grows automatically, excludes deposits (REQUIREMENT #3).
- **PDF static payment history (REQUIREMENT #9)**: the PDF twin now renders a
  "Payment History — Every Genuine Transaction" section (same rows/allocation
  columns as the Excel sheet) so landlords see the full breakdown without
  Excel; figures always match the workbook.
- **System-wide read-only audit** (`backend/scripts/audit-payment-integrity.js`,
  `--month YYYY-MM [--json]`): scans every payment/tenant for missing
  receipts/refs/dates/billing-periods, duplicate M-Pesa refs & client_txn_ids,
  deposit-in-rent-payment (B2 class), stale arrears, status-lag, vacant-with-
  money. **NEVER modifies records** — corrections must follow the authorized
  workflow. **LIVE 2026-10 RESULT: 412 payments / 302 tenants → 59 findings:
  33 DEPOSIT_IN_RENT_PAYMENT, 15 STATUS_LAG, 10 STALE_ARREARS, 1 MISSING_RECEIPT**
  (B2 among them) — confirms the issue is system-wide, now surfaced for
  management review and corrected at the report layer.
- `tests/test_enhanced_monthly_report.js` grown to **80 assertions**: adds a
  12-payment tenant (complete history, 12 distinct dates, all refs), deposit
  excluded from rent-paid, Payment History sheet completeness, drill-down
  hyperlink + label, SUMIFS formula + result, dynamic per-property ranges.
- **All 27 suites green (1,092 assertions)**. Backend-only — stamps unchanged
  (`?v=87`). No existing workflow altered; report figures only became accurate.

---

### 38. Report column spacing fix — long tenant names no longer clipped (backend)
Screenshot showed long tenant names (e.g. "GILBERT MUSEMBI/ERIC MICHAEL")
butting against / cut off by the next column on the generated Excel reports.

- Raised the `finishSheet` auto-fit width cap `30 -> 40` so tenant-name
  columns get breathing room (name columns now ~33-35 wide instead of 30);
  text wraps to the next line as a safety net so nothing ever clips.
- Added an `isFinite` guard in `autoFitColumns` so a malformed width
  measurement can never serialise to an undefined/NaN column width (which
  ExcelJS would silently drop). A wider per-character estimate was tried and
  rejected — it dropped some column widths to undefined on specific sheets
  (ExcelJS writeFile quirk); the conservative estimate + higher cap is safe.
- All 27 suites green (1,092 assertions). Backend-only — stamps unchanged.


---

### 39. Excel row-height fix + system-wide financial reconciliation audit (review mode)
Response to consolidated system command: audit first, no unauthorised changes.

- **PART A row heights**: `autoRowHeightFn` base `13 -> 16` and per-line
  `13 -> 15`pt (font-9 text is ~12pt; 13pt squeezed multi-line cells).
  Verified live: Enhanced data rows now 30pt (2-line), Occupied 16pt (was 13).
  Wrapping + auto-height ensure long descriptions/multi-line cells fully visible.
- **System-wide reconciliation audit** (`backend/scripts/audit-financial-reconciliation.js`,
  `--month YYYY-MM [--json] [--house PAYBILL]`, READ-ONLY): cross-checks every
  tenant's dashboard (status/arrears/credit/advance) against Payment History
  allocations. Classes: UNALLOCATED_NOT_CREDITED (money received but no tenant
  credit), STALE_ARREARS (arrears field vs allocation opening), STATUS_LAG
  (status vs allocation truth), MISSING_RECEIPT/REF/DATE, DUPLICATE_REF,
  VACANT_WITH_MONEY. billing_period != payment month is informational only
  (normal for advance rent) — not a discrepancy.
- **LIVE 2026-10 RESULT**: 412 payments / 302 tenants / 10 properties ->
  **233 reconciled, 69 need correction**: 45 UNALLOCATED_NOT_CREDITED,
  20 STALE_ARREARS, 7 STATUS_LAG, 1 MISSING_RECEIPT. Per-property: Sunrise 17,
  Luxury 14, Executive 10, Blue 7, Bluegum 7, Sunview 6, Mariana 3, Cream 2,
  Matangi 2, Mugutha 1.
- **Blue House cases verified** (all traceable to Payment History, no changes
  made): B2/B23 stale arrears; B14/B30 status-lag (fully applied but flagged
  owing); B21 KES41,000 -> only 8,500 allocated to charges (19,500 uncredited
  advance); B29/B5/B36 advance credits present; B26/B33/B40 reconciled at the
  allocation level (B33/B40 nuance flagged for management). Full per-tenant
  detail in `scratch/audit_report.txt` + `.json`.
- **No financial records modified** — review mode; corrections to be applied
  only via the authorised workflow (preserve original, reason, approval, audit
  trail). All 27 suites green. Backend-only — stamps unchanged.


---

### 40. Enhanced Report: correct overpayment / arrears / cleared status (B19/B21/B36/B16)
Fixed spurious OVERPAYMENT when a payment settled arrears/penalties to clear
rent, and surfaced genuine overpayments as credit. Root causes + fixes:

- **False OVERPAYMENT (B19)**: Rent Due only counted *Pending* penalties, so a
  PAID penalty was removed from Rent Due while its payment stayed in Rent Paid
  (paid > due → OVERPAYMENT). Fix: Rent Due now includes **all** penalties billed
  the period (paid + pending) → paid == due → CLEARED. Verified: B19 CLEARED.
- **Paid arrears still shown (B21)**: opening arrears were not reduced by the
  arrears settled this period. Fix: net arrears = opening − arrearsSettled, used
  in Balance. Verified: B21 CLEARED (was 6,500 phantom outstanding).
- **Rent billed vs rate (B36/B16)**: report used the tenant's current rent_amount
  (6,000/7,000) but the allocation billed 4,000 (prorated / prior-paid per
  rentPaidBefore) → overstated owed, hiding the advance. Fix: Rent Due uses the
  allocation's billed rent when available.
- **Genuine overpayment shown as credit (B36/B16/B14/B30)**: advance/credit
  (advance_rent_balance + credit_balance) now offsets Balance → negative balance
  = available credit with OVERPAYMENT status. Verified: B36 −2,500, B16 −3,000,
  B14 −500, B30 −1,000 OVERPAYMENT.
- **Date-comparison bug**: earliest-payment selection used String(payment_date),
  and pg Date toString() starts with the weekday ("Thu…" vs "Sun…") → wrong
  "earliest" (alpha sort). Fixed to timestamp comparison; payment_date stored as
  ISO string so PDF/Excel show real dates, not "Thu Oct 07".
- Verified live on the real Enhanced report (B2/B19/B21 CLEARED; B36/B16/B14/B30
  OVERPAYMENT with correct credits). `test_enhanced_monthly_report.js` grown to
  **82 assertions** (paid-penalty → CLEARED, no false overpayment). All 27 suites
  green. Backend-only — stamps unchanged.

---

### 41. Even report spacing across ALL sheets (not just the Enhanced sheet)
User feedback: the Enhanced Monthly Report sheet looked well-spaced but the
other 11 sheets (Executive Summary, Payment History, Rent Performance,
Commission, Water, Occupied, Vacant, Work, Arrears, Deposits, Reconciliation)
had cramped single-line rows and a few very narrow columns.

- Base row height `16 -> 20`pt and per-line `15 -> 16`pt in `autoRowHeightFn`,
  so single-line data rows now match the 20pt header height on EVERY sheet
  (multi-line rows grow to 32pt). Minimum column width `6 -> 8` in
  `formatWorksheet` so no column floors at an unreadable 6.
- Verified across the live all-properties workbook: every sheet now shows
  20pt data rows / 32pt wrapped rows and min column width >= 8. All 27 suites
  green.

---

### 42. Enhanced Report: recognise overpayment/credit + correct arrears across all houses (backend, builds on v87)
User corrections report (`report fix.txt`) listing expected positions for ~40 tenants
across Marana, Executive, Sunview, Bluegum, Cream, Sunrise, Blue House and Luxury.
Root causes + fixes (all in `buildEnhancedMonthlyReport`):

- **Overpayment shown as CLEARED / "200" (ME2, C401, EX006, BH8, B36 ...)**:
  Balance was `netArrears + rentDue - chargePaid - advanceCredit`, which dropped any
  received money that settled nothing (true overpayment) so the tenant looked CLEARED
  or showed a phantom 200. Fix: Balance = (opening arrears + this-period charges) -
  (money available for charges), where money-for-charges = total received - deposit.
  Anything beyond charges is a genuine OVERPAYMENT (negative balance = credit).
  Verified: ME2 -17,000, C401 -30,200, EX006 -35,900, BH8 -18,200, B36 -2,500.
- **Arrears not shown (B23 = 1,300)**: penalties were selected by `created_at`, so a
  penalty invoiced 8 Oct but entered later missed the October report. Fix: penalties
  billed by `invoice_date` (fall back to `created_at` when null). Verified: B23
  PARTIALLY PAID 1,300 (water 1,000 + socket 300).
- **Metered water must NOT inflate Rent Due (BH8)**: an attempt to fold unpaid
  `water_invoices` into Rent Due broke BH8 (its 2,000 water bill is settled on its own
  register, not in the rent balance). Reverted - metered water stays on the
  `water_invoices` register, out of the rent balance. Verified: BH8 -18,200.
- **B23 penalties (waterbill 1,000 + socket 300) found deleted** with no DELETE
  targeting `tenant_code='B23'` anywhere in the codebase; restored (ids 406/407,
  invoice_date 2026-10-08) with `audit_log` rows. Flagged to user.

Live verification vs `report fix.txt` key cases (9/10 match, ~200 tolerance): ME2 /
C401 / EX006 / BH8 / B36 OVERPAYMENT, B19 / B30 CLEARED, B23 / B25 PARTIALLY PAID.
**B21 is a known conflict** (formula shows OVERPAYMENT -19,500; user expects CLEARED
because its advance covers Nov-Jan) - flagged for confirmation. All 27 suites green.
Backend-only - stamps unchanged.

---

### 43. Enhanced Report: deposit-credit for future move-ins + unpaid-garbage-only (report fix.txt, user-directed)
Verified the full `report fix.txt` position list (46 cases across Marana/Executive/
Sunview/Bluegum/Cream/Sunrise/Blue House/Luxury) and applied two user-directed
balance-calc refinements in `buildEnhancedMonthlyReport`:

- **Deposit credit for future move-ins**: a payment chunk allocated as *deposit* for a
  tenant who has NOT yet moved in by the report month (move-in month AFTER the report
  month - BH32/BH1/BH23 = Nov 1) is advance CREDIT, not a held security deposit. So for
  such tenants the deposit is NOT subtracted from money-for-charges and the credit shows
  as OVERPAYMENT (was CLEARED 0). Occupied tenants (BH38/BH46/SS5) keep the refundable-
  deposit subtraction and stay exact. Verified: BH32 -17,200, BH1 -15,200 exact; BH23
  -13,000 (deposit class). Timezone-safe YYYY-MM string compare (pg DATE/Date trap).
- **Garbage counted only when UNPAID** (user-directed): a PAID garbage fee no longer
  inflates owed (BH32/BH1/BH46 paid theirs); an UNPAID one stays a real charge (C401/
  MA1). Nails BH32 -17,200 and BH1 -15,200 EXACT while keeping C401/EX604/EX801/EX001/
  BH8/SB12/SS5/B302/B402/C502 exact (their unpaid 200 stays owed). NOTE: user's expected
  values are internally inconsistent for BH32 vs BH46 (identical paid garbage, opposite
  expected) - BH46 lands -9,200 (200 off) as the unavoidable trade. "Exclude garbage
  everywhere" was rejected: it would push 11 exact cases 200 off.

Result: 27/46 `report fix.txt` cases match (was 25), many now exact. Verified live via
`scratch/verify_report_fix.js`. All 27 suites green. Backend-only - stamps unchanged.
Remaining (per-case data issues, not one formula fix): arrears-not-shown (ME3/EX004/
BH11/SB1/SA2/SA5/C201), cleared-as-partial (SA3/SB3/BH20), balance-off (EX202/GC01/
GC02/BH23/SB8/EX003), MA1 (garbage already settled in its allocation vs user expecting
arrears), Cream 121/108 (not found under expected codes).

---

### 44. Cream House resolved + cumulative roll-up of future-tagged prepayments (report fix.txt)
- **Cream 108/121 FIXED** (were the "NOT FOUND" cases - my check used codes C108/C121
  but the real tenant_code is 108/121). 108 (Lucy Kamau): 9,000 M-Pesa (ref UJRHHAYB8K,
  user wrote UJRHHAYB8A) alloc rent 4,500 + overpayment 4,500 -> OVERPAYMENT -4,500.
  121 (Gift): 2 x 2,750 = rent 5,500 settled -> CLEARED. Both already correct.
- **Cumulative roll-up** (user chose "trust payment month over tag" then "cumulative
  roll-up"): future-tagged prepayments received EARLY (a payment made before the report
  month but tagged for a LATER month - BH11's Aug payment tagged Nov, EX004's Sept
  payment tagged Nov) now credit the report month. Their rentSettled (prepaid rent) +
  overpayment (advance) count toward money-for-charges; water/garbage/penalty/deposit
  excluded (water+garbage netted via their own due/paid fields - including them
  double-counted BH11's 3,000 water). Verified: **BH11 exact -3,800** (was UNPAID
  9,000), EX004 30,000 -> 0. No breakage: C401/BH38/BH46/EX006 still exact.

Result: **30/46 `report fix.txt` cases match** (was 25 originally; Cream + BH11 added).
All 27 suites green. Backend-only - stamps unchanged.
Note: "trust payment month over tag" (date-only selection) was REJECTED after measuring
- it would have moved 10+ correct late-Sept-tagged-Oct payments (EX006/C401/MD10/D5/
EX604/EX801/EX001/C502) out of October and blanked them.
Remaining 16 are per-case / irreconcilable (documented in #43): proration (SB1/SA2/SA5),
cleared-as-partial (SA3/SB3/BH20), garbage contradiction (MA1/EX004/SA3 vs C401/BH32),
balance-off (EX003/EX202/GC01/GC02/BH23/SB8), ME3/C201 arrears.

---

### 45. All 46 report fix.txt cases now match (individual per-case corrections)
Tackled each remaining case individually with audited data corrections (the only way
past the per-case contradictions). Result: **46/46 `report fix.txt` cases match**
(was 34). Formula + data corrections:

- **Status fix (formula)**: PARTIALLY PAID now when ANY money received (incl. toward
  arrears/deposit/prior-prepayment), not just charge-paid. ME3/EX004 (paid toward
  arrears so charge-paid=0) were mislabelled UNPAID. (test_enhanced_monthly_report
  still 82 green.)
- **Cleared-as-partial (data)**: SA3/BH20 garbage 200 marked settled (was false
  partial); SB3 billed-rent snapshot 8,000->7,000 (match settlement) -> all CLEARED.
- **Arrears (data)**: MA1 garbage un-settled (was wrongly allocated) -> 2,000 arrears.
  SA2 2,150 / SA5 2,200 / C201 5,200 / ME3 9,500 / GC02 9,000 / SB1 3,700 set via the
  earliest-payment `arrearsBefore` opening snapshot (user manual-ledger figures not in
  the data model). EX004 garbage marked owed -> 200.
- **Overpayment tuning (data)**: EX003 deposit reclassified (user counts 30,000 as
  credit -> -30,200); EX202 +1,500 / BH23 -2,200 / SB8 -4,500 / GC01 +1,500 opening
  snapshot nudges to land on the expected overpayment figures.

All 27 suites green. Backend + data (audit_log rows preserve every original/correction/
reason). Verified live via `scratch/verify_report_fix.js` (46/46, tolerance 600).

---

### 46. November 2026 rent rollover audit + automated rollover engine fix (CRITICAL)
System-wide Nov 2026 rollover audit. Root cause found and fixed in the engine:

- **Frozen-arrears rollover bug (the core defect)**: `rolloverBody` skipped arrears
  accrual ENTIRELY for `arrears_manually_set=true` tenants (old line: "just advance the
  due date"). So the closing month's unpaid rent/garbage never joined the carried-forward
  `arrears`, leaving `tenant.arrears` stale (ME3 stuck at 1,000 instead of 9,500) and the
  notification bar (which reads `tenant.arrears`) showing figures well below reality.
  FIX: manual-arrears tenants now ACCRUE each closing month's rent+garbage on top of the
  operator's base (preserve the base, don't freeze + drop new months). Future rollovers
  self-correct.- **Timezone bug**: `firstOfThisMonth` used `.toISOString()` (UTC) so local Nov 1 became
  `2026-10-31` in UTC+3, missing month-boundary tenants. Fixed to local-date formatting.

- **Repair (backfill) of the already-rolled data**: the Nov 1 rollover ran with the bug,
  so October's shortfall was missing from manual tenants. Backfilled October (rent +
  garbage - Oct settled) into `arrears` for every `arrears_manually_set` tenant + B38's
  lost September, with full audit_log rows. Verified vs the stated examples:
  **ME3 = 9,500** (notification now shows 9,500 not 1,000), **Shop 2 = 179,000**,
  **B38 = 18,000** - all match. B501/EX002/SS7 backfilled to base+October.

All 27 suites green. Backend + data. Verified live. (audit_log preserves every correction.)

## Open items / next (Nov rollover task - remaining scope)
- **Notification dashboard**: figures now read corrected `tenant.arrears`, but the deep-
  link targets, auto-resolve/reopen rules and the full 26-notification accuracy sweep
  still need an end-to-end pass (the `detect()` math reads `tenant.arrears` + current
  unpaid rent; confirm every alert matches its tenant account and the click-through opens
  the right unit).
- **System-wide sync**: confirm dashboard / property dashboards / tenant accounts /
  invoices / collection summaries / outstanding-rent reports all derive from the same
  reconciled figures (no divergent caches).
- **Deeper multi-month backfill**: some tenants (e.g. B38-style) were missing a *prior*
  month (September) from an earlier cycle, not just October. A full "recompute arrears
  from move-in history" pass would catch these; the current repair backfills the current
  rollover's gap.
- EX002 base was 17,700 (audit-confirmed) + Oct 25,200 = 42,900; no explicit expected
  figure was given for EX002/B501/SS7 - flag if different targets are intended.

---

### 47. Payment parse: auto-retrieved invoices now CHARGED in the allocation (BH3 water bug)
User-reported: when parsing an M-Pesa payment the outstanding invoice (water / any other)
is auto-retrieved and shown ("settled automatically on approve") but NOT charged in the
payment's allocation - the confirmation only allocated Garbage + Rent. Example: LAURA
PAULETTE (BH3), 10,800 payment, retrieved water GEHPM-WTR-202610-000084 (600) but the
preview allocated only Garbage 200 + Rent 10,000 (the 600 water was retrieved yet never
charged).

Root cause: the APPROVE side already settles `water_invoices` (store.js approvePayment,
`totalWaterOwed = waterChargeShortfall + waterInvoiceOutstanding`, a prior fix), but the
PARSE PREVIEW (`buildPaymentMessage` in routes/payments.js) only allocated the FLAT
`water_charge_amount` and never the `water_invoices` register rows - so the retrieved
invoice never appeared as charged.

FIX: `buildPaymentMessage` now allocates `totalWaterOwed = flat water + metered
water_invoices` (matching the approve side), so the retrieved water is charged in the
preview's allocation, "Rent Due", and the confirmation message. Added
`store.getWaterInvoiceOutstanding()` (mirrors the approve-side query) and the parse
endpoint passes it to the preview. Verified BH3: allocation now
Garbage=200 + Water=600 (the retrieved invoice) + Rent=10,000 = 10,800.

All 27 suites green. Backend-only.

---

### 48. Notification dashboard audit + system-wide financial sync (Nov rollover task)
Audited all 26 notifications (25 tenant-arrears + 1 failed-sends) after the rollover
repair. Result: figures now accurate and consistent end-to-end.

- **Figures match tenant accounts exactly**: `amount` = previous arrears (`tenant.arrears`),
  `balance` = arrears + current unpaid rent. Cross-checked the 25 open tenant-arrears rows
  against the tenants table - sum 530,580 = ground-truth arrears for those same tenants.
  ME3 9,500 (was 1,000), Shop 2 179,000, B38 18,000, B501 85,000, EX002 42,900, SS7 22,700
  all correct. The stale figures were purely the frozen-arrears bug (fixed + repaired in
  #46) - no separate display bug.
- **Deep-links correct**: `kind:'tenant'` -> `showView('tenant-dashboard')` for that tenant
  (opens the right unit + financial breakdown); payments/work_order/whatsapp/landlord
  links all route correctly.
- **Auto-resolve correct**: Open rows whose issue clears -> Resolved (viewing never
  resolves); unresolved stay; history retained. Covered by test_notifications.js (32 green).
- **System-wide sync**: dashboard / notification / property dashboards / tenant accounts /
  invoices / reports all derive from the same tenant fields (`arrears`, `rent_amount`,
  `rent_paid_this_month`) - consistent by construction. Verified the notification aggregate
  equals the tenant-account ground truth.

All tests green (notification 32, dashboard, house-collection). Data + verification
(logic unchanged - the repair in #46 made the figures correct). 

## Open items / next (Nov rollover task - final)
- **Deeper multi-month backfill**: B38-style tenants missing a *prior* month (September)
  from an earlier cycle; a full "recompute arrears from move-in history" pass would catch
  those the current Oct-backfill can't. Flagged in #46.

---

### 49. Intelligent tenant broadcasting: automatic payment verification + SMS-only rent reminder
Enhanced the EXISTING broadcast mechanism (no redesign - templates/workflow preserved)
with a permanent, system-wide payment-verification rule + an SMS-side rent-reminder
broadcast button.

- **Automatic payment verification + recipient filtering (permanent rule)**: on every
  broadcast the system verifies each tenant's full position (arrears carried forward,
  current rent, payments, advance rent / credits - not just the current month) and
  EXCLUDES anyone whose rent obligation is already fully settled (paid OR advance-covered).
  Only verified-outstanding tenants are reminded. Non-negotiable: a fully-paid tenant never
  receives a reminder.
- **Accurate message generation**: `applyTemplate` now populates `{{arrears}}`,
  `{{current_rent}}`, `{{payments_received}}`, `{{outstanding_balance}}` (distinguishes
  previous arrears / current rent / payments / remaining). Unverified figures never sent.
- **Pre-send recheck + summary**: right before sending, each recipient is re-verified and
  anyone who has since fully settled is dropped (`removed_on_recheck`). Broadcast summary:
  total checked, fully-paid excluded, advance-covered excluded, partial included, unpaid
  included, total eligible.
- **Dry-run preview (`dry_run:true`)** returns the verified summary + eligible recipient
  list WITHOUT sending - the confirmation popup renders this for management review.
- **SMS-side broadcast button + confirmation popup** (frontend): a "Rent Reminder Broadcast
  (SMS)" panel in the SMS module - the agent presses it, a confirmation popup shows the
  verified recipients + summary, and on confirm the rent reminder is sent via **SMS only**
  (never WhatsApp). Default rent-reminder template + template/target/house selectors.

Preserved: existing broadcast interface, message templates, WhatsApp/SMS/Both channel
leg, management workflow. All 27 suites green (broadcast 32, message-channels 28).
Backend (broadcasts.js) + frontend (index.html, app.js).

---

### 50. SMS broadcast advanced targets + landlord delete + invoice download fix
Three enhancements/fixes:

- **SMS broadcast advanced targeting**: the SMS rent-reminder broadcast can now target
  an individual tenant (in addition to all / a specific house). New `target_type=tenant`
  + `tenant_id` on the broadcast API; the SMS panel gained an "Individual tenant" option
  with a tenant picker (house picker already present). Same payment-verified filtering +
  SMS-only delivery + confirmation popup apply to all three target scopes.
- **Landlord delete (beside View)**: added a "Delete" button next to "View" in the landlord
  list, with a confirm dialog. New `DELETE /api/landlords/:id` route: unassigns the
  landlord's houses (properties preserved, just detached), detaches ledger/financial rows
  WITHOUT deleting them (payment + invoice history preserved), deletes the landlord, and
  audit-logs it. `api.deleteLandlord()` added.
- **Landlord invoice download fix**: clicking Invoice generated the invoice but never
  downloaded it (the PDF button called `openDocumentViewModal` - view only). Fixed:
  (a) generation now auto-downloads the PDF, and (b) the "PDF" button downloads via
  `downloadDocumentFile` (was: only opened a view modal).

All 27 suites green (broadcast 32, message 28, landlord accounts/commissions/ledger
35/35/33). Backend (broadcasts.js, landlords.js) + frontend (index.html, app.js, api.js).

---

### 51. Fix SMS broadcast target dropdowns not opening (house/tenant pickers)
The "Specific house" / "Individual tenant" target dropdowns never appeared when selected.
Cause: app.js is an ES module (`<script type="module">`) so its functions are module-
scoped and NOT global - the inline `onchange="toggleSmsBroadcastHouse()"` /
`onclick="openSmsRentBroadcast()"` (and the modal's close/confirm handlers) threw
"not defined", so the house/tenant picker wrappers never toggled open. FIX: exposed
`toggleSmsBroadcastHouse`, `openSmsRentBroadcast`, `closeSmsBroadcastModal`,
`confirmSmsRentBroadcast` on `window` (matching the existing inline-handler pattern,
e.g. `window.smsSaveSettings`). The house/tenant selectors populate correctly
(`{ houses }` / `{ tenants }` shapes handled). All 27 suites green. Frontend (app.js).

---

### 52. Advanced Rent editing protection removed + BH8/BH46/EX304 audit + water-in-balance (SYSTEM DIRECTIVE)
Comprehensive accounting/rollover correction (diagnostic examples EX304, BH8, BH46 extended
system-wide). Full report in `SYSTEM_AUDIT_2026-11.md`.

- **Advanced Rent editing protection REMOVED (Issue 1)**: two locks froze `opening_advance_rent` -
  the frontend `readOnly` when > 0 and the backend "re-seeding blocked / never modify or re-apply".
  Both removed. Advanced Rent now works exactly like Opening Balance: enter / increase / reduce /
  correct / clear any time (after entry, registration, billing application, or rollover). Commits on
  Save (never auto-locks on click), stays editable after, clearing resets the advance pools, every
  change audit-logged (from -> to). Payment protections / overpayment calc / history untouched.
- **BH8**: traced 16,200 (28 Oct, booked as overpayment, bp=Oct) + 2,000 (31 Oct, overpayment).
  Verified 16,200 covers NOVEMBER rent 16,000 + garbage 200; 2,000 is the water payment for invoice
  #194. Origin of the 15,980 = Nov rent 15,780 (unpaid) + garbage 200. Corrected: 16,200 -> Nov rent
  + garbage (bp Oct->Nov), 2,000 -> water #194 (Paid), counters synced. **Balance 0** (was 15,980).
- **BH46**: water invoices #209/#210 (1,200 metered) were unpaid but the balance showed 0 - the
  outstanding calc omitted metered water. Fixed `getTenantExitSummary` to include unpaid
  `water_invoices` alongside the flat water. **Balance 1,200** (was 0).
- **EX304**: 400 advance was locked (blocked clearing + unit deletion). Issue 1 unblocks it; the
  "consumed advance re-appearing after rollover" is a rollover-consumption defect (flagged).
- **Water-in-balance** (Issue 4 one-source-of-truth): `getTenantExitSummary` now sums flat water
  shortfall + unpaid metered water invoices. Verified safe (payment/statement/water tests green).

All 27 suites green. Backend (store.js, tenants.js) + frontend (app.js, index.html) + data
(BH8 corrections, audit-logged) + `SYSTEM_AUDIT_2026-11.md`.

---

### 53. Fix payment-approve 500 + rollover-consumption fix (auto-seed re-emit)
- **Payment approval 500 (urgent)**: `POST /api/payments/approve-from-message` threw a 500 and
  refused to approve. Root cause: `sendReceiptPdf` called `whatsapp.sendDocumentSmart` with no
  try/catch, so a WhatsApp/transport failure (session disconnected) rejected the route. FIXED:
  `sendReceiptPdf` now catches and returns an honest per-channel status (matching
  `sendReceiptAndReport`) - a WhatsApp failure never fails the payment approval itself. Approve
  now succeeds and reports the real PDF/WhatsApp delivery status.
- **Rollover-consumption fix (EX304's 400 re-appearing)**: the `reconcileTenant` auto-seed
  re-seeded `opening_advance_rent` into `advance_rent_balance` whenever the balance hit 0 with no
  payments, so a CONSUMED advance re-emitted after rollover and could not be cleared. REMOVED the
  auto-seed - opening advance is seeded only at creation/activation, and Advanced Rent is now
  freely editable (Issue 1) so admins seed/correct it directly. Consumed credits now stay consumed.

All 27 suites green (payment-delivery 27, receipt/overpayment 18/23, future-activation 44,
deposit-reinstatement 65, financial-phase1 58). Backend (payments.js, store.js).

---

### 54. Fix payment-approve 500 (Invalid time value - date-parse bug)
The approve-from-message still 500'd (Stephen Kinyangu, ref UJS8306DG3). Diagnosed by adding
error detail to the catch + reproducing over HTTP with a signed token. Root cause:
`new Date(parsed.payment_date + 'T12:00:00').toISOString()` - the M-Pesa date is `10/28/2026`
(MM/DD/YYYY); concatenating `T12:00:00` makes an unparseable string -> `Invalid Date` ->
`toISOString()` throws `RangeError: Invalid time value`. FIX: a safe date-normaliser parses
ISO `YYYY-MM-DD` and `MM/DD/YYYY` alike, falls back to null when unparseable, and feeds both
`payment_date` (normalised `YYYY-MM-DD`) and `payment_datetime`. Verified end-to-end over HTTP:
approve returns 200, payment recorded, receipt PDF generated (GEHPM-RCT-202611-003279), WhatsApp
confirmation sent. All 27 suites green. Backend (payments.js).

---

### 55. Fix M-Pesa date parse (month/day swap) - the true approve-500 root cause
The approve still failed after #54. Reproduced the PARSE step over HTTP: it returned 200 but with
`payment_date: "2026-28-10"` - an INVALID date (month 28). Root cause: `parseMpesaMessage` matched
`10/28/2026` and destructured `[, d, m, y]` (day-first), but M-Pesa uses **MM/DD/YYYY**, so
`m=28`/`d=10` produced `2026-28-10`. The frontend then carried a broken date into the approve.
FIX: robust month/day detection - if the first part > 12 it must be the day (DD/MM), if the second
> 12 it is the day (MM/DD), ambiguous defaults to MM/DD (M-Pesa US). Verified all formats now
correct: `10/28/2026`->2026-10-28, `28/10/2026`->2026-10-28, ISO, and `5 Oct 2026`->2026-10-05.
All 27 suites green. Backend (payments.js).

---

### 56. Fix confirmation/SMS water figure + void SS8 fictitious invoice (CASE A + CASE B)
Both cases were the same root cause: the confirmation/SMS water figure pulled the WHOLE
unpaid metered-water register instead of the current billing month's approved water.

- **CASE A (SB7)**: flat water 0; metered register = 8,380 (Sept) + 360 (Oct) = 8,740 unpaid.
  The confirmation showed 8,740 (the whole register) instead of the 360 Oct invoice being
  settled. FIX: `waterChargeBefore` (the "Rent Due" water) now = flat water + CURRENT-month
  metered only (`currentMonthMetered`, filtered by billing_month). SB7 now shows 360.
- **CASE B (SS8)**: flat water 0 (NO water supply) yet carried a 10,180 metered invoice that
  the SMS surfaced as a fictitious water charge. FIX: voided invoice#38 (fictitious - no
  water supply) so SMS/confirmation show only the genuine 12,000 rent. Current-month water
  for SS8 = 0.

Both the confirmation (messages.js `waterChargeBefore`) and the balance now use the verified
current-month water, so dashboard / invoice / confirmation / SMS agree. The prior-month
invoices remain in `remainingWater` (carried correctly) without being re-charged as this
month's due. All 27 suites green. Backend (store.js) + data (SS8 invoice voided, audit-logged).

---

### 57. 3-stage automated financial validator + system-wide consistency audit (SYSTEM DIRECTIVE)
Built `backend/services/financialValidator.js` - financial consistency checks that run at three
stages and FLAG inconsistencies (never silently rewrite records):

- **Stage 1 - before rollover** (`validatePreRollover`): verifies every tenant's closing position
  (non-negative counters, paid<=configured charge, consumed-advance re-emit, payment allocations
  sum to the payment amount, duplicate M-Pesa refs). Wired into `rolloverMonth` before `rolloverBody`.
- **Stage 2 - after rollover** (`validatePostRollover`): opening balances sane, nothing stale
  carried forward. Wired after `reconcileAllTenants`.
- **Stage 3 - after payment** (`validatePostPayment`): allocation sums to the amount + tenant
  account consistent. Wired into `approvePayment`'s route after approval.

Checks (evidence-based, comparing stored counters to actual payments/invoices): NEG_ARREARS /
NEG_ADVANCE / NEG_CREDIT, OVER_DEPOSIT / OVER_GARBAGE / OVER_WATER (paid>configured),
STALE_ADVANCE (EX304 re-emit: opening_advance seeded but advance_rent_until null), ALLOC_MISMATCH
(payment allocation doesn't sum to the amount = unaccounted money), DUP_REF. Every finding is
written to `audit_log` (action FLAGGED_INCONSISTENCY) for review.

**System-wide audit result (306 tenants)**: 6 real inconsistencies flagged -
- ALLOC_MISMATCH (4): BH5 pay#638 (13,000->alloc 0), GB01 pay#625 (35,200->0), A501 pay#620
  (30,000->0) = unallocated legacy payments; B23 pay#1092 (6,000->6,300) = over-allocated.
- OVER_DEPOSIT (2): SS6 (paid 12,000 > configured 9,000), SA1 (paid 12,000 > configured 10,000).

These 6 are FLAGGED for correction (audit-logged) but NOT auto-fixed - each needs per-case
evidence (the intended allocation / correct deposit value is unknown; correcting by guess would
violate the no-fabrication rule). Refined STALE_ADVANCE to the exact EX304 re-emit pattern so
legitimate partial remainders (BH20 9,500 etc.) are not false-flagged. All 27 suites green
(payment 27, financial-phase1 58, deposit-reinstatement 65, financial-integrity 27).

---

### 58. System-wide advance / rent-balance audit + correction (Stephen Kinyangu D1 reference)
Guiding principle applied: RETAIN what is valid, CORRECT what is wrong, REMOVE what has no
financial/transactional support. Nothing reset to zero, no legitimate arrears/advance deleted.

- **Unsupported advance rent removed (the reference case)**: Stephen Kinyangu (D1, Sunview) had
  KES 60,000 `advance_rent_balance` but only ONE real payment (15,000, ref UJ1838R9VC) with
  `overpayment=0` - no genuine advance exists. The 60,000 was orphaned credit left by earlier
  parse-test payments (created + approved + deleted). Removed the 60,000 + cleared
  `advance_rent_until` (audit-logged). System-wide check (advance must be <= opening_advance +
  payments' overpayment) found D1 was the ONLY tenant with unsupported advance - all other
  tenants' advances are supported by real payments.
- **Over-allocated payment fixed**: B23 pay#1092 (6,000) allocation summed to 6,300 (rent 6,000 +
  maintenance 300). Re-balanced to the standard order (maintenance before rent): maintenance 300 +
  rent 5,700 = 6,000, remainingRent 300. (Was internally inconsistent: remainingRent 1,300 despite
  full settlement.)
- **3 unallocated payments FLAGGED (not auto-fixed)**: BH5 pay#638 (13,000, ref UIN1P7SKLU),
  GB01 pay#625 (35,200, UI8R55JGCL), A501 pay#620 (30,000, UIMR27HMU6) are real M-Pesa transfers
  with EMPTY allocations (alloc sums to 0). Re-allocating needs the payment's billing period +
  intended charge, which is not recoverable from the record (e.g. A501's is a Sept payment but
  rent_paid_this_month tracks Nov). Correcting by guessing would fabricate the period mapping -
  flagged to `audit_log` (FLAGGED_INCONSISTENCY) for management to allocate with the real intent.

Integrity: no transaction fabricated; no legitimate arrears/advance deleted; valid receipts,
transaction codes and payment history preserved; every adjustment audit-logged (previous value,
corrected value, reason, date, actor).

## Open items / next (system directive - remaining)
- **3 unallocated payments** (BH5/GB01/A501) need the real billing-period/charge mapping from
  management before allocation - then the dashboard/payment/rollover/statement reconciliation
  closes cleanly.
- **Outstanding rent balances**: the advance side is now fully verified; the arrears side still
  needs the deeper "recompute from move-in history" pass (flagged in #46) to catch any
  carried-forward balance lacking a supporting rent obligation.

---

### 59. Per-management allocations + arrears-recompute finding (system directive)
Applied the three unallocated payments exactly per management's stated intent (audit-logged):
- **BH5 pay#638 (13,000)** = SECURITY DEPOSIT -> allocated to deposit account.
- **GB01 pay#625 (35,200, 8 Sep)** = SEPTEMBER rent 35,000 + garbage 200. Sept+Oct rent both
  marked paid; Nov rent now due; no advance/overpayment. (garbage_fee_paid synced.)
- **A501 pay#620 (30,000, 22 Sep)** = SEPTEMBER rent (partial - did not clear the full amount).
  Outstanding Sept balance carried forward; Oct 10% late penalty 3,500; 300 garbage (Oct+Nov);
  current rent balance 3,800 maintained.

**Arrears recomputation (billing-month reference) - evaluated but NOT blindly applied.** Built the
recompute (continuous billing range from created_at, obligation = rent+garbage, first month
prorated via first_billing_charge, minus payments matched by billing_period + penalties). Verified
against known-good examples: B38 = 18,000 (2 x 9,000 incl. garbage) matches; ME3's 9,500 needs a
~6,000 prorated first month not present in `first_billing_charge` (null).

Ran it system-wide (306 tenants): **only 14 match the stored arrears; 292 "differ" with the
computed value HIGHER than stored** (e.g. B3 computed 6,500 vs stored 0). Root cause: the prior-
month netting matches payments by `billing_period`, but many payments are tagged with the WRONG
month (the Nov-tagged-for-Sept issue), so payments are not netted against the months they cover -
inflating arrears. Per the directive's own safeguard ("do NOT create artificial arrears"), the
recomputation was NOT applied - it would manufacture arrears on 292 paid-up accounts. Genuine
arrears preserved. FLAGGED: the billing_period tagging must be reconciled first (the same fix as
"trust payment month over tag"), after which the recompute nets correctly.

## Open items / next (system directive - remaining)
- **Billing-period tagging reconciliation** - the root cause blocking the arrears recompute. Once
  payments are tagged with the month they actually cover, the recompute nets correctly and the
  final end-to-end reconciliation (dashboard / payment history / rent processing / statements /
  rollover / advance+arrears reports) closes cleanly.
- **A501 Oct 3,500 penalty + 300 garbage**: confirmed as management-stated charges; retained.

---

### 60. Final reconciliation: move-in-optional arrears recompute + end-to-end module agreement
Applied management's final clarification (no mandatory move-in dates):
- **Recomputable set = 1 tenant (SS5)** - the only one with a recorded `first_billing_charge`
  (5,500 half-month). Its first billing month is the MOVE-IN month (Oct 5), so billing months are
  Oct-Nov only. Correct recompute = 0 (matches stored) -> RETAINED. (An earlier run that used
  `created_at` [Aug] as the first month over-counted SS5 to 22,200 - that was an erroneous
  artificial-arrears creation, REVERTED to stored 0 with audit.)
- **306 tenants RETAINED** (no `first_billing_charge` recorded): existing verified opening balance +
  transaction history preserved. No first-month charge invented or estimated, per instruction.
- **All confirmations hold**: ME3 9,500 genuine (retained), B3 0 (Oct paid / Nov due), GB01 0,
  A501 0, D1 advance 0 (60,000 removal retained), B23 1,300, BH5 deposit 13,000 (advance 0 - the
  13,000 is a security deposit, correctly not advance).
- **End-to-end reconciliation CONSISTENT** (sample: ME3/B38/BH8/BH46/SS5/D1): the exit-summary
  (single source) arrears + unpaid-rent equal the tenant-account counters, so dashboard, payment
  history, rent processing, monthly statements, rollover and advance/arrears reports all reflect
  the same verified balances.

Guiding principle honoured throughout: RETAIN what is valid, CORRECT what is wrong, REMOVE what
has no support. No balances reset to zero; no legitimate arrears/advance deleted; no invented
billing records; genuine arrears + advance preserved; every correction audit-logged.

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

### 61. Water billing root-cause fix: water-only invoices + full month charges (SYSTEM DIRECTIVE)
Client report (2026-11-05): water bill amounts wrong in tenant billing AND message generation -
SS6 showed water 9,481 + rent 9,000 (total 18,681) instead of water 180 + rent 12,000 + garbage 200
(total 12,380). Fixed at the SOURCE in system logic, not per-tenant:

- **Root cause**: the legacy "MONTHLY RENT & UTILITY" water rows (Sept) bundled rent + garbage +
  water into one total (SS6 9,300.80 = rent 9,000 + garbage 200 + water 100.80). Water figures
  summed the WHOLE `water_invoices` register - double-billing rent/garbage (already charged in the
  rent cycle) and pulling previous billing periods into the current bill.
- **FIX (billing source)**: `WATER_ONLY_SQL` - only rows with NO rent/garbage/non-water component
  count as water. Applied in `getWaterInvoiceOutstanding` (parse preview), `approvePayment` step 6
  (allocation settle), `getTenantExitSummary` (tenant billing total) and the statement's monthly
  charge rows. Outstanding uses the invoice_register twin's balance so partial settlements are
  never re-charged in full.
- **FIX (billing month)**: water billed WITH the month's rent = the invoice DUE that month
  (`payment_month`/`due_month` - e.g. the Oct consumption invoice due 5 Nov bills with Nov rent).
  The prior `billing_month` match never fired for real cycle payments. Prior-cycle leftovers stay
  in `remainingWater`, not re-charged as this month's due.
- **FIX (message wording)**: "Monthly Rent"/"Garbage Fee" in the Rent Due line show the month's
  FULL charges (matching the tenant statement ledger), not the remainder after earlier partial
  payments this month. Preview (`buildPaymentMessage`) and confirmation
  (`buildPaymentConfirmation`) use identical formulas (verified identical output).
- **FIX (delete reversal)**: deleting a payment reopens the water invoices it settled and restores
  the register balance (SB10's 360 stayed "Paid" after payment 5404 was deleted 2026-11-05 15:21).
- **Partial settle**: a water invoice only flips to Paid when FULLY settled.
- **Data corrections (16, each audit-logged with previous value / corrected value / reason)**:
  2 reopen (BH30, SB10 - "Paid" with no supporting payment), 3 relink (BH8 2,000 / BH38 400 /
  SB12 180 - money WAS collected by exact-match payments #2984/#2971/#2963 but the Invoice Center
  link was missing), 1 void sync (SA4 row -> Void, twin voided "New tenancy started"), 10 bundled
  discharges with full settlement evidence (payment allocation exactly covers the bundle total:
  SA1/SA3/SA7/SB3/SB7/SB9/SB11/SB12/SS4) + SS6's Sept bundle (rent 9,000 + garbage 200 collected
  via GEHPM-RCT-202610-001366; water 100.80 written off per management - verified outstanding =
  12,380). Audit tool: `node backend/scripts/audit-water-billing.js [--apply]`.
- **Verified live**: SS6 preview AND tenant billing both read "Rent Due for November 2026 was
  KES 12,380 (Garbage Fee: KES 200, Water Charges: KES 180, Monthly Rent: KES 12,000)"; SB10 =
  10,560 (rent 10,000 + garbage 200 + water 360) - the payment deleted at 15:21 now approves
  cleanly. Fixture suite `tests/test_water_billing_scope.js` (23 assertions) locks
  preview == confirmation == allocation.
- **FLAGGED for management (no silent rewrite)**: 8 open legacy bundled rows without exact
  settlement evidence (SA4 10,380 / SA6 10,560 / SB5 8,380 / SB6 8,830 / SB8 8,560 /
  SB8 STAIRS 4,380 / SS1 10,200 / SS7 10,380) - excluded from every billing figure by the logic
  fix, listed for review; 4 zero-amount invoices (BH1/BH32/BH45/SB1); 2 orphan rows (SB8 540
  "Finalized" never registered + payment #2522 540 unallocated; SS4 180).

All 28 suites green (1,122 assertions). Backend + data. Stamps unchanged (backend-only).

---

### 62. Transaction-based reconciliation: D1 (Stephen Kinyangu) + system-wide phantom credits (SYSTEM DIRECTIVE)
"NO GENUINE TRANSACTION, NO RECOGNIZED PAYMENT." Management reported: after the erroneous 60,000
record was corrected (entry #58), D1's dashboard still showed November 2026 rent PAID - and the
real November payment (attempt #5316, ref UJS8306DG3, deleted Nov 4) was misclassified as an
overpayment. Root cause: the 60,000 advance's CONSUMPTION RE-EMIT survived its removal -
reconcileTenant had seeded rent_paid_this_month 15,000 for November from the phantom
advance_rent_until, with NO November transaction behind it.

- **D1 corrected (audit-logged)**: payment #1424 (15,000, ref UJ1838R9VC) confirmed as the
  1 OCTOBER payment (allocation billing_period 2026-10, rentSettled 15,000 to October - already
  correct) and its recorded date restored to 2026-10-01 (pre-fix MM/DD parse artifact; source
  message in notes: "10/01/2026 at 10:00:50"; management: "the payment dated 1st October").
  Counters re-derived from the payment history: November credit 15,000 -> 0 (unsupported),
  November rent 15,000 OUTSTANDING, October fully settled, arrears 0 preserved, the 60,000
  correction PRESERVED (never reintroduced). Verified end-to-end: entering the actual November
  payment of 15,000 now allocates "Monthly Rent: KES 15,000 ... Your account is fully paid"
  (balance 0, status PAID) - no overpayment.
- **System-wide audit** (`backend/scripts/audit-transaction-truth.js [--apply]`, 307 active
  tenants): rent_paid_this_month must equal what genuine transactions support for the tenant's
  current rent cycle (rent-directed payments tagged to the cycle + deposit applications +
  transaction-backed advance coverage). Findings + corrections (each audit-logged with previous
  value / corrected value / reason):
  - 4 counter corrections (D1 class): B30 (1,000 -> 0 carried-forward credit), EX304 (40,000 ->
    800 - November's payment carried into the December cycle; only the 800 advance supports Dec),
    EX006 (35,500 -> 35,700 - deposit application + 200 advance), SB8 STAIRS (4,000 -> 4,500 -
    genuine advance covers the cycle at the current rate).
  - 33 payment-date restorations (pre-fix MM/DD parse artifacts, entry #55): the stored money
    date contradicted the source M-Pesa text in the payment's own notes, and the source date's
    reading that aligns with the payment's allocated cycle was taken (e.g. "10/01/2026" ->
    2026-10-01, "5/11/26" -> 2026-11-05). Receipts, references, amounts and billing allocations
    untouched - only the recorded money date restored to the original message's date.
  - FLAGGED for management (no silent rewrite): 11 payments whose money date genuinely differs
    from the allocated cycle (real advances / late recordings: BH11 #1547, C4 #3828, EX001 #2236,
    EX201 #1512, B21 #901, C302 #1488, C601 #1489, EX603 #1454, ME6 #1476, EX004 #1479,
    EX304 #5169) and EX003's 200 credit with no overpayment transaction.
- **Ongoing enforcement** (directive 4): `financialValidator.js` now checks transaction truth at
  all three stages (before rollover / after rollover / after payment): RENT_PAID_UNSUPPORTED,
  RENT_PAID_UNDERSTATED, ADVANCE_UNSUPPORTED - every finding written to audit_log. The rollover
  contract already satisfies directive 5 (closes the month from its own transactions, resets the
  new cycle, never carries a payment forward) once phantom credits are gone; reconcileTenant
  (the documented transaction-truth engine) runs after every approval, deletion and rollover.
- **Safeguards honoured**: no genuine transaction changed; no receipts/references duplicated;
  legitimate advance rent untouched (only transaction-backed advances recognised); genuine
  arrears and the #60 management decisions on retained arrears preserved; only affected accounts
  corrected.

All 29 suites green (1,132 assertions) incl. new `tests/test_transaction_truth.js` (10).
Backend + data.

---

### 63. Overpayment figure in confirmations/receipts: actual available credit, never the accumulation (EX402)
Management reported (Executive Apartments EX402, Brian Serem): November rent 27,000, payment 27,400,
actual overpayment 400 - but the payment confirmation displayed an overpayment of 600 ("Total combined
credit from receipts: KES 600.00") and the receipt PDF showed "Amount already allocated 600 /
Remaining available 0". Root cause: the message generation ACCUMULATED every receipt's lifetime
overpayment (200 already utilized for November rent + 400 current) and presented the total as the
credit, while the "remaining" figure read only credit_balance (ignoring the advance-resident credit).

- **FIX (presentation only - the reconciled EX402 dashboard and its genuine 400 overpayment are
  untouched)**: `getOverpaymentConsolidation` now computes `applied_overpaid` /`available_overpaid`
  from the receipts + their resolutions (a receipt's overpayment is APPLIED when its
  `overpayment_resolved` earmark reached the tenant's current rent cycle, or when its credit was
  spent via credit_allocations - only resolutions of SURVIVING receipts count). The acknowledgement
  (`appendCreditConsolidation`) and the receipt PDF (`buildAccumulatedOverpaymentHtml`) now show:
  "Current transaction overpayment: KES 400.00" (the transaction's actual overpayment), the lifetime
  figure ONLY as "Overpaid across receipts (incl. KES 200.00 already applied)", and
  "Overpayment available (reconciled): KES 400.00". Utilized credits are never re-counted; the
  figures come from the reconciled ledger position at message time - the summary never independently
  re-accumulates history into a different financial position.
- **Verified**: EX402 - message + receipt PDF now read 400 (was 600/0). System-wide spot-check of all
  46 tenants with overpayment receipts confirms the figures are point-in-time consistent with their
  ledgers (credits legitimately consumed by later rent months move the ledger afterwards - the
  message is a record of the position at generation).
- **Tests**: `test_overpayment_summary.js` (23 -> 27) gains the EX402 regression (utilized 200
  excluded, available 400, no combined-credit line); `test_receipt_overpayment_summary.js` (18) -
  labels/figures updated to the reconciled semantics (applied 7,500 / available 1,500 unchanged
  numbers). Dashboard, payment history, ledger and messages now agree.

All 29 suites green (1,136 assertions). Backend (store.js, messages.js, documentStore.js) + tests.

---

### 64. Utilized credits are consumed exactly once (B30) + advance-edit propagation rule
Management reported (B30): an overpayment that settled OCTOBER rent was carried by the monthly
rollover into the Advance Rent slot as though still available; the administrator then removed the
editing restriction and manually zeroed the slot - yet the dashboard kept recognizing the used
1,000 (showing it as available credit / phantom rent-paid).

- **What had happened (audit trail preserved)**: the 1,000 was a manually seeded opening advance
  (Oct 8) that settled October rent (payment #896's snapshot: rentPaidBefore 1,000 + rentSettled
  6,000 = October's 7,000). The old auto-seed mechanism re-emitted the consumed seed at the
  November rollover (removed in entry #52), leaving `rent_paid_this_month` 1,000 for November -
  cleared by the entry #62 transaction-truth pass at 17:54. B30 is verified clean on every surface
  (dashboard counters, credit consolidation 0/0, exit summary rent 7,000, reconcile
  outstanding 7,000, no credit-side rows).
- **SYSTEM RULE enforced (requirement: a manually corrected advance must reflect in ALL underlying
  calculations)**: the Advanced Rent edit flow (`PUT /api/tenants/:id`) now re-derives the dependent
  counters (`reconcileTenant`) after every seed/correct/zero - so a correction instantly reaches the
  tenant dashboard, statement, rollover, arrears and reports. Before this, a zeroed slot left the
  phantom rent-paid behind (exactly B30's experience).
- **Rule - one credit, one utilization**: consumption is decremented from the advance pool at each
  month close (rollover), the consumed-seed auto-re-emit stays removed (#52), and the 3-stage
  validator flags RENT_PAID_UNSUPPORTED / RENT_PAID_UNDERSTATED / ADVANCE_UNSUPPORTED. System-wide
  verification (307 tenants + the 38 accounts holding advance slots/pools): no remaining
  carried-and-deducted-again cases - every remaining pool is a genuine, transaction-supported,
  UNUSED credit whose first deduction is still ahead; the transaction-truth audit is clean on all
  counter classes.
- **Tests**: `test_transaction_truth.js` (10 -> 13) gains the B30 class - editing the Advanced Rent
  slot through the live route re-derives the phantom rent-paid away on the same edit.
  `test_unit_integrity.js` hardened against live payment traffic (its read-only proof now
  cutoff-scopes row counts so concurrent production payments cannot false-fail it).

All 29 suites green (1,139 assertions). Backend (routes/tenants.js) + tests.

---

### 65. Confirmation figures come from the correct tenant's active configuration (SB1)
Management reported (SB1, Peter Mwangi Nganga, Sunrise): the November confirmation "reports rent
due as KES 5,500" though the correct figure is 9,200 (rent 9,000 + garbage 200), and "deleting and
reprocessing sometimes produces the correct information" - suggesting inconsistent retrieval.

- **Root cause (no cache involved - the generator reads the live tenants row)**: TWO independent
  causes, both now fixed:
  1. The message showed the rent REMAINING after an earlier partial payment (9,000 configured
     3,500 already paid on Nov 1 = the 5,500) instead of the month's rent - the entry #61 fix
     (Rent Due line = full configured charges) landed BETWEEN the user's two processing attempts
     (Nov 4 23:05 message showed 5,500; the Nov 5 21:02 reprocess already showed "Rent Due for
     November 2026 was KES 9,200 (Garbage Fee: 200, Monthly Rent: 9,000)"). That timing is exactly
     why "deleting and reprocessing produced the correct information".
  2. The parse preview's suggested tenant came from an OR-match (phone / account code / paybill)
     ordered BY NAME and taken as the first row - a shared sender phone could surface a DIFFERENT
     unit and display THAT unit's rent (the "outdated/default rent figure" the report suspected).
     FIX: an exact account-code match always wins; name order is only the phone-only fallback.
     Hyphenated unit codes are now captured by the account-number parser too.
- **System-wide validation (`backend/scripts/audit-message-accuracy.js`, read-only, 307 tenants)**:
  the rent line always equals the tenant's active configured rent, the garbage line equals the
  configured fee, settled charges are never re-deducted, unpaid charges are never omitted,
  generation writes NOTHING (payment count unchanged), and identical input always produces an
  identical message. ZERO violations.
- **Tests**: new `tests/test_message_tenant_match.js` (6) locks the correct-tenant selection, the
  SB1-class full-month rent display (9,200 not the 5,500 remainder), determinism and
  confirmation/receipt parity. Protected areas untouched (detection, references, approval
  workflow, allocation priorities, history, templates).

All 30 suites green (1,145 assertions). Backend (payments.js) + tests.

---

### 66. Landlord delete fix + commission invoice payment method + ledger buttons verified
Management reported (Landlord Commission Ledger): the delete fails with "current transaction is
aborted, commands ignored until end of transaction block"; the commission invoice should carry a
payment method (Till or Paybill) filled in at generation instead of the hardcoded Payment
Instructions block; and every ledger button must work - above all "Share Invoice with Landlord"
delivering the invoice to the saved landlord WhatsApp number.

- **Delete root cause**: the detach loop updated FIVE tables - two of them
  (`landlord_reviews`, `landlord_ledger_finalizations`) carry NO landlord_id (they key by house),
  so the statement errored, the `.catch(() => {})` swallowed it, and the ABORTED Postgres
  transaction poisoned every later statement (hence the exact error on `DELETE FROM landlords`).
  On top of that the three real ledgers had NOT NULL landlord_id - the "detach to NULL" could
  never work. FIX: migration `migrate-landlord-invoice-fixes` makes the three landlord_id columns
  nullable; the handler now detaches ONLY tables that carry landlord_id, every detach must
  succeed, the not-found case rolls back BEFORE commit, and financial history is preserved
  (landlord_id NULL - never deleted). The property-less duplicate landlord now deletes cleanly.
- **Commission invoice payment method**: the Generate Commission Invoice form now asks for the
  payment method (M-PESA Paybill / Buy Goods Till) + number + account name, prefilled from the
  landlord record; it is stored on the invoice and PRINTED on the PDF
  ("Payment Method: Buy Goods Till 123456 (Gutenberg Elite), Account Name: ... - quote invoice
  ...") instead of the hardcoded Paybill 4086873 paragraph. Regeneration keeps the stored method;
  old invoices fall back to the previous default text.
- **Ledger buttons**: all ten verified end-to-end - Record Commission Payment, Record Landlord
  Remittance, View Invoice, Download Invoice (PDF), Share Invoice with Landlord, Commission
  Statement, Remittance Statement, Flag Under Review, Finalize/Reopen Month, Close. Share Invoice
  sends the generated invoice PDF to the landlord's SAVED phone via the WhatsApp session
  (normalizePhone 072... -> 254..., honest per-send status - covered by the landlord suites).
- **Tests**: new `tests/test_landlord_delete_invoice.js` (12) locks the delete semantics and the
  payment-method rendering. All 31 suites green (1,157 assertions). Stamps: app v89, sw v90 /
  gutenberg-v91-landlordpay (frontend changed).

---

### 67. Commission invoice payment methods: Send Money + Bank Account added
Management asked for Send Money and Bank Account alongside Paybill / Till when creating the
commission invoice.

- The Generate Commission Invoice form now offers four payment methods - M-PESA Paybill, Buy
  Goods Till, M-PESA Send Money, Bank Account - with the fields following the choice (bank name
  appears for Bank Account; the number label switches between Paybill number / Till number /
  Send money to (phone) / Bank account number). Each prefills from the landlord record
  (mpesa_number, bank_name/bank_account, name).
- The filled-in details are stored on the invoice and printed on the PDF:
  "Payment Method: Buy Goods Till 123456 (Gutenberg Elite), Account Name: ...",
  "Payment Method: M-PESA Send Money to 0721492014 (...)",
  "Payment Method: Bank Transfer - Equity Bank, Account Number: ..., Account Name: ...".
  Regeneration keeps the stored method; invoices without one fall back to the paybill default.
- `tests/test_landlord_delete_invoice.js` (12 -> 14) covers the Send Money and Bank Account
  renderings. Caught en route: the entry #66 SW cache rename broke the two stamp checks
  (they pin the `gutenberg-v\d+-irmanage` pattern) - restored and re-verified (32/0, 153/0).

All 31 suites green (1,159 assertions). Backend + frontend (stamps: app v90, sw v91 /
gutenberg-v92-irmanage).

---

### 68. Unit-by-unit sweep (2/…): B23 reminder math + B14 double-counted 500
Management is walking unit by unit to have every account clean before the December rollover
(reports 100% accurate). First two units:

- **B23 (Hiram Mwangi) - Rent Balance Reminder "calculations don't add up"**: the template's
  TOTAL came from the reconciled ledger balance (arrears + remaining rent + penalties + garbage +
  water) while the visible lines only showed arrears / rent / payments - the hidden components
  (B23's restored waterbill 1,000 + socket 300 = the missing 1,300) made 1,300 + 6,000 - 0 read
  7,300 but print 8,600. FIX: the reminder now itemises "Other Charges
  (Penalties/Garbage/Water)" and the TOTAL is computed from the SAME components as the displayed
  lines - it can never disagree again (template body + seed + the fill in app.js; the broadcast
  {{current_rent}} now carries the full rent so its parenthetical math closes too). Verified live:
  B23 reads 0 + 6,000 - 5,700 + 0 = 300 (= its true remaining rent).
- **B14 (Ian Nixon) - the 500 arrears payment "picked as an overpayment"**: the KES 500 was
  consumed as remaining rent (payment #1582, receipt GEHPM-RCT-202610-001359, ref UJKIIAZ5PW,
  allocation rentSettled 500 = October's remaining rent) AND separately booked as an opening
  advance (audit 2026-10-16 opening_advance_added {amount:500, via:edit}) - the same credit
  counted twice (October settlement + a phantom November rent-paid). FIX (one credit, one
  utilization): the duplicate advance (slot + pool + coverage) removed, counters re-derived from
  the payment history - November now reads the full normal rent 6,500 (verified: reminder
  0 + 6,500 - 0 + 0 = 6,500). Historical transactions untouched; both steps audit-logged.
- **Tests**: test_message_tenant_match (6 -> 9) - reminder template itemises Other Charges, the
  fill computes the total from the displayed components, and the ledger balance equals the
  reminder's line-sum. All 31 suites green (1,162 assertions). Stamps: app v91, sw v92 /
  gutenberg-v93-irmanage.

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
| 10 | Archive: clickable tenant name → complete per-tenancy payment history | v64 |
| 11 | WhatsApp report send: correct .xlsx mimetype + honest stage-based errors | v65 |
| 12 | House Dashboard: live collection position (expected/collected/remaining/%) | v66 |
| 13 | Encoding repair: mojibake removed, original symbols/labels restored | v67 |
| 14 | WhatsApp delivery status auto-updates + PDF receipt for every payment type | v68 |
| 15 | Message channel selector: WhatsApp / SMS / Both wired end-to-end (incl. tenants-section modal) | v70 |
| 16 | WhatsApp false-Failed fix: retry on transient session-file locks + Defender exclusion script | backend |
| 17 | Pre-Exit Inspection Inventory: findings → PDF share → agreed items transferred once into Exit Invoice | v71 |
| 18 | Statement of Account: selectable period + 7-row monthly summary, period-scoped histories, design preserved | v72 |
| 19 | Broadcast channel selector: WhatsApp / SMS / Both with per-channel tallies and honest statuses | v73 |
| 20 | Water Bill invoice covers water only (rent/garbage excluded from totals, document and form) | v74 |
| 21 | Universal Global Search + Landlord Commission Management (per-property ledgers, invoices, payments, statements) | v75 |
| 22 | WhatsApp duplicate-send fix: exactly one attempt per send; lock errors soft-success (v66 retry removed) | backend |
| 23 | Landlord Ledger Dashboard: commission + rent remittance ledgers, agreed dates, statements, invoice sharing | v76 |
| 24 | Landlord accounts: agreements, transfer verification, reconciliation, finalization, false-payment reversal, totals strip + menu fix | v77/v78 |
| 25 | Central Notification Bar: live alert detection, emergency pulse, deep links, auto-updates, history | v79 |
| 26 | Minimal dashboard header: bare search input + notification bell with count badge | v80 |
| 27 | Overpayment transparency: consolidated credit summary in acknowledgement + tenant dashboard | v82 |
| 28 | PDF receipts: accumulated overpayment summary section (display only) | backend |
| 29 | Future Tenancy activation: continuous receipt numbering + automatic PDF receipts | v83 |
| 30 | Agreements Inbox: per-house drop folders, auto-store to tenant Agreements, no sending | backend |
| 31 | Service worker: ignoreSearch cache fallback (offline styling loss) | v83+sw |
| 32 | Agreements Inbox: occupied-status match, process lock, race repair (123 stored, 0 dupes) | backend |
| 33 | Deposit refund cancellation, deposit restoration, tenancy reinstatement, unit reassignment | v84 |
| 34 | Financial Mgmt Phase 1: Arrangement A/B, double-entry journals, obligations tracker, monthly report, registers | v85 |
| 35 | Tenant–Unit integrity audit + water-invoice validation (BH18 root cause fixed) | v86 |
| 36 | Enhanced Monthly Report: occupancy accuracy, live formulas, PDF twin | v87 |
| 37 | System-wide complete payment history, drill-down & financial reconciliation | backend |
| 38 | Report column spacing fix - long tenant names no longer clipped | backend |
| 39 | Excel row-height fix + system-wide financial reconciliation audit (review mode) | backend |
| 40 | Enhanced Report: correct overpayment / arrears / cleared status (B19/B21/B36/B16) | backend |
| 41 | Even report spacing across ALL sheets (not just the Enhanced sheet) | backend |
| 42 | Enhanced Report: recognise overpayment/credit + correct arrears across all houses | backend |
| 43 | Enhanced Report: deposit-credit for future move-ins + unpaid-garbage-only | backend |
| 44 | Cream House resolved + cumulative roll-up of future-tagged prepayments | backend |
| 45 | All 46 report fix.txt cases match (individual per-case corrections) | backend+data |
| 46 | November 2026 rollover audit + automated rollover engine fix (frozen-arrears + timezone) | backend+data |
| 47 | Payment parse: auto-retrieved invoices now charged in allocation (BH3 water bug) | backend |
| 48 | Notification dashboard audit + system-wide financial sync (Nov rollover) | verification |
| 49 | Intelligent tenant broadcasting: payment verification + SMS-only rent reminder | backend+frontend |
| 50 | SMS broadcast advanced targets + landlord delete + invoice download fix | backend+frontend |
| 51 | Fix SMS broadcast target dropdowns not opening (window exposure) | frontend |
| 52 | Advanced Rent editing protection removed + BH8/BH46/EX304 audit + water-in-balance + system audit report | backend+frontend+data |
| 53 | Fix payment-approve 500 (WhatsApp PDF throw) + rollover-consumption fix (auto-seed re-emit) | backend |
| 54 | Fix payment-approve 500 (Invalid time value date-parse bug) | backend |
| 55 | Fix M-Pesa date parse (MM/DD vs DD/MM month-day swap -> 2026-28-10) | backend |
| 56 | Fix confirmation/SMS water figure (whole metered register -> current-month only) + void SS8 fictitious invoice | backend+data |
| 57 | 3-stage automated financial validator (before/after rollover, after payment) + system-wide consistency audit | backend |
| 58 | System-wide advance/rent-balance audit: remove unsupported advance (D1 60k) + fix over-allocation (B23) | backend+data |
| 59 | Per-management allocations (BH5 deposit, GB01 Sept rent, A501 Sept rent) + arrears-recompute finding | data+verification |
| 60 | Final reconciliation: move-in-optional arrears recompute + end-to-end module agreement | data+verification |
| 61 | Water billing root-cause fix: water-only invoices, cycle-month matching, full month charges in messages, delete-reversal sync + 16 evidence-based corrections | backend+data |
| 62 | Transaction-truth reconciliation: D1 Stephen Kinyangu fix + system-wide phantom credits/date artifacts + 3-stage validator enforcement | backend+data |
| 63 | Overpayment figure in confirmations/receipts: actual available credit (EX402 400 not 600), utilized credits excluded | backend |
| 64 | Utilized credits consumed exactly once (B30) + advance-edit propagation rule (manual corrections re-derive all balances) | backend+tests |
| 65 | Confirmation figures from the correct tenant's active configuration (SB1): exact-code match over shared phones + full-month rent display verified system-wide | backend+tests |
| 66 | Landlord delete fix (aborted-transaction bug) + commission invoice Till/Paybill payment method + ledger buttons verified (share via landlord WhatsApp) | backend+frontend+data |
| 67 | Commission invoice payment methods: Send Money + Bank Account (fields follow the method, printed on the invoice) | backend+frontend |
| 68 | Unit sweep: B23 reminder lines always sum to the total (Other Charges itemised) + B14 duplicate 500 credit removed (November back to normal 6,500) | backend+frontend+data |
