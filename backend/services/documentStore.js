/**
 * Document Store — generates and persists PDF documents (payment receipts,
 * tenant statements, invoices) into the documents registry + filesystem so the
 * Documents hub can list, download and share them.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { getPuppeteerLaunchOptions } = require('../config/puppeteerChrome');
const { getLogoBase64 } = require('./logo');
const { receiptDocumentName, statementDocumentName, maintenanceInvoiceDocumentName, workOrderDocumentName, invoiceDocumentName, exitInvoiceDocumentName } = require('./docNames');
const store = require('../storage/store');

const DOCUMENTS_DIR = path.join(__dirname, '../storage/documents');

function ensureDir() {
  if (!fs.existsSync(DOCUMENTS_DIR)) {
    fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
  }
}

function readLogoBase64() {
  return getLogoBase64();
}

function renderTemplate(templateName, vars) {
  const templatePath = path.join(__dirname, `../templates/${templateName}`);
  let html = fs.readFileSync(templatePath, 'utf8');
  html = html.replace('{{logo_base64}}', readLogoBase64());
  for (const [key, value] of Object.entries(vars)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => String(value ?? ''));
  }
  return html;
}

async function generatePdfToFile(html, dir, filename) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const pdfPath = path.join(dir, filename);
  const browser = await puppeteer.launch(getPuppeteerLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '0px', bottom: '0px' } });
  } finally {
    await browser.close();
  }
  return pdfPath;
}

function formatDate(iso, opts = {}) {
  if (!iso) return '';
  let d = iso;
  if (!(d instanceof Date)) d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return String(iso);
  if (opts.monthFull) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const KES = (v) => 'KES ' + Number(v || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });

function buildAllocationHtml(allocation) {
  if (!allocation) {
    return `
      <tr>
        <td>Rent payment received</td>
        <td style="text-align: right;">{{amount_paid}}</td>
      </tr>
    `;
  }
  const rows = [];
  const add = (label, value) => {
    const v = Number(value || 0);
    if (v > 0) rows.push(`<tr><td>${label}</td><td style="text-align: right;">${KES(v)}</td></tr>`);
  };

  if (allocation.paymentType === 'deposit') {
    add('Deposit paid', allocation.depositSettled);
  } else {
    add('Arrears settled', allocation.arrearsSettled);
    add('Penalties settled', allocation.penaltySettled);
    add('Maintenance settled', allocation.maintenanceSettled);
    add('Other charges settled', allocation.otherSettled);
    add('Garbage fee settled', allocation.garbageFeeSettled);
    add('Rent settled', allocation.rentSettled);
  }

  if (rows.length === 0) {
    return `<tr><td>Payment received</td><td style="text-align: right;">{{amount_paid}}</td></tr>`;
  }
  return rows.join('');
}

function nextRentDue(tenant, allocation) {
  if (tenant?.rent_due_date) {
    return formatDate(tenant.rent_due_date, { monthFull: true });
  }
  const now = new Date();
  now.setMonth(now.getMonth() + 1);
  return `${now.getDate()} ${now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
}

function buildReceiptHtml(tenant, payment, allocation) {
  const amount = Number(payment?.amount || 0);
  const propertyName = tenant?.linked_house_name || tenant?.property_name || '';
  const housePaybill = tenant?.house_id || tenant?.house_paybill_number || '';
  const unitLabel = tenant?.unit_label || tenant?.tenant_code || '';
  const mpesaRef = payment?.mpesa_reference || '—';
  const paymentType = payment?.payment_type === 'deposit' ? 'Deposit' : 'Rent';
  const allocationHtml = buildAllocationHtml(allocation);

  return renderTemplate('receipt.html', {
    date: formatDate(payment?.payment_date || null, { monthFull: true }),
    receipt_no: payment?.receipt_number || '',
    tenant_name: tenant?.name || '',
    unit_label: unitLabel,
    property_name: propertyName,
    house_paybill: housePaybill,
    amount_paid: KES(amount),
    payment_type: paymentType,
    mpesa_reference: mpesaRef,
    allocation_html: allocationHtml,
    remaining_balance: KES(allocation?.remainingBalance ?? 0),
    overpayment: KES(allocation?.overpayment ?? 0),
    next_due: nextRentDue(tenant, allocation),
  });
}

/**
 * Generate + persist a PDF payment receipt and record it in the documents hub.
 * Returns the stored document row (or null on failure).
 */
async function generateAndStoreReceipt(tenant, payment, allocation) {
  try {
    const html = buildReceiptHtml(tenant, payment, allocation);
    const filename = receiptDocumentName({
      receiptNo: payment?.receipt_number,
      tenantName: tenant?.name,
      unitCode: tenant?.unit_label || tenant?.tenant_code,
    });
    ensureDir();
    const pdfPath = await generatePdfToFile(html, DOCUMENTS_DIR, filename);

    return await store.createDocument({
      doc_type: 'receipt',
      doc_number: payment?.receipt_number,
      title: `Payment Receipt ${payment?.receipt_number || ''}`.trim(),
      filename,
      file_path: pdfPath,
      tenant_code: tenant?.tenant_code || tenant?.id,
      house_paybill_number: tenant?.house_id || tenant?.house_paybill_number || null,
      property_name: tenant?.linked_house_name || tenant?.property_name || null,
      unit_label: tenant?.unit_label || null,
      amount: payment?.amount,
      doc_date: payment?.payment_date || null,
    });
  } catch (err) {
    console.error('[Documents] Receipt generation failed:', err.message);
    return null;
  }
}

/**
 * Copy an already-generated PDF (e.g. invoice) into the documents store and
 * record it in the hub. `srcPath` is the source file; `filename` is the
 * descriptive delivery name.
 */
async function storeGeneratedPdf({ srcPath, filename, doc_type, doc_number, title, tenant, house, amount, doc_date }) {
  try {
    ensureDir();
    const target = path.join(DOCUMENTS_DIR, filename);
    fs.copyFileSync(srcPath, target);

    return await store.createDocument({
      doc_type,
      doc_number,
      title,
      filename,
      file_path: target,
      tenant_code: tenant?.tenant_code || tenant?.id || null,
      house_paybill_number: (house?.paybill_number) || tenant?.house_id || tenant?.house_paybill_number || null,
      property_name: (house?.house_name) || tenant?.linked_house_name || tenant?.property_name || null,
      unit_label: tenant?.unit_label || null,
      amount: amount != null ? amount : null,
      doc_date: doc_date || null,
    });
  } catch (err) {
    console.error('[Documents] Storing PDF failed:', err.message);
    return null;
  }
}

const CATEGORY_LABELS = { penalty: 'Penalty', maintenance: 'Maintenance', other: 'Other Charge' };

function statementPaymentRows(payments) {
  if (!payments || !payments.length) {
    return '<tr><td colspan="5" class="empty-note">No payments recorded yet.</td></tr>';
  }
  return payments.map(p => `
    <tr>
      <td>${formatDate(p.payment_date)}</td>
      <td class="font-mono">${p.receipt_number || '—'}</td>
      <td class="font-mono">${p.mpesa_reference || '—'}</td>
      <td>${p.payment_type === 'deposit' ? 'Deposit' : 'Rent'}</td>
      <td style="text-align: right;">KES ${KES(p.amount)}</td>
    </tr>
  `).join('');
}

function statementInvoiceRows(invoices) {
  if (!invoices || !invoices.length) {
    return '<tr><td colspan="6" class="empty-note">No charges / invoices recorded.</td></tr>';
  }
  return invoices.map(i => `
    <tr>
      <td class="font-mono">${i.invoice_number || '—'}</td>
      <td>${formatDate(i.invoice_date || i.created_at)}</td>
      <td>${i.description || ''}</td>
      <td>${CATEGORY_LABELS[i.category] || 'Charge'}</td>
      <td>${i.status || 'Pending'}</td>
      <td style="text-align: right;">KES ${KES(i.amount)}</td>
    </tr>
  `).join('');
}

function buildTenantStatementHtml(statement, statementNo, dateISO) {
  const s = statement.summary;
  const tenant = statement.tenant;
  const house = statement.house || {};

  const status = s.outstanding_balance > 0 ? 'ARREARS' : (s.advance_rent_until || s.credit_balance > 0 ? 'PAID IN ADVANCE' : 'UP TO DATE');
  const statusClass = s.outstanding_balance > 0 ? 'warn' : 'good';

  const creditParts = [];
  if (s.credit_balance > 0) creditParts.push(`Credit balance: KES ${KES(s.credit_balance)}`);
  if (s.advance_rent_until) creditParts.push(`Advance rent paid up to ${formatDate(s.advance_rent_until, { monthFull: true })}`);
  const creditLine = creditParts.length ? creditParts.join(' • ') : (s.advance_rent_balance > 0 ? `Advance rent balance: KES ${KES(s.advance_rent_balance)}` : 'No credit or advance rent on account');

  return renderTemplate('tenant_statement.html', {
    date: formatDate(dateISO, { monthFull: true }),
    statement_no: statementNo,
    tenant_name: tenant.name || '',
    unit_label: tenant.unit_label || tenant.tenant_code || '',
    property_name: tenant.property_name || '',
    house_paybill: house.paybill_number || tenant.id || '',
    rent_amount: KES(s.rent_amount),
    outstanding_balance: KES(s.outstanding_balance),
    deposit: `${KES(s.deposit_paid)} / ${KES(s.deposit_amount)}`,
    status,
    status_class: statusClass,
    arrears: KES(s.arrears),
    rent_due: KES(s.rent_amount),
    garbage_fee: KES(s.garbage_fee_balance),
    pending_charges: KES(s.pending_charges),
    total_charges: KES(s.total_charges),
    total_payments: KES(s.total_payments),
    next_due: tenant.rent_due_date ? formatDate(tenant.rent_due_date, { monthFull: true }) : '—',
    credit_line: creditLine,
    payments_html: statementPaymentRows(statement.payments),
    invoices_html: statementInvoiceRows(statement.invoices),
    payment_instructions: (house.payment_instructions || 'Kindly settle any outstanding balance at your earliest convenience.').replace(/\{\{TENANT_CODE\}\}/gi, tenant.tenant_code || ''),
  });
}

async function generateAndStoreTenantStatement(tenantCode, statementNo) {
  try {
    const statement = await store.getTenantStatement(tenantCode);
    if (!statement) return null;

    const filename = statementDocumentName({
      statementNo,
      tenantName: statement.tenant.name,
      houseName: statement.tenant.property_name,
      unitCode: statement.tenant.unit_label || statement.tenant.tenant_code,
    });
    ensureDir();
    const html = buildTenantStatementHtml(statement, statementNo, new Date().toISOString().slice(0, 10));
    const pdfPath = await generatePdfToFile(html, DOCUMENTS_DIR, filename);

    return await store.createDocument({
      doc_type: 'tenant_statement',
      doc_number: statementNo,
      title: `Tenant Statement ${statementNo}`,
      filename,
      file_path: pdfPath,
      tenant_code: statement.tenant.tenant_code,
      house_paybill_number: statement.house.paybill_number || null,
      property_name: statement.tenant.property_name || null,
      unit_label: statement.tenant.unit_label || null,
      amount: null,
      doc_date: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    console.error('[Documents] Statement generation failed:', err.message);
    return null;
  }
}

function rentPaymentRows(payments) {
  if (!payments || !payments.length) {
    return '<tr><td colspan="5" class="empty-note">No payments recorded for this period.</td></tr>';
  }
  return payments.map(p => `
    <tr>
      <td>${formatDate(p.payment_date)}</td>
      <td>${p.receipt_number || '—'}</td>
      <td>${p.mpesa_reference || '—'}</td>
      <td>${p.payment_type === 'deposit' ? 'Deposit' : 'Rent'}</td>
      <td style="text-align: right;">KES ${KES(p.amount)}</td>
    </tr>
  `).join('');
}

function rentPendingRows(items) {
  if (!items || !items.length) {
    return '<tr><td colspan="5" class="empty-note">No outstanding charges.</td></tr>';
  }
  return items.map(i => `
    <tr>
      <td>${formatDate(i.invoice_date || i.created_at)}</td>
      <td>${i.invoice_number || '—'}</td>
      <td>${i.description || ''}</td>
      <td>${CATEGORY_LABELS[i.category] || 'Charge'}</td>
      <td style="text-align: right;">KES ${KES(i.amount)}</td>
    </tr>
  `).join('');
}

function buildRentInvoiceHtml(data, invoiceNo, dateISO) {
  const tenant = data.tenant || {};
  const house = data.house || {};
  const c = data.charges || {};
  const billing = data.billing || {};
  const paymentsSection = `
    <div class="section-label">Payment History ({{period_label}})</div>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Receipt No</th>
          <th>M-PESA Reference</th>
          <th>Type</th>
          <th style="text-align: right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rentPaymentRows(data.payments)}
      </tbody>
    </table>`;

  const pendingSection = `
    <div class="section-label">Outstanding Charges</div>
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Invoice No</th>
          <th>Description</th>
          <th>Category</th>
          <th style="text-align: right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rentPendingRows(data.pending_items)}
      </tbody>
    </table>`;

  return renderTemplate('rent_invoice.html', {
    date: formatDate(dateISO, { monthFull: true }),
    invoice_no: invoiceNo,
    period_label: billing.period_label || '',
    from_date: billing.from_date || '',
    to_date: billing.to_date || '',
    tenant_name: tenant.name || '',
    unit_label: tenant.unit_label || tenant.tenant_code || '',
    property_name: tenant.property_name || '',
    house_paybill: house.paybill_number || tenant.id || '',
    opening_balance: KES(data.opening_balance).replace('KES ', ''),
    rent_charge: KES(c.rent).replace('KES ', ''),
    garbage_charge: KES(c.garbage).replace('KES ', ''),
    water_charge: KES(c.water).replace('KES ', ''),
    penalty_charge: KES(c.penalties).replace('KES ', ''),
    maintenance_charge: KES(c.maintenance).replace('KES ', ''),
    other_charge: KES(c.other).replace('KES ', ''),
    rent_due_date: tenant.rent_due_date ? formatDate(tenant.rent_due_date, { monthFull: true }) : '—',
    total_due: KES(data.total_due).replace('KES ', ''),
    payments_received: KES(data.payments_received).replace('KES ', ''),
    applied_credits: KES(data.credit_balance + data.advance_rent).replace('KES ', ''),
    closing_balance: KES(data.closing_balance).replace('KES ', ''),
    payments_section: paymentsSection,
    pending_section: pendingSection,
    payment_instructions: (house.payment_instructions || 'Kindly settle the closing balance at your earliest convenience.').replace(/\{\{TENANT_CODE\}\}/gi, tenant.tenant_code || ''),
  });
}

/**
 * Record an issued invoice in the permanent Invoice Register. Never fails the
 * generation flow — a register write error is logged and skipped so the PDF
 * itself is still returned. The returned document row gets `register_id`.
 */
async function registerInvoice(doc, data) {
  try {
    const register = await store.createInvoiceRegister(data);
    if (register && doc) doc.register_id = register.id;
  } catch (err) {
    console.error('[Invoice Register] Failed to record invoice:', err.message);
  }
  return doc;
}

async function generateAndStoreRentInvoice(tenantCode, billingPeriod, actor) {
  try {
    const data = await store.getRentInvoiceData(tenantCode, billingPeriod);
    if (!data) return null;

    const invoiceNo = await store.generateInvoiceNumber();
    const filename = invoiceDocumentName({
      invoiceNo,
      invoiceType: 'rent',
      tenantName: data.tenant.name,
      houseName: data.tenant.property_name,
      unitCode: data.tenant.unit_label,
    });
    ensureDir();
    const html = buildRentInvoiceHtml(data, invoiceNo, new Date().toISOString().slice(0, 10));
    const pdfPath = await generatePdfToFile(html, DOCUMENTS_DIR, filename);

    const doc = await store.createDocument({
      doc_type: 'rent_invoice',
      doc_number: invoiceNo,
      title: `Rent Invoice ${invoiceNo}`,
      filename,
      file_path: pdfPath,
      tenant_code: data.tenant.tenant_code,
      house_paybill_number: data.house.paybill_number || null,
      property_name: data.tenant.property_name || null,
      unit_label: data.tenant.unit_label || null,
      amount: data.total_due,
      doc_date: new Date().toISOString().slice(0, 10),
    });

    return await registerInvoice(doc, {
      document_id: doc ? doc.id : null,
      invoice_number: invoiceNo,
      invoice_type: 'rent',
      generated_by: actor || null,
      tenant_code: data.tenant.tenant_code,
      tenant_name: data.tenant.name,
      property_name: data.tenant.property_name,
      house_paybill_number: data.house.paybill_number || null,
      unit_label: data.tenant.unit_label || null,
      amount: data.total_due,
    });
  } catch (err) {
    console.error('[Documents] Rent invoice generation failed:', err.message);
    return null;
  }
}

function exitInvoiceLinesRows(lines) {
  if (!lines || !lines.length) {
    return '<tr><td colspan="2" class="empty-note">No deductions recorded.</td></tr>';
  }
  return lines.map((l, idx) => `
    <tr>
      <td>${l.label || 'Deduction ' + (idx + 1)}</td>
      <td style="text-align: right;">KES ${KES(l.amount)}</td>
    </tr>
  `).join('');
}

function buildExitInvoiceHtml(invoice, tenant = {}) {
  const lines = parseItems(invoice.lines);

  // Management decision labels
  const rentLabels = { full_month: 'Full Month Rent', pro_rated: 'Pro-rated / Overstayed Days', waived: 'Rent Waived' };
  const depositLabels = { apply_to_rent: 'Applied to Rent', apply_to_deductions: 'Applied to Deductions', apply_to_both: 'Applied to Rent & Deductions', refund: 'Deposit Refunded', other: 'Other Management Adjustment' };
  const rentTreatment = invoice.rent_treatment || 'full_month';
  const depositTreatment = invoice.deposit_treatment || 'apply_to_deductions';
  const rentCharged = Number(invoice.rent_charged_amount || 0);
  const depToRent = Number(invoice.deposit_applied_to_rent || 0);
  const depToDed = Number(invoice.deposit_applied_to_deductions || 0);

  // Always show management decision section on finalized invoices
  let decisionHtml = '';
  if (invoice.status === 'Finalized' || rentTreatment !== 'full_month' || depositTreatment !== 'apply_to_deductions') {
    let d = '<div class="reason-box" style="border-color:#1a4b8c;background:#eef3fb;">';
    d += '<strong>Settlement Decision</strong><br>';
    d += `Rent Treatment: <strong>${rentLabels[rentTreatment] || rentTreatment}</strong>`;
    if (rentTreatment === 'waived') d += ' — KES 0 (excluded from settlement)';
    else if (rentCharged > 0) d += ` — KES ${KESNum(rentCharged)}`;
    else d += ` — KES ${KESNum(Number(invoice.rent_amount || 0))}`;
    if (invoice.pro_rated_days) d += ` (${invoice.pro_rated_days} days)`;
    d += '<br>';
    d += `Deposit Treatment: <strong>${depositLabels[depositTreatment] || depositTreatment}</strong>`;
    if (depToRent > 0) d += ` — KES ${KESNum(depToRent)} to rent`;
    if (depToDed > 0) d += ` — KES ${KESNum(depToDed)} to deductions`;
    if (depToRent === 0 && depToDed === 0 && depositTreatment === 'refund') d += ' — full refund';
    if (depToRent === 0 && depToDed === 0 && depositTreatment === 'apply_to_deductions') d += ' — no deposit applied';
    d += '<br>';
    if (invoice.rent_treatment_reason) d += `<em>Reason: ${invoice.rent_treatment_reason}</em><br>`;
    if (invoice.settlement_decision_reason) d += `<em>Notes: ${invoice.settlement_decision_reason}</em>`;
    d += '</div>';
    decisionHtml = d;
  }

  return renderTemplate('exit_invoice.html', {
    date: formatDate(new Date(), { monthFull: true }),
    exit_number: invoice.exit_number || '',
    status: invoice.status || 'Draft',
    status_label: invoice.status === 'Finalized' ? 'FINALIZED' : 'DRAFT',
    tenant_name: invoice.tenant_name || tenant.name || '',
    unit_label: invoice.unit_label || tenant.unit_label || tenant.tenant_code || '',
    property_name: invoice.property_name || tenant.property_name || '',
    house_paybill: invoice.house_paybill_number || tenant.house_id || tenant.house_paybill_number || '—',
    national_id: tenant.national_id || '—',
    phone_number: tenant.phone_number || '—',
    move_in_date: tenant.move_in_date ? formatDate(tenant.move_in_date, { monthFull: true }) : '—',
    move_out_date: invoice.move_out_date ? formatDate(invoice.move_out_date, { monthFull: true }) : '—',
    reason_box: invoice.reason
      ? `<div class="reason-box"><strong>Exit Reason:</strong> ${invoice.reason}</div>`
      : '',
    decision_box: decisionHtml,
    lines_html: exitInvoiceLinesRows(lines),
    deposit_paid: KESNum(invoice.deposit_paid),
    deductions_total: KESNum(invoice.deductions_total),
    outstanding_balance: KESNum(invoice.outstanding_balance),
    deposit_refund: KESNum(invoice.deposit_refund),
    final_settlement: KESNum(invoice.final_settlement),
  });
}

async function generateAndStoreExitInvoice(id, actor) {
  try {
    const invoice = await store.getExitInvoice(id);
    if (!invoice) return null;
    const tenant = await store.getTenant(invoice.tenant_code);
    if (!tenant) return null;

    const filename = exitInvoiceDocumentName({
      exitNo: invoice.exit_number,
      tenantName: invoice.tenant_name || tenant.name,
      houseName: invoice.property_name || tenant.property_name,
      unitCode: invoice.unit_label || tenant.unit_label || invoice.tenant_code,
    });
    ensureDir();
    const html = buildExitInvoiceHtml(invoice, tenant);
    const pdfPath = await generatePdfToFile(html, DOCUMENTS_DIR, filename);

    const doc = await store.createDocument({
      doc_type: 'exit_invoice',
      doc_number: invoice.exit_number,
      title: `Exit Invoice ${invoice.exit_number}`,
      filename,
      file_path: pdfPath,
      tenant_code: invoice.tenant_code,
      house_paybill_number: invoice.house_paybill_number || tenant.house_id || null,
      property_name: invoice.property_name || tenant.property_name || null,
      unit_label: invoice.unit_label || null,
      amount: invoice.final_settlement,
      doc_date: invoice.move_out_date || new Date().toISOString().slice(0, 10),
    });

    return await registerInvoice(doc, {
      document_id: doc ? doc.id : null,
      invoice_number: invoice.exit_number,
      invoice_type: 'exit',
      generated_by: actor || null,
      tenant_code: invoice.tenant_code,
      tenant_name: invoice.tenant_name || tenant.name,
      property_name: invoice.property_name || tenant.property_name,
      house_paybill_number: invoice.house_paybill_number || tenant.house_id || null,
      unit_label: invoice.unit_label || tenant.unit_label || null,
      amount: invoice.final_settlement,
      move_out_date: invoice.move_out_date || null,
      deposit_paid: invoice.deposit_paid,
      deposit_refund: invoice.deposit_refund,
      deductions_total: invoice.deductions_total,
      final_refund: invoice.final_settlement,
      approved_by: invoice.finalized_by || null,
    });
  } catch (err) {
    console.error('[Documents] Exit invoice generation failed:', err.message);
    return null;
  }
}

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

function maintenanceItemsRows(items) {
  if (!items || !items.length) {
    return '<tr><td colspan="10" class="empty-note">No work items.</td></tr>';
  }
  return items.map((it, idx) => {
    const labour = Number(it.labour_cost || 0);
    const material = Number(it.material_cost || 0);
    return `
      <tr>
        <td>${idx + 1}</td>
        <td>${it.unit_code || ''}</td>
        <td>${it.problem || ''}<br><span style="color:#555;font-size:9px;">${it.work_required || ''}</span></td>
        <td>${it.work_done || ''}</td>
        <td>${it.materials || ''}</td>
        <td>${it.priority || 'Medium'}</td>
        <td>${it.status || 'Pending'}</td>
        <td style="text-align: right;">KES ${KES(labour)}</td>
        <td style="text-align: right;">KES ${KES(material)}</td>
        <td style="text-align: right;">KES ${KES(labour + material)}</td>
      </tr>
    `;
  }).join('');
}

function workOrderItemsRows(items) {
  if (!items || !items.length) {
    return '<tr><td colspan="7" class="empty-note">No work items.</td></tr>';
  }
  return items.map((it, idx) => {
    const cost = Number(it.material_cost || 0) + Number(it.labour_cost || 0);
    return `
      <tr>
        <td>${idx + 1}</td>
        <td>${it.unit_code || ''}</td>
        <td>${it.problem || ''}<br><span style="color:#555;font-size:9px;">${it.work_required || ''}</span></td>
        <td>${it.work_done || ''}</td>
        <td>${it.materials || ''}</td>
        <td>${it.status || 'Pending'}</td>
        <td style="text-align: right;">KES ${KES(cost)}</td>
      </tr>
    `;
  }).join('');
}

function partyClass(p) {
  const s = String(p || '').toLowerCase();
  if (s.includes('tenant'))   return 'tenant';
  if (s.includes('management') || s.includes('owner')) return 'mgmt';
  if (s.includes('shared'))   return 'shared';
  return 'pending';
}

function KESNum(n) {
  return Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
}

/**
 * Group work-order items by unit_code and render as a series of cards,
 * each with a unit header and a table of issues (Issue | Responsible Party |
 * Cost).  This matches the professional unit-by-unit format requested by
 * management.
 */
function workOrderItemsGroupedHtml(items) {
  // Kept for backward compatibility; superseded by workOrderItemsRegisterHtml.
  return workOrderItemsRegisterHtml(items);
}

/**
 * Build the complete issue register table for the Work Order PDF.
 * Columns: Issue No. | Unit | Problem | Repair Required | Materials | Responsible Party | Material Cost | Labour Cost | Total Cost | Status
 * Issues are grouped visually by unit with a unit header row spanning all columns.
 */
function workOrderItemsRegisterHtml(items) {
  if (!items || !items.length) {
    return '<table><tr><td colspan="10" class="empty-note">No issues reported.</td></tr></table>';
  }

  let html = '<table>';
  html += '<thead><tr>';
  html += '<th style="width:30px">#</th>';
  html += '<th style="width:50px">Unit</th>';
  html += '<th>Problem</th>';
  html += '<th>Repair Required</th>';
  html += '<th>Materials</th>';
  html += '<th style="width:90px">Responsible Party</th>';
  html += '<th style="width:70px" class="cost-cell">Mat. Cost</th>';
  html += '<th style="width:65px" class="cost-cell">Labour</th>';
  html += '<th style="width:75px" class="cost-cell">Total Cost</th>';
  html += '<th style="width:70px">Status</th>';
  html += '</tr></thead>';
  html += '<tbody>';

  let currentUnit = '';
  for (const it of items) {
    const unit = String(it.unit_code || '').trim() || 'Unassigned';
    if (unit !== currentUnit) {
      currentUnit = unit;
      html += `<tr><td colspan="10" style="background:#e8eef6;font-weight:700;color:#1a4b8c;padding:6px 8px;font-size:11px;border-bottom:2px solid #1a4b8c;">${esc(unit)}</td></tr>`;
    }

    const matCost = Number(it.material_cost || 0);
    const labourCost = Number(it.labour_cost || 0);
    const totalCost = matCost + labourCost;
    const party = it.responsible_party || 'Pending Assessment';
    const status = it.status || 'Pending';
    const issueNo = it.issue_no || '';

    // Materials display: structured list or text fallback
    let matDisplay = '';
    if (Array.isArray(it.materials) && it.materials.length) {
      matDisplay = it.materials.map(m => {
        const qty = Number(m.quantity || 0);
        const name = esc(m.name || '');
        return qty > 1 ? `${name} (×${qty})` : name;
      }).filter(Boolean).join('<br>');
    } else if (it.material_names) {
      matDisplay = esc(it.material_names);
    } else if (typeof it.materials === 'string') {
      matDisplay = esc(it.materials);
    }

    html += '<tr>';
    html += `<td>${issueNo}</td>`;
    html += `<td>${esc(it.unit_code || '')}</td>`;
    html += `<td>${esc(it.problem || '')}</td>`;
    html += `<td>${esc(it.work_required || '')}</td>`;
    html += `<td class="materials-cell">${matDisplay || '—'}</td>`;
    const mgmtNote = it.mgmt_note ? `<br><span style="font-size:8.5px;color:#666;font-style:italic;">${esc(it.mgmt_note)}</span>` : '';
    html += `<td><span class="party-tag ${partyClass(party)}">${esc(party)}</span>${mgmtNote}</td>`;
    html += `<td class="cost-cell">${matCost > 0 ? KESNum(matCost) : '—'}</td>`;
    html += `<td class="cost-cell">${labourCost > 0 ? KESNum(labourCost) : '—'}</td>`;
    html += `<td class="cost-cell" style="font-weight:600;">${totalCost > 0 ? KESNum(totalCost) : '—'}</td>`;
    html += `<td><span class="status-tag ${statusClass(status)}">${esc(status)}</span></td>`;
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

function statusClass(s) {
  const sl = String(s || '').toLowerCase();
  if (sl.includes('completed') || sl.includes('paid')) return 'completed';
  if (sl.includes('progress') || sl.includes('assigned') || sl.includes('approved')) return 'in-progress';
  if (sl.includes('charged')) return 'charged';
  return 'pending';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notesHtml(notes) {
  if (!notes) return '';
  return `
    <div class="note-box" style="border-color:#1a4b8c;background:#eef3fb;color:#1a4b8c;">
      <strong>Notes:</strong> ${notes}
    </div>`;
}

function buildMaintenanceInvoiceHtml(mnt) {
  const items = parseItems(mnt.items);
  const labourTotal = mnt.labour_total != null ? Number(mnt.labour_total) : items.reduce((s, it) => s + Number(it.labour_cost || 0), 0);
  const materialTotal = mnt.material_total != null ? Number(mnt.material_total) : items.reduce((s, it) => s + Number(it.material_cost || 0), 0);
  const grandTotal = mnt.grand_total != null ? Number(mnt.grand_total) : labourTotal + materialTotal;

  return renderTemplate('maintenance_invoice.html', {
    date: formatDate(new Date(), { monthFull: true }),
    mnt_number: mnt.mnt_number || '',
    property_name: mnt.property_name || '',
    house_paybill: mnt.house_paybill_number || '—',
    unit_codes: mnt.unit_codes || '—',
    caretaker_name: mnt.caretaker_name || '—',
    date_reported: formatDate(mnt.date_reported),
    date_work_started: formatDate(mnt.date_work_started),
    date_completed: formatDate(mnt.date_completed),
    status: mnt.status || 'Pending',
    items_html: maintenanceItemsRows(items),
    technician_name: mnt.technician_name || '—',
    technician_phone: mnt.technician_phone || '—',
    subtotal: KES(grandTotal).replace('KES ', ''),
    labour_total: KES(labourTotal).replace('KES ', ''),
    material_total: KES(materialTotal).replace('KES ', ''),
    grand_total: KES(grandTotal).replace('KES ', ''),
    notes_html: notesHtml(mnt.notes),
    payment_instructions: 'Settlement of this maintenance invoice is handled by property management. For enquiries contact the caretaker or management office.',
  });
}

async function generateAndStoreMaintenanceInvoice(id, actor) {
  try {
    const mnt = await store.getMaintenanceInvoice(id);
    if (!mnt) return null;

    const filename = maintenanceInvoiceDocumentName({
      mntNo: mnt.mnt_number,
      houseName: mnt.property_name,
      unitCodes: mnt.unit_codes,
    });
    ensureDir();
    const html = buildMaintenanceInvoiceHtml(mnt);
    const pdfPath = await generatePdfToFile(html, DOCUMENTS_DIR, filename);

    const doc = await store.createDocument({
      doc_type: 'maintenance_invoice',
      doc_number: mnt.mnt_number,
      title: `Maintenance Invoice ${mnt.mnt_number}`,
      filename,
      file_path: pdfPath,
      tenant_code: null,
      house_paybill_number: mnt.house_paybill_number || null,
      property_name: mnt.property_name || null,
      unit_label: mnt.unit_codes || null,
      amount: mnt.grand_total,
      doc_date: mnt.date_reported || new Date().toISOString().slice(0, 10),
    });

    return await registerInvoice(doc, {
      document_id: doc ? doc.id : null,
      invoice_number: mnt.mnt_number,
      invoice_type: 'maintenance',
      generated_by: actor || null,
      tenant_code: null,
      tenant_name: null,
      property_name: mnt.property_name,
      house_paybill_number: mnt.house_paybill_number || null,
      unit_label: mnt.unit_codes || null,
      amount: mnt.grand_total,
    });
  } catch (err) {
    console.error('[Documents] Maintenance invoice generation failed:', err.message);
    return null;
  }
}

function buildWorkOrderHtml(wo) {
  const items = parseItems(wo.items);
  const totalMaterialCost = items.reduce((s, it) => s + Number(it.material_cost || 0), 0);
  const totalLabourCost = items.reduce((s, it) => s + Number(it.labour_cost || 0), 0);
  const totalCost = wo.total_cost != null
    ? Number(wo.total_cost)
    : totalMaterialCost + totalLabourCost;

  return renderTemplate('work_order.html', {
    date: formatDate(new Date(), { monthFull: true }),
    wo_number: wo.wo_number || '',
    property_name: wo.property_name || '',
    house_paybill: wo.house_paybill_number || '—',
    unit_codes: wo.unit_codes || '—',
    caretaker_name: wo.caretaker_name || '—',
    date_requested: formatDate(wo.date_requested),
    date_work_started: formatDate(wo.date_work_started),
    date_completed: formatDate(wo.date_completed),
    priority: wo.priority || 'Medium',
    priority_class: (wo.priority || 'Medium') === 'High' ? 'warn' : 'good',
    technician_name: wo.technician_name || '—',
    technician_phone: wo.technician_phone || '—',
    date_assigned: formatDate(wo.date_assigned),
    expected_completion: formatDate(wo.expected_completion),
    items_register_html: workOrderItemsRegisterHtml(items),
    total_material_cost: KESNum(totalMaterialCost),
    total_labour_cost: KESNum(totalLabourCost),
    total_cost: KESNum(totalCost),
    labour_involved: wo.labour_involved || '—',
    notes_html: notesHtml(wo.notes),
    payment_instructions: 'This work order authorizes the listed repairs. The corresponding maintenance invoice is raised on completion.',
  });
}

async function generateAndStoreWorkOrder(id) {
  try {
    const wo = await store.getWorkOrder(id);
    if (!wo) return null;

    const filename = workOrderDocumentName({
      woNo: wo.wo_number,
      houseName: wo.property_name,
      unitCodes: wo.unit_codes,
    });
    ensureDir();
    const html = buildWorkOrderHtml(wo);
    const pdfPath = await generatePdfToFile(html, DOCUMENTS_DIR, filename);

    return await store.createDocument({
      doc_type: 'work_order',
      doc_number: wo.wo_number,
      title: `Work Order ${wo.wo_number}`,
      filename,
      file_path: pdfPath,
      tenant_code: null,
      house_paybill_number: wo.house_paybill_number || null,
      property_name: wo.property_name || null,
      unit_label: (wo.unit_codes || '').slice(0, 64) || null,
      amount: wo.total_cost,
      doc_date: wo.date_requested || new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    console.error('[Documents] Work order generation failed:', err.message);
    return null;
  }
}

module.exports = {
  DOCUMENTS_DIR,
  buildReceiptHtml,
  generateAndStoreReceipt,
  storeGeneratedPdf,
  buildTenantStatementHtml,
  generateAndStoreTenantStatement,
  generatePdfToFile,
  buildRentInvoiceHtml,
  generateAndStoreRentInvoice,
  buildMaintenanceInvoiceHtml,
  generateAndStoreMaintenanceInvoice,
  buildWorkOrderHtml,
  generateAndStoreWorkOrder,
  buildExitInvoiceHtml,
  generateAndStoreExitInvoice,
};
