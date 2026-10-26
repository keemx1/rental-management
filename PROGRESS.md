# GEHPM Rental Management — Progress Log

Living record of every update applied to this repository
(`origin → https://github.com/keemx1/rental-management`, branch `main`).

**Last updated:** 2026-10-25 · app version `v70` · SW cache `gutenberg-v71-irmanage`

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
| Send retry (session locks) | `node tests/test_send_retry.js` | 11 assertions — transient session-file locks (EPERM-open/EBUSY) retried safely pre-transmission, real failures surfaced immediately, disconnected guard untouched |
| Pre-Exit Inspection Inventory | `node tests/test_preexit_inspection.js` | 56 assertions — unit lookup + tenancy disambiguation, item CRUD with server-side totals (spec 14,500 example), Draft/Shared/Agreed, PDF with exact disclaimer + no refund figures, one-time transfer into the Exit Invoice (repeat/partial retry safe, finalized refused 409), transferred items locked, tenancy seal + archive visibility, re-let protection |

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
| 10 | Archive: clickable tenant name → complete per-tenancy payment history | v64 |
| 11 | WhatsApp report send: correct .xlsx mimetype + honest stage-based errors | v65 |
| 12 | House Dashboard: live collection position (expected/collected/remaining/%) | v66 |
| 13 | Encoding repair: mojibake removed, original symbols/labels restored | v67 |
| 14 | WhatsApp delivery status auto-updates + PDF receipt for every payment type | v68 |
| 15 | Message channel selector: WhatsApp / SMS / Both wired end-to-end (incl. tenants-section modal) | v70 |
| 16 | WhatsApp false-Failed fix: retry on transient session-file locks + Defender exclusion script | backend |
| 17 | Pre-Exit Inspection Inventory: findings → PDF share → agreed items transferred once into Exit Invoice | v71 |
