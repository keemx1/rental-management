const fs = require('fs');
const path = require('path');
const os = require('os');
const whatsapp = require('../config/whatsapp');
const { renameForDelivery } = require('./docNames');

async function writeWorkbookTemp(workbook, baseName) {
  const tempFilePath = path.join(os.tmpdir(), `${baseName}_${Date.now()}_${Math.floor(Math.random() * 100000)}.xlsx`);
  await workbook.xlsx.writeFile(tempFilePath);
  return tempFilePath;
}

/**
 * Deliver a generated workbook to a phone number via WhatsApp.
 * Shared by every Excel report route (reports, payments, houses...).
 */
/**
 * Generate + deliver a workbook via WhatsApp using the SAME ExcelJS
 * serialisation as the Download button (writeWorkbookTemp), with honest,
 * stage-tagged errors and cleanup that can never fail a successful send:
 *   err.reportStage = 'generate' -> the workbook could not be produced
 *   err.reportStage = 'send'     -> workbook produced, WhatsApp delivery failed
 */
async function sendExcelReport(phone_number, workbook, filename, caption) {
  let tempFilePath = null;
  try {
    tempFilePath = await writeWorkbookTemp(workbook, 'report');
  } catch (e) {
    const err = new Error(`Excel generation failed: ${e.message}`);
    err.reportStage = 'generate';
    throw err;
  }

  let deliveryPath = null;
  try {
    deliveryPath = renameForDelivery(tempFilePath, filename);
  } catch (e) {
    const err = new Error(`Excel generation failed: could not prepare file (${e.message})`);
    err.reportStage = 'generate';
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (_) {}
    throw err;
  }

  let waResult = null;
  try {
    waResult = await whatsapp.sendDocumentSmart(phone_number, deliveryPath, caption);
  } catch (e) {
    waResult = { status: 'Failed', failureReason: e.message };
  }

  // Cleanup AFTER delivery — and never let it mask a successful send.
  try { if (deliveryPath && fs.existsSync(deliveryPath)) fs.unlinkSync(deliveryPath); } catch (_) {}
  try { if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (_) {}

  if (!waResult || waResult.status !== 'Sent') {
    const err = new Error((waResult && waResult.failureReason) || 'WhatsApp session not connected');
    err.reportStage = 'send';
    throw err;
  }
  return waResult;
}

function streamWorkbook(res, workbook, baseName, displayName, filename) {
  const today = new Date().toISOString().slice(0, 10);
  const computed = `${(displayName || baseName).replace(/[^A-Za-z0-9._-]/g, '_')}_${today}.xlsx`;
  const file = filename || computed;
  writeWorkbookTemp(workbook, baseName)
    .then((tempFilePath) => {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
      res.setHeader('X-Report-Filename', file);
      res.sendFile(tempFilePath, (err) => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream report' });
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      });
    })
    .catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'Failed to generate report' });
    });
}

module.exports = { streamWorkbook, writeWorkbookTemp, sendExcelReport };
