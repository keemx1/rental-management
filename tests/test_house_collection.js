/**
 * Acceptance test — House Dashboard "Collection Position" (4 figures).
 *
 * Verifies (client requirements):
 *  1. TOTAL AMOUNT EXPECTED = all legitimate charges raised in the period:
 *     rent + new-tenant deposits + water (metered else flat) + garbage +
 *     penalties + maintenance + exit-invoice charges (final rent + lines)
 *  2. TOTAL AMOUNT COLLECTED = every approved payment for the house in the
 *     period, regardless of category (billing_period with payment_date
 *     fallback for legacy rows)
 *  3. REMAINING = expected − collected, COLLECTION % = collected/expected×100
 *  4. A mid-period joiner's rent/deposit is included; payments flow through
 *  5. Figures recompute automatically when charges/payments change (live
 *     query — no stored figures, no workflow change)
 *  6. Endpoint + House Dashboard UI markers served
 *
 * Fixtures: house 999999, tenants ZZCOL-*, fully removed afterwards.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const jwt = require('jsonwebtoken');
const store = require('../backend/storage/store');
const { query } = require('../backend/config/database');

const HOUSE = '999999';
const A = 'ZZCOL-A1';
const B = 'ZZCOL-B1';
const C = 'ZZCOL-C1';
const D = 'ZZCOL-D1';
const PERIOD = '2026-10';
const BASE = 'http://127.0.0.1:3003/api';

let pass = 0;
let fail = 0;
const failures = [];
function check(ok, label, extra) {
  if (ok) { pass++; console.log('PASS ' + label); }
  else { fail++; failures.push(label); console.log('FAIL ' + label + (extra ? ` -> ${JSON.stringify(extra)}` : '')); }
}

async function cleanup() {
  const stmts = [
    `DELETE FROM payments WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM penalties WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM water_invoices WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM maintenance_charges WHERE unit_code LIKE 'ZZCOL-%'`,
    `DELETE FROM work_orders WHERE house_paybill_number = $1`,
    `DELETE FROM deposit_refunds WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM exit_invoices WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM tenancy_archive WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM documents WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM message_logs WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM tenants WHERE tenant_code LIKE 'ZZCOL-%'`,
    `DELETE FROM houses WHERE paybill_number = $1`,
  ];
  for (const sql of stmts) {
    try { await query(sql, sql.includes('$1') ? [HOUSE] : undefined); } catch (_) {}
  }
}

async function makeToken() {
  const u = (await query(
    `SELECT id, username, role FROM users WHERE is_active IS DISTINCT FROM false
      ORDER BY (role = 'admin') DESC, id LIMIT 1`
  )).rows[0];
  return jwt.sign({ sub: u.id, username: u.username, role: u.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

async function main() {
  await cleanup();

  // ── Fixture house ─────────────────────────────────────────────────────────
  await query(
    `INSERT INTO houses (paybill_number, house_name, total_units, occupancy_status)
     VALUES ($1, 'ZZ Collection House', 10, 'unknown')`,
    [HOUSE]
  );

  // ── Tenants: A + B join mid-period, C joined before, D exits mid-period ──
  const mk = (code, moveIn, rent, garbage, water, deposit) => store.createTenant({
    tenant_code: code, name: `ZZCOL Tenant ${code.slice(-2)}`, phone_number: '+254700000401',
    property_name: 'ZZ Collection House', house_id: HOUSE,
    rent_amount: rent, garbage_fee_amount: garbage, water_charge_amount: water, deposit_amount: deposit,
    move_in_date: moveIn, rent_due_date: '2026-10-05', status: 'Active',
  });
  await mk(A, '2026-10-01', 10000, 2000, 1000, 5000);
  await mk(B, '2026-10-15', 8000, 2000, 0, 3000);
  await mk(C, '2026-09-01', 7000, 0, 0, 0);
  await mk(D, '2026-09-05', 6000, 0, 0, 0);

  // Payment helper (approvals derive billing_period 2026-10 from rent_due)
  const pay = async (tenant, amount, ref) => {
    const p = await store.createPayment({
      tenant_id: tenant, amount, payment_type: 'rent', status: 'Pending',
      mpesa_reference: ref, client_txn_id: `zzcol-${ref}`, payment_mode: 'M-Pesa', source: 'manual',
    });
    if (p && p.error) throw new Error(`create failed for ${ref}: ${p.error}`);
    const a = await store.approvePayment(p.id);
    if (!a || a.error) throw new Error(`approve failed for ${ref}: ${a && a.error}`);
    return p.id;
  };

  // D's payment happens DURING D's tenancy — before the exit below.
  await pay(D, 1000, 'ZC4');

  // D exits mid-period with a finalized exit invoice (final rent + a deduction)
  const ei = await store.createExitInvoice(D, {
    move_out_date: '2026-10-20', reason: 'End of tenancy (test)',
    lines: [{ description: 'Test damage charge', amount: 600 }],
  });
  check(!!ei && !ei.error, 'fixture: D exit invoice drafted', ei && ei.error);
  await store.finalizeExitInvoice(ei.id, { move_out_date: '2026-10-20' }, 'test');
  const vacD = await store.vacateTenancy(D, {
    move_out_date: '2026-10-20', reason: 'End of tenancy (test)', exit_invoice_id: ei.id, archived_by: 'test',
  });
  check(!!vacD && !!vacD.archive, 'fixture: D archived/vacated', vacD && vacD.error);

  // ── Penalty + maintenance charged IN the period ──────────────────────────
  await store.createPenalty({ tenant_code: A, description: 'ZZCOL late fee', amount: 700, invoice_date: '2026-10-10' });
  const wo = (await query(
    `INSERT INTO work_orders (wo_number, property_name, house_paybill_number, status)
     VALUES ('ZZCOL-WO-1', 'ZZ Collection House', $1, 'Completed') RETURNING id`, [HOUSE]
  )).rows[0];
  await query(
    `INSERT INTO maintenance_charges (work_order_id, wo_number, issue_no, unit_code, tenant_code, tenant_name,
       problem, repair_description, material_cost, labour_cost, total_cost, charge_month, responsible_party)
     VALUES ($1, 'ZZCOL-WO-1', 1, $2, $2, 'ZZCOL Tenant A1', 'Test repair', 'Test repair work', 500, 400, 900, $3, 'Management')`,
    [wo.id, A, PERIOD]
  );

  // ── Payments (all become billing_period 2026-10 via rent_due 2026-10-05) ─
  await pay(A, 5000, 'ZC1');
  await pay(B, 3000, 'ZC2');
  await pay(C, 7000, 'ZC3');
  // Legacy row: NULL billing_period + payment_date inside the period -> counted
  await query(
    `INSERT INTO payments (tenant_code, amount, status, payment_date, source)
     VALUES ($1, 2000, 'Approved', '2026-10-12', 'manual')`, [C]
  );
  // Rows OUTSIDE the period -> must NOT count
  await query(
    `INSERT INTO payments (tenant_code, amount, status, payment_date, billing_period, source)
     VALUES ($1, 9999, 'Approved', '2026-10-20', '2026-09', 'manual'),
            ($1, 8888, 'Approved', '2026-10-20', '2026-11', 'manual')`, [C]
  );

  // ── 1. BASE FIGURES ──────────────────────────────────────────────────────
  const pos = await store.getHouseCollectionPosition(HOUSE, PERIOD);
  const eb = pos.expected_by;
  check(pos.period === PERIOD && pos.period_label === 'October 2026', 'P1. period + label', pos);
  check(eb.rent === 25000, `P2. rent expected 25,000 (A+B+C occupied; D excluded via exit) got ${eb.rent}`, eb);
  check(eb.deposits === 8000, `P3. new-tenant deposits 8,000 (A+B joined in period) got ${eb.deposits}`, eb);
  check(eb.water === 1000, `P4. flat water 1,000 (no metered invoices yet) got ${eb.water}`, eb);
  check(eb.garbage === 4000, `P5. garbage 4,000 got ${eb.garbage}`, eb);
  check(eb.penalties === 700, `P6. penalties raised in period 700 got ${eb.penalties}`, eb);
  check(eb.maintenance === 900, `P7. maintenance charged to period 900 got ${eb.maintenance}`, eb);
  check(eb.exit_charges === 6600, `P8. exit charges 6,600 (final rent 6,000 + line 600) got ${eb.exit_charges}`, eb);
  check(pos.expected === 46200, `P9. TOTAL EXPECTED 46,200 got ${pos.expected}`, pos);

  check(pos.collected === 18000, `Q1. TOTAL COLLECTED 18,000 (5k+3k+7k+1k+2k; Sep/Nov rows excluded) got ${pos.collected}`, pos);
  const typeSum = (pos.collected_by_type || []).reduce((s, x) => s + Number(x.amount), 0);
  check(typeSum === pos.collected, `Q2. collected breakdown sums to total (${typeSum} vs ${pos.collected})`, pos.collected_by_type);

  check(pos.remaining === 46200 - 18000, `R1. REMAINING = expected - collected (28,200) got ${pos.remaining}`, pos);
  check(pos.percent === Math.round((18000 / 46200) * 1000) / 10,
    `R2. COLLECTION % = collected/expected*100 (39) got ${pos.percent}`, pos);

  // ── 2. MID-PERIOD JOINER included (B joined 15 Oct: rent + deposit above)
  check(eb.rent >= 8000 && eb.deposits >= 3000, 'S1. mid-period joiner rent + deposit included');

  // ── 3. AUTO-UPDATE on charge/payment changes (live recompute) ────────────
  await store.createPenalty({ tenant_code: B, description: 'ZZCOL late fee 2', amount: 300, invoice_date: '2026-10-22' });
  const pos2 = await store.getHouseCollectionPosition(HOUSE, PERIOD);
  check(pos2.expected === 46500, `T1. new penalty raises expected to 46,500 got ${pos2.expected}`, pos2.expected_by);
  check(pos2.expected_by.penalties === 1000, `T1b. penalties now 1,000 got ${pos2.expected_by.penalties}`);

  const extra = await pay(A, 500, 'ZC5');
  const pos3 = await store.getHouseCollectionPosition(HOUSE, PERIOD);
  check(pos3.collected === 18500, `T2. new payment raises collected to 18,500 got ${pos3.collected}`);
  check(pos3.remaining === 46500 - 18500, `T2b. remaining updates to 28,000 got ${pos3.remaining}`);

  await query(
    `INSERT INTO water_invoices (wtr_number, tenant_code, tenant_name, property_name, house_paybill_number,
       unit_label, billing_month, previous_reading, current_reading, units_used, rate_per_unit, total_amount, status)
     VALUES ('ZZCOL-W1', $1, 'ZZCOL Tenant A1', 'ZZ Collection House', $2, $1, $3, 0, 15, 15, 100, 1500, 'Finalized')`,
    [A, HOUSE, PERIOD]
  );
  const pos4 = await store.getHouseCollectionPosition(HOUSE, PERIOD);
  check(pos4.expected_by.water === 1500,
    `T3. metered water invoice (1,500) replaces flat water got ${pos4.expected_by.water}`);
  check(pos4.expected === 46500 - 1000 + 1500, `T3b. expected recomputes to 47,000 got ${pos4.expected}`);

  await query(`DELETE FROM payments WHERE id = $1`, [extra]);
  const pos5 = await store.getHouseCollectionPosition(HOUSE, PERIOD);
  check(pos5.collected === 18000, `T4. deleted payment drops collected back to 18,000 got ${pos5.collected}`);

  // ── 4. ENDPOINT ──────────────────────────────────────────────────────────
  const token = await makeToken();
  const res = await fetch(`${BASE}/houses/${HOUSE}/collection?period=${PERIOD}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  check(res.status === 200 && json.collection && json.collection.expected === pos5.expected,
    `U1. endpoint returns the same live figures (HTTP ${res.status})`, json.collection && json.collection.expected);
  check(json.collection.house_name === 'ZZ Collection House', 'U2. endpoint carries house name');
  const noPeriod = await fetch(`${BASE}/houses/${HOUSE}/collection`, { headers: { Authorization: `Bearer ${token}` } });
  const np = await noPeriod.json();
  check(/^\d{4}-\d{2}$/.test(np.collection && np.collection.period || ''),
    'U3. missing period defaults to a valid current month', np.collection && np.collection.period);
  const missing = await fetch(`${BASE}/houses/nope-999/collection?period=${PERIOD}`, { headers: { Authorization: `Bearer ${token}` } });
  check(missing.status === 404, `U4. unknown house -> 404 (got ${missing.status})`);

  // ── 5. FRONTEND MARKERS ──────────────────────────────────────────────────
  const idx = await (await fetch('http://127.0.0.1:3003/')).text();
  check(idx.includes('house-collection-panel') && idx.includes('hc-expected') && idx.includes('house-collection-period'),
    'V1. House Dashboard collection panel + period selector served');
  const app = await (await fetch('http://127.0.0.1:3003/js/app.js?v=66')).text();
  check(app.includes('loadHouseCollection') && app.includes('houseCollection'),
    'V2. loadHouseCollection + api client served');
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n===============================\nRESULT: ${pass} passed, ${fail} failed`);
    if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
    process.exit(fail ? 1 : 0);
  })
  .catch(async (e) => {
    console.error(e);
    try { await cleanup(); } catch (_) {}
    process.exit(1);
  });
