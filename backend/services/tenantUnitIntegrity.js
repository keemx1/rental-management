'use strict';

/**
 * Tenant–Unit integrity audit + water-invoice validation (diagnostic only).
 *
 * The audit is READ-ONLY: it lists exceptions for management review and
 * NEVER modifies, deletes, reassigns or recreates any record.
 *
 * Water-invoice validation runs BEFORE generation: structural problems are
 * refused (with an explicit override for authorised management), identity
 * warnings are flagged on the response and audited.
 */

const { query } = require('../config/database');

// ── System-wide audit (exception list) ────────────────────────────────────
async function unitIntegrityAudit() {
  const exceptions = [];
  const add = (e) => exceptions.push(e);

  // Houses + their unit accounting
  const houses = (await query(`SELECT paybill_number, house_name, total_units FROM houses ORDER BY house_name`)).rows;
  const tenantsByHouse = {};
  const allTenants = (await query(
    `SELECT tenant_code, name, phone_number, status, house_paybill_number, unit_label, move_in_date::text AS move_in_date
       FROM tenants ORDER BY house_paybill_number, tenant_code`
  )).rows;
  for (const t of allTenants) {
    const hp = t.house_paybill_number || '(no property)';
    (tenantsByHouse[hp] = tenantsByHouse[hp] || []).push(t);
  }

  for (const h of houses) {
    const rows = tenantsByHouse[h.paybill_number] || [];
    const occupied = rows.filter((r) => String(r.status || '').trim() !== 'Vacant' && String(r.status || '').trim() !== '');
    const named = occupied.filter((r) => String(r.name || '').trim() !== '');

    // 1. Occupied rows without tenant identity (name blanked)
    for (const t of occupied.filter((r) => String(r.name || '').trim() === '')) {
      add({
        severity: 'error', type: 'occupied_without_identity',
        property: h.house_name, unit: t.tenant_code, occupancy: t.status || 'Occupied',
        tenant_name: null, tenancy_status: t.status,
        reason: `Unit is marked ${t.status} but the tenant record has no name — the unit looks occupied yet no tenant can be retrieved.`,
      });
    }

    // 2. Property expects more units than tenant records exist
    const expected = Number(h.total_units || 0);
    if (expected > rows.length) {
      add({
        severity: 'warning', type: 'missing_unit_records',
        property: h.house_name, unit: `(${rows.length} of ${expected} unit records exist)`, occupancy: '—',
        tenant_name: null, tenancy_status: null,
        reason: `Property has ${expected} units configured but only ${rows.length} unit/tenant records — ${expected - rows.length} unit(s) have NO record at all (cannot be invoiced or tracked).`,
      });
    }

    // 3. Dangling property reference (tenant points to a non-existent house)
  }
  for (const t of allTenants) {
    if (t.house_paybill_number && !houses.some((h) => h.paybill_number === t.house_paybill_number)) {
      add({
        severity: 'error', type: 'dangling_property',
        property: t.house_paybill_number || '(none)', unit: t.tenant_code, occupancy: t.status,
        tenant_name: t.name || null, tenancy_status: t.status,
        reason: `Tenant/unit references property ${t.house_paybill_number} which does not exist in Houses.`,
      });
    }
  }

  // 4. Duplicate unit labels inside one property (ambiguous matching)
  for (const h of houses) {
    const labels = {};
    for (const t of (tenantsByHouse[h.paybill_number] || [])) {
      const key = String(t.unit_label || '').trim().toUpperCase();
      if (!key) continue;
      (labels[key] = labels[key] || []).push(t.tenant_code);
    }
    for (const [label, codes] of Object.entries(labels)) {
      if (codes.length > 1) {
        add({
          severity: 'warning', type: 'duplicate_unit_label',
          property: h.house_name, unit: label, occupancy: 'ambiguous',
          tenant_name: null, tenancy_status: null,
          reason: `Unit label "${label}" is used by ${codes.length} records (${codes.join(', ')}) — tenant lookups by unit are ambiguous.`,
        });
      }
    }
  }

  // 5. Vacant rows still carrying live financial activity
  const vacantActive = (await query(
    `SELECT t.tenant_code, t.name, t.status, t.house_paybill_number, h.house_name,
            COUNT(p.id)::int AS payments, COALESCE(SUM(p.amount),0)::float8 AS total
       FROM tenants t
       LEFT JOIN houses h ON h.paybill_number = t.house_paybill_number
       LEFT JOIN payments p ON p.tenant_code = t.tenant_code AND p.status = 'Approved' AND p.tenancy_id IS NULL
      WHERE COALESCE(t.status,'') = 'Vacant'
      GROUP BY t.tenant_code, t.name, t.status, t.house_paybill_number, h.house_name
     HAVING COUNT(p.id) > 0`
  )).rows;
  for (const v of vacantActive) {
    add({
      severity: 'warning', type: 'vacant_with_live_payments',
      property: v.house_name || v.house_paybill_number || '(none)', unit: v.tenant_code, occupancy: 'Vacant',
      tenant_name: v.name || null, tenancy_status: 'Vacant',
      reason: `Unit is Vacant but still has ${v.payments} unsealed approved payment(s) totalling KES ${Number(v.total).toLocaleString()} — financials may be stranded on a vacant unit.`,
    });
  }

  // 6. Orphan financial records: money referencing tenants that do not exist
  const orphans = (await query(
    `SELECT p.tenant_code, COUNT(*)::int AS n, COALESCE(SUM(p.amount),0)::float8 AS total,
            MAX(p.payment_date)::text AS last_date
       FROM payments p
      WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.tenant_code = p.tenant_code)
      GROUP BY p.tenant_code LIMIT 50`
  )).rows;
  for (const o of orphans) {
    add({
      severity: 'error', type: 'orphan_payments',
      property: '(unknown — tenant record missing)', unit: o.tenant_code, occupancy: '—',
      tenant_name: null, tenancy_status: 'MISSING',
      reason: `${o.n} approved payment(s) totalling KES ${Number(o.total).toLocaleString()} reference tenant/unit "${o.tenant_code}" which has NO tenant record (last payment ${o.last_date || '—'}).`,
    });
  }

  // 7. Water invoices pointing at missing/vacant tenants (the BH18 pattern)
  const wtrIssues = (await query(
    `SELECT w.id, w.wtr_number, w.tenant_code, w.unit_label, w.billing_month, w.status,
            t.name AS tenant_name, t.status AS tenant_status,
            h.house_name
       FROM water_invoices w
       LEFT JOIN tenants t ON t.tenant_code = w.tenant_code
       LEFT JOIN houses h ON h.paybill_number = COALESCE(t.house_paybill_number, w.house_paybill_number)
      WHERE w.status <> 'Void'
        AND (t.tenant_code IS NULL OR COALESCE(t.status,'') = 'Vacant' OR COALESCE(t.name,'') = '')
      ORDER BY w.billing_month DESC LIMIT 100`
  )).rows;
  for (const w of wtrIssues) {
    add({
      severity: w.tenant_status ? 'warning' : 'error',
      type: w.tenant_code && !w.tenant_name ? 'invoice_tenant_missing' : 'invoice_tenant_vacant_or_anonymous',
      property: w.house_name || '(unknown)', unit: w.unit_label || w.tenant_code, occupancy: w.tenant_status || 'No record',
      tenant_name: w.tenant_name || null, tenancy_status: w.tenant_status || 'MISSING',
      reason: w.tenant_status
        ? `Water invoice ${w.wtr_number} (${w.billing_month}) targets a ${w.tenant_status} unit with ${w.tenant_name ? 'blank/anonymous identity issues' : 'no retrievable tenant name'}.`
        : `Water invoice ${w.wtr_number} (${w.billing_month}) references tenant "${w.tenant_code}" which has NO tenant record.`,
    });
  }

  // 8. Active tenants with NO phone (cannot receive bills/confirmations)
  const noPhone = (await query(
    `SELECT t.tenant_code, t.name, t.status, t.house_paybill_number, h.house_name
       FROM tenants t LEFT JOIN houses h ON h.paybill_number = t.house_paybill_number
      WHERE COALESCE(t.status,'') NOT IN ('Vacant','') AND COALESCE(t.phone_number,'') = ''
      LIMIT 100`
  )).rows;
  for (const n of noPhone) {
    add({
      severity: 'warning', type: 'missing_phone',
      property: n.house_name || n.house_paybill_number || '(none)', unit: n.tenant_code, occupancy: n.status,
      tenant_name: n.name || null, tenancy_status: n.status,
      reason: 'Occupied unit has no phone number — billing/confirmations cannot be delivered.',
    });
  }

  // 9. Reserved units colliding with occupied tenants (double-booking)
  const collisions = (await query(
    `SELECT f.unit_label, f.tenant_name, f.house_paybill, h.house_name, t.tenant_code AS occupied_by
       FROM future_tenancies f
       JOIN houses h ON h.paybill_number = f.house_paybill
       LEFT JOIN tenants t ON t.house_paybill_number = f.house_paybill
         AND (UPPER(COALESCE(t.unit_label,'')) = UPPER(f.unit_label) OR UPPER(t.tenant_code) = UPPER(f.unit_label))
         AND COALESCE(t.status,'') NOT IN ('Vacant','')
      WHERE f.status = 'RESERVED' AND t.tenant_code IS NOT NULL`
  )).rows;
  for (const c of collisions) {
    add({
      severity: 'error', type: 'reserved_vs_occupied',
      property: c.house_name, unit: c.unit_label, occupancy: 'RESERVED + occupied',
      tenant_name: c.occupied_by, tenancy_status: 'RESERVED vs Active',
      reason: `Unit ${c.unit_label} is RESERVED ("${c.tenant_name}") yet already occupied by tenant ${c.occupied_by} — activation conflict.`,
    });
  }

  // 10. The BH18 class: occupied tenants that unit-based lookups cannot
  // retrieve (status filters, identity issues). Every occupied tenant with a
  // name MUST be findable by its unit/code for its own property.
  const { findTenantByPropertyAndUnit } = require('../storage/store');
  for (const t of allTenants) {
    const status = String(t.status || '').trim();
    if (status === '' || status === 'Vacant') continue;
    if (!String(t.name || '').trim()) continue; // already reported as occupied_without_identity
    if (!t.house_paybill_number || !houses.some((h) => h.paybill_number === t.house_paybill_number)) continue; // dangling already reported
    try {
      const found = await findTenantByPropertyAndUnit(t.house_paybill_number, t.tenant_code);
      if (!found || found.tenant_code !== t.tenant_code) {
        add({
          severity: 'error', type: 'lookup_failed',
          property: (houses.find((h) => h.paybill_number === t.house_paybill_number) || {}).house_name || t.house_paybill_number,
          unit: t.tenant_code, occupancy: status,
          tenant_name: t.name, tenancy_status: status,
          reason: `Occupied tenant ${t.tenant_code} (${t.name}) cannot be retrieved by the unit lookup used for billing — invoice generation would fail for this unit.`,
        });
      }
    } catch (_) {
      add({
        severity: 'error', type: 'lookup_failed',
        property: t.house_paybill_number, unit: t.tenant_code, occupancy: status,
        tenant_name: t.name, tenancy_status: status,
        reason: `Unit lookup threw an error for ${t.tenant_code}.`,
      });
    }
  }

  const summary = {
    properties_checked: houses.length,
    tenants_checked: allTenants.length,
    exceptions: exceptions.length,
    errors: exceptions.filter((e) => e.severity === 'error').length,
    warnings: exceptions.filter((e) => e.severity === 'warning').length,
    by_type: exceptions.reduce((m, e) => { m[e.type] = (m[e.type] || 0) + 1; return m; }, {}),
  };
  return { generated_at: new Date().toISOString(), read_only: true, summary, exceptions };
}

// ── Water-invoice pre-generation validation ───────────────────────────────
/**
 * Structural problems -> { level: 'error', code, message } (override with
 * body.override === true, audited). Identity/occupancy issues -> warnings.
 */
async function validateTenantForBilling(tenantCode, { unit_label, house_paybill } = {}) {
  const warnings = [];
  const tenant = (await query(
    `SELECT * FROM tenants WHERE tenant_code = $1`, [tenantCode]
  )).rows[0];
  if (!tenant) {
    return {
      ok: false, error: {
        level: 'error', code: 'TENANT_MISSING',
        message: `No tenant record exists for "${tenantCode}" — the unit cannot be billed until management creates/corrects the tenant record.`,
      },
      warnings,
    };
  }
  if (house_paybill && tenant.house_paybill_number && tenant.house_paybill_number !== house_paybill) {
    return {
      ok: false, error: {
        level: 'error', code: 'PROPERTY_MISMATCH',
        message: `Tenant ${tenantCode} belongs to property ${tenant.house_paybill_number}, not ${house_paybill}.`,
      },
      warnings,
    };
  }
  const tUnit = String(tenant.unit_label || tenant.tenant_code || '').toUpperCase();
  const invUnit = String(unit_label || '').toUpperCase();
  if (invUnit && tUnit && invUnit !== tUnit && invUnit !== String(tenant.tenant_code || '').toUpperCase()) {
    return {
      ok: false, error: {
        level: 'error', code: 'UNIT_MISMATCH',
        message: `Unit "${unit_label}" does not match tenant ${tenantCode} (unit ${tUnit}).`,
      },
      warnings,
    };
  }
  const status = String(tenant.status || '').trim();
  if (status === 'Vacant') {
    warnings.push({
      level: 'warning', code: 'UNIT_VACANT',
      message: `Unit ${tenant.tenant_code} is Vacant — billing a unit with no active tenant. Confirm this is intended.`,
    });
  }
  if (!String(tenant.name || '').trim()) {
    warnings.push({
      level: 'warning', code: 'TENANT_ANONYMOUS',
      message: `Tenant ${tenant.tenant_code} has NO name on file — the invoice will carry an incomplete identity.`,
    });
  }
  return { ok: true, tenant, warnings };
}

module.exports = { unitIntegrityAudit, validateTenantForBilling };
