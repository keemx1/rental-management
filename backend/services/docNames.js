const fs = require('fs');
const path = require('path');

function clean(s, fallback = '') {
  return String(s ?? fallback)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanLabel(s, fallback = '') {
  return String(s ?? fallback)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function upperClean(s, fallback = '') {
  return clean(s, fallback).toUpperCase();
}

function titleClean(s, fallback = '') {
  return clean(s, fallback).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function monthYearLabel(date) {
  const d = date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return `${d.toLocaleString('en-US', { month: 'long' })}-${d.getFullYear()}`;
}

function invoiceDocumentName({ invoiceNo, invoiceType, tenantName, houseName, unitCode }) {
  let no = String(invoiceNo || 'INVOICE');
  if (invoiceType === 'exit') no = no.replace('-INV-', '-EXIT-');
  const parts = [no, upperClean(tenantName), upperClean(houseName), clean(unitCode)].filter(Boolean);
  return parts.join('_') + '.pdf';
}

function receiptDocumentName({ receiptNo, tenantName, unitCode }) {
  const parts = [String(receiptNo || 'RECEIPT'), upperClean(tenantName), clean(unitCode)].filter(Boolean);
  return parts.join('_') + '.pdf';
}

function statementDocumentName({ statementNo, tenantName, houseName, unitCode }) {
  const parts = [String(statementNo || 'STATEMENT'), upperClean(tenantName), upperClean(houseName), clean(unitCode)].filter(Boolean);
  return parts.join('_') + '.pdf';
}

function maintenanceInvoiceDocumentName({ mntNo, houseName, unitCodes }) {
  const parts = [String(mntNo || 'MAINTENANCE'), upperClean(houseName), clean(unitCodes)].filter(Boolean);
  return parts.join('_') + '.pdf';
}

function workOrderDocumentName({ woNo, houseName, unitCodes }) {
  const parts = [String(woNo || 'WORK-ORDER'), upperClean(houseName), clean(unitCodes)].filter(Boolean);
  return parts.join('_') + '.pdf';
}

function exitInvoiceDocumentName({ exitNo, tenantName, houseName, unitCode }) {
  const parts = [String(exitNo || 'EXIT-INVOICE'), upperClean(tenantName), upperClean(houseName), clean(unitCode)].filter(Boolean);
  return parts.join('_') + '.pdf';
}

function reportDocumentName({ type, houseName, date, ext = 'xlsx' }) {
  const typeLabel = cleanLabel(String(type || 'Report'), 'Report');
  const house = houseName ? titleClean(houseName) : 'All-Houses';
  return `${typeLabel}_${house}_${monthYearLabel(date)}.${ext}`;
}

function renameForDelivery(filePath, docName) {
  const target = path.join(path.dirname(filePath), docName);
  fs.renameSync(filePath, target);
  return target;
}

module.exports = {
  clean,
  cleanLabel,
  upperClean,
  titleClean,
  monthYearLabel,
  invoiceDocumentName,
  receiptDocumentName,
  statementDocumentName,
  maintenanceInvoiceDocumentName,
  workOrderDocumentName,
  exitInvoiceDocumentName,
  reportDocumentName,
  renameForDelivery,
};
