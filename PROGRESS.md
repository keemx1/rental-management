# GEHPM Rental Management — Progress Log

Living record of every update applied to this repository
(`origin → https://github.com/keemx1/rental-management`, branch `main`).

**Last updated:** 2026-10-25 · app version `v62` · SW cache `gutenberg-v63-irmanage`

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
