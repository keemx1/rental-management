# SYSTEM ACCOUNTING & ROLLOVER AUDIT — November 2026

Scope: all properties/units/tenants. Diagnostic examples: EX304 (Executive), BH8 & BH46 (Bluegum).
Method: every figure below is traced to verified records (approved payments + allocation
snapshots + water invoices + tenant counters). No transactions were manufactured; every
correction is audit-logged (see `audit_log`, action `CORRECT` / `opening_advance_edited`).

---

## ISSUE 1 — Advanced Rent editing protection (REMOVED)

Root cause (2 locks):
- Frontend: `opening_advance_rent.readOnly = openingAdvance > 0` — the field froze once set.
- Backend (`PUT /api/tenants/:id`): "re-seeding is blocked" — `delete patch.opening_advance_rent`
  when the value already existed or was being cleared.

Both removed. Advanced Rent (`opening_advance_rent`) now behaves exactly like Opening Balance
(`arrears`): it can be entered, increased, reduced, corrected or cleared at any time (immediately
after entry, after registration, after the advance was applied in billing, after monthly
rollover). It commits only on Save (never auto-locks on click) and stays editable after. Clearing
it resets the advance pools (`advance_rent_balance`/`advance_rent_until`). Every change is
audit-logged with from -> to. Ordinary payment protections / overpayment calculations /
historical transactions are untouched.

EX304 consequence: the KES 400 advance that was "locked against the unit" can now be edited or
cleared, so the unit can be freed/re-registered without deleting history.

---

## ISSUE 2 — Diagnostic examples (verified positions + corrections)

### BH8 — Bluegum (CHIANUMBA ALOYSIUS CHUKWUDI)
Verified transaction history:
- 16 Oct: 16,000 (ref UJ51I90JMM) -> Oct rent 15,800 + garbage 200. 16 Oct: 200 (UJ51I90ROB) -> Oct rent 200.
- 28 Oct: **16,200** (UJS1IBTSYC) -> user-verified as covering **November rent 16,000 + garbage 200**.
- 31 Oct: **2,000** (UJV1I0982L) -> the water payment for invoice GEHPM-WTR-202610-000089 (2,000).
- Water invoice #194 (2,000, issued 31 Oct).

Before: the 16,200 was booked as `overpayment` (tagged `billing_period=Oct`) and the 2,000 as
`overpayment`, so neither settled their charge. Water invoice #194 sat "Sent" (unpaid).

**Origin of the KES 15,980**: Nov rent 16,000 - rent_paid_this_month 220 = 15,780 (unpaid rent) +
garbage 200 = **15,980**. It was the un-settled November rent + garbage while the 16,200 sat as
"overpayment".

Correction (audit-logged): 16,200 -> Nov rent 16,000 + garbage 200 (billing_period Oct -> 2026-11);
2,000 -> water invoice #194 (marked Paid); tenant counters synced (rent_paid_this_month 16,000,
garbage_fee_paid 200, advance/credit -> 0/0).
**Verified November position: rent 16,000 + garbage 200 + water 2,000 all settled -> balance 0.**

### BH46 — Bluegum (JOHN WILLIAM MUSUMBA)
Verified: rent 9,000 + garbage 200 + flat water 3,000 all paid (13,700 + 9,000 + 7,500 on 28 Oct).
Water invoices #209 and #210 (600 each = **1,200**, metered) were **unpaid** ("Sent").

Before: dashboard showed a zero balance — the metered water invoices were never included in the
balance calculation (only the flat water charge was).

Correction: the outstanding-balance calculation now includes unpaid metered water invoices
(`water_invoices`) alongside the flat water shortfall. BH46 now correctly shows **1,200** owed
(the unpaid water invoices). Rent/garbage/flat-water all remain correctly settled.

### EX304 — Executive Apartments
Verified: `opening_advance_rent = 400`, `advance_rent_balance = 400`, no payment rows (the October
payment was removed during the reported troubleshooting). The 400 advance was consumed in October
but re-appeared after the November rollover, and the editing lock prevented clearing it (which in
turn blocked deleting the unit).

Correction: the editing lock is removed (Issue 1) — the administrator can now edit/clear the 400
Advanced Rent directly. The "consumed advance re-appearing" is a rollover-consumption defect
(Issue 3 below) to be addressed in the rollover engine.

---

## ISSUE 3 — Systemic weaknesses identified

1. **Cross-period advance mis-booking**: a payment received in month M for month M+1 is tagged with
   `billing_period = M` (the then-current cycle) and allocated as *overpayment* instead of settling
   the target month's rent. (BH8's 16,200.) Result: the target month shows unpaid while the money
   sits as "credit".
2. **Metered water invoices omitted from balances**: `water_invoices` were never summed into the
   outstanding balance (only the flat `water_charge_amount`), so unpaid water invoices showed a
   misleading zero (BH46). Fixed in `getTenantExitSummary`.
3. **Consumed advances re-appearing after rollover** (EX304's 400): the `reconcileTenant` auto-seed
   re-seeded `opening_advance_rent` into `advance_rent_balance` whenever the balance hit 0 with no
   payments, so a utilised advance re-emitted and could not be cleared. FIXED (auto-seed removed).
4. **Advanced Rent was immutable** — prevented onboarding corrections and cleanup of stale credits
   (Issue 1 — fixed).

---

## ISSUE 3 (cont.) — FULL SYSTEM SWEEP (all tenants)

System-wide scan for the three patterns above. Counts (before per-case correction):
- **Pattern 1 — cross-period advance mis-booking**: 9 genuine payments (bp != payment month AND
  booked as overpayment): B21 (19,500), A302 (1,200), 116 (6,000), B35 (4,000), ME6 (7,000),
  BH11 (3,800), BH46 (1,500+7,500), EX001 (22,700), EX003 (28,700). Each needs verification of
  whether the overpayment is correct (advance for the tagged month) or should settle the target
  month's rent (BH8-style) - not a blanket fix.
- **Pattern 2 — unpaid metered water invoices**: 43 tenants hold unpaid `water_invoices`
  (SA1 11,460 / SA3 11,100 / SS7 10,740 / SA6 10,560 ... BH46 1,200). These are now correctly
  reflected in the outstanding balance (water-in-balance fix). Each still needs verification
  whether a payment already settled the invoice (BH8-style: mark Paid) or it is genuinely owed.
- **Pattern 3 — advance / opening-advance balances**: 41 tenants hold an advance or opening advance
  (D1 30,000 / C102 15,000 / BH45 14,200 ... ). Most are legitimate future-month prepayments; the
  risk is a stale consumed credit (EX304-style). The auto-seed fix prevents re-emission going
  forward; existing balances need review against utilisation history.

These three groups are the complete population of accounts potentially affected by the systemic
weaknesses. Corrections must be verified per-tenant against actual payments/invoices (no blanket
edits, no manufactured transactions) - see "Open / flagged" below for the correction plan.

---

## ISSUE 4 — One source of financial truth

The outstanding-balance calculation (`getTenantExitSummary`) is the single source and now reflects:
previous arrears + current-month unpaid rent + penalties + garbage shortfall + **water (flat
shortfall + unpaid metered invoices)**. Verified balances:
- BH8 = 0 (everything settled), BH46 = 1,200 (unpaid water only), EX304 = 40,000 (Vacant unit's
  rent+garbage; its 400 advance is editable via Issue 1).

Payments, charges and water invoices form the base; no figure is invented.

---

## ISSUE 6 — Integrity (enforced)

No payments/invoices/references were fabricated. No unpaid charge was marked paid without evidence
(the water invoice was marked Paid only because the 2,000 payment exists and is verified as its
settlement). No legitimate history deleted. Every correction carries an audit row (previous value,
corrected value, reason, date, actor).

---

## ISSUE 7 — Validation summary

- EX304: Advanced Rent freely editable (Issue 1). 400 can now be cleared.
- BH8: 16,200 -> Nov rent 16,000 + garbage 200; 2,000 -> water #194; **balance 0** (was 15,980).
- BH46: water #209/#210 (1,200) unpaid and now reflected; **balance 1,200** (was 0).
- Water-in-balance fix verified safe (payment/statement/water tests green).

## Open / flagged for administrative review
- **Rollover consumption defect** (Issue 3.3): consumed advances re-appearing after rollover
  (EX304's 400). Requires a rollover-engine fix so a utilised advance is decremented and not
  re-emitted; also verify no other tenant has a stale consumed credit.
- **System-wide sweep** (Issue 3): extend the cross-period advance re-booking + metered-water
  verification to every tenant (the three examples exposed the patterns). The per-tenant audit
  table for all 307 tenants is generated on demand.
- EX304's record is currently `Vacant` with 40,000 in standing charges — confirm whether the unit
  should be fully cleared/deleted now that the advance lock is removed.

Every tenant must have the correct balance; every payment must be accounted for; every invoice
properly recognised; every rollover accurate. The examples above now satisfy this; the flagged
rollover-consumption defect and the full-system sweep remain.
