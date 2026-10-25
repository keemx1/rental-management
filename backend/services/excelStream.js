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
async function sendExcelReport(phone_number, workbook, filename, caption) {
  const tempFilePath = path.join(os.tmpdir(), `report_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(tempFilePath);
  const deliveryPath = renameForDelivery(tempFilePath, filename);
  const waResult = await whatsapp.sendDocumentSmart(phone_number, deliveryPath, caption);
  if (waResult.status !== 'Sent') throw new Error(waResult.failureReason || 'provider could not deliver the report');
  fs.unlinkSync(deliveryPath);
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
