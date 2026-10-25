const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const store = require('../backend/storage/store');
const { query } = require('../backend/config/database');

let failures = 0;
const assert = (label, actual, expected) => {
  const a = typeof actual === 'number' ? Math.round(actual * 100) / 100 : actual;
  const e = typeof expected === 'number' ? Math.round(expected * 100) / 100 : expected;
  const ok = String(a) === String(e);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${a}, expected ${e}`);
};

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';

  const m = await store.getDashboardMetrics();
  console.log('METRICS:', JSON.stringify(m, null, 2));

  // ---- independent raw SQL (deliberately written differently) ----
  const rawCounts = (await query(`
    SELECT
      (SELECT COUNT(*) FROM tenants WHERE status <> 'Vacant')::int AS total,
      (SELECT COUNT(*) FROM tenants WHERE status = 'Vacant')::int AS vacant,
      (SELECT COUNT(*) FROM tenants WHERE status <> 'Vacant'
        AND (arrears > 0 OR (rent_paid_this_month < rent_amount AND rent_due_date < $1::date)))::int AS overdue,
      (SELECT COUNT(*) FROM tenants WHERE status <> 'Vacant'
        AND rent_due_date >= $1::date AND rent_due_date <= $2::date
        AND rent_paid_this_month < rent_amount)::int AS due7,
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'Approved' AND payment_date >= $3::date)::numeric AS revenue,
      (SELECT COUNT(*) FROM payments WHERE status = 'Pending')::int AS pending_count,
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'Pending')::numeric AS pending_amount
  `, [today, (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })(), monthStart])).rows[0];

  const rawFinancials = (await query(`
    SELECT
      COALESCE((SELECT SUM(t2.arrears) FROM tenants t2 WHERE t2.status <> 'Vacant'), 0)::numeric AS arrears_bf,
      COALESCE((SELECT SUM(GREATEST(0, t2.rent_amount - t2.rent_paid_this_month)) FROM tenants t2 WHERE t2.status <> 'Vacant'), 0)::numeric AS unpaid_rent,
      COALESCE((SELECT SUM(pen.amount) FROM penalties pen JOIN tenants t3 ON t3.tenant_code = pen.tenant_code WHERE pen.status = 'Pending' AND t3.status <> 'Vacant'), 0)::numeric AS penalties,
      COALESCE((SELECT SUM(GREATEST(0, t2.garbage_fee_amount - t2.garbage_fee_paid)) FROM tenants t2 WHERE t2.status <> 'Vacant'), 0)::numeric AS garbage,
      COALESCE((SELECT SUM(GREATEST(0, t2.water_charge_amount - t2.water_charge_paid)) FROM tenants t2 WHERE t2.status <> 'Vacant'), 0)::numeric AS water,
      COALESCE((SELECT SUM(t2.rent_amount) FROM tenants t2 WHERE t2.status <> 'Vacant'), 0)::numeric AS expected,
      COALESCE((SELECT SUM(LEAST(t2.rent_amount, t2.rent_paid_this_month)) FROM tenants t2 WHERE t2.status <> 'Vacant'), 0)::numeric AS collected
  `)).rows[0];

  // ---- metrics vs raw ----
  assert('total_tenants', m.tenants.total_tenants, rawCounts.total);
  assert('vacant_units', m.tenants.vacant_units, rawCounts.vacant);
  assert('overdue count', m.tenants.overdue_tenants, rawCounts.overdue);
  assert('due7 count', m.tenants.due_7d, rawCounts.due7);
  assert('revenue_mtd', m.revenue.revenue_mtd, Number(rawCounts.revenue));
  assert('pending_count', m.revenue.pending_count, rawCounts.pending_count);
  assert('pending_amount', m.revenue.pending_amount, Number(rawCounts.pending_amount));
  assert('arrears_bf', m.revenue.arrears_breakdown.arrears_bf, Number(rawFinancials.arrears_bf));
  assert('unpaid_rent', m.revenue.arrears_breakdown.unpaid_rent, Number(rawFinancials.unpaid_rent));
  assert('penalties', m.revenue.arrears_breakdown.penalties, Number(rawFinancials.penalties));
  assert('garbage', m.revenue.arrears_breakdown.garbage, Number(rawFinancials.garbage));
  assert('water', m.revenue.arrears_breakdown.water, Number(rawFinancials.water));
  const expectedTotal = Number(rawFinancials.arrears_bf) + Number(rawFinancials.unpaid_rent) + Number(rawFinancials.penalties) + Number(rawFinancials.garbage) + Number(rawFinancials.water);
  assert('total_arrears = components', m.revenue.total_arrears, expectedTotal);
  assert('progress expected', m.collection.expected, Number(rawFinancials.expected));
  assert('progress collected', m.collection.collected, Number(rawFinancials.collected));
  assert('progress outstanding', m.collection.outstanding, Number(rawFinancials.expected) - Number(rawFinancials.collected));
  assert('progress invariant collected+outstanding=expected', m.collection.collected + m.collection.outstanding, m.collection.expected);
  const pct = Number(rawFinancials.expected) > 0 ? Math.round((Number(rawFinancials.collected) / Number(rawFinancials.expected)) * 1000) / 10 : 0;
  assert('progress percent', m.collection.percent, pct);

  // ---- drilldowns vs metrics (card must equal its list) ----
  const kinds = ['vacant', 'overdue', 'due7', 'pending', 'arrears', 'revenue', 'progress'];
  const d = {};
  for (const k of kinds) d[k] = await store.getDashboardDrilldown(k);

  assert('vacant: card == rows', m.tenants.vacant_units, d.vacant.rows.length);
  assert('overdue: card == rows', m.tenants.overdue_tenants, d.overdue.rows.length);
  assert('due7: card == rows', m.tenants.due_7d, d.due7.rows.length);
  assert('pending: card == rows', m.revenue.pending_count, d.pending.rows.length);
  assert('pending: amount sums', m.revenue.pending_amount, d.pending.totals.pending_amount);
  assert('revenue: card == row sum', m.revenue.revenue_mtd, d.revenue.totals.total);
  assert('arrears: card == row sum', m.revenue.total_arrears, d.arrears.totals.outstanding);
  assert('arrears: breakdown sums', m.revenue.total_arrears,
    d.arrears.totals.arrears_bf + d.arrears.totals.unpaid_rent + d.arrears.totals.penalties + d.arrears.totals.garbage + d.arrears.totals.water);
  assert('progress: card expected == row sum', m.collection.expected, d.progress.totals.expected);
  assert('progress: card collected == row sum', m.collection.collected, d.progress.totals.collected);
  assert('progress: card outstanding == row sum', m.collection.outstanding, d.progress.totals.outstanding);
  assert('progress: card percent == row percent', m.collection.percent, d.progress.totals.percent);

  // ---- sample rows against tenant profile balance (SS7 = William) ----
  const williamArrears = d.arrears.rows.find((r) => r.tenant_code === 'SS7');
  if (williamArrears) {
    const p = (await query(`
      SELECT t.arrears,
        GREATEST(0, t.rent_amount - t.rent_paid_this_month) AS unpaid,
        (SELECT COALESCE(SUM(amount),0) FROM penalties WHERE tenant_code = t.tenant_code AND status = 'Pending') AS pen,
        GREATEST(0, t.garbage_fee_amount - t.garbage_fee_paid) AS garbage,
        GREATEST(0, t.water_charge_amount - t.water_charge_paid) AS water
      FROM tenants t WHERE t.tenant_code = 'SS7'`)).rows[0];
    const bal = Number(p.arrears) + Number(p.unpaid) + Number(p.pen) + Number(p.garbage) + Number(p.water);
    assert('SS7 drilldown balance == profile formula', williamArrears.outstanding_balance, bal);
  } else {
    console.log('SKIP  SS7 not in arrears drilldown (fully settled)');
  }

  // ---- overdue period derivation spot-check ----
  const od = d.overdue.rows[0];
  if (od) {
    console.log(`INFO  overdue sample: ${od.tenant_code} since ${od.overdue_since} (${od.overdue_days} days), due ${od.rent_due_date}, outstanding ${od.outstanding_balance}`);
    const anchorOk = od.overdue_since && od.overdue_since <= today;
    if (!anchorOk) failures++;
    console.log(`${anchorOk ? 'PASS' : 'FAIL'}  overdue anchor <= today`);
  }

  // ---- vacant rows all actually vacant ----
  const badVacant = d.vacant.rows.filter((r) => !r.unit_display);
  assert('vacant rows all have a unit display', badVacant.length, 0);

  // ---- revenue drilldown has no approved-outside-month rows ----
  const outside = d.revenue.rows.filter((r) => String(r.payment_date).slice(0, 10) < monthStart);
  assert('revenue rows all within month', outside.length, 0);

  // ---- due7 rows all unpaid & within window ----
  const badDue7 = d.due7.rows.filter((r) => Number(r.amount_due) <= 0 || r.rent_due_date < today);
  assert('due7 rows unpaid & in window', badDue7.length, 0);

  // ---- every overdue row really satisfies the predicate ----
  const badOd = d.overdue.rows.filter((r) => !(Number(r.arrears_bf) > 0 || (Number(r.rent_paid_this_month) < Number(r.rent_amount) && String(r.rent_due_date).slice(0, 10) < today)));
  assert('overdue rows satisfy predicate', badOd.length, 0);

  console.log(`\n${failures === 0 ? 'ALL ASSERTIONS PASSED' : failures + ' ASSERTION(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
