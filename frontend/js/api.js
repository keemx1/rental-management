/**
 * Rental Messaging — API client
 */
const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('rental_token');
}
function setToken(t) {
  if (t) localStorage.setItem('rental_token', t);
  else localStorage.removeItem('rental_token');
}
function getUser() {
  const raw = localStorage.getItem('rental_user');
  return raw ? JSON.parse(raw) : null;
}
function setUser(u) {
  if (u) localStorage.setItem('rental_user', JSON.stringify(u));
  else localStorage.removeItem('rental_user');
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Multipart (file upload): auth header only, browser sets the boundary.
async function multipartRequest(path, formData) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function filenameFromDisposition(disposition) {
  if (!disposition) return 'invoice.pdf';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return (match && match[1]) || 'invoice.pdf';
}

async function blobRequest(url, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const contentType = res.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return { json: data };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return {
    blob: await res.blob(),
    invoice_no: res.headers.get('X-Invoice-Number') || null,
    exit_no: res.headers.get('X-Exit-Number') || null,
    statement_no: res.headers.get('X-Statement-Number') || null,
    filename: filenameFromDisposition(res.headers.get('Content-Disposition')),
  };
}

async function getBlob(url, params) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let target = `${API_BASE}${url}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) target += `?${qs}`;
  }
  const res = await fetch(target, { headers });
  const contentType = res.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return { json: data };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('Content-Disposition')),
  };
}

export const api = {
  getToken,
  setToken,
  getUser,
  setUser,
  logout() {
    setToken(null);
    setUser(null);
  },
  login(username, password) {
    return request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  },
  me() {
    return request('/auth/me');
  },
  metrics() {
    return request('/dashboard/metrics');
  },
  dashboardDrill(kind) {
    return request(`/dashboard/drilldown/${encodeURIComponent(kind)}`);
  },
  whatsappStatus() {
    return request('/network/whatsapp-status');
  },
  resetWhatsapp() {
    return request('/network/whatsapp-reset', { method: 'POST' });
  },
  tenants(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/tenants${qs ? `?${qs}` : ''}`);
  },
  tenant(id) {
    return request(`/tenants/${encodeURIComponent(id)}`);
  },
  tenantProfile(id) {
    return request(`/tenants/${encodeURIComponent(id)}/profile`);
  },
  createTenant(body) {
    return request('/tenants', { method: 'POST', body: JSON.stringify(body) });
  },
  updateTenant(id, body) {
    return request(`/tenants/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  toggleDeposit(id) {
    return request(`/tenants/${encodeURIComponent(id)}/deposit`, { method: 'PATCH' });
  },
  deleteTenant(id) {
    return request(`/tenants/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  markUnitVacant(id, body = {}) {
    return request(`/tenants/${encodeURIComponent(id)}/vacant`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  recordNoticeToVacate(id, body) {
    return request(`/tenants/${encodeURIComponent(id)}/notice-to-vacate`, { method: 'POST', body: JSON.stringify(body) });
  },
  markOccupied(id, body) {
    return request(`/tenants/${encodeURIComponent(id)}/occupy`, { method: 'POST', body: JSON.stringify(body) });
  },
  listAgreements(tenantId) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/agreements`);
  },
  uploadAgreement(tenantId, blob, filename) {
    const form = new FormData();
    form.append('file', blob, filename);
    return multipartRequest(`/tenants/${encodeURIComponent(tenantId)}/agreements`, form);
  },
  previewAgreement(tenantId, agreementId) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/agreements/${agreementId}/preview`);
  },
  deleteAgreement(tenantId, agreementId) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/agreements/${agreementId}`, { method: 'DELETE' });
  },
  listExitInvoices(tenant_code = null) {
    const qs = tenant_code ? `?tenant_code=${encodeURIComponent(tenant_code)}` : '';
    return request(`/exit-invoices${qs}`);
  },
  getExitInvoice(id) {
    return request(`/exit-invoices/${id}`);
  },
  createExitInvoice(body) {
    return request('/exit-invoices', { method: 'POST', body: JSON.stringify(body) });
  },
  updateExitInvoice(id, body) {
    return request(`/exit-invoices/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  finalizeExitInvoice(id, body = {}) {
    return request(`/exit-invoices/${id}/finalize`, { method: 'POST', body: JSON.stringify(body) });
  },
  deleteExitInvoice(id) {
    return request(`/exit-invoices/${id}`, { method: 'DELETE' });
  },
  downloadExitInvoice(id) {
    return blobRequest(`/exit-invoices/${id}/send`, { mode: 'download' });
  },
  sendExitInvoice(id, phone_number) {
    return request(`/exit-invoices/${id}/send`, { method: 'POST', body: JSON.stringify({ mode: 'send', phone_number }) });
  },
  archives(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/archive${qs ? `?${qs}` : ''}`);
  },
  archive(id) {
    return request(`/archive/${id}`);
  },
  archiveHistory(id) {
    return request(`/archive/${id}/history`);
  },
  preexitLookup(unit) {
    return request(`/preexit/lookup?unit=${encodeURIComponent(unit)}`);
  },
  preexitList(unit) {
    return request(`/preexit?unit=${encodeURIComponent(unit)}`);
  },
  preexitCreate(body) {
    return request('/preexit', { method: 'POST', body: JSON.stringify(body) });
  },
  preexitGet(id) {
    return request(`/preexit/${id}`);
  },
  preexitSave(id, body) {
    return request(`/preexit/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  preexitStatus(id, status) {
    return request(`/preexit/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
  },
  preexitShare(id) {
    return request(`/preexit/${id}/share`, { method: 'POST', body: JSON.stringify({}) });
  },
  preexitTransfer(id, itemIds) {
    return request(`/preexit/${id}/transfer`, { method: 'POST', body: JSON.stringify({ item_ids: itemIds }) });
  },
  globalSearch(q, limit) {
    return request(`/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`);
  },
  listLandlords(month) {
    return request(`/landlords${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  },
  createLandlord(body) {
    return request('/landlords', { method: 'POST', body: JSON.stringify(body) });
  },
  getLandlord(id, month) {
    return request(`/landlords/${id}${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  },
  updateLandlord(id, body) {
    return request(`/landlords/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  assignLandlordHouse(id, housePaybill) {
    return request(`/landlords/${id}/assign-house`, { method: 'POST', body: JSON.stringify({ house_paybill_number: housePaybill }) });
  },
  landlordLedger(id, paybill) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/ledger`);
  },
  generateCommissionInvoice(id, paybill, billingMonth) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/commission-invoice`, {
      method: 'POST', body: JSON.stringify({ billing_month: billingMonth }),
    });
  },
  recordCommissionPayment(id, paybill, body) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/commission-payments`, {
      method: 'POST', body: JSON.stringify(body),
    });
  },
  commissionStatement(id, paybill) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/statement`, { method: 'POST', body: JSON.stringify({}) });
  },
  voidCommissionInvoice(invoiceId) {
    return request(`/landlords/commission-invoices/${invoiceId}/void`, { method: 'POST', body: JSON.stringify({}) });
  },
  landlordDashboard(id, paybill, month) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/dashboard${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  },
  recordRemittancePayment(id, paybill, body) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/remittance-payments`, {
      method: 'POST', body: JSON.stringify(body),
    });
  },
  setRemittanceDay(id, paybill, day) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/remittance-day`, {
      method: 'PUT', body: JSON.stringify({ day }),
    });
  },
  remittanceStatement(id, paybill) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/remittance-statement`, { method: 'POST', body: JSON.stringify({}) });
  },
  verifyRemittancePayment(paymentId) {
    return request(`/landlords/remittance-payments/${paymentId}/verify`, { method: 'POST', body: JSON.stringify({}) });
  },
  landlordReconciliation(id, paybill, month) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/reconciliation${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  },
  finalizeLandlordLedger(id, paybill, billingMonth) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/finalize`, { method: 'POST', body: JSON.stringify({ billing_month: billingMonth }) });
  },
  reopenLandlordLedger(id, paybill, billingMonth) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/reopen`, { method: 'POST', body: JSON.stringify({ billing_month: billingMonth }) });
  },
  flagLandlordReview(id, paybill, body) {
    return request(`/landlords/${id}/properties/${encodeURIComponent(paybill)}/reviews`, { method: 'POST', body: JSON.stringify(body) });
  },
  resolveLandlordReview(reviewId) {
    return request(`/landlords/reviews/${reviewId}/resolve`, { method: 'POST', body: JSON.stringify({}) });
  },
  reverseFalsePayment(paymentId, reason) {
    return request(`/payments/${paymentId}/reverse-false`, { method: 'POST', body: JSON.stringify({ reason }) });
  },
  deleteArchive(id) {
    return request(`/archive/${id}`, { method: 'DELETE' });
  },
  occupancyHistory(houseId) {
    return request(`/archive/occupancy/house/${encodeURIComponent(houseId)}`);
  },
  resolveOverpayment(tenantId, body) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/resolve-overpayment`, { method: 'POST', body: JSON.stringify(body) });
  },
  skipOverpayment(paymentId, overpayment) {
    return request(`/payments/${paymentId}/skip-overpayment`, { method: 'POST', body: JSON.stringify({ overpayment }) });
  },
  pendingOverpayments(status) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(`/pending-overpayments${qs}`);
  },
  resolvePendingOverpayment(id, body) {
    return request(`/pending-overpayments/${id}/resolve`, { method: 'POST', body: JSON.stringify(body) });
  },
  applyCredit(tenantId, body) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/apply-credit`, { method: 'POST', body: JSON.stringify(body) });
  },
  importTenants(file_base64, house_id = null) {
    return request('/tenants/import', { method: 'POST', body: JSON.stringify({ file_base64, house_id }) });
  },
  payments(status) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(`/payments${qs}`);
  },
  createPayment(body) {
    return request('/payments', { method: 'POST', body: JSON.stringify(body) });
  },
  approvePayment(id) {
    return request(`/payments/${id}/approve`, { method: 'POST' });
  },
  syncHistoricalPayments() {
    return request('/payments/sync-history', { method: 'POST' });
  },
  deletePayment(id) {
    return request(`/payments/${id}`, { method: 'DELETE' });
  },
  resendPaymentWhatsApp(id) {
    return request(`/payments/${id}/resend-whatsapp`, { method: 'POST' });
  },
  sendPaymentReport(phone_number, house_id) {
    return request('/payments/send-report', { method: 'POST', body: JSON.stringify({ phone_number, house_id }) });
  },
  sendVacantReport(phone_number, house_id) {
    return request('/houses/send-vacant-report', { method: 'POST', body: JSON.stringify({ phone_number, house_id }) });
  },
  sendOutstandingReport(phone_number, house_id) {
    return request('/reports/outstanding-balances', { method: 'POST', body: JSON.stringify({ phone_number, house_id }) });
  },
  sendUnpaidReport(phone_number, house_id) {
    return request('/reports/unpaid-units', { method: 'POST', body: JSON.stringify({ phone_number, house_id }) });
  },
  sendDepositsReport(phone_number, house_id, month) {
    return request('/reports/deposits-new-tenants', { method: 'POST', body: JSON.stringify({ phone_number, house_id, month }) });
  },
  runRollover() {
    return request('/reports/rollover', { method: 'POST' });
  },
  parsePaymentMessage(raw_message) {
    return request('/payments/parse-message', { method: 'POST', body: JSON.stringify({ raw_message }) });
  },
  approvePaymentFromMessage({ raw_message, tenant_id, payment_date, client_txn_id }) {
    return request('/payments/approve-from-message', {
      method: 'POST',
      body: JSON.stringify({ raw_message, tenant_id, payment_date, client_txn_id }),
    });
  },
  approveCashPesaLink({ payment_mode, amount, payment_date, payment_time, tenant_code, tenant_id, client_txn_id }) {
    return request('/payments/approve-cash-pesalink', {
      method: 'POST',
      body: JSON.stringify({ payment_mode, amount, payment_date, payment_time, tenant_code, tenant_id, client_txn_id }),
    });
  },
  syncPull({ payments_days = 90, payments_limit = 5000 } = {}) {
    const qs = new URLSearchParams({ payments_days: String(payments_days), payments_limit: String(payments_limit) }).toString();
    return request(`/sync/pull?${qs}`);
  },
  listConflicts(status = 'pending') {
    return request(`/sync/conflicts?status=${encodeURIComponent(status)}`);
  },
  resolveConflict(id, resolution) {
    return request(`/sync/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution }) });
  },
  checkConflicts(client_txn_ids) {
    return request('/sync/conflicts/check', { method: 'POST', body: JSON.stringify({ client_txn_ids }) });
  },
  commissionReport({ month, house_paybill } = {}) {
    const qs = new URLSearchParams({ ...(month ? { month } : {}), ...(house_paybill ? { house_paybill } : {}) }).toString();
    return request(`/commissions${qs ? `?${qs}` : ''}`);
  },
  setCommissionRate(house_paybill_number, rate_percent) {
    return request('/commissions/rates', { method: 'PUT', body: JSON.stringify({ house_paybill_number, rate_percent }) });
  },
  houses(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/houses${qs ? `?${qs}` : ''}`);
  },
  house(id) {
    return request(`/houses/${id}`);
  },
  createHouse(body) {
    return request('/houses', { method: 'POST', body: JSON.stringify(body) });
  },
  updateHouse(id, body) {
    return request(`/houses/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  setHouseOccupancy(id, occupancy_status) {
    return request(`/houses/${id}`, { method: 'PUT', body: JSON.stringify({ occupancy_status }) });
  },
  deleteHouse(id) {
    return request(`/houses/${id}`, { method: 'DELETE' });
  },
  houseDashboard(id) {
    return request(`/houses/${encodeURIComponent(id)}/dashboard`);
  },
  houseCollection(id, period) {
    const qs = period ? `?period=${encodeURIComponent(period)}` : '';
    return request(`/houses/${encodeURIComponent(id)}/collection${qs}`);
  },
  templates() {
    return request('/templates');
  },
  createTemplate(body) {
    return request('/templates', { method: 'POST', body: JSON.stringify(body) });
  },
  updateTemplate(id, body) {
    return request(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteTemplate(id) {
    return request(`/templates/${id}`, { method: 'DELETE' });
  },
  sendBroadcast(body) {
    return request('/broadcasts/send', { method: 'POST', body: JSON.stringify(body) });
  },
  sendInvoice(body) {
    return request('/invoices/send', { method: 'POST', body: JSON.stringify(body) });
  },
  getInvoiceTenantSummary(tenantCode) {
    return request(`/invoices/tenant-summary/${encodeURIComponent(tenantCode)}`);
  },
  downloadInvoice(body) {
    return blobRequest('/invoices/send', { ...body, mode: 'download' });
  },
  sendAndDownloadInvoice(body) {
    return blobRequest('/invoices/send', { ...body, mode: 'both' });
  },
  downloadPaymentReport(house_id) {
    return blobRequest('/payments/send-report', { mode: 'download', house_id });
  },
  downloadVacantReport(house_id) {
    return blobRequest('/houses/send-vacant-report', { mode: 'download', house_id });
  },
  downloadOutstandingReport(house_id) {
    return blobRequest('/reports/outstanding-balances', { mode: 'download', house_id });
  },
  downloadUnpaidReport(house_id) {
    return blobRequest('/reports/unpaid-units', { mode: 'download', house_id });
  },
  downloadDepositsReport(house_id, month) {
    return blobRequest('/reports/deposits-new-tenants', { mode: 'download', house_id, month });
  },
  sendMessage(id, message, client_txn_id, channel) {
    return request(`/tenants/${encodeURIComponent(id)}/send-message`, {
      method: 'POST',
      body: JSON.stringify({ message, client_txn_id, channel }),
    });
  },
  listInspections({ limit = 100 } = {}) {
    return request(`/inspections?limit=${limit}`);
  },
  createInspection(body) {
    return request('/inspections', { method: 'POST', body: JSON.stringify(body) });
  },
  uploadOfflineMedia(body) {
    return request('/sync/media', { method: 'POST', body: JSON.stringify(body) });
  },
  users() {
    return request('/users');
  },
  createUser(body) {
    return request('/users', { method: 'POST', body: JSON.stringify(body) });
  },
  updateUser(id, body) {
    return request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteUser(id) {
    return request(`/users/${id}`, { method: 'DELETE' });
  },
  listPenalties(tenantCode) {
    return request(`/penalties/${encodeURIComponent(tenantCode)}`);
  },
  createPenalty(body) {
    return request('/penalties', { method: 'POST', body: JSON.stringify(body) });
  },
  payPenalty(id) {
    return request(`/penalties/${id}/pay`, { method: 'PATCH' });
  },
  deletePenalty(id) {
    return request(`/penalties/${id}`, { method: 'DELETE' });
  },
  getReceiptMode() {
    return request('/receipts/mode');
  },
  setReceiptMode(mode) {
    return request('/receipts/mode', { method: 'PATCH', body: JSON.stringify({ mode }) });
  },
  resetTestReceipts() {
    return request('/receipts/reset-test', { method: 'POST' });
  },
  documents(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/documents${qs ? `?${qs}` : ''}`);
  },
  document(id) {
    return request(`/documents/${id}`);
  },
  shareDocument(id, phone_number) {
    return request(`/documents/${id}/share-whatsapp`, {
      method: 'POST',
      body: JSON.stringify({ phone_number }),
    });
  },
  docTemplates() {
    return request('/documents/templates');
  },
  stampStatus() {
    return request('/settings/stamp');
  },
  async stampImageBlob() {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/settings/stamp/image`, { headers });
    if (!res.ok) throw new Error('No stamp preview available');
    return res.blob();
  },
  uploadStamp(formData) {
    return multipartRequest('/settings/stamp', formData);
  },
  setStampActive(active) {
    return request('/settings/stamp', { method: 'PATCH', body: JSON.stringify({ active }) });
  },
  deleteStamp() {
    return request('/settings/stamp', { method: 'DELETE' });
  },
  signatureStatus() {
    return request('/settings/signature');
  },
  async signatureImageBlob() {
    const headers = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/settings/signature/image`, { headers });
    if (!res.ok) throw new Error('No signature preview available');
    return res.blob();
  },
  uploadSignature(formData) {
    return multipartRequest('/settings/signature', formData);
  },
  patchSignature(body) {
    return request('/settings/signature', { method: 'PATCH', body: JSON.stringify(body || {}) });
  },
  deleteSignature() {
    return request('/settings/signature', { method: 'DELETE' });
  },
  arrangements(tenantCode) {
    return request(`/arrangements/tenant/${encodeURIComponent(tenantCode)}`);
  },
  createArrangement(body) {
    return request('/arrangements', { method: 'POST', body: JSON.stringify(body) });
  },
  approveArrangement(id, body) {
    return request(`/arrangements/${id}/approve`, { method: 'POST', body: JSON.stringify(body || {}) });
  },
  declineArrangement(id, body) {
    return request(`/arrangements/${id}/decline`, { method: 'POST', body: JSON.stringify(body || {}) });
  },
  modifyArrangement(id, body) {
    return request(`/arrangements/${id}`, { method: 'PATCH', body: JSON.stringify(body || {}) });
  },
  cancelArrangement(id, body) {
    return request(`/arrangements/${id}/cancel`, { method: 'POST', body: JSON.stringify(body || {}) });
  },
  expireArrangement(id, body) {
    return request(`/arrangements/${id}/expire`, { method: 'POST', body: JSON.stringify(body || {}) });
  },
  arrangementHistory(id) {
    return request(`/arrangements/${id}/history`);
  },
  paymentReceipt(id) {
    return request(`/payments/${id}/receipt`);
  },
  paymentDeliveryStatus(id) {
    return request(`/payments/${id}/delivery-status`);
  },
  resolveLetter({ template_key, tenant_code, values }) {
    return request('/documents/letters/resolve', {
      method: 'POST',
      body: JSON.stringify({ template_key, tenant_code, values }),
    });
  },
  placeholders(templateKey) {
    return request(`/documents/letters/placeholders${templateKey ? `?template_key=${encodeURIComponent(templateKey)}` : ''}`);
  },
  createLetter(body) {
    return request('/documents/letters', { method: 'POST', body: JSON.stringify(body) });
  },
  updateLetterDraft(id, body) {
    return request(`/documents/letters/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  finalizeLetter(id) {
    return request(`/documents/letters/${id}/finalize`, { method: 'POST' });
  },
  newVersionLetter(id) {
    return request(`/documents/letters/${id}/new-version`, { method: 'POST' });
  },
  deleteDocument(id) {
    return request(`/documents/${id}`, { method: 'DELETE' });
  },
  previewLetter(body) {
    return request('/documents/letters/preview', { method: 'POST', body: JSON.stringify(body) });
  },
  batchLetters(body) {
    return request('/documents/letters/batch', { method: 'POST', body: JSON.stringify(body) });
  },
  customNotice(body) {
    return request('/documents/letters/custom-notice', { method: 'POST', body: JSON.stringify(body) });
  },
  generateStatement(tenant_id, mode, period) {
    return request('/statements/generate', {
      method: 'POST',
      body: JSON.stringify({ tenant_id, mode, period }),
    });
  },
  downloadStatement(tenant_id, period) {
    return blobRequest('/statements/generate', { tenant_id, mode: 'download', period });
  },
  sendAndDownloadStatement(tenant_id, period) {
    return blobRequest('/statements/generate', { tenant_id, mode: 'both', period });
  },
  generateRentInvoice(tenant_id, mode, billing_period) {
    return request('/invoices/rent', {
      method: 'POST',
      body: JSON.stringify({ tenant_id, mode, billing_period }),
    });
  },
  downloadRentInvoice(tenant_id, billing_period) {
    return blobRequest('/invoices/rent', { tenant_id, mode: 'download', billing_period });
  },
  sendAndDownloadRentInvoice(tenant_id, billing_period) {
    return blobRequest('/invoices/rent', { tenant_id, mode: 'both', billing_period });
  },
  listMaintenanceInvoices(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/maintenance-invoices${qs ? '?' + qs : ''}`);
  },
  listEligibleManagementExpenses(house = null) {
    const qs = house ? `?house=${encodeURIComponent(house)}` : '';
    return request(`/maintenance-invoices/eligible${qs}`);
  },
  getMaintenanceInvoice(id) {
    return request(`/maintenance-invoices/${id}`);
  },
  createMaintenanceInvoice(body) {
    return request('/maintenance-invoices', { method: 'POST', body: JSON.stringify(body) });
  },
  updateMaintenanceInvoice(id, body) {
    return request(`/maintenance-invoices/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  linkWoExpenses(invoiceId, woId, issueNos) {
    return request(`/maintenance-invoices/${invoiceId}/link-wo`, {
      method: 'POST',
      body: JSON.stringify({ wo_id: woId, issue_nos: issueNos }),
    });
  },
  recordExpensePayment(invoiceId, payment) {
    return request(`/maintenance-invoices/${invoiceId}/payments`, {
      method: 'POST', body: JSON.stringify(payment),
    });
  },
  getExpensePayments(invoiceId) {
    return request(`/maintenance-invoices/${invoiceId}/payments`);
  },
  deleteExpensePayment(invoiceId, paymentId) {
    return request(`/maintenance-invoices/${invoiceId}/payments/${paymentId}`, { method: 'DELETE' });
  },
  listSalaryRecords(month) {
    return request(`/salary?month=${encodeURIComponent(month)}`);
  },
  listSalaryEmployees() {
    return request('/salary/employees');
  },
  getSalaryHistory(employee) {
    return request(`/salary/history/${encodeURIComponent(employee)}`);
  },
  createSalaryRecord(body) {
    return request('/salary', { method: 'POST', body: JSON.stringify(body) });
  },
  updateSalaryRecord(id, body) {
    return request(`/salary/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteSalaryRecord(id) {
    return request(`/salary/${id}`, { method: 'DELETE' });
  },
  getSalaryRecord(id) {
    return request(`/salary/${id}`);
  },
  recordSalaryPayment(recordId, payment) {
    return request(`/salary/${recordId}/payments`, { method: 'POST', body: JSON.stringify(payment) });
  },
  getSalaryPayments(recordId) {
    return request(`/salary/${recordId}/payments`);
  },
  deleteSalaryPayment(recordId, paymentId) {
    return request(`/salary/${recordId}/payments/${paymentId}`, { method: 'DELETE' });
  },
  rollOverSalaries(month) {
    return request('/salary/rollover', { method: 'POST', body: JSON.stringify({ month }) });
  },
  downloadSalaryInvoice(recordId) {
    return getBlob(`/salary/${recordId}/invoice`, { mode: 'download' });
  },
  generateSalaryInvoice(recordId) {
    return request(`/salary/${recordId}/invoice?mode=info`);
  },
  downloadReimbursementInvoice(invoiceId) {
    return getBlob(`/maintenance-invoices/${invoiceId}/reimbursement-invoice`, { mode: 'download' });
  },
  generateReimbursementInvoice(invoiceId) {
    return request(`/maintenance-invoices/${invoiceId}/reimbursement-invoice?mode=info`);
  },
  downloadExpenseInvoice(invoiceId) {
    return getBlob(`/maintenance-invoices/${invoiceId}/expense-invoice`, { mode: 'download' });
  },
  generateExpenseInvoice(invoiceId) {
    return request(`/maintenance-invoices/${invoiceId}/expense-invoice?mode=info`);
  },
  getManagementExpensesReport(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request('/management-expenses-report' + (qs ? '?' + qs : ''));
  },
  downloadManagementExpensesReport(params = {}) {
    return blobRequest('/management-expenses-report/pdf', params);
  },
  getPropertyExpenseReport(property, month) {
    const params = new URLSearchParams({ property });
    if (month) params.set('month', month);
    return request('/management-expenses-report/property?' + params.toString());
  },
  deleteMaintenanceInvoice(id) {
    return request(`/maintenance-invoices/${id}`, { method: 'DELETE' });
  },
  generateMaintenanceInvoice(id, mode, phone_number) {
    return request(`/maintenance-invoices/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ mode, phone_number }),
    });
  },
  downloadMaintenanceInvoice(id) {
    return blobRequest(`/maintenance-invoices/${id}/generate`, { mode: 'download' });
  },
  sendAndDownloadMaintenanceInvoice(id, phone_number) {
    return blobRequest(`/maintenance-invoices/${id}/generate`, { mode: 'both', phone_number });
  },
  listWorkOrders(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/work-orders${qs ? '?' + qs : ''}`);
  },
  getWorkOrder(id) {
    return request(`/work-orders/${id}`);
  },
  createWorkOrder(body) {
    return request('/work-orders', { method: 'POST', body: JSON.stringify(body) });
  },
  updateWorkOrder(id, body) {
    return request(`/work-orders/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteWorkOrder(id) {
    return request(`/work-orders/${id}`, { method: 'DELETE' });
  },
  generateWorkOrder(id, mode, phone_number) {
    return request(`/work-orders/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ mode, phone_number }),
    });
  },
  downloadWorkOrder(id) {
    return blobRequest(`/work-orders/${id}/generate`, { mode: 'download' });
  },
  sendAndDownloadWorkOrder(id, phone_number) {
    return blobRequest(`/work-orders/${id}/generate`, { mode: 'both', phone_number });
  },
  invoiceRegister(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/invoice-register${qs ? `?${qs}` : ''}`);
  },
  invoiceRegisterMonthly(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/invoice-register/monthly${qs ? `?${qs}` : ''}`);
  },
  invoiceRegisterById(id) {
    return request(`/invoice-register/${id}`);
  },
  invoiceRegisterByNumber(invoiceNumber) {
    return request(`/invoice-register/by-number/${encodeURIComponent(invoiceNumber)}`);
  },
  downloadRegisterDocument(id, inline = false) {
    return getBlob(`/invoice-register/${id}/document`, inline ? { inline: '1' } : null);
  },
  viewRegisterDocument(id) {
    return getBlob(`/invoice-register/${id}/document`, { inline: '1' });
  },
  resendInvoiceRegister(id, phone_number) {
    return request(`/invoice-register/${id}/send`, {
      method: 'POST',
      body: JSON.stringify({ phone_number }),
    });
  },
  updateInvoiceRegister(id, body) {
    return request(`/invoice-register/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body || {}),
    });
  },
  deleteInvoiceRegister(id) {
    return request(`/invoice-register/${id}`, { method: 'DELETE' });
  },
  listMonthlyReports() {
    return request('/monthly-reports');
  },
  getMonthlyReport(month, housePaybill) {
    const qs = housePaybill ? `?house_paybill=${encodeURIComponent(housePaybill)}` : '';
    return request(`/monthly-reports/${encodeURIComponent(month)}${qs}`);
  },
  refreshMonthlyReport(month, housePaybill) {
    return request(`/monthly-reports/${encodeURIComponent(month)}/refresh`, {
      method: 'POST',
      body: JSON.stringify({ house_paybill: housePaybill || null }),
    });
  },
  downloadMonthlyReport(month, housePaybill) {
    return blobRequest(`/monthly-reports/${encodeURIComponent(month)}/excel`, { house_paybill: housePaybill || null });
  },
  getDepositPreview(tenantId, billingPeriod) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/deposit-preview?billing_period=${encodeURIComponent(billingPeriod)}`);
  },
  applyDepositToRent(tenantId, body) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/apply-deposit`, { method: 'POST', body: JSON.stringify(body) });
  },
  recordRentLoss(tenantId, body) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/record-loss`, { method: 'POST', body: JSON.stringify(body) });
  },
  getDepositApplications(tenantId) {
    return request(`/tenants/${encodeURIComponent(tenantId)}/deposit-applications`);
  },
  downloadCollectionReport(house_id, billing_month) {
    return getBlob('/payments/collection-report', { mode: 'download', house_id, billing_month });
  },
  sendCollectionReport(house_id, billing_month, phone_number) {
    return request('/payments/collection-report', { method: 'POST', body: JSON.stringify({ house_id, billing_month, mode: 'send', phone_number }) });
  },
  // Staff Advances (Phase 6)
  listStaffAdvances(employee) {
    const qs = employee ? `?employee=${encodeURIComponent(employee)}` : '';
    return request('/staff-advances' + qs);
  },
  listStaffAdvanceEmployees() {
    return request('/staff-advances/employees');
  },
  getStaffAdvance(id) {
    return request(`/staff-advances/${id}`);
  },
  createStaffAdvance(body) {
    return request('/staff-advances', { method: 'POST', body: JSON.stringify(body) });
  },
  updateStaffAdvance(id, body) {
    return request(`/staff-advances/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteStaffAdvance(id) {
    return request(`/staff-advances/${id}`, { method: 'DELETE' });
  },
  getStaffAdvancePayments(id) {
    return request(`/staff-advances/${id}/payments`);
  },
  recordStaffAdvancePayment(id, payment) {
    return request(`/staff-advances/${id}/payments`, { method: 'POST', body: JSON.stringify(payment) });
  },
  deleteStaffAdvancePayment(advanceId, paymentId) {
    return request(`/staff-advances/payments/${paymentId}`, { method: 'DELETE' });
  },
  // Employee Rent (Phase 6)
  listEmployeeRent(employee, period) {
    const params = new URLSearchParams();
    if (employee) params.set('employee', employee);
    if (period) params.set('period', period);
    const qs = params.toString() ? '?' + params.toString() : '';
    return request('/employee-rent' + qs);
  },
  listEmployeeRentEmployees() {
    return request('/employee-rent/employees');
  },
  getEmployeeRent(id) {
    return request(`/employee-rent/${id}`);
  },
  createEmployeeRent(body) {
    return request('/employee-rent', { method: 'POST', body: JSON.stringify(body) });
  },
  updateEmployeeRent(id, body) {
    return request(`/employee-rent/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteEmployeeRent(id) {
    return request(`/employee-rent/${id}`, { method: 'DELETE' });
  },
  getEmployeeRentPayments(id) {
    return request(`/employee-rent/${id}/payments`);
  },
  recordEmployeeRentPayment(id, payment) {
    return request(`/employee-rent/${id}/payments`, { method: 'POST', body: JSON.stringify(payment) });
  },
  deleteEmployeeRentPayment(rentId, paymentId) {
    return request(`/employee-rent/payments/${paymentId}`, { method: 'DELETE' });
  },
  deductRentFromSalary(rentId, salaryRecordId, amount, recordedBy) {
    return request(`/employee-rent/${rentId}/deduct-from-salary`, {
      method: 'POST',
      body: JSON.stringify({ salary_record_id: salaryRecordId, amount, recorded_by: recordedBy }),
    });
  },
  // Salary Deductions (Phase 6)
  listSalaryDeductions(employee, month) {
    const params = new URLSearchParams();
    if (employee) params.set('employee', employee);
    if (month) params.set('month', month);
    const qs = params.toString() ? '?' + params.toString() : '';
    return request('/salary-deductions' + qs);
  },
  getSalaryDeductionsForMonth(employee, month) {
    return request(`/salary-deductions/for-month?employee=${encodeURIComponent(employee)}&month=${encodeURIComponent(month)}`);
  },
  createSalaryDeduction(body) {
    return request('/salary-deductions', { method: 'POST', body: JSON.stringify(body) });
  },
  updateSalaryDeduction(id, body) {
    return request(`/salary-deductions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteSalaryDeduction(id) {
    return request(`/salary-deductions/${id}`, { method: 'DELETE' });
  },
  // Staff Advance Invoice
  downloadStaffAdvanceInvoice(id) {
    return getBlob(`/staff-advances/${id}/invoice`, { mode: 'download' });
  },
  generateStaffAdvanceInvoice(id) {
    return request(`/staff-advances/${id}/invoice?mode=info`);
  },
  // Employee Rent Invoice
  downloadEmployeeRentInvoice(id) {
    return getBlob(`/employee-rent/${id}/invoice`, { mode: 'download' });
  },
  generateEmployeeRentInvoice(id) {
    return request(`/employee-rent/${id}/invoice?mode=info`);
  },

  // Deposit Refunds
  listDepositRefunds(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/deposit-refunds${qs ? '?' + qs : ''}`);
  },
  getDepositRefundSummary() {
    return request('/deposit-refunds/summary');
  },
  getDepositRefund(id) {
    return request(`/deposit-refunds/${id}`);
  },
  recordDepositRefund(id, body) {
    return request(`/deposit-refunds/${id}/record-refund`, { method: 'POST', body: JSON.stringify(body) });
  },
  updateDepositRefund(id, body) {
    return request(`/deposit-refunds/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },

  // WhatsApp Module
  waStatus() {
    return request('/whatsapp/status');
  },
  waConnect() {
    return request('/whatsapp/connect', { method: 'POST' });
  },
  waSimulateScan() {
    return request('/whatsapp/simulate-scan', { method: 'POST' });
  },
  waDisconnect() {
    return request('/whatsapp/disconnect', { method: 'POST' });
  },
  waLogout() {
    return request('/whatsapp/logout', { method: 'POST' });
  },
  waQR() {
    return request('/whatsapp/qr');
  },
  waSendTest(phone, message) {
    return request('/whatsapp/send-test', { method: 'POST', body: JSON.stringify({ phone, message }) });
  },
  waSettings() {
    return request('/whatsapp/settings');
  },
  waUpdateSettings(settings) {
    return request('/whatsapp/settings', { method: 'PUT', body: JSON.stringify(settings) });
  },
  waMessages(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/whatsapp/messages${qs ? '?' + qs : ''}`);
  },
  waMessageStats() {
    return request('/whatsapp/messages/stats');
  },
  waQueueStats() {
    return request('/whatsapp/queue/stats');
  },
  waQueueRecent(limit = 50) {
    return request(`/whatsapp/queue/recent?limit=${limit}`);
  },
  waQueueRetry(id) {
    return request(`/whatsapp/queue/retry/${id}`, { method: 'POST' });
  },
  waQueueCancel(id) {
    return request(`/whatsapp/queue/${id}`, { method: 'DELETE' });
  },
  waTemplates() {
    return request('/whatsapp/templates');
  },
  waTemplatePreview(key) {
    return request(`/whatsapp/templates/${key}/preview`, { method: 'POST' });
  },
  // ─── SMS Module (Bytewave) ─────────────────────────────────────────────────
  smsStatus() {
    return request('/sms/status');
  },
  smsUpdateSettings(settings) {
    return request('/sms/settings', { method: 'PUT', body: JSON.stringify(settings) });
  },
  smsBalance() {
    return request('/sms/balance');
  },
  smsSendTest(phone, message) {
    return request('/sms/send-test', { method: 'POST', body: JSON.stringify({ phone, message }) });
  },
  smsMessages(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/sms/messages${qs ? '?' + qs : ''}`);
  },
  // ─── Future Tenancies ───────────────────────────────────────────────────
  futureTenancies(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/future-tenancies${qs ? '?' + qs : ''}`);
  },
  futureTenancy(id) {
    return request(`/future-tenancies/${id}`);
  },
  createFutureTenancy(body) {
    return request('/future-tenancies', { method: 'POST', body: JSON.stringify(body) });
  },
  updateFutureTenancy(id, body) {
    return request(`/future-tenancies/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  cancelFutureTenancy(id) {
    return request(`/future-tenancies/${id}/cancel`, { method: 'POST' });
  },
  activateFutureTenancy(id) {
    return request(`/future-tenancies/${id}/activate`, { method: 'POST' });
  },
  // ─── House Charges ────────────────────────────────────────────────────────
  houseCharges(houseId) {
    return request(`/house-charges/${houseId}`);
  },
  createHouseCharge(houseId, body) {
    return request(`/house-charges/${houseId}`, { method: 'POST', body: JSON.stringify(body) });
  },
  updateHouseCharge(houseId, chargeId, body) {
    return request(`/house-charges/${houseId}/${chargeId}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  toggleHouseCharge(houseId, chargeId) {
    return request(`/house-charges/${houseId}/${chargeId}/toggle`, { method: 'PATCH' });
  },
  deleteHouseCharge(houseId, chargeId) {
    return request(`/house-charges/${houseId}/${chargeId}`, { method: 'DELETE' });
  },
  futureTenancyPayments(id) {
    return request(`/future-tenancies/${id}/payments`);
  },
  createFuturePayment(tenancyId, body) {
    return request(`/future-tenancies/${tenancyId}/payments`, { method: 'POST', body: JSON.stringify(body) });
  },
  approveFuturePayment(paymentId) {
    return request(`/future-tenancies/payments/${paymentId}/approve`, { method: 'POST' });
  },
  cancelFuturePayment(paymentId) {
    return request(`/future-tenancies/payments/${paymentId}/cancel`, { method: 'POST' });
  },
  // ─── Enhanced Monthly Report ─────────────────────────────────────────────
  getEnhancedMonthlyReport(month, housePaybill) {
    const qs = housePaybill ? `?house_paybill=${encodeURIComponent(housePaybill)}` : '';
    return request(`/monthly-reports/${encodeURIComponent(month)}/enhanced${qs}`);
  },
  downloadEnhancedMonthlyReport(month, housePaybill) {
    return blobRequest(`/monthly-reports/${encodeURIComponent(month)}/enhanced/excel`, { house_paybill: housePaybill || null });
  },
  getWaterBillReport({ house_paybill, billing_month, unit } = {}) {
    const qs = new URLSearchParams({ ...(house_paybill ? { house_paybill } : {}), ...(billing_month ? { billing_month } : {}), ...(unit ? { unit } : {}) }).toString();
    return request(`/monthly-reports/water/report${qs ? `?${qs}` : ''}`);
  },
  downloadWaterBillReport({ house_paybill, billing_month, unit } = {}) {
    return blobRequest('/monthly-reports/water/pdf', { house_paybill, billing_month, unit: unit || null });
  },
  sendWaterBillReport({ house_paybill, billing_month, unit, phone } = {}) {
    return request('/monthly-reports/water/send', { method: 'POST', body: JSON.stringify({ house_paybill, billing_month, unit: unit || null, phone }) });
  },

  // ─── Water Invoices ─────────────────────────────────────────────────────
  listWaterInvoices(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/water-invoices${qs ? '?' + qs : ''}`);
  },
  getWaterInvoice(id) {
    return request(`/water-invoices/${id}`);
  },
  createWaterInvoice(body) {
    return request('/water-invoices', { method: 'POST', body: JSON.stringify(body) });
  },
  updateWaterInvoice(id, body) {
    return request(`/water-invoices/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  finalizeWaterInvoice(id) {
    return request(`/water-invoices/${id}/finalize`, { method: 'POST' });
  },
  voidWaterInvoice(id, reason) {
    return request(`/water-invoices/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
  },
  deleteWaterInvoice(id) {
    return request(`/water-invoices/${id}`, { method: 'DELETE' });
  },
  downloadWaterInvoice(id) {
    return blobRequest(`/water-invoices/${id}/send`, { mode: 'download' });
  },
  sendWaterInvoice(id) {
    return request(`/water-invoices/${id}/send`, { method: 'POST', body: JSON.stringify({ mode: 'send' }) });
  },
  getWaterRate(housePaybill) {
    return request(`/water-invoices/rates/${encodeURIComponent(housePaybill)}`);
  },
  updateWaterRate(housePaybill, body) {
    return request(`/water-invoices/rates/${encodeURIComponent(housePaybill)}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  getWaterRateHistory(housePaybill) {
    return request(`/water-invoices/rates/${encodeURIComponent(housePaybill)}/history`);
  },
  getLatestWaterReading(tenantCode) {
    return request(`/water-invoices/latest-reading/${encodeURIComponent(tenantCode)}`);
  },
  findTenantByPropertyAndUnit(housePaybill, unitLabel) {
    return request(`/water-invoices/find-tenant/${encodeURIComponent(housePaybill)}/${encodeURIComponent(unitLabel)}`);
  },
};
