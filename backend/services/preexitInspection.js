'use strict';

/**
 * Pre-Exit Inspection Inventory — records inspection findings per TENANCY
 * before the Exit Invoice, tracks agreement, and transfers agreed items into
 * the existing Exit Invoice exactly once.
 *
 * Invariants:
 *  - the Exit Invoice itself is NEVER modified here except through
 *    store.updateExitInvoice (its own existing calculation/process)
 *  - transferred items are locked: they can no longer be edited or deleted
 *  - duplicate transfers are blocked by conditional claims, a per-inspection
 *    in-process lock, a DB trigger, and a unique transfer_ref
 *  - inventories are tenancy-scoped: sealed to the tenancy archive at vacate
 */

const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { generatePdfToFile, renderTemplate, DOCUMENTS_DIR } = require('./documentStore');

const DISCLAIMER = "This document records items identified during pre-exit inspection for review. It is not a final Exit Invoice, does not confirm final deposit deductions, and does not determine the tenant's deposit refund. Any agreed items may subsequently be transferred to the existing Exit Invoice for final processing.";

// Serialises saves/transfers per inspection (single-process server).
const _locks = new Map();
function withInspectionLock(id, fn) {
  const prev = _locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  _locks.set(id, next.catch(() => {}));
  return next;
}

function itemTotal(quantity, costPerQty) {
  return Math.round((Number(quantity) || 0) * (Number(costPerQty) || 0) * 100) / 100;
}

// pg returns DATE columns as JS Dates (local midnight) — normalise to YYYY-MM-DD.
function fmtDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const s = v.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : v;
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inspectionSubtotal(items) {
  return items.reduce((s, it) => s + Number(it.total || 0), 0);
}

// ── Lookup ───────────────────────────────────────────────────────────────────
// Unit number -> current tenant + every historical tenancy + existing
// inventories, so management always picks the RIGHT tenancy (a re-let unit
// must never silently attach a new inventory to the previous tenant).
async function lookupUnit(unit) {
  const code = String(unit || '').trim();
  if (!code) return { error: 'unit is required' };
  const live = await store.getTenant(code);
  const archived = (await require('../config/database').query(
    `SELECT id, tenant_name, move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
            property_name, archived_at
       FROM tenancy_archive WHERE tenant_code = $1
      ORDER BY archived_at DESC`,
    [code]
  )).rows;
  const inventories = await listInspections(code);
  const occupied = !!(live && String(live.status || '').trim() !== 'Vacant' && String(live.name || '').trim() !== '');
  return {
    unit: code,
    live_tenant: live ? {
      tenant_code: live.tenant_code,
      name: live.name,
      status: live.status,
      property_name: live.property_name,
      move_in_date: fmtDate(live.move_in_date),
      phone_number: live.phone_number,
      occupied,
    } : null,
    archived_tenancies: archived,
    inventories,
    requires_tenancy_choice: !occupied && archived.length > 0,
  };
}

async function listInspections(unit) {
  const rows = await require('../config/database').query(
    `SELECT i.id, i.tenant_code, i.tenancy_id, i.tenant_name, i.property_name, i.unit_label,
            i.inspection_date::text AS inspection_date, i.status, i.shared_at, i.edited_after_share,
            i.document_id, i.created_at,
            (SELECT COUNT(*)::int FROM preexit_inspection_items it WHERE it.inspection_id = i.id) AS item_count,
            (SELECT COUNT(*)::int FROM preexit_inspection_items it WHERE it.inspection_id = i.id AND it.agreed) AS agreed_count,
            (SELECT COUNT(*)::int FROM preexit_inspection_items it WHERE it.inspection_id = i.id AND it.transfer_status = 'Transferred') AS transferred_count,
            COALESCE((SELECT SUM(it.total) FROM preexit_inspection_items it WHERE it.inspection_id = i.id), 0)::float8 AS total_estimated,
            (SELECT t.tenant_name FROM tenancy_archive t WHERE t.id = i.tenancy_id) AS tenancy_name
       FROM preexit_inspections i
      WHERE i.tenant_code = $1
      ORDER BY i.inspection_date DESC, i.id DESC`,
    [unit]
  );
  return rows.rows;
}

async function getInspection(id) {
  const db = require('../config/database');
  const insp = (await db.query(`SELECT * FROM preexit_inspections WHERE id = $1`, [id])).rows[0];
  if (!insp) return null;
  const items = (await db.query(
    `SELECT * FROM preexit_inspection_items WHERE inspection_id = $1 ORDER BY id`, [id]
  )).rows;

  // Tenant/tenancy context: live tenant for the unit, plus the archived
  // tenancy this inventory belongs to (when sealed or explicitly chosen).
  const live = await store.getTenant(insp.tenant_code);
  let tenancy = null;
  if (insp.tenancy_id) {
    tenancy = (await db.query(
      `SELECT id, tenant_name, move_in_date::text AS move_in_date, move_out_date::text AS move_out_date,
              property_name, unit_label, exit_invoice_number, exit_reason, rent_amount, deposit_paid
         FROM tenancy_archive WHERE id = $1`, [insp.tenancy_id]
    )).rows[0] || null;
  }

  // The receiving Exit Invoice (prefer a draft; never touch a finalized one).
  const exitInvoices = await store.listExitInvoices(insp.tenant_code);
  const draftExit = exitInvoices.find((e) => e.status === 'Draft') || null;
  const anyExit = exitInvoices[0] || null;

  return {
    ...insp,
    inspection_date: fmtDate(insp.inspection_date),
    items: items.map((it) => ({ ...it, quantity: Number(it.quantity), cost_per_qty: Number(it.cost_per_qty), total: Number(it.total) })),
    total_estimated: inspectionSubtotal(items),
    live_tenant: live ? {
      tenant_code: live.tenant_code, name: live.name, status: live.status,
      property_name: live.property_name, phone_number: live.phone_number,
      move_in_date: fmtDate(live.move_in_date),
    } : null,
    tenancy,
    exit_invoice: draftExit || anyExit ? {
      id: (draftExit || anyExit).id,
      exit_number: (draftExit || anyExit).exit_number,
      status: (draftExit || anyExit).status,
      is_draft: !!draftExit,
    } : null,
  };
}

// ── Create ───────────────────────────────────────────────────────────────────
async function createInspection({ unit, inspection_date, tenancy_id, actor }) {
  const code = String(unit || '').trim();
  if (!code) return { error: 'Unit number is required', code: 'VALIDATION' };
  if (!inspection_date) return { error: 'Inspection date is required', code: 'VALIDATION' };

  const live = await store.getTenant(code);
  if (!live) return { error: `Unit "${code}" does not exist`, code: 'NOT_FOUND' };

  let tenantName;
  let chosenTenancyId = null;
  let propertyName = live.property_name || null;
  let paybill = live.house_paybill_number || live.house_id || null;

  const occupied = String(live.status || '').trim() !== 'Vacant' && String(live.name || '').trim() !== '';
  if (tenancy_id) {
    // Explicit historical tenancy selection (re-let unit / archived record).
    const arch = (await require('../config/database').query(
      `SELECT id, tenant_name, property_name, house_paybill_number FROM tenancy_archive WHERE id = $1 AND tenant_code = $2`,
      [Number(tenancy_id), code]
    )).rows[0];
    if (!arch) return { error: 'Selected tenancy record not found for this unit', code: 'NOT_FOUND' };
    chosenTenancyId = arch.id;
    tenantName = arch.tenant_name;
    propertyName = arch.property_name || propertyName;
    paybill = arch.house_paybill_number || paybill;
  } else {
    if (!occupied) {
      return {
        error: 'This unit has no current tenant — select the correct historical tenancy from the list before creating the inventory.',
        code: 'TENANCY_REQUIRED',
      };
    }
    tenantName = live.name;
  }

  const db = require('../config/database');
  const res = await db.query(
    `INSERT INTO preexit_inspections
       (tenant_code, tenancy_id, house_paybill_number, property_name, unit_label, tenant_name,
        inspection_date, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Draft', $8)
     RETURNING id`,
    [code, chosenTenancyId, paybill, propertyName, code, tenantName, inspection_date, actor || null]
  );
  return getInspection(res.rows[0].id);
}

// ── Save (add / edit / delete items in one batch, server-authoritative) ─────
async function saveInspection(id, { inspection_date, items }) {
  return withInspectionLock(Number(id), async () => {
    const current = await getInspection(id);
    if (!current) return { error: 'Inventory not found', code: 'NOT_FOUND' };
    if (!Array.isArray(items)) return { error: 'items array is required', code: 'VALIDATION' };

    const db = require('../config/database');
    const preserved = [];
    const keptIds = new Set();

    for (const incoming of items) {
      const description = String(incoming.description || '').trim();
      if (!description) return { error: 'Every item needs a description', code: 'VALIDATION' };
      const quantity = Number(incoming.quantity);
      const cost = Number(incoming.cost_per_qty);
      if (!(quantity > 0)) return { error: `Quantity must be greater than 0 ("${description}")`, code: 'VALIDATION' };
      if (!(cost >= 0)) return { error: `Cost per quantity cannot be negative ("${description}")`, code: 'VALIDATION' };
      const total = itemTotal(quantity, cost);
      const agreed = !!incoming.agreed;

      if (incoming.id) {
        const existing = current.items.find((it) => it.id === Number(incoming.id));
        if (!existing) return { error: 'An item no longer exists — reload and try again', code: 'STALE' };
        keptIds.add(existing.id);
        if (existing.transfer_status === 'Transferred') {
          // Locked: transferred items can never be edited or deleted here.
          // Corrections happen on the Exit Invoice itself (audited there).
          preserved.push(existing.id);
          continue;
        }
        await db.query(
          `UPDATE preexit_inspection_items
              SET description = $1, quantity = $2, cost_per_qty = $3, total = $4,
                  remarks = $5, agreed = $6, updated_at = NOW()
            WHERE id = $7 AND transfer_status = 'Not Transferred'`,
          [description, quantity, cost, total, incoming.remarks || null, agreed, existing.id]
        );
      } else {
        const ins = await db.query(
          `INSERT INTO preexit_inspection_items (inspection_id, description, quantity, cost_per_qty, total, remarks, agreed)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [Number(id), description, quantity, cost, total, incoming.remarks || null, agreed]
        );
        keptIds.add(ins.rows[0].id);
      }
    }

    // Items omitted from the payload are deleted (transferred ones are kept
    // no matter what — they are linked to the Exit Invoice).
    const deletable = current.items.filter((it) => !keptIds.has(it.id) && it.transfer_status !== 'Transferred');
    const lockedMissing = current.items.filter((it) => !keptIds.has(it.id) && it.transfer_status === 'Transferred');
    preserved.push(...lockedMissing.map((it) => it.id));
    if (deletable.length) {
      await db.query(
        `DELETE FROM preexit_inspection_items WHERE id = ANY($1::int[]) AND transfer_status = 'Not Transferred'`,
        [deletable.map((it) => it.id)]
      );
    }

    // Inspection header update + "changed since shared" flag.
    const newDate = inspection_date ? String(inspection_date).slice(0, 10) : current.inspection_date;
    const itemsChanged = deletable.length > 0 || keptIds.size !== current.items.length
      || (items || []).some((i) => i.id && current.items.some((e) => e.id === Number(i.id)));
    const editedAfterShare = current.shared_at != null && (
      (itemsChanged && JSON.stringify((items || []).map((i) => [i.id, i.description, i.quantity, i.cost_per_qty, i.remarks, i.agreed]))
        !== JSON.stringify(current.items.map((i) => [i.id, i.description, i.quantity, i.cost_per_qty, i.remarks, i.agreed])))
      || newDate !== current.inspection_date
    );
    if (newDate !== current.inspection_date || editedAfterShare) {
      await db.query(
        `UPDATE preexit_inspections
            SET inspection_date = $1,
                edited_after_share = CASE WHEN $2 THEN TRUE ELSE edited_after_share END,
                updated_at = NOW()
          WHERE id = $3`,
        [newDate, editedAfterShare, Number(id)]
      );
    }

    const fresh = await getInspection(id);
    return { inspection: fresh, preserved_transferred: preserved, deleted: deletable.map((d) => d.id) };
  });
}

// ── Status ───────────────────────────────────────────────────────────────────
async function setStatus(id, status) {
  const allowed = ['Draft', 'Shared', 'Agreed'];
  if (!allowed.includes(status)) return { error: 'Invalid status', code: 'VALIDATION' };
  const current = await getInspection(id);
  if (!current) return { error: 'Inventory not found', code: 'NOT_FOUND' };
  if (status === 'Shared' && current.shared_at == null) {
    return { error: 'Use Share with Tenant to mark the inventory as Shared', code: 'VALIDATION' };
  }
  await require('../config/database').query(
    `UPDATE preexit_inspections SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, Number(id)]
  );
  return getInspection(id);
}

// ── Share with Tenant (PDF + WhatsApp, existing document pipeline) ──────────
async function shareInspection(id, { actor } = {}) {
  const current = await getInspection(id);
  if (!current) return { error: 'Inventory not found', code: 'NOT_FOUND' };
  if (!current.items.length) return { error: 'Add at least one inspection item before sharing', code: 'VALIDATION' };
  const tenant = await store.getTenant(current.tenant_code);
  if (!tenant || !tenant.phone_number) {
    return { error: 'No tenant phone number available for this unit', code: 'VALIDATION' };
  }

  const rowsHtml = current.items.map((it) => `
    <tr>
      <td>${esc(String(it.description))}</td>
      <td class="num">${Number(it.quantity)}</td>
      <td class="num">${kES(it.cost_per_qty)}</td>
      <td class="num">${kES(it.total)}</td>
      <td class="notes">${esc(String(it.remarks || '—'))}</td>
    </tr>`).join('');

  const html = renderTemplate('preexit_inspection.html', {
    tenant_name: current.tenant_name,
    property_name: current.property_name || '—',
    unit: current.unit_label || current.tenant_code,
    inspection_date: current.inspection_date,
    tenancy_label: current.tenancy
      ? `Tenancy: ${current.tenancy.tenant_name} (${current.tenancy.move_in_date || '?'} → ${current.tenancy.move_out_date || 'closed'})`
      : 'Tenancy: current occupancy',
    status: current.status,
    rows_html: rowsHtml,
    item_count: current.items.length,
    total_estimated: kES(current.total_estimated),
    generated_at: new Date().toLocaleString(),
  });

  const safeUnit = String(current.unit_label || current.tenant_code).replace(/[^A-Za-z0-9_-]+/g, '');
  const filename = `PREEXIT-INSPECTION-${safeUnit}-${current.inspection_date}.pdf`;
  const pdfPath = await generatePdfToFile(html, DOCUMENTS_DIR, filename);

  const doc = await store.createDocument({
    doc_type: 'preexit_inspection',
    doc_number: `PEI-${current.id}`,       // one stable registry row per inventory
    title: `Pre-Exit Inspection Inventory — ${current.tenant_name} (${current.unit_label || current.tenant_code})`,
    filename,
    file_path: pdfPath,
    tenant_code: current.tenant_code,
    house_paybill_number: current.house_paybill_number,
    property_name: current.property_name,
    unit_label: current.unit_label,
    amount: current.total_estimated,
    doc_date: current.inspection_date,
    reuse_invoice_doc: true,
  });

  const caption = `PRE-EXIT INSPECTION INVENTORY — ${current.tenant_name} (${current.unit_label || current.tenant_code}) — ${current.inspection_date}`;
  const wa = await whatsapp.sendDocumentSmart(tenant.phone_number, pdfPath, caption);
  if (wa.status !== 'Sent') {
    return {
      error: `PDF generated but WhatsApp delivery failed: ${wa.failureReason || 'unknown error'}`,
      code: 'SEND_FAILED',
      document: doc || null,
    };
  }

  await require('../config/database').query(
    `UPDATE preexit_inspections
        SET status = CASE WHEN status = 'Draft' THEN 'Shared' ELSE status END,
            shared_at = NOW(),
            edited_after_share = FALSE,
            document_id = $1,
            updated_at = NOW()
      WHERE id = $2`,
    [doc ? doc.id : null, Number(id)]
  );
  return { inspection: await getInspection(id), document: doc, whatsapp: wa };
}

// ── Transfer agreed items → the existing Exit Invoice (exactly once) ────────
async function transferItems(inspectionId, { item_ids, actor } = {}) {
  return withInspectionLock(Number(inspectionId), async () => {
    const current = await getInspection(inspectionId);
    if (!current) return { error: 'Inventory not found', code: 'NOT_FOUND' };
    if (current.status !== 'Agreed') {
      return { error: 'Mark the inventory as Agreed before transferring items', code: 'NOT_AGREED' };
    }

    const requested = Array.isArray(item_ids) && item_ids.length
      ? current.items.filter((it) => item_ids.includes(it.id))
      : current.items;
    const already = requested.filter((it) => it.transfer_status === 'Transferred').map((it) => it.id);
    const eligible = requested.filter((it) => it.transfer_status === 'Not Transferred' && it.agreed);

    if (!eligible.length) {
      // Idempotent repeat: everything already transferred (or nothing agreed).
      const draft = current.exit_invoice;
      return { invoice_id: draft ? draft.id : null, exit_number: draft ? draft.exit_number : null, transferred: [], already, total: 0, message: 'No new items to transfer' };
    }

    // Ensure a DRAFT Exit Invoice exists (the existing process creates it).
    let invoice = current.exit_invoice && current.exit_invoice.is_draft
      ? { id: current.exit_invoice.id, exit_number: current.exit_invoice.exit_number }
      : null;
    if (!invoice) {
      const existing = await store.listExitInvoices(current.tenant_code);
      const draft = existing.find((e) => e.status === 'Draft');
      if (draft) {
        invoice = { id: draft.id, exit_number: draft.exit_number };
      } else if (existing.length) {
        return {
          error: 'The Exit Invoice for this unit is already finalized — transfers require a draft Exit Invoice.',
          code: 'EXIT_INVOICE_FINALIZED',
        };
      } else {
        const created = await store.createExitInvoice(current.tenant_code, {
          reason: 'Pre-exit inspection transfer',
        });
        if (!created || created.error) {
          return { error: (created && created.error) || 'Could not create the Exit Invoice', code: 'EXIT_CREATE_FAILED' };
        }
        invoice = { id: created.id, exit_number: created.exit_number };
      }
    }
    if (!invoice) {
      return { error: 'No draft Exit Invoice available for this unit', code: 'EXIT_INVOICE_FINALIZED' };
    }

    // Fresh invoice lines + append (skip any item already present — belt).
    const inv = await store.getExitInvoice(invoice.id);
    if (!inv) return { error: 'Exit Invoice not found', code: 'NOT_FOUND' };
    if (inv.status === 'Finalized') {
      return { error: 'The Exit Invoice is finalized — transfers require a draft Exit Invoice.', code: 'EXIT_INVOICE_FINALIZED' };
    }
    const lines = Array.isArray(inv.lines) ? inv.lines.slice() : [];
    const presentItemIds = new Set(lines.filter((l) => l && l.pei_item_id != null).map((l) => Number(l.pei_item_id)));
    const toAppend = eligible.filter((it) => !presentItemIds.has(it.id));
    for (const it of toAppend) {
      lines.push({
        description: it.description,
        amount: Number(it.total),
        quantity: Number(it.quantity),
        cost_per_qty: Number(it.cost_per_qty),
        remarks: it.remarks || null,
        source: 'preexit_inspection',
        pei_inspection_id: Number(inspectionId),
        pei_item_id: it.id,
      });
    }

    // Claim the items FIRST (conditional update = atomic single transfer),
    // compensating on any failure of the invoice update.
    const claimed = [];
    for (const it of toAppend) {
      const res = await require('../config/database').query(
        `UPDATE preexit_inspection_items
            SET transfer_status = 'Transferred', transferred_at = NOW(),
                exit_invoice_id = $1, transfer_ref = $2, updated_at = NOW()
          WHERE id = $3 AND transfer_status = 'Not Transferred'
          RETURNING id`,
        [invoice.id, `PEI-${inspectionId}-${it.id}`, it.id]
      );
      if (res.rowCount === 1) claimed.push(it.id);
    }

    if (toAppend.length) {
      try {
        // Existing Exit Invoice process: same calculation path as any edit.
        const updated = await store.updateExitInvoice(invoice.id, { lines });
        if (updated && updated.error) throw new Error(updated.error);
      } catch (err) {
        // Compensate: unclaim so a retry transfers exactly once, never twice.
        await require('../config/database').query(
          `UPDATE preexit_inspection_items
              SET transfer_status = 'Not Transferred', transferred_at = NULL,
                  exit_invoice_id = NULL, transfer_ref = NULL, updated_at = NOW()
            WHERE id = ANY($1::int[]) AND transfer_status = 'Transferred'`,
          [claimed]
        );
        return { error: `Transfer failed while updating the Exit Invoice: ${err.message}`, code: 'TRANSFER_FAILED' };
      }
    }

    const after = await getInspection(inspectionId);
    const freshInv = after.exit_invoice;
    return {
      invoice_id: invoice.id,
      exit_number: invoice.exit_number,
      transferred: claimed,
      already,
      total: after.total_estimated,
      inspection: after,
      message: `Transferred ${claimed.length} item(s) to Exit Invoice ${invoice.exit_number}`,
      actor: actor || null,
    };
  });
}

// ── PDF helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kES(n) {
  return `KES ${Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 })}`;
}

module.exports = {
  DISCLAIMER,
  lookupUnit,
  listInspections,
  getInspection,
  createInspection,
  saveInspection,
  setStatus,
  shareInspection,
  transferItems,
};
