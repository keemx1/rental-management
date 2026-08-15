const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { getPuppeteerLaunchOptions } = require('../config/puppeteerChrome');
const { getLogoBase64 } = require('../services/logo');
const { storeGeneratedPdf } = require('../services/documentStore');
const { generateAndStoreRentInvoice } = require('../services/documentStore');
const { invoiceDocumentName, renameForDelivery } = require('../services/docNames');

const router = express.Router();
router.use(requireAuthActive);

function readLogoBase64() {
  return getLogoBase64();
}

async function generatePdf(html) {
  const browser = await puppeteer.launch(getPuppeteerLaunchOptions());
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfPath = path.join(__dirname, `../../scratch/invoice_${Date.now()}_${Math.floor(Math.random() * 100000)}.pdf`);
  if (!fs.existsSync(path.dirname(pdfPath))) {
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  }
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '0px', bottom: '0px' } });
  await browser.close();
  return pdfPath;
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

async function buildMaintenanceInvoiceHtml(tenant, house, invoiceNumber, date, items) {
  let subtotal = 0;
  let deductions = 0;
  const lineItemsHtml = items.map(item => {
    const lineTotal = Number(item.qty || 1) * Number(item.unit_price || 0);
    if (lineTotal < 0) {
      deductions += lineTotal;
    } else {
      subtotal += lineTotal;
    }
    return `
      <tr>
        <td>${item.qty || 1}</td>
        <td>${item.description || ''}</td>
        <td>KES ${Number(item.unit_price || 0).toLocaleString()}</td>
        <td style="text-align: right;">KES ${lineTotal.toLocaleString()}</td>
      </tr>
    `;
  }).join('');
  const grandTotal = subtotal + deductions;
  const paymentInstructions = house ? store.getPaymentInstructionsText(house, tenant.tenant_code) : '';
  return renderTemplate('invoice.html', {
    date,
    plot_name: house ? `${house.house_name} ${tenant.tenant_code}` : (tenant.property_name || ''),
    tenant_name: tenant.name,
    phone_number: tenant.phone_number,
    line_items_html: lineItemsHtml,
    invoice_no: invoiceNumber,
    subtotal: subtotal.toLocaleString(),
    deductions: Math.abs(deductions).toLocaleString(),
    grand_total: grandTotal.toLocaleString(),
    payment_instructions: paymentInstructions,
  });
}

async function buildExitInvoiceHtml(tenant, house, invoiceNumber, date, summary, exitDeductions) {
  const outstandingTotal = summary.totals.outstanding_total;
  const outstandingRowsHtml = summary.outstanding.map(item => `
    <tr>
      <td>${item.description || ''}</td>
      <td style="text-align: right;">KES ${Number(item.amount || 0).toLocaleString()}</td>
    </tr>
  `).join('');
  const deductionRowsHtml = exitDeductions.map(d => `
    <tr>
      <td>${d.description || 'Exit Deduction'}</td>
      <td style="text-align: right;">KES ${Number(d.amount || 0).toLocaleString()}</td>
    </tr>
  `).join('');

  const deductionsTotal = outstandingTotal + exitDeductions.reduce((s, d) => s + Number(d.amount || 0), 0);
  const depositPaid = summary.deposit.paid;
  const settlement = depositPaid - deductionsTotal;

  let settlementLabel;
  let settlementAmount;
  let settlementNote;
  let paymentInstructions;
  if (settlement >= 0) {
    settlementLabel = 'DEPOSIT REFUND';
    settlementAmount = settlement;
    settlementNote = 'Amount to be refunded to the tenant upon vacating the unit.';
    paymentInstructions = 'Please allow 30 days for the refund to be processed after vacating and handing over the unit.';
  } else {
    settlementLabel = 'AMOUNT PAYABLE BY TENANT';
    settlementAmount = Math.abs(settlement);
    settlementNote = 'Outstanding amount to be settled by the tenant upon vacating the unit.';
    paymentInstructions = house ? store.getPaymentInstructionsText(house, tenant.tenant_code) : 'Kindly settle the outstanding amount before vacating the unit.';
  }

  return renderTemplate('exit_invoice.html', {
    date,
    plot_name: house ? `${house.house_name} ${tenant.tenant_code}` : (tenant.property_name || ''),
    tenant_name: tenant.name,
    phone_number: tenant.phone_number,
    invoice_no: invoiceNumber,
    deposit_required: Number(summary.deposit.amount || 0).toLocaleString(),
    deposit_paid: Number(depositPaid || 0).toLocaleString(),
    deposit_balance: Number(summary.deposit.balance || 0).toLocaleString(),
    outstanding_rows_html: outstandingRowsHtml,
    outstanding_total: outstandingTotal.toLocaleString(),
    deduction_rows_html: deductionRowsHtml || '<tr><td style="text-align: center;">None</td><td style="text-align: right;">KES 0</td></tr>',
    deductions_total: exitDeductions.reduce((s, d) => s + Number(d.amount || 0), 0).toLocaleString(),
    total_deductions: deductionsTotal.toLocaleString(),
    settlement_label: settlementLabel,
    settlement_amount: settlementAmount.toLocaleString(),
    settlement_note: settlementNote,
    payment_instructions: paymentInstructions,
  });
}

async function buildInvoice(req) {
  const { tenant_id, date, invoice_type, items, deductions } = req.body;
  const invoiceType = invoice_type === 'exit' ? 'exit' : 'maintenance';
  if (!tenant_id) return { error: 'tenant_id is required', status: 400 };
  if (invoiceType === 'maintenance' && (!items || !items.length)) {
    return { error: 'items are required for a maintenance invoice', status: 400 };
  }

  const tenant = await store.getTenant(tenant_id);
  if (!tenant) return { error: 'Tenant not found', status: 404 };
  const house = tenant.house_id ? await store.getHouse(tenant.house_id) : null;

  let invoiceNumber = req.body.invoice_no || null;
  if (!invoiceNumber) {
    invoiceNumber = await store.generateInvoiceNumber();
  }

  let html;
  if (invoiceType === 'exit') {
    const summary = await store.getTenantExitSummary(tenant.tenant_code);
    if (!summary) return { error: 'Tenant summary not found', status: 404 };
    html = await buildExitInvoiceHtml(
      tenant,
      house,
      invoiceNumber,
      date || new Date().toISOString().split('T')[0],
      summary,
      Array.isArray(deductions) ? deductions : []
    );
  } else {
    html = await buildMaintenanceInvoiceHtml(
      tenant,
      house,
      invoiceNumber,
      date || new Date().toISOString().split('T')[0],
      items
    );
  }

  return { tenant, house, invoiceNumber, invoiceType, html };
}

function buildWhatsAppCaption(tenant, invoiceType) {
  const unitText = tenant.tenant_code ? ` for unit ${tenant.tenant_code}` : '';
  if (invoiceType === 'exit') {
    return `Hello ${tenant.name}, please find attached your final exit settlement statement${unitText}.`;
  }
  return `Hello ${tenant.name}, please find attached your latest invoice${unitText}.`;
}

router.get('/tenant-summary/:tenantCode', async (req, res) => {
  try {
    const summary = await store.getTenantExitSummary(req.params.tenantCode);
    if (!summary) return res.status(404).json({ error: 'Tenant not found' });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tenant summary: ' + err.message });
  }
});

router.post('/send', async (req, res) => {
  let pdfPath = null;
  let deliveredPath = null;
  try {
    const mode = req.body.mode || 'send';
    const built = await buildInvoice(req);
    if (built.error) return res.status(built.status || 500).json({ error: built.error });

    pdfPath = await generatePdf(built.html);
    const { tenant, house, invoiceNumber, invoiceType } = built;
    const docName = invoiceDocumentName({
      invoiceNo: invoiceNumber,
      invoiceType,
      tenantName: tenant.name,
      houseName: house ? house.house_name : '',
      unitCode: tenant.tenant_code,
    });
    deliveredPath = pdfPath;

    let registerId = null;
    try {
      const savedDoc = await storeGeneratedPdf({
        srcPath: pdfPath,
        filename: docName,
        doc_type: invoiceType === 'exit' ? 'exit_invoice' : 'invoice',
        doc_number: invoiceNumber,
        title: `${invoiceType === 'exit' ? 'Exit Invoice' : 'Invoice'} ${invoiceNumber}`,
        tenant,
        house,
        amount: built.amount != null ? built.amount : null,
        doc_date: req.body.date || null,
      });
      const register = await store.createInvoiceRegister({
        document_id: savedDoc ? savedDoc.id : null,
        invoice_number: invoiceNumber,
        invoice_type: invoiceType === 'exit' ? 'exit' : 'maintenance',
        generated_by: req.user?.username || null,
        tenant_code: tenant.tenant_code || tenant.id || null,
        tenant_name: tenant.name || null,
        property_name: (house ? house.house_name : null) || tenant.linked_house_name || tenant.property_name || null,
        house_paybill_number: (house ? house.paybill_number : null) || tenant.house_id || tenant.house_paybill_number || null,
        unit_label: tenant.unit_label || null,
        amount: built.amount != null ? built.amount : null,
      });
      if (register && register.id) registerId = register.id;
    } catch (err) {
      console.error('[Documents] Invoice store failed:', err.message);
    }

    const markRegister = (action) => {
      if (registerId) store.markInvoiceRegister({ id: registerId, action }).catch(() => {});
    };

    if (mode === 'download') {
      markRegister('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${docName}"`);
      return res.sendFile(pdfPath, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream PDF' });
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      });
    }

    try {
      deliveredPath = renameForDelivery(pdfPath, docName);
      await whatsapp.sendMediaMessage(tenant.phone_number, deliveredPath, buildWhatsAppCaption(tenant, invoiceType));
      await store.logMessage({
        tenantId: tenant.id,
        messageType: 'Invoice',
        messageBody: invoiceType === 'exit'
          ? `Exit settlement PDF sent successfully (${invoiceNumber})`
          : `Invoice PDF sent successfully (${invoiceNumber})`,
        status: 'Sent',
      });
      markRegister('send');
    } catch (err) {
      await store.logMessage({
        tenantId: tenant.id,
        messageType: 'Invoice',
        messageBody: 'Failed to send Invoice PDF',
        status: 'Failed',
      });
      return res.status(500).json({ error: 'WhatsApp delivery failed: ' + err.message });
    }

    if (mode === 'both') {
      markRegister('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${docName}"`);
      res.setHeader('X-Invoice-Number', invoiceNumber);
      return res.sendFile(deliveredPath, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream PDF' });
        if (fs.existsSync(deliveredPath)) fs.unlinkSync(deliveredPath);
      });
    }

    if (fs.existsSync(deliveredPath)) fs.unlinkSync(deliveredPath);
    res.json({ success: true, message: 'Invoice sent successfully', invoice_no: invoiceNumber });
  } catch (err) {
    if (deliveredPath && fs.existsSync(deliveredPath)) fs.unlinkSync(deliveredPath);
    else if (pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    res.status(500).json({ error: 'Invoice operation failed: ' + err.message });
  }
});

router.post('/rent', async (req, res) => {
  try {
    const mode = req.body.mode || 'download';
    const tenantId = req.body.tenant_id;
    const billingPeriod = req.body.billing_period || null;
    if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });

    const tenant = await store.getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const doc = await generateAndStoreRentInvoice(tenant.tenant_code, billingPeriod, req.user?.username);
    if (!doc) return res.status(500).json({ error: 'Failed to generate rent invoice' });

    const mark = (action) => {
      if (doc.register_id) store.markInvoiceRegister({ id: doc.register_id, action }).catch(() => {});
    };

    const unitText = tenant.tenant_code ? ` for unit ${tenant.tenant_code}` : '';
    const caption = `Hello ${tenant.name}, please find attached your rent invoice for the current billing period${unitText}.`;

    if (mode === 'download') {
      mark('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Invoice-Number', doc.doc_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream rent invoice PDF' });
      });
    }

    try {
      await whatsapp.sendMediaMessage(tenant.phone_number, doc.file_path, caption);
      await store.logMessage({
        tenantId: tenant.id,
        messageType: 'Invoice',
        messageBody: `Rent invoice PDF sent successfully (${doc.doc_number})`,
        status: 'Sent',
      });
      mark('send');
    } catch (err) {
      await store.logMessage({
        tenantId: tenant.id,
        messageType: 'Invoice',
        messageBody: 'Failed to send Rent invoice PDF',
        status: 'Failed',
      });
      return res.status(500).json({ error: 'WhatsApp delivery failed: ' + err.message });
    }

    if (mode === 'both') {
      mark('download');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Invoice-Number', doc.doc_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream rent invoice PDF' });
      });
    }

    res.json({ success: true, message: 'Rent invoice sent successfully', invoice_no: doc.doc_number });
  } catch (err) {
    res.status(500).json({ error: 'Rent invoice operation failed: ' + err.message });
  }
});

module.exports = router;
