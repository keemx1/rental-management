import { api } from './api.js';

let currentView = 'login';
let metricsPoll = null;
let waPoll = null;
let housesCache = [];
let templatesCache = [];
let activeHouseId = null;
let activeTenantCode = null;
let houseEditReturnView = 'houses';

function formatKes(val) {
  return 'KES ' + Number(val || 0).toLocaleString();
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setTextEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function isAdmin() {
  return api.getUser()?.role === 'admin';
}

function showView(name) {
  currentView = name;
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.view !== name);
  });
  // Desktop sidebar: hide on login
  document.getElementById('sidebar')?.classList.toggle('hidden', name === 'login');
  // Login mode: collapse grid so login centers on full width
  document.querySelector('.app-shell')?.classList.toggle('login-mode', name === 'login');
  // Mobile header: hide on login
  document.getElementById('main-nav')?.classList.toggle('hidden', name === 'login');
  // Mobile drawer: also hide on login
  document.getElementById('nav-container')?.classList.toggle('hidden', name === 'login');
  // Active state on both desktop sidebar links and mobile nav links
  document.querySelectorAll('.nav-link, .sidebar-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
  window.scrollTo(0, 0);
  if (name === 'dashboard') loadDashboard();
  if (name === 'houses') loadHouses();
  if (name === 'tenants') loadTenants();
  if (name === 'payments') loadPayments();
  if (name === 'broadcasts') loadBroadcastCenter();
  if (name === 'whatsapp') refreshWhatsappBeacon();
  if (name === 'invoices') loadInvoicesCenter();
  if (name === 'work-orders') loadWorkOrders();
  if (name === 'documents') loadDocuments();
  if (name === 'invoice-register') loadInvoiceRegister();
  if (name === 'monthly-reports') loadMonthlyReports();
  if (name === 'mgmt-expenses-report') {
    document.getElementById('mer-month').value = new Date().toISOString().slice(0, 7);
    document.getElementById('mer-date-from').value = '';
    document.getElementById('mer-date-to').value = '';
    populatePropertyDropdowns();
  }
  if (name === 'archive') loadArchive();
  if (name === 'pending-overpayments') loadPendingOverpayments();
  if (name === 'deposit-refunds') loadDepositRefunds();
  if (name === 'users') loadUsers();
  if (name === 'reports') {
    document.getElementById('report-phone').value = '';
    refreshHouseOptions();
    loadReceiptMode();
  }
  if (name === 'house-dashboard') loadHouseDashboardPage(activeHouseId);
  if (name === 'tenant-dashboard') loadTenantDashboard(activeTenantCode);
}

function setHash(hash) {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

function parseRoute() {
  const raw = (window.location.hash || '').replace(/^#/, '');
  if (!raw) return { view: null };
  const [head, id] = raw.split('/');
  if (head === 'house' && id) return { view: 'house-dashboard', houseId: id };
  if (head === 'tenant' && id) return { view: 'tenant-dashboard', tenantCode: id };
  return { view: null };
}

function applyRoute() {
  const route = parseRoute();
  if (route.view === 'house-dashboard') {
    activeHouseId = route.houseId;
    showView('house-dashboard');
    return true;
  }
  if (route.view === 'tenant-dashboard') {
    activeTenantCode = route.tenantCode;
    showView('tenant-dashboard');
    return true;
  }
  return false;
}

async function loadTenantDashboard(code) {
  if (!code) return;

  // Reset fields to loading state
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('td-title', 'Loading…');
  setText('td-subtitle', '');
  setText('td-info-name', '…');
  setText('td-info-code', '…');
  setText('td-info-phone', '…');
  setText('td-info-national-id', '…');
  setText('td-info-rent', '…');
  setText('td-info-due', '…');
  setText('td-info-water', '…');
  setText('td-house-name', '…');
  setText('td-house-paybill', '…');
  setText('td-house-units', '…');
  const tbody = document.getElementById('td-payments-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-500">Loading…</td></tr>';

  try {
    const { tenant, house, payments, totalPaid, pendingAmount, summary, maintenanceCharges } = await api.tenantProfile(code);
    const s = summary || {};

    // Header
    setText('td-title', `${tenant.name || tenant.tenant_code}`);
    setText('td-subtitle', `Unit ${tenant.tenant_code} — ${house ? house.house_name : tenant.property_name || '—'}`);

    // Tenant info
    setText('td-info-name', tenant.name || '—');
    setText('td-info-code', tenant.tenant_code || '—');
    setText('td-info-phone', tenant.phone_number || '—');
    setText('td-info-national-id', tenant.national_id || '—');
    setText('td-info-rent', `KES ${Number(tenant.rent_amount || 0).toLocaleString()}`);

    // Format next rent due date dynamically — always 5th of next month
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 5);
    const day = nextMonth.getDate();
    const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
    setText('td-info-due', `${day}${suffix} ${monthNames[nextMonth.getMonth()]} ${nextMonth.getFullYear()}`);
    setText('td-info-movein', tenant.move_in_date || '—');
    setText('td-info-water', tenant.water_charge_amount ? `KES ${Number(tenant.water_charge_amount).toLocaleString()} / month` : '—');

    // House info
    setText('td-house-name', house ? house.house_name : '—');
    setText('td-house-paybill', house ? house.paybill_number : '—');
    setText('td-house-units', house ? house.total_units : '—');

    // Payment status bar
    const payStatus = s.payment_status || 'Not Paid';
    const payPct = s.payment_percent || 0;
    const balance = s.balance || 0;
    const rentAmt = s.rent_amount || 0;

    const statusEl = document.getElementById('td-payment-status-text');
    if (statusEl) statusEl.textContent = payStatus.toUpperCase();

    const bar = document.getElementById('td-payment-bar');
    if (bar) {
      let barColor = 'bg-red-500';
      if (payStatus === 'Fully Paid') barColor = 'bg-green-500';
      else if (payStatus === 'Overpaid') barColor = 'bg-cyan-400';
      else if (payStatus === 'Partial') barColor = 'bg-amber-400';
      bar.className = `h-2 rounded-full transition-all duration-500 ${barColor}`;
      bar.style.width = Math.min(payPct, 100) + '%';
    }

    const balanceEl = document.getElementById('td-balance-label');
    if (balanceEl) {
      balanceEl.textContent = balance > 0 ? `KES ${Number(balance).toLocaleString()}` : balance < 0 ? `KES ${Number(Math.abs(balance)).toLocaleString()} overpaid` : 'KES 0';
      balanceEl.className = balance > 0 ? 'font-mono font-bold text-xl text-red-400' : balance < 0 ? 'font-mono font-bold text-xl text-cyan-400' : 'font-mono font-bold text-xl text-green-400';
    }

    setText('td-paid-label', `KES ${totalPaid.toLocaleString()}`);
    setText('td-rent-label', `KES ${rentAmt.toLocaleString()}`);

    const arrears = s.arrears || 0;
    const arrearsRow = document.getElementById('td-arrears-row');
    if (arrearsRow) {
      if (arrears > 0) {
        arrearsRow.style.display = '';
        setText('td-arrears-label', `KES ${Number(arrears).toLocaleString()}`);
      } else {
        arrearsRow.style.display = 'none';
      }
    }

    const depositAmount = s.deposit_amount || 0;
    const depositPaid = s.deposit_paid || 0;
    const depositRow = document.getElementById('td-deposit-row');
    if (depositRow) {
      if (depositAmount > 0) {
        depositRow.style.display = '';
        setText('td-deposit-label', `KES ${Number(depositPaid).toLocaleString()} / KES ${Number(depositAmount).toLocaleString()}`);
        const toggleBtn = document.getElementById('td-deposit-toggle');
        if (toggleBtn) {
          const isPaid = depositPaid >= depositAmount;
          toggleBtn.textContent = isPaid ? 'PAID' : 'NOT PAID';
          toggleBtn.className = isPaid
            ? 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-green-500 bg-green-500/20 text-green-400 transition-all'
            : 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-amber-500 bg-amber-500/20 text-amber-400 transition-all';
          toggleBtn.onclick = async () => {
            toggleBtn.disabled = true;
            try {
              await api.toggleDeposit(code);
              loadTenantDashboard(code);
            } catch (err) {
              alert(err.message);
              toggleBtn.disabled = false;
            }
          };
        }
      } else {
        depositRow.style.display = 'none';
      }
    }

    // Garbage fee
    const garbageFeeAmount = s.garbage_fee_amount || 0;
    const garbageFeePaid = s.garbage_fee_paid || 0;
    const garbageFeeBalance = Math.max(0, garbageFeeAmount - garbageFeePaid);
    const garbageRow = document.getElementById('td-garbage-row');
    const garbageDetail = document.getElementById('td-garbage-detail');
    if (garbageRow) {
      if (garbageFeeAmount > 0) {
        garbageRow.style.display = '';
        if (garbageDetail) garbageDetail.style.display = '';
        setText('td-garbage-charged', `KES ${Number(garbageFeeAmount).toLocaleString()}`);
        setText('td-garbage-paid-label', `KES ${Number(garbageFeePaid).toLocaleString()}`);
        setText('td-garbage-balance', `KES ${Number(garbageFeeBalance).toLocaleString()}`);
        const garbageToggle = document.getElementById('td-garbage-toggle');
        if (garbageToggle) {
          const isPaid = garbageFeePaid >= garbageFeeAmount;
          garbageToggle.textContent = isPaid ? 'PAID' : 'NOT PAID';
          garbageToggle.className = isPaid
            ? 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-green-500 bg-green-500/20 text-green-400 transition-all'
            : 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-amber-500 bg-amber-500/20 text-amber-400 transition-all';
          garbageToggle.onclick = async () => {
            garbageToggle.disabled = true;
            try {
              await api.updateTenant(code, { garbage_fee_paid: isPaid ? 0 : garbageFeeAmount });
              loadTenantDashboard(code);
            } catch (err) {
              alert(err.message);
              garbageToggle.disabled = false;
            }
          };
        }
      } else {
        garbageRow.style.display = 'none';
        if (garbageDetail) garbageDetail.style.display = 'none';
      }
    }

    // Tenancy agreement fee
    const agreementCharge = Number(s.agreement_charge || 0);
    const agreementPaid = Number(s.agreement_paid || 0);
    const agreementOutstanding = Number(s.agreement_outstanding || 0);
    const agreementRow = document.getElementById('td-agreement-row');
    const agreementDetail = document.getElementById('td-agreement-detail');
    if (agreementRow) {
      if (agreementCharge > 0) {
        agreementRow.style.display = '';
        if (agreementDetail) agreementDetail.style.display = '';
        setText('td-agreement-charged', `KES ${Number(agreementCharge).toLocaleString()}`);
        setText('td-agreement-paid-label', `KES ${Number(agreementPaid).toLocaleString()}`);
        setText('td-agreement-balance', `KES ${Number(agreementOutstanding).toLocaleString()}`);
        const agreementToggle = document.getElementById('td-agreement-toggle');
        if (agreementToggle) {
          const isPaid = agreementOutstanding <= 0;
          agreementToggle.textContent = isPaid ? 'PAID' : 'NOT PAID';
          agreementToggle.className = isPaid
            ? 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-green-500 bg-green-500/20 text-green-400 transition-all'
            : 'px-2 py-0.5 rounded text-xs font-mono cursor-pointer border border-amber-500 bg-amber-500/20 text-amber-400 transition-all';
        }
      } else {
        agreementRow.style.display = 'none';
        if (agreementDetail) agreementDetail.style.display = 'none';
      }
    }

    // Tenant info — agreement fee
    const agreementChargeInfo = Number(tenant.agreement_charge || 0);
    const agreementPaidInfo = Number(tenant.agreement_paid || 0);
    const agreementOutstandingInfo = Number(tenant.agreement_outstanding || 0);
    if (agreementChargeInfo > 0) {
      setText('td-info-agreement', `KES ${Number(agreementChargeInfo).toLocaleString()} ${agreementOutstandingInfo > 0 ? `(Outstanding: KES ${agreementOutstandingInfo.toLocaleString()})` : '(Paid)'}`);
    } else {
      setText('td-info-agreement', '—');
    }

    // Credit balance and advance rent
    const creditBalance = Number(s.credit_balance || 0);
    const advanceRentBalance = Number(s.advance_rent_balance || 0);
    const advanceRentUntil = s.advance_rent_until || null;
    const creditRow = document.getElementById('td-credit-row');
    if (creditRow) {
      if (creditBalance > 0 || advanceRentBalance > 0) {
        creditRow.style.display = '';
        setText('td-credit-label', `KES ${Number(creditBalance).toLocaleString()}`);
        setText('td-advance-label', `KES ${Number(advanceRentBalance).toLocaleString()} ${advanceRentUntil ? `(until ${advanceRentUntil})` : ''}`);
        const applyBtn = document.getElementById('td-apply-credit-btn');
        if (applyBtn) {
          applyBtn.style.display = creditBalance > 0 ? '' : 'none';
          applyBtn.onclick = () => showApplyCreditModal(code, creditBalance);
        }
      } else {
        creditRow.style.display = 'none';
      }
    }

    // Metrics
    const statusBadgeEl = document.getElementById('td-metric-status');
    if (statusBadgeEl) statusBadgeEl.innerHTML = statusBadge(tenant.status);
    setText('td-metric-total-paid', `KES ${totalPaid.toLocaleString()}`);
    setText('td-metric-pending', `KES ${pendingAmount.toLocaleString()}`);
    setText('td-metric-payment-count', payments.length);

    // Payment history
    if (tbody) {
      if (!payments.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-slate-500">No payment records</td></tr>';
      } else {
        tbody.innerHTML = payments.map(p => `
          <tr>
            <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.receipt_number || '—')}</td>
            <td class="font-mono text-green-400">KES ${Number(p.amount).toLocaleString()}</td>
            <td class="font-mono text-xs">${p.payment_mode ? `<span class="text-purple-400 text-[10px]">${escapeHtml(p.payment_mode)}</span> ` : ''}${escapeHtml(p.mpesa_reference || p.cheque_number || '—')}</td>
            <td class="text-slate-400 text-xs">${p.payment_date ? new Date(p.payment_date).toLocaleDateString() : '—'}</td>
            <td>${statusBadge(p.status)}</td>
            <td><button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-td-delete-payment="${p.id}">Delete</button></td>
          </tr>`).join('');
      }
    }

    // Wire up Edit button
    document.getElementById('btn-td-edit')?.addEventListener('click', () => openTenantModal(tenant.tenant_code), { once: true });
    // Wire up Message button
    document.getElementById('btn-td-message')?.addEventListener('click', () => openMessageModal(tenant.tenant_code), { once: true });
    // Wire up Statement button
    document.getElementById('btn-td-statement')?.addEventListener('click', () => openStatementModal(tenant.tenant_code), { once: true });
    // Wire up Notice to Vacate button
    document.getElementById('btn-td-notice')?.addEventListener('click', async () => {
      const date = prompt('Notice to Vacate — date given by tenant? (YYYY-MM-DD, informational only; unit stays OCCUPIED until exit is completed)', new Date().toISOString().slice(0, 10));
      if (date == null) return;
      const reason = prompt('Reason (optional):', '') || null;
      try {
        await api.recordNoticeToVacate(tenant.tenant_code, { notice_date: date, reason });
        alert('Notice to Vacate recorded for ' + tenant.tenant_code + '.');
      } catch (err) {
        alert(err.message);
      }
    }, { once: true });
    // Wire up Exit Invoice button — navigate to Invoice Command Center
    document.getElementById('btn-td-exit-invoice')?.addEventListener('click', () => {
      // Navigate to Invoice Center → Exit Invoice
      setHash('invoices');
      showView('invoices');
      // Load invoices center and then trigger exit invoice for this tenant
      setTimeout(() => {
        showInvoiceType('exit');
        const search = document.getElementById('exit-tenant-search');
        if (search) {
          search.value = `${tenant.name} (${tenant.tenant_code})`;
          search.dispatchEvent(new Event('change'));
        }
      }, 200);
    }, { once: true });

    // Deposit-to-Rent Authorization
    document.getElementById('btn-td-deposit-rent')?.addEventListener('click', async () => {
      const currentMonth = new Date().toISOString().slice(0, 7);
      try {
        const { preview } = await api.getDepositPreview(tenant.tenant_code, currentMonth);
        if (!preview) return alert('Could not load deposit preview.');
        if (preview.outstanding_rent <= 0) return alert('This tenant has no outstanding rent for the current month.');
        if (preview.available_deposit <= 0) return alert('This tenant has no available deposit to apply.');

        // Populate the modal
        document.getElementById('dr-tenant-name').textContent = preview.tenant_name;
        document.getElementById('dr-unit').textContent = preview.unit_code;
        document.getElementById('dr-period').textContent = preview.billing_period;
        document.getElementById('dr-rent-due').textContent = money(preview.rent_due);
        document.getElementById('dr-already-paid').textContent = money(preview.payments_applied + preview.deposit_already_applied);
        document.getElementById('dr-outstanding').textContent = money(preview.outstanding_rent);
        document.getElementById('dr-deposit-avail').textContent = money(preview.available_deposit);
        document.getElementById('dr-amount').value = Math.min(preview.available_deposit, preview.outstanding_rent);
        document.getElementById('dr-amount').max = preview.max_can_apply;
        document.getElementById('dr-reason').value = '';
        document.getElementById('dr-hint').textContent = '';

        // Show write-off row if deposit doesn't fully cover
        const writeOffRow = document.getElementById('dr-writeoff-row');
        if (preview.available_deposit < preview.outstanding_rent) {
          writeOffRow.classList.remove('hidden');
          document.getElementById('dr-writeoff').value = preview.outstanding_rent - Math.min(preview.available_deposit, preview.outstanding_rent);
        } else {
          writeOffRow.classList.add('hidden');
          document.getElementById('dr-writeoff').value = '0';
        }

        // Store context for the authorize button
        document.getElementById('deposit-rent-modal').dataset.tenantCode = tenant.tenant_code;
        document.getElementById('deposit-rent-modal').dataset.billingPeriod = currentMonth;
        document.getElementById('deposit-rent-modal').classList.remove('hidden');
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }, { once: true });

    // Penalties
    loadTenantPenalties(tenant.tenant_code);

    // Maintenance / Repairs from Work Orders
    loadTenantMaintenanceCharges(tenant.tenant_code, maintenanceCharges || []);

    // Deposit Refund info (if exit invoice exists)
    loadTenantDepositRefund(tenant.tenant_code);

    const addPenaltyBtn = document.getElementById('btn-td-add-penalty');
    if (addPenaltyBtn) {
      addPenaltyBtn.onclick = async () => {
        const catEl = document.getElementById('td-penalty-category');
        const descEl = document.getElementById('td-penalty-desc');
        const amtEl = document.getElementById('td-penalty-amount');
        const category = catEl?.value || 'penalty';
        const desc = (descEl?.value || '').trim();
        const amt = Number(amtEl?.value || 0);
        if (!desc || amt <= 0) return alert('Enter description and a valid amount');
        addPenaltyBtn.disabled = true;
        try {
          await api.createPenalty({ tenant_code: tenant.tenant_code, description: desc, amount: amt, category });
          descEl.value = '';
          amtEl.value = '';
          loadTenantPenalties(tenant.tenant_code);
        } catch (err) {
          alert(err.message);
        } finally {
          addPenaltyBtn.disabled = false;
        }
      };
    }

  } catch (err) {
    setText('td-title', 'Error loading tenant');
    setText('td-subtitle', err.message);
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

function loadTenantMaintenanceCharges(tenantCode, charges) {
  const tbody = document.getElementById('td-maintenance-tbody');
  if (!tbody) return;
  const outstandingEl = document.getElementById('td-maintenance-outstanding');

  if (!charges || !charges.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-slate-500 py-4">No maintenance issues recorded.</td></tr>';
    if (outstandingEl) outstandingEl.textContent = 'KES 0';
    return;
  }

  let outstanding = 0;
  tbody.innerHTML = charges.map(mc => {
    const cost = Number(mc.total_cost || 0);
    const isPaid = mc.recovery_status === 'Paid';
    if (!isPaid && mc.responsible_party && mc.responsible_party.toLowerCase().includes('tenant')) {
      outstanding += cost - Number(mc.amount_recovered || 0);
    }
    const statusClass = isPaid ? 'text-green-400' : (mc.recovery_status === 'Pending' ? 'text-amber-400' : 'text-slate-400');
    return `<tr>
      <td class="font-mono text-xs">${escapeHtml(mc.wo_number_ref || mc.wo_number || '—')}</td>
      <td>${mc.issue_no || '—'}</td>
      <td>${escapeHtml(mc.problem || '—')}</td>
      <td>${escapeHtml(mc.responsible_party || '—')}</td>
      <td class="font-mono text-right">${money(cost)}</td>
      <td class="${statusClass}">${escapeHtml(mc.recovery_status || mc.status || '—')}</td>
    </tr>`;
  }).join('');

  if (outstandingEl) outstandingEl.textContent = money(outstanding);
}

async function loadTenantDepositRefund(tenantCode) {
  const section = document.getElementById('td-deposit-refund-section');
  if (!section) return;
  try {
    const { refunds } = await api.listDepositRefunds({ tenant: tenantCode, sort: 'newest' });
    const refund = refunds.find(r => r.tenant_code === tenantCode);
    if (!refund) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    setTextEl('td-dr-deposit', formatKes(refund.deposit_paid));
    setTextEl('td-dr-deductions', formatKes(refund.deductions_total));
    setTextEl('td-dr-refundable', formatKes(refund.refundable_amount));
    const statusMap = { pending: 'Pending', due_soon: 'Due Soon', due_today: 'Due Today', overdue: 'Overdue', refunded: 'Refunded', partially_refunded: 'Partially Refunded', no_refund_due: 'No Refund Due' };
    const statusEl = document.getElementById('td-dr-status');
    statusEl.textContent = statusMap[refund.refund_status] || refund.refund_status;
    statusEl.className = 'font-bold ' + (refund.refund_status === 'refunded' ? 'text-green-400' : refund.refund_status === 'overdue' ? 'text-rose-400' : 'text-amber-400');
    setTextEl('td-dr-due', fmtDate(refund.refund_due_date));
    setTextEl('td-dr-countdown', getDrCountdown(refund).replace(/<[^>]+>/g, ''));
    document.getElementById('btn-td-view-refund').onclick = () => {
      showView('deposit-refunds');
      setTimeout(() => openDrDetail(refund.id), 300);
    };
  } catch (_) { section.classList.add('hidden'); }
}

async function loadTenantPenalties(tenantCode) {
  const tbody = document.getElementById('td-penalties-tbody');
  if (!tbody) return;
  try {
    const { penalties } = await api.listPenalties(tenantCode);
    if (!penalties.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-slate-500">No penalties</td></tr>';
      return;
    }
    const catLabel = (c) => ({ penalty: 'Penalty', maintenance: 'Maintenance', other: 'Other' }[c] || 'Penalty');
    tbody.innerHTML = penalties.map(p => `
      <tr>
        <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.invoice_number || '—')}</td>
        <td class="text-slate-400 text-xs">${catLabel(p.category)}</td>
        <td class="text-slate-300">${escapeHtml(p.description)}</td>
        <td class="font-mono text-rose-400">KES ${Number(p.amount).toLocaleString()}</td>
        <td class="text-slate-400 text-xs">${p.invoice_date ? new Date(p.invoice_date).toLocaleDateString() : '—'}</td>
        <td>${statusBadge(p.status)}</td>
        <td>
          ${p.status === 'Pending'
            ? `<button type="button" class="action-btn action-btn-success !py-1 !px-2 text-xs" data-td-pay-penalty="${p.id}">Mark Paid</button>
               <button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-td-delete-penalty="${p.id}">Delete</button>`
            : `<span class="text-green-400 text-xs font-mono">Paid ${p.paid_date ? new Date(p.paid_date).toLocaleDateString() : ''}</span>`}
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

function showOverpaymentPrompt(result) {
  const modal = document.getElementById('overpayment-modal');
  if (!modal) return;
  document.getElementById('overpayment-amount').textContent = formatKes(result.overpayment);
  document.getElementById('overpayment-tenant-id').value = result.tenant?.id || '';
  document.getElementById('overpayment-payment-id').value = result.payment_id || result.payment?.id || '';
  document.getElementById('overpayment-value').value = result.overpayment;
  document.getElementById('overpayment-hint').textContent = '';
  modal.style.display = 'flex';
  modal.dataset.tenantCode = result.tenant?.tenant_code || '';
}

document.getElementById('btn-overpayment-advance')?.addEventListener('click', async () => {
  const modal = document.getElementById('overpayment-modal');
  const tenantId = document.getElementById('overpayment-tenant-id').value;
  const paymentId = document.getElementById('overpayment-payment-id').value;
  const overpayment = Number(document.getElementById('overpayment-value').value);
  const tenantCode = modal.dataset.tenantCode || '';
  modal.style.display = 'none';
  await openAdvanceMonthsModal(tenantId, paymentId, overpayment, tenantCode);
});

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function monthPrefix(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function openAdvanceMonthsModal(tenantId, paymentId, overpayment, tenantCode, pendingId) {
  const modal = document.getElementById('advance-months-modal');
  const hint = document.getElementById('advance-months-hint');
  if (!modal) return;

  document.getElementById('advance-months-tenant-id').value = tenantId;
  document.getElementById('advance-months-payment-id').value = paymentId;
  document.getElementById('advance-months-pending-id').value = pendingId || '';
  document.getElementById('advance-months-overpayment').value = overpayment;
  document.getElementById('advance-months-amount').textContent = formatKes(overpayment);
  hint.textContent = '';

  let rentAmount = 0;
  let rentPaidThisMonth = 0;
  try {
    const t = await api.tenant(tenantId);
    rentAmount = Number(t?.tenant?.rent_amount || 0);
    rentPaidThisMonth = Number(t?.tenant?.rent_paid_this_month || 0);
  } catch (_) { /* ignore */ }
  modal.dataset.rentAmount = rentAmount;
  modal.dataset.rentPaidThisMonth = rentPaidThisMonth;
  modal.dataset.overpayment = overpayment;

  const now = new Date();
  const firstMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const options = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + i, 1);
    options.push({ prefix: monthPrefix(d), label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` });
  }

  // Default selection: the consecutive future months the overpayment covers.
  const checked = new Set();
  if (rentAmount > 0 && overpayment > 0) {
    let remaining = overpayment;
    let idx = 0;
    while (remaining > 0 && idx < options.length) {
      checked.add(options[idx].prefix);
      remaining -= Math.min(rentAmount, remaining);
      idx++;
    }
  }

  document.getElementById('advance-months-list').innerHTML = options
    .map((o) => {
      const isChecked = checked.has(o.prefix);
      return `<label class="flex items-center gap-2 px-2 py-1.5 rounded border border-slate-700 bg-slate-900 cursor-pointer select-none text-sm ${isChecked ? 'border-green-600' : ''}" data-prefix="${o.prefix}">
        <input type="checkbox" value="${o.prefix}" ${isChecked ? 'checked' : ''} class="advance-month-check accent-green-500" />
        <span class="font-mono text-slate-200">${o.label}</span>
      </label>`;
    })
    .join('');

  renderAdvanceCoverage();
  modal.style.display = 'flex';
}

function ordinalDay(d) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
}

function renderAdvanceCoverage() {
  const el = document.getElementById('advance-months-coverage');
  const modal = document.getElementById('advance-months-modal');
  if (!el || !modal) return;
  const rentAmount = Number(modal.dataset.rentAmount || 0);
  const rentPaidThisMonth = Number(modal.dataset.rentPaidThisMonth || 0);
  const overpayment = Number(modal.dataset.overpayment || 0);
  const prefixes = Array.from(document.querySelectorAll('#advance-months-list .advance-month-check:checked'))
    .map((cb) => cb.value)
    .sort();
  if (rentAmount <= 0 || overpayment <= 0 || !prefixes.length) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }

  const remainingThisMonth = Math.max(0, rentAmount - rentPaidThisMonth);
  let remaining = overpayment - remainingThisMonth;
  if (remaining < 0) remaining = 0;

  let endDate = null;
  let coveredMonths = 0;
  for (const p of prefixes) {
    if (remaining <= 0) break;
    const [y, m] = p.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const settle = Math.min(rentAmount, remaining);
    coveredMonths++;
    if (settle >= rentAmount) {
      endDate = new Date(y, m - 1, daysInMonth);
    } else {
      const coveredDays = Math.ceil((settle / rentAmount) * daysInMonth);
      endDate = new Date(y, m - 1, Math.min(coveredDays, daysInMonth));
    }
    remaining -= settle;
  }

  el.style.display = '';
  if (endDate) {
    const untilStr = `${ordinalDay(endDate.getDate())} ${MONTH_NAMES[endDate.getMonth()]} ${endDate.getFullYear()}`;
    el.textContent = `Advance rent covers ${coveredMonths} month(s) and is paid up to ${untilStr}.`;
  } else {
    el.textContent = 'Advance rent amount cannot be fully placed into the selected month(s); the remainder stays as advance balance.';
  }
}

document.getElementById('advance-months-list')?.addEventListener('change', (e) => {
  if (e.target.classList.contains('advance-month-check')) {
    const label = e.target.closest('label[data-prefix]');
    if (label) label.classList.toggle('border-green-600', e.target.checked);
    renderAdvanceCoverage();
  }
});

document.getElementById('btn-advance-months-confirm')?.addEventListener('click', async () => {
  const hint = document.getElementById('advance-months-hint');
  const modal = document.getElementById('advance-months-modal');
  const tenantId = document.getElementById('advance-months-tenant-id').value;
  const paymentId = document.getElementById('advance-months-payment-id').value;
  const overpayment = Number(document.getElementById('advance-months-overpayment').value);
  const months = Array.from(document.querySelectorAll('#advance-months-list .advance-month-check:checked'))
    .map((cb) => cb.value)
    .sort();
  if (!months.length) {
    hint.textContent = 'Select at least one future month.';
    return;
  }
  hint.textContent = 'Allocating…';
  try {
    const pendingId = document.getElementById('advance-months-pending-id').value;
    let result;
    if (pendingId) {
      result = await api.resolvePendingOverpayment(pendingId, { choice: 'advance_rent', months });
    } else {
      result = await api.resolveOverpayment(tenantId, {
        payment_id: paymentId,
        overpayment,
        choice: 'advance_rent',
        months,
      });
    }
    modal.style.display = 'none';
    loadPayments();
    loadDashboard();
    if (pendingId) loadPendingOverpayments();
    const tenantCode = result.tenant?.tenant_code || '';
    if (tenantCode) loadTenantDashboard(tenantCode);
    const pmHint = document.getElementById('payment-message-hint');
    const pmApproveBtn = document.getElementById('btn-approve-from-message');
    if (pmHint) pmHint.textContent = 'Overpayment resolved successfully.';
    if (pmApproveBtn) pmApproveBtn.disabled = false;
    showOverpaymentReview(result.messageBody, tenantId);
  } catch (err) {
    hint.textContent = err.message;
  }
});

// Deposit-to-Rent modal handlers
document.getElementById('btn-dr-cancel')?.addEventListener('click', () => {
  document.getElementById('deposit-rent-modal').classList.add('hidden');
});

document.getElementById('btn-dr-authorize')?.addEventListener('click', async () => {
  const modal = document.getElementById('deposit-rent-modal');
  const tenantCode = modal.dataset.tenantCode;
  const billingPeriod = modal.dataset.billingPeriod;
  const amount = Number(document.getElementById('dr-amount').value);
  const writeOff = Number(document.getElementById('dr-writeoff').value) || 0;
  const reason = document.getElementById('dr-reason').value.trim() || null;
  const hint = document.getElementById('dr-hint');
  const btn = document.getElementById('btn-dr-authorize');

  if (!amount || amount <= 0) { hint.textContent = 'Enter a valid amount.'; return; }

  if (!confirm(`Authorize KES ${amount.toLocaleString()} from deposit for ${billingPeriod} rent?`)) return;

  btn.disabled = true;
  hint.textContent = 'Processing...';
  try {
    await api.applyDepositToRent(tenantCode, {
      amount, billing_period: billingPeriod, reason, write_off_amount: writeOff,
    });
    modal.classList.add('hidden');
    alert('Deposit applied successfully. Tenant balance updated.');
    // Refresh tenant dashboard
    if (typeof loadTenantDashboard === 'function') loadTenantDashboard(tenantCode);
    loadDashboard();
  } catch (err) {
    hint.textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-advance-months-back')?.addEventListener('click', () => {
  const monthsModal = document.getElementById('advance-months-modal');
  const pendingId = document.getElementById('advance-months-pending-id')?.value;
  if (pendingId) {
    monthsModal.style.display = 'none';
    document.getElementById('pending-op-resolve-modal').style.display = 'flex';
  } else {
    const overpaymentModal = document.getElementById('overpayment-modal');
    monthsModal.style.display = 'none';
    overpaymentModal.style.display = 'flex';
  }
});

document.getElementById('btn-overpayment-credit')?.addEventListener('click', async () => {
  const modal = document.getElementById('overpayment-modal');
  const tenantId = document.getElementById('overpayment-tenant-id').value;
  const paymentId = document.getElementById('overpayment-payment-id').value;
  const overpayment = document.getElementById('overpayment-value').value;
  const hint = document.getElementById('overpayment-hint');
  hint.textContent = 'Processing…';
  try {
    const result = await api.resolveOverpayment(tenantId, {
      payment_id: paymentId,
      overpayment,
      choice: 'credit_balance',
    });
    modal.style.display = 'none';
    loadPayments();
    loadDashboard();
    const tenantCode = result.tenant?.tenant_code || modal.dataset.tenantCode;
    if (tenantCode) loadTenantDashboard(tenantCode);
    const pmHint = document.getElementById('payment-message-hint');
    const pmApproveBtn = document.getElementById('btn-approve-from-message');
    if (pmHint) pmHint.textContent = 'Overpayment resolved successfully.';
    if (pmApproveBtn) pmApproveBtn.disabled = false;
    showOverpaymentReview(result.messageBody, tenantId);
  } catch (err) {
    hint.textContent = err.message;
  }
});

document.getElementById('btn-overpayment-skip')?.addEventListener('click', () => {
  const overpaymentModal = document.getElementById('overpayment-modal');
  const skipModal = document.getElementById('skip-overpayment-modal');
  document.getElementById('skip-overpayment-payment-id').value = document.getElementById('overpayment-payment-id').value;
  document.getElementById('skip-overpayment-tenant-id').value = document.getElementById('overpayment-tenant-id').value;
  document.getElementById('skip-overpayment-value').value = document.getElementById('overpayment-value').value;
  document.getElementById('skip-overpayment-hint').textContent = '';
  overpaymentModal.style.display = 'none';
  skipModal.style.display = 'flex';
});

document.getElementById('btn-skip-overpayment-back')?.addEventListener('click', () => {
  document.getElementById('skip-overpayment-modal').style.display = 'none';
  document.getElementById('overpayment-modal').style.display = 'flex';
});

document.getElementById('btn-skip-overpayment-confirm')?.addEventListener('click', async () => {
  const hint = document.getElementById('skip-overpayment-hint');
  const skipModal = document.getElementById('skip-overpayment-modal');
  const tenantId = document.getElementById('skip-overpayment-tenant-id').value;
  const paymentId = document.getElementById('skip-overpayment-payment-id').value;
  const overpayment = Number(document.getElementById('skip-overpayment-value').value);
  hint.textContent = 'Approving payment and recording pending overpayment…';
  try {
    const result = await api.skipOverpayment(paymentId, overpayment);
    skipModal.style.display = 'none';
    loadPayments();
    loadDashboard();
    const pmHint = document.getElementById('payment-message-hint');
    const pmApproveBtn = document.getElementById('btn-approve-from-message');
    if (pmHint) pmHint.textContent = 'Overpayment skipped. Pending overpayment recorded.';
    if (pmApproveBtn) pmApproveBtn.disabled = false;
    if (tenantId) {
      loadTenantDashboard(tenantId);
      showOverpaymentReview(result.messageBody, tenantId);
    }
  } catch (err) {
    hint.textContent = err.message;
  }
});

function showOverpaymentReview(messageBody, tenantId) {
  const modal = document.getElementById('overpayment-review-modal');
  if (!modal) return;
  document.getElementById('overpayment-review-body').textContent = messageBody || '(No message generated)';
  document.getElementById('overpayment-review-tenant-id').value = tenantId;
  document.getElementById('overpayment-review-hint').textContent = '';
  modal.style.display = 'flex';
}

document.getElementById('btn-overpayment-review-send')?.addEventListener('click', async () => {
  const modal = document.getElementById('overpayment-review-modal');
  const tenantId = document.getElementById('overpayment-review-tenant-id').value;
  const messageBody = document.getElementById('overpayment-review-body').textContent;
  const hint = document.getElementById('overpayment-review-hint');
  const btn = document.getElementById('btn-overpayment-review-send');
  if (!tenantId || !messageBody) return;
  hint.textContent = 'Sending…';
  btn.disabled = true;
  try {
    const result = await api.sendMessage(tenantId, messageBody);
    modal.style.display = 'none';
    const wa = result.whatsapp || {};
    if (wa.status === 'Failed') {
      alert('Message sent to tenant, but WhatsApp delivery failed' + (wa.failureReason ? ': ' + wa.failureReason : '') + '.');
    } else {
      alert('Confirmation message sent to tenant successfully.');
    }
  } catch (err) {
    hint.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-overpayment-review-close')?.addEventListener('click', () => {
  document.getElementById('overpayment-review-modal').style.display = 'none';
});

function showApplyCreditModal(tenantCode, creditBalance) {
  const modal = document.getElementById('apply-credit-modal');
  if (!modal) return;
  document.getElementById('apply-credit-tenant-code').value = tenantCode;
  document.getElementById('apply-credit-balance').textContent = formatKes(creditBalance);
  document.getElementById('apply-credit-amount').value = '';
  document.getElementById('apply-credit-amount').max = creditBalance;
  document.getElementById('apply-credit-hint').textContent = '';
  modal.style.display = 'flex';
}

document.getElementById('btn-apply-credit')?.addEventListener('click', async () => {
  const tenantCode = document.getElementById('apply-credit-tenant-code').value;
  const target = document.getElementById('apply-credit-target').value;
  const amount = Number(document.getElementById('apply-credit-amount').value);
  const reason = document.getElementById('apply-credit-reason').value.trim();
  const hint = document.getElementById('apply-credit-hint');
  if (!amount || amount <= 0) { hint.textContent = 'Enter a valid amount.'; return; }
  if (!confirm(`Are you sure you want to apply this credit balance of KES ${amount.toLocaleString()} towards ${target}?\n\nThe amount, reason, date and approving user will be recorded.`)) {
    return;
  }
  hint.textContent = 'Applying…';
  try {
    await api.applyCredit(tenantCode, { target, amount, reason: reason || null });
    document.getElementById('apply-credit-modal').style.display = 'none';
    document.getElementById('apply-credit-reason').value = '';
    alert('Credit applied.');
    loadTenantDashboard(tenantCode);
    loadPayments();
    loadDashboard();
  } catch (err) {
    hint.textContent = err.message;
  }
});

document.getElementById('btn-apply-credit-close')?.addEventListener('click', () => {
  document.getElementById('apply-credit-modal').style.display = 'none';
});

function statusBadge(status) {
  const map = {
    Active: 'badge-active',
    Overdue: 'badge-expired',
    Evicted: 'badge-suspended',
    Pending: 'badge-pending',
    Approved: 'badge-active',
    Paid: 'badge-active',
    Partial: 'badge-pending',
    Arrears: 'badge-expired',
    Unpaid: 'badge-expired',
    Vacant: 'badge-vacant',
    Sent: 'badge-sent',
    Delivered: 'badge-delivered',
    Read: 'badge-read',
    Failed: 'badge-failed',
  };
  const cls = map[status] || 'badge-suspended';
  return `<span class="status-badge ${cls}"><span class="status-dot"></span>${escapeHtml(status)}</span>`;
}

// Phase 1 synchronization: an approved payment only reads as "Approved & Sent"
// once every module (payment -> tenant -> penalties) has updated and validated
// (payments.sync_status = 'synced').
function paymentStatusBadge(p) {
  if (p.status === 'Approved' && p.sync_status === 'synced') {
    return `<span class="status-badge badge-active"><span class="status-dot"></span>Approved &amp; Sent</span>`;
  }
  if (p.status === 'Approved') {
    const failed = p.sync_status === 'sync_failed';
    const label = failed ? 'Approved · Sync Failed' : 'Approved · Syncing';
    const cls = failed ? 'badge-suspended' : 'badge-pending';
    return `<span class="status-badge ${cls}" title="${escapeHtml('Payment pending full module synchronization.')}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
  }
  return statusBadge(p.status);
}

function formatExpiryDisplay(t) {
  const time = t.rent_due_time ? String(t.rent_due_time).slice(0, 5) : '23:59';
  return `${t.rent_due_date} ${time}`;
}

function renderWhatsappPanel(wa) {
  const status = wa?.status || 'offline';
  const message = wa?.message;
  const labels = { ready: 'OPERATIONAL', syncing: 'SYNCING', offline: 'OFFLINE' };
  const cls = { ready: 'beacon-green', syncing: 'beacon-amber', offline: 'beacon-red' };

  const statusNote = status === 'ready'
    ? '<p class="text-green-400 font-mono text-sm mt-3">✓ Cloud API connected</p>'
    : status === 'syncing'
      ? '<p class="text-amber-400 font-mono text-sm mt-3">⟳ Validating credentials…</p>'
      : '<p class="text-rose-400 font-mono text-sm mt-3">✗ Not configured</p>';

  const resetBtn = isAdmin()
    ? `<button type="button" id="btn-wa-reset" class="qc-btn mt-3">Re-validate connection</button>`
    : '';

  return `
    <div class="whatsapp-module glass-panel p-5">
      <div class="flex flex-wrap items-center gap-6">
        <div class="beacon-wrap shrink-0">
          <span class="beacon-pulse ${cls[status] || 'beacon-red'}"></span>
          <span class="beacon-core ${cls[status] || 'beacon-red'}"></span>
        </div>
        <div>
          <span class="sys-tag">[WA_GATEWAY]</span>
          <p class="font-orbitron text-lg text-white mt-1">${labels[status] || 'OFFLINE'}</p>
        </div>
      </div>
      ${message ? `<p class="text-amber-400/90 font-mono text-xs mt-3">${escapeHtml(message)}</p>` : ''}
      ${statusNote}
      ${resetBtn}
    </div>`;
}

async function refreshWhatsappBeacon() {
  try {
    const wa = await api.whatsappStatus();
    const el = document.getElementById('wa-beacon-slot');
    if (el) el.innerHTML = renderWhatsappPanel(wa);
  } catch (_) {
    /* ignore poll errors */
  }
}

async function handleWhatsappReset() {
  if (!confirm('Re-validate Meta Cloud API connection?')) return;
  try {
    const result = await api.resetWhatsapp();
    const el = document.getElementById('wa-beacon-slot');
    if (el && result.whatsapp) el.innerHTML = renderWhatsappPanel(result.whatsapp);
  } catch (err) {
    alert(err.status === 403 ? 'Admin only' : err.message);
  }
}

async function loadDashboard() {
  try {
    const data = await api.metrics();
    const t = data.tenants || {};
    const r = data.revenue || {};
    document.getElementById('metric-total').textContent = t.total_tenants ?? 0;
    document.getElementById('metric-vacant').textContent = t.vacant_units ?? 0;
    document.getElementById('metric-overdue').textContent = t.overdue_tenants ?? 0;
    document.getElementById('metric-due7').textContent = t.due_7d ?? 0;
    document.getElementById('metric-pending').textContent = r.pending_count ?? 0;
    document.getElementById('metric-revenue').textContent = `KES ${Number(r.revenue_mtd || 0).toLocaleString()}`;
    document.getElementById('metric-arrears').textContent = `KES ${Number(r.total_arrears || 0).toLocaleString()}`;
  } catch (err) {
    console.error(err);
  }
}

async function loadTenants() {
  const tbody = document.getElementById('tenants-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  try {
    const q = document.getElementById('tenant-search')?.value?.trim();
    const status = document.getElementById('tenant-filter-status')?.value;
    const { tenants } = await api.tenants({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
    if (!tenants.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500">No tenants yet</td></tr>`;
      return;
    }
    tbody.innerHTML = tenants
      .map(
        (t) => `
      <tr>
        <td class="font-mono text-purple-300">
          <a href="#tenant/${t.tenant_code}" class="hover:underline text-purple-300 font-semibold">${escapeHtml(t.tenant_code)}</a>
        </td>
        <td class="text-white">${escapeHtml(t.name)}</td>
        <td class="font-mono text-sm">${escapeHtml(t.phone_number)}</td>
        <td class="text-slate-400">${escapeHtml(t.property_name)}</td>
        <td class="font-mono text-green-400">${Number(t.rent_amount).toLocaleString()}</td>
        <td class="font-mono text-sm">${t.agreement_outstanding > 0 ? `<span class="text-amber-400 font-semibold">KES ${Number(t.agreement_outstanding).toLocaleString()}</span>` : `<span class="text-emerald-400">✓</span>`}</td>
        <td class="font-mono text-sm text-slate-400">${escapeHtml(formatExpiryDisplay(t))}</td>
        <td>${statusBadge(t.status)}</td>
        <td class="space-x-1">
          <button type="button" class="action-btn" data-tenant-profile="${t.id}">Profile</button>
          <button type="button" class="action-btn action-btn-wa" data-message-tenant="${t.id}">💬 Msg</button>
          <button type="button" class="action-btn" data-edit-tenant="${t.id}">Edit</button>
          <button type="button" class="action-btn action-btn-danger" data-delete-tenant="${t.id}">Delete</button>
        </td>
      </tr>`
      )
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-rose-400 text-center py-8">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadPayments() {
  const tbody = document.getElementById('payments-tbody');
  if (!tbody) return;
  const filter = document.getElementById('payment-filter')?.value;
  tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  try {
    const { payments } = await api.payments(filter || undefined);
    if (!payments.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">No payments</td></tr>`;
      return;
    }
    tbody.innerHTML = payments
      .map(
        (p) => `
      <tr>
        <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.receipt_number || '—')}</td>
        <td class="text-white">${escapeHtml(p.tenant_name || '—')} <span class="text-slate-500 font-mono text-xs">${escapeHtml(p.tenant_code || '')}</span></td>
        <td class="font-mono text-green-400">KES ${Number(p.amount).toLocaleString()}</td>
        <td class="font-mono text-xs">${p.payment_type === 'deposit' ? '<span class="text-cyan-400">DEPOSIT</span> ' : ''}${p.payment_mode ? `<span class="text-purple-400 text-[10px]">${escapeHtml(p.payment_mode)}</span>` : ''} ${escapeHtml(p.mpesa_reference || p.cheque_number || '—')}</td>
        <td class="font-mono text-sm text-slate-400">${escapeHtml(p.payment_date)}</td>
        <td>${paymentStatusBadge(p)}</td>
        <td>
          <div class="flex items-center gap-2">
            ${p.status === 'Pending' ? `<button type="button" class="qc-btn qc-btn-primary !py-1 !px-2 text-xs" data-approve-payment="${p.id}">Approve</button>` : ''}
            <button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-delete-payment="${p.id}">Delete</button>
          </div>
        </td>
      </tr>`
      )
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-rose-400 text-center py-8">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function refreshHouseOptions() {
  const { houses } = await api.houses();
  housesCache = houses;
  const tenantSelect = document.getElementById('tenant-house-select');
  const broadcastHouseSelect = document.getElementById('broadcast-house-select');
  if (tenantSelect) {
    tenantSelect.innerHTML = houses
      .map((h) => `<option value="${h.id}">${escapeHtml(h.house_name)} (${escapeHtml(h.total_units)} units)</option>`)
      .join('');
  }
  if (broadcastHouseSelect) {
    broadcastHouseSelect.innerHTML = houses
      .map((h) => `<option value="${h.id}">${escapeHtml(h.house_name)} (${escapeHtml(h.total_units)} units)</option>`)
      .join('');
  }
  const reportHouseSelect = document.getElementById('report-house-select');
  if (reportHouseSelect) {
    reportHouseSelect.innerHTML = '<option value="">All Houses</option>' + houses
      .map((h) => `<option value="${h.id}">${escapeHtml(h.house_name)}</option>`)
      .join('');
  }
}

async function openTenantModal(id = null) {
  const modal = document.getElementById('tenant-modal');
  const form = document.getElementById('tenant-form');
  form.reset();
  form.dataset.occupyMode = '';
  await refreshHouseOptions();
  document.getElementById('tenant-form-id').value = id || '';
  document.getElementById('tenant-modal-title').textContent = id ? 'Edit tenant' : 'Add tenant';

  const openingAdvanceField = document.getElementById('opening-advance-field');
  const openingAdvanceInput = form.opening_advance_rent;
  const openingAdvanceHint = document.getElementById('opening-advance-hint');
  if (openingAdvanceField) openingAdvanceField.style.display = '';
  if (openingAdvanceInput) openingAdvanceInput.readOnly = false;
  if (openingAdvanceHint) openingAdvanceHint.classList.add('hidden');

  if (id) {
    form.tenant_code.readOnly = true;
    api.tenant(id).then(({ tenant: t }) => {
      form.name.value = t.name;
      form.tenant_code.value = t.tenant_code;
      form.phone_number.value = t.phone_number;
      form.national_id.value = t.national_id || '';
      form.guardian_name.value = t.guardian_name || '';
      form.guardian_id.value = t.guardian_id || '';
      form.guardian_phone.value = t.guardian_phone || '';
      form.guardian_relationship.value = t.guardian_relationship || '';
      form.house_id.value = t.house_id || '';
      // unit_label is no longer used
      form.rent_amount.value = t.rent_amount;
      form.standard_monthly_rent.value = t.standard_monthly_rent || '';
      form.first_billing_method.value = t.first_billing_method || '';
      form.first_billing_charge.value = t.first_billing_charge || '';
      form.first_billing_days.value = t.first_billing_days || '';
      form.first_billing_reason.value = t.first_billing_reason || '';
      // Trigger first billing method UI
      const fbm = document.getElementById('tenant-first-billing-method');
      if (fbm) fbm.dispatchEvent(new Event('change'));
      form.deposit_amount.value = t.deposit_amount || 0;
      form.deposit_paid.value = t.deposit_paid || 0;
      form.garbage_fee_amount.value = t.garbage_fee_amount || 0;
      form.water_charge_amount.value = t.water_charge_amount || 0;
      form.arrears.value = t.arrears || 0;
      form.agreement_charge.value = t.agreement_charge || 0;
      form.agreement_paid.value = t.agreement_paid || 0;
      const openingAdvance = Number(t.opening_advance_rent || 0);
      form.opening_advance_rent.value = openingAdvance;
      // An already-recorded opening advance can never be changed or re-applied.
      form.opening_advance_rent.readOnly = openingAdvance > 0;
      if (openingAdvanceHint) openingAdvanceHint.classList.toggle('hidden', openingAdvance <= 0);
      form.move_in_date.value = t.move_in_date || '';
      form.rent_due_date.value = String(t.rent_due_date || '').slice(0, 10);
      form.rent_due_time.value = String(t.rent_due_time || '23:59:00').slice(0, 5);
      if (t.status === 'Vacant') {
        form.status.value = 'Active';
        form.dataset.occupyMode = '1';
        document.getElementById('tenant-modal-title').textContent = `Mark Occupied — Assign Tenant to Unit ${t.tenant_code}`;
      } else {
        form.status.value = t.status;
        form.dataset.occupyMode = '';
      }
    });
  } else {
    form.tenant_code.readOnly = false;
    form.dataset.occupyMode = '';
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    d.setDate(5);
    form.rent_due_date.value = d.toISOString().slice(0, 10);
  }
  modal.classList.remove('hidden');
}

async function openStatementModal(tenantId) {
  const modal = document.getElementById('statement-modal');
  const statusEl = document.getElementById('statement-status');
  document.getElementById('statement-tenant-id').value = tenantId;
  statusEl.classList.add('hidden');
  statusEl.textContent = '';
  document.getElementById('btn-statement-download').disabled = false;
  document.getElementById('btn-statement-send').disabled = false;
  document.getElementById('btn-statement-both').disabled = false;
  modal.classList.remove('hidden');
}

async function runStatementGeneration(mode) {
  const tenantId = document.getElementById('statement-tenant-id').value;
  const statusEl = document.getElementById('statement-status');
  if (!tenantId) return;
  statusEl.classList.remove('hidden');
  statusEl.textContent = mode === 'download' ? 'Generating statement…' : (mode === 'both' ? 'Generating and sending statement…' : 'Sending statement via WhatsApp…');
  document.getElementById('btn-statement-download').disabled = true;
  document.getElementById('btn-statement-send').disabled = true;
  document.getElementById('btn-statement-both').disabled = true;
  try {
    if (mode === 'download' || mode === 'both') {
      const result = mode === 'download'
        ? await api.downloadStatement(tenantId)
        : await api.sendAndDownloadStatement(tenantId);
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || `statement-${tenantId}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        statusEl.textContent = result.json?.error ? `Sent, but download failed: ${result.json.error}` : (mode === 'both' ? 'Statement sent and download started.' : 'Download started.');
      } else {
        statusEl.textContent = result.json?.message || (result.json?.error ? `Error: ${result.json.error}` : 'Done.');
      }
    } else {
      const res = await api.generateStatement(tenantId, 'send');
      statusEl.textContent = res?.message || 'Statement sent successfully.';
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err.message || err);
  } finally {
    document.getElementById('btn-statement-download').disabled = false;
    document.getElementById('btn-statement-send').disabled = false;
    document.getElementById('btn-statement-both').disabled = false;
  }
}

// ---- Exit Invoice modal -----------------------------------------------------

function renderEiLines(lines) {
  const tbody = document.getElementById('ei-lines-tbody');
  if (!tbody) return;
  const badge = (document.getElementById('ei-status-badge').textContent || '').toUpperCase();
  const editing = badge === 'EDITING';
  const locked = badge === 'FINALIZED' && !editing;
  const rows = (lines || []).map((l, i) => `
    <tr data-ei-line="${i}">
      <td><select class="qc-input text-sm w-36" data-ei-cat ${locked ? 'disabled' : ''}>
        ${['maintenance','repair','cleaning','painting','utility','deduction','other'].map(c =>
          `<option value="${c}" ${(l.category || 'other') === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}
      </select></td>
      <td><input type="text" class="qc-input text-sm w-56" data-ei-desc value="${escapeHtml(l.description || '')}" ${locked ? 'disabled' : ''} /></td>
      <td><input type="number" min="0" class="qc-input text-sm w-32 text-right" data-ei-amt value="${Number(l.amount || 0)}" ${locked ? 'disabled' : ''} /></td>
      <td>${locked ? '' : '<button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-ei-del>✕</button>'}</td>
    </tr>`).join('');
  tbody.innerHTML = rows || '<tr><td colspan="4" class="text-center py-4 text-slate-500">No deductions yet. Add charges below.</td></tr>';
  tbody.querySelectorAll('[data-ei-amt], [data-ei-desc]').forEach((el) => {
    el.addEventListener('input', recalcEiTotals);
  });
  tbody.querySelectorAll('[data-ei-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('tr')?.remove();
      recalcEiTotals();
    });
  });
}

function collectEiLines() {
  const tbody = document.getElementById('ei-lines-tbody');
  if (!tbody) return [];
  const lines = [];
  tbody.querySelectorAll('tr[data-ei-line]').forEach((tr) => {
    const cat = tr.querySelector('[data-ei-cat]')?.value || 'other';
    const desc = (tr.querySelector('[data-ei-desc]')?.value || '').trim();
    const amt = Number(tr.querySelector('[data-ei-amt]')?.value || 0);
    if (amt > 0) lines.push({ category: cat, description: desc || cat, amount: amt });
  });
  return lines;
}

function recalcEiTotals() {
  const lines = collectEiLines();
  const deductions = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const depositPaid = Number(document.getElementById('ei-deposit-paid')?.textContent.replace(/[^0-9]/g, '') || 0);
  const rentAmount = Number(document.getElementById('ei-rent')?.textContent.replace(/[^0-9]/g, '') || 0);
  const arrears = Number(document.getElementById('ei-outstanding')?.textContent.replace(/[^0-9]/g, '') || 0);

  // Get rent treatment
  const rentTreatment = document.querySelector('input[name="ei-rent-treatment"]:checked')?.value || 'full_month';
  let rentCharged = rentAmount;
  if (rentTreatment === 'pro_rated') {
    const days = Number(document.getElementById('ei-pro-rated-days')?.value || 0);
    rentCharged = Math.round((rentAmount / 30) * days);
    const amtEl = document.getElementById('ei-pro-rated-amount');
    if (amtEl) amtEl.value = rentCharged;
  } else if (rentTreatment === 'waived') {
    rentCharged = 0;
  }

  // Total obligations = arrears + rent charged + deductions
  const totalObligations = arrears + rentCharged + deductions;

  // Get deposit treatment
  const depositTreatment = document.querySelector('input[name="ei-deposit-treatment"]:checked')?.value || 'apply_to_deductions';
  let depToRent = 0;
  let depToDed = 0;
  if (depositTreatment === 'apply_to_rent') {
    depToRent = Math.min(depositPaid, rentCharged);
  } else if (depositTreatment === 'apply_to_deductions') {
    depToDed = Math.min(depositPaid, deductions);
  } else if (depositTreatment === 'apply_to_both') {
    depToRent = Math.min(depositPaid, rentCharged);
    const remaining = depositPaid - depToRent;
    depToDed = Math.min(remaining, deductions);
  } else if (depositTreatment === 'refund') {
    depToRent = 0;
    depToDed = 0;
  }

  const totalCredits = depToRent + depToDed;
  const depositRefund = Math.max(0, depositPaid - depToRent - depToDed);
  const finalSettlement = totalCredits - totalObligations;

  setTextEl('ei-total-deductions', `KES ${deductions.toLocaleString()}`);
  setTextEl('ei-deposit-refund', `KES ${depositRefund.toLocaleString()}`);
  setTextEl('ei-final-settlement', `KES ${finalSettlement.toLocaleString()}`);
}

function renderEiActions(invoice) {
  const draftActions = document.getElementById('ei-actions-draft');
  const finalActions = document.getElementById('ei-actions-final');
  const editActions = document.getElementById('ei-actions-editing');
  const addLineWrap = document.getElementById('ei-add-line');
  const finalized = invoice && invoice.status === 'Finalized';
  const editing = finalized && window._eiEditing;
  if (draftActions) draftActions.classList.toggle('hidden', finalized);
  if (finalActions) finalActions.classList.toggle('hidden', !finalized || editing);
  if (editActions) editActions.classList.toggle('hidden', !editing);
  if (addLineWrap) addLineWrap.style.display = (!finalized || editing) ? '' : 'none';
  // Disable/enable form fields based on editing state
  const fields = ['ei-move-out-date', 'ei-exit-reason', 'ei-pro-rated-days', 'ei-rent-treatment-reason', 'ei-settlement-reason'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = finalized && !editing;
  });
  document.querySelectorAll('input[name="ei-rent-treatment"], input[name="ei-deposit-treatment"]').forEach(r => {
    r.disabled = finalized && !editing;
  });
  setTextEl('ei-number', invoice ? (invoice.exit_number || '—') : 'New Invoice');
  const badge = document.getElementById('ei-status-badge');
  if (badge) {
    if (editing) {
      badge.textContent = 'EDITING';
      badge.className = 'sys-tag text-[10px] text-amber-300';
    } else {
      badge.textContent = finalized ? 'FINALIZED' : 'DRAFT';
      badge.className = 'sys-tag text-[10px] ' + (finalized ? 'text-emerald-300' : 'text-amber-300');
    }
  }
}

async function loadEiDepositRefundInfo(exitInvoiceId) {
  const panel = document.getElementById('ei-deposit-refund-info');
  if (!panel) return;
  try {
    const { refunds } = await api.listDepositRefunds({ sort: 'newest' });
    const refund = refunds.find(r => r.exit_invoice_id === Number(exitInvoiceId));
    if (!refund) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    setTextEl('ei-dr-amount', formatKes(refund.refundable_amount));
    setTextEl('ei-dr-due', fmtDate(refund.refund_due_date));
    const statusEl = document.getElementById('ei-dr-status');
    const statusMap = { pending: 'Pending', due_soon: 'Due Soon', due_today: 'Due Today', overdue: 'Overdue', refunded: 'Refunded', partially_refunded: 'Partially Refunded', no_refund_due: 'No Refund Due' };
    statusEl.textContent = statusMap[refund.refund_status] || refund.refund_status;
    statusEl.className = 'font-bold ' + (refund.refund_status === 'refunded' ? 'text-green-400' : refund.refund_status === 'overdue' ? 'text-rose-400' : refund.refund_status === 'no_refund_due' ? 'text-slate-500' : 'text-amber-400');
    document.getElementById('btn-ei-view-refund').onclick = () => {
      document.getElementById('exit-invoice-modal').classList.add('hidden');
      showView('deposit-refunds');
      setTimeout(() => openDrDetail(refund.id), 300);
    };
  } catch (_) { panel.classList.add('hidden'); }
}

function setEiStatusMsg(msg) {
  const el = document.getElementById('ei-status-msg');
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}

async function openExitInvoiceModal(tenantCode) {
  window._eiEditing = false;
  _lastEiInvoice = null;
  const modal = document.getElementById('exit-invoice-modal');
  if (modal) modal.classList.remove('hidden');

  document.getElementById('ei-id').value = '';
  document.getElementById('ei-tenant-code').value = tenantCode;
  document.getElementById('ei-move-out-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('ei-exit-reason').value = '';
  document.getElementById('ei-mark-vacant-panel')?.classList.add('hidden');
  setEiStatusMsg('');
  setTextEl('ei-number', 'Loading…');
  setTextEl('ei-status-badge', '—');
  setTextEl('ei-deposit-paid', 'KES —');
  setTextEl('ei-rent', 'KES —');
  setTextEl('ei-tenant-name', 'Loading…');
  setTextEl('ei-tenant-unit', 'Loading…');

  let summary = null;
  try { summary = await api.getInvoiceTenantSummary(tenantCode); } catch (_) { summary = null; }

  let existing = null;
  try {
    const { exit_invoices } = await api.listExitInvoices(tenantCode);
    existing = exit_invoices[0] || null;
  } catch (_) { existing = null; }

  const depPaid = existing ? existing.deposit_paid : (summary ? summary.deposit.paid : 0);
  const rent = summary ? summary.tenant.rent_amount : 0;

  setTextEl('ei-deposit-paid', `KES ${Number(depPaid).toLocaleString()}`);
  setTextEl('ei-rent', `KES ${Number(rent).toLocaleString()}`);
  setTextEl('ei-tenant-name', summary ? summary.tenant.name : tenantCode);
  setTextEl('ei-tenant-unit', summary ? `${summary.tenant.unit_label || tenantCode} — ${summary.tenant.property_name || ''}` : tenantCode);

  if (existing) {
    _lastEiInvoice = existing;
    document.getElementById('ei-id').value = existing.id;
    document.getElementById('ei-move-out-date').value = existing.move_out_date || '';
    document.getElementById('ei-exit-reason').value = existing.reason || '';

    // Restore management decisions from existing invoice
    if (existing.rent_treatment) {
      const rt = document.querySelector(`input[name="ei-rent-treatment"][value="${existing.rent_treatment}"]`);
      if (rt) { rt.checked = true; rt.dispatchEvent(new Event('change')); }
    }
    if (existing.deposit_treatment) {
      const dt = document.querySelector(`input[name="ei-deposit-treatment"][value="${existing.deposit_treatment}"]`);
      if (dt) { dt.checked = true; dt.dispatchEvent(new Event('change')); }
    }
    if (existing.pro_rated_days) {
      const prd = document.getElementById('ei-pro-rated-days');
      if (prd) prd.value = existing.pro_rated_days;
    }
    if (existing.rent_treatment_reason) {
      const rtr = document.getElementById('ei-rent-treatment-reason');
      if (rtr) rtr.value = existing.rent_treatment_reason;
    }
    if (existing.settlement_decision_reason) {
      const sdr = document.getElementById('ei-settlement-reason');
      if (sdr) sdr.value = existing.settlement_decision_reason;
    }
  }

  renderEiActions(existing);
  renderEiLines(existing ? existing.lines : []);
  recalcEiTotals();
  // Load deposit refund info for finalized invoices
  if (existing && existing.status === 'Finalized' && existing.id) {
    loadEiDepositRefundInfo(existing.id);
  } else {
    document.getElementById('ei-deposit-refund-info')?.classList.add('hidden');
  }
}

async function saveEiDraft() {
  const id = document.getElementById('ei-id').value;
  const tenantCode = document.getElementById('ei-tenant-code').value;
  const lines = collectEiLines();
  const deductions = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const depositPaid = Number(document.getElementById('ei-deposit-paid')?.textContent.replace(/[^0-9]/g, '') || 0);
  const rentAmount = Number(document.getElementById('ei-rent')?.textContent.replace(/[^0-9]/g, '') || 0);

  // Management decisions
  const rentTreatment = document.querySelector('input[name="ei-rent-treatment"]:checked')?.value || 'full_month';
  const depositTreatment = document.querySelector('input[name="ei-deposit-treatment"]:checked')?.value || 'apply_to_deductions';
  const proRatedDays = rentTreatment === 'pro_rated' ? Number(document.getElementById('ei-pro-rated-days')?.value || 0) : null;
  const rentTreatmentReason = document.getElementById('ei-rent-treatment-reason')?.value.trim() || null;
  const settlementReason = document.getElementById('ei-settlement-reason')?.value.trim() || null;

  // Compute rent charged
  let rentCharged = rentAmount;
  if (rentTreatment === 'pro_rated' && proRatedDays) {
    rentCharged = Math.round((rentAmount / 30) * proRatedDays);
  } else if (rentTreatment === 'waived') {
    rentCharged = 0;
  }

  // Compute deposit application
  let depToRent = 0;
  let depToDed = 0;
  if (depositTreatment === 'apply_to_rent') {
    depToRent = Math.min(depositPaid, rentCharged);
  } else if (depositTreatment === 'apply_to_deductions') {
    depToDed = Math.min(depositPaid, deductions);
  } else if (depositTreatment === 'apply_to_both') {
    depToRent = Math.min(depositPaid, rentCharged);
    depToDed = Math.min(depositPaid - depToRent, deductions);
  }

  const body = {
    tenant_code: tenantCode,
    lines,
    move_out_date: document.getElementById('ei-move-out-date').value || null,
    reason: document.getElementById('ei-exit-reason').value.trim() || null,
    rent_treatment: rentTreatment,
    rent_charged_amount: rentCharged,
    pro_rated_days: proRatedDays,
    rent_treatment_reason: rentTreatmentReason,
    deposit_treatment: depositTreatment,
    deposit_applied_to_rent: depToRent,
    deposit_applied_to_deductions: depToDed,
    settlement_decision_reason: settlementReason,
  };
  let invoice;
  if (id) {
    delete body.tenant_code;
    invoice = (await api.updateExitInvoice(id, body)).exit_invoice;
  } else {
    invoice = (await api.createExitInvoice(body)).exit_invoice;
  }
  document.getElementById('ei-id').value = invoice.id;
  setTextEl('ei-number', invoice.exit_number);
  _lastEiInvoice = invoice;
  renderEiActions(invoice);
  setEiStatusMsg('Draft saved. Finalize when all deductions are captured.');
  recalcEiTotals();
  return invoice;
}

async function finalizeEi() {
  const id = document.getElementById('ei-id').value;
  try {
    let invoice = id ? (await api.getExitInvoice(id)).exit_invoice : null;
    if (!invoice || invoice.status !== 'Draft') {
      invoice = await saveEiDraft();
      if (!invoice) return;
    }
    const res = await api.finalizeExitInvoice(invoice.id, {
      move_out_date: document.getElementById('ei-move-out-date').value || null,
      reason: document.getElementById('ei-exit-reason').value.trim() || null,
    });
    const fin = res.exit_invoice;
    _lastEiInvoice = fin;
    document.getElementById('ei-id').value = fin.id;
    renderEiLines(fin.lines);
    renderEiActions(fin);
    recalcEiTotals();
    setEiStatusMsg('Exit invoice finalized and locked.');
    // Load deposit refund info
    loadEiDepositRefundInfo(fin.id);
  } catch (err) {
    setEiStatusMsg('Error: ' + (err.message || err));
  }
}

async function runExitInvoiceAction(mode) {
  const id = document.getElementById('ei-id').value;
  const tenantCode = document.getElementById('ei-tenant-code').value;
  const markPanel = document.getElementById('ei-mark-vacant-panel');
  if (!id) return setEiStatusMsg('No exit invoice. Create and finalize it first.');
  setEiStatusMsg(mode === 'download' ? 'Generating exit invoice PDF…' : mode === 'both' ? 'Sending and generating exit invoice…' : 'Sending exit invoice via WhatsApp…');
  try {
    if (mode === 'download' || mode === 'both') {
      const result = await api.downloadExitInvoice(id);
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || `exit-invoice-${tenantCode}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      if (mode === 'download') setEiStatusMsg('Exit Invoice downloaded. Completed successfully.');
      else setEiStatusMsg('Exit Invoice sent via WhatsApp and downloaded. Completed successfully.');
    } else {
      await api.sendExitInvoice(id);
      setEiStatusMsg('Exit Invoice sent via WhatsApp. Completed successfully.');
    }
    if (markPanel) markPanel.classList.remove('hidden');
  } catch (err) {
    setEiStatusMsg('Error: ' + (err.message || err));
  }
}

async function markVacantFromEi() {
  const tenantCode = document.getElementById('ei-tenant-code').value;
  const id = document.getElementById('ei-id').value;
  const moveOut = document.getElementById('ei-move-out-date').value || null;
  const reason = document.getElementById('ei-exit-reason').value.trim() || null;
  if (!tenantCode) return;
  if (!confirm('Mark unit ' + tenantCode + ' as VACANT? The tenancy will be permanently archived.')) return;
  setEiStatusMsg('Marking unit vacant and archiving tenancy…');
  try {
    await api.markUnitVacant(tenantCode, { exit_invoice_id: id || null, move_out_date: moveOut, reason });
    document.getElementById('exit-invoice-modal').classList.add('hidden');
    alert(`Unit ${tenantCode} marked VACANT. The tenancy has been permanently archived.`);
    if (currentView === 'tenant-dashboard') {
      // Tenant is now vacant — go back to the houses view
      setHash('houses');
      showView('houses');
    } else if (currentView === 'house-dashboard') {
      loadHouseDashboardPage(activeHouseId);
    }
    loadTenants();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    setEiStatusMsg('Error: ' + (err.message || err));
  }
}

// ---- Exit Invoice: Edit / Save / Delete (Finalized) ------------------------

function startEditFinalizedEi() {
  window._eiEditing = true;
  const invoice = _lastEiInvoice;
  if (!invoice) return;
  renderEiActions(invoice);
  renderEiLines(invoice.lines);
  recalcEiTotals();
  setEiStatusMsg('Editing finalized invoice. Make changes and click Save.');
}

function cancelEditEi() {
  window._eiEditing = false;
  const invoice = _lastEiInvoice;
  if (!invoice) return;
  renderEiActions(invoice);
  renderEiLines(invoice.lines);
  recalcEiTotals();
  setEiStatusMsg('');
}

async function saveFinalizedEi() {
  const id = document.getElementById('ei-id').value;
  if (!id) return setEiStatusMsg('No exit invoice to save.');
  const lines = collectEiLines();
  const depositPaid = Number(document.getElementById('ei-deposit-paid')?.textContent.replace(/[^0-9]/g, '') || 0);
  const rentAmount = Number(document.getElementById('ei-rent')?.textContent.replace(/[^0-9]/g, '') || 0);
  const rentTreatment = document.querySelector('input[name="ei-rent-treatment"]:checked')?.value || 'full_month';
  const depositTreatment = document.querySelector('input[name="ei-deposit-treatment"]:checked')?.value || 'apply_to_deductions';
  const proRatedDays = rentTreatment === 'pro_rated' ? Number(document.getElementById('ei-pro-rated-days')?.value || 0) : null;
  const rentTreatmentReason = document.getElementById('ei-rent-treatment-reason')?.value.trim() || null;
  const settlementReason = document.getElementById('ei-settlement-reason')?.value.trim() || null;
  let rentCharged = rentAmount;
  if (rentTreatment === 'pro_rated' && proRatedDays) {
    rentCharged = Math.round((rentAmount / 30) * proRatedDays);
  } else if (rentTreatment === 'waived') {
    rentCharged = 0;
  }
  let depToRent = 0, depToDed = 0;
  if (depositTreatment === 'apply_to_rent') {
    depToRent = Math.min(depositPaid, rentCharged);
  } else if (depositTreatment === 'apply_to_deductions') {
    depToDed = Math.min(depositPaid, lines.reduce((s, l) => s + Number(l.amount || 0), 0));
  } else if (depositTreatment === 'apply_to_both') {
    depToRent = Math.min(depositPaid, rentCharged);
    depToDed = Math.min(depositPaid - depToRent, lines.reduce((s, l) => s + Number(l.amount || 0), 0));
  }
  const body = {
    lines,
    move_out_date: document.getElementById('ei-move-out-date').value || null,
    reason: document.getElementById('ei-exit-reason').value.trim() || null,
    rent_treatment: rentTreatment,
    rent_charged_amount: rentCharged,
    pro_rated_days: proRatedDays,
    rent_treatment_reason: rentTreatmentReason,
    deposit_treatment: depositTreatment,
    deposit_applied_to_rent: depToRent,
    deposit_applied_to_deductions: depToDed,
    settlement_decision_reason: settlementReason,
  };
  try {
    setEiStatusMsg('Saving changes…');
    const res = await api.updateExitInvoice(id, body);
    const updated = res.exit_invoice;
    _lastEiInvoice = updated;
    window._eiEditing = false;
    document.getElementById('ei-id').value = updated.id;
    setTextEl('ei-number', updated.exit_number);
    renderEiActions(updated);
    renderEiLines(updated.lines);
    recalcEiTotals();
    setEiStatusMsg('Changes saved successfully.');
    loadEiDepositRefundInfo(updated.id);
  } catch (err) {
    setEiStatusMsg('Error saving: ' + (err.message || err));
  }
}

async function deleteExitInvoice() {
  const id = document.getElementById('ei-id').value;
  const tenantCode = document.getElementById('ei-tenant-code').value;
  if (!id) return;
  if (!confirm('Are you sure you want to delete this Exit Invoice? This will also cancel the associated deposit refund process.')) return;
  try {
    setEiStatusMsg('Deleting exit invoice…');
    await api.deleteExitInvoice(id);
    document.getElementById('exit-invoice-modal').classList.add('hidden');
    window._eiEditing = false;
    _lastEiInvoice = null;
    alert('Exit Invoice deleted. The associated deposit refund process has been cancelled.');
    if (currentView === 'tenant-dashboard') {
      loadTenantDashboard(tenantCode);
    }
    loadTenants();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    setEiStatusMsg('Error deleting: ' + (err.message || err));
  }
}

var _lastEiInvoice = null;

// ---- Tenancy Archive view ---------------------------------------------------

async function refreshHouseSelects(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  try {
    const { houses } = await api.houses();
    sel.innerHTML = '<option value="">All Properties</option>' + houses.map(h =>
      `<option value="${escapeHtml(h.paybill_number || h.id || '')}">${escapeHtml(h.house_name)}</option>`).join('');
  } catch (_) { /* keep empty */ }
}

async function loadArchive() {
  await Promise.all([refreshHouseSelects('archive-house'), refreshHouseSelects('occupancy-house')]);
  const q = document.getElementById('archive-q').value.trim();
  const house = document.getElementById('archive-house').value;
  const unit = document.getElementById('archive-unit').value.trim();
  const exitDate = document.getElementById('archive-exit-date').value;
  const params = {};
  if (q) params.q = q;
  if (house) params.house_id = house;
  if (unit) params.unit_code = unit;
  if (exitDate) params.to = exitDate;
  const tbody = document.getElementById('archive-tbody');
  const countEl = document.getElementById('archive-count');
  if (countEl) countEl.textContent = 'Searching…';
  try {
    const { archives } = await api.archives(params);
    if (countEl) countEl.textContent = `${archives.length} record${archives.length === 1 ? '' : 's'}`;
    if (!archives.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center py-6 text-slate-500">No archived tenancies found.</td></tr>';
    } else {
      tbody.innerHTML = archives.map(a => `
        <tr>
          <td class="font-semibold text-white">${escapeHtml(a.tenant_name || '—')}<div class="text-xs text-slate-500 font-mono">${escapeHtml(a.phone_number || '')}</div></td>
          <td class="font-mono text-purple-300">${escapeHtml(a.tenant_code || '—')}</td>
          <td class="text-slate-300 text-xs">${escapeHtml(a.property_name || '—')}</td>
          <td class="text-slate-400 text-xs font-mono">${fmtDate(a.move_in_date)}</td>
          <td class="text-slate-400 text-xs font-mono">${fmtDate(a.move_out_date)}</td>
          <td class="font-mono text-xs">${escapeHtml(a.exit_invoice_number || '—')}</td>
          <td class="font-mono text-right">KES ${Number(a.deposit_paid || 0).toLocaleString()}</td>
          <td class="font-mono text-right text-cyan-400">KES ${Number(a.deposit_refund || 0).toLocaleString()}</td>
          <td class="text-xs text-slate-400 max-w-[180px] truncate">${escapeHtml(a.exit_reason || '—')}</td>
          <td>
            <div class="flex gap-1">
              <button type="button" class="action-btn !py-1 !px-2 text-xs" data-archive-view="${a.id}">View</button>
              <button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-archive-del="${a.id}">Delete</button>
            </div>
          </td>
        </tr>`).join('');
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
    if (countEl) countEl.textContent = 'Error';
  }
}

async function loadOccupancyHistory() {
  const house = document.getElementById('occupancy-house').value;
  const tbody = document.getElementById('occupancy-tbody');
  if (!tbody) return;
  if (!house) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-slate-500">Select a property to view occupancy history.</td></tr>';
    return;
  }
  try {
    const { history } = await api.occupancyHistory(house);
    if (!history.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-slate-500">No occupancy records for this property.</td></tr>';
      return;
    }
    tbody.innerHTML = history.flatMap(u => u.occupants.map((o, i) => `
      <tr class="${o.status === 'Current' ? 'bg-emerald-500/5' : ''}">
        <td class="font-mono text-purple-300">${escapeHtml(u.unit_code || '—')}</td>
        <td class="text-white font-semibold">${escapeHtml(o.tenant_name || o.name || '—')}</td>
        <td>${statusBadge(o.status)}</td>
        <td class="text-xs font-mono text-slate-400">${fmtDate(o.move_in_date)}</td>
        <td class="text-xs font-mono text-slate-400">${fmtDate(o.move_out_date)}</td>
        <td class="text-xs font-mono text-slate-500">${o.status === 'Current' ? '—' : (o.exit_invoice_number ? o.exit_invoice_number : '')}</td>
      </tr>`).join('')).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function openArchiveDetail(id) {
  const modal = document.getElementById('archive-detail-modal');
  const body = document.getElementById('archive-detail-body');
  if (!modal || !body) return;
  modal.classList.remove('hidden');
  body.innerHTML = '<p class="text-slate-400">Loading…</p>';
  try {
    const { archive: a } = await api.archive(id);
    const pays = Array.isArray(a.payments) ? a.payments : [];
    const pens = Array.isArray(a.penalties) ? a.penalties : [];
    const msgs = Array.isArray(a.message_logs) ? a.message_logs : [];
    const docs = Array.isArray(a.documents) ? a.documents : [];
    const stmts = Array.isArray(a.statements) ? a.statements : [];
    const exitInv = a.exit_invoice ? (typeof a.exit_invoice === 'string' ? JSON.parse(a.exit_invoice) : a.exit_invoice) : null;
    const fin = a.financial_snapshot ? (typeof a.financial_snapshot === 'string' ? JSON.parse(a.financial_snapshot) : a.financial_snapshot) : null;
    setTextEl('archive-detail-title', `Archived Tenancy — ${a.tenant_name}`);
    setTextEl('archive-detail-sub', `Unit ${a.tenant_code} · ${a.property_name || '—'} · Archived ${a.archived_at ? new Date(a.archived_at).toLocaleString() : '—'}`);

    const ksh = (v) => `KES ${Number(v || 0).toLocaleString()}`;
    body.innerHTML = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Phone</p><p class="font-mono text-sm">${escapeHtml(a.phone_number || '—')}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">National ID</p><p class="font-mono text-sm">${escapeHtml(a.national_id || '—')}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Move In</p><p class="font-mono text-sm">${fmtDate(a.move_in_date)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Move Out</p><p class="font-mono text-sm">${fmtDate(a.move_out_date)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Rent</p><p class="font-mono text-sm text-green-400">${ksh(a.rent_amount)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Deposit Paid</p><p class="font-mono text-sm text-cyan-400">${ksh(a.deposit_paid)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Deposit Refund</p><p class="font-mono text-sm text-cyan-400">${ksh(a.deposit_refund)}</p>
        </div>
        <div class="bg-slate-900 border border-slate-700 rounded p-3">
          <p class="text-xs text-slate-500 font-mono">Final Balance</p><p class="font-mono text-sm ${a.final_balance > 0 ? 'text-rose-400' : 'text-green-400'}">${ksh(a.final_balance)}</p>
        </div>
      </div>

      ${a.exit_reason ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono">Exit Reason</p><p class="text-sm">${escapeHtml(a.exit_reason)}</p>
      </div>` : ''}

      ${exitInv ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Exit Invoice ${escapeHtml(exitInv.exit_number || a.exit_invoice_number || '')}</p>
        <table class="w-full text-sm cyber-table">
          <thead><tr><th>Item</th><th class="text-right">Amount</th></tr></thead>
          <tbody>${(exitInv.lines || []).map(l => `<tr><td>${escapeHtml(l.description || l.category || '—')}</td><td class="text-right font-mono">${ksh(l.amount)}</td></tr>`).join('')}
          </tbody>
          <tfoot>
            <tr><td class="text-slate-400">Total Deductions</td><td class="text-right font-mono text-rose-400">${ksh(exitInv.deductions_total)}</td></tr>
            <tr><td class="text-slate-400">Outstanding Balance</td><td class="text-right font-mono">${ksh(exitInv.outstanding_balance)}</td></tr>
            <tr class="font-bold"><td class="text-white">Final Settlement</td><td class="text-right font-mono text-green-400">${ksh(exitInv.final_settlement)}</td></tr>
          </tfoot>
        </table>
      </div>` : ''}

      <div id="archive-dr-section" class="bg-slate-900 border border-slate-700 rounded p-3 hidden">
        <p class="text-xs text-slate-500 font-mono mb-2">Deposit Refund</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm font-mono">
          <div>Deposit Paid: <span class="text-cyan-400" id="arch-dr-deposit">KES 0</span></div>
          <div>Deductions: <span class="text-rose-400" id="arch-dr-deductions">KES 0</span></div>
          <div>Refundable: <span class="text-green-400" id="arch-dr-refundable">KES 0</span></div>
          <div>Status: <span class="font-bold" id="arch-dr-status">—</span></div>
          <div>Due Date: <span class="text-amber-400" id="arch-dr-due">—</span></div>
          <div>Refunded: <span class="text-green-400" id="arch-dr-refunded">KES 0</span></div>
          <div>Method: <span class="text-slate-300" id="arch-dr-method">—</span></div>
          <div>Reference: <span class="text-cyan-400" id="arch-dr-ref">—</span></div>
        </div>
      </div>

      ${fin ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Financial Snapshot</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm font-mono">
          <div>Deposit: <span class="text-cyan-400">${ksh(fin.deposit_amount)}</span></div>
          <div>Deposit Paid: <span class="text-cyan-400">${ksh(fin.deposit_paid)}</span></div>
          <div>Credit: <span class="text-cyan-400">${ksh(fin.credit_balance)}</span></div>
          <div>Advance Rent: <span class="text-purple-400">${ksh(fin.advance_rent_balance)}</span></div>
        </div>
      </div>` : ''}

      <div class="glass-panel overflow-x-auto">
        <div class="p-3 border-b border-slate-700"><h4 class="font-orbitron text-white">Payments (${pays.length})</h4></div>
        <table class="data-grid w-full min-w-[500px]">
          <thead><tr><th>Receipt</th><th>Amount</th><th>Type</th><th>Date</th><th>Ref</th></tr></thead>
          <tbody>${pays.length ? pays.map(p => `<tr>
            <td class="font-mono text-xs text-cyan-400">${escapeHtml(p.receipt_number || '—')}</td>
            <td class="font-mono text-green-400">${ksh(p.amount)}</td>
            <td class="text-xs">${escapeHtml(p.payment_type || 'rent')}</td>
            <td class="text-xs font-mono text-slate-400">${fmtDate(p.payment_date)}</td>
            <td class="text-xs font-mono">${escapeHtml(p.mpesa_reference || '—')}</td>
          </tr>`).join('') : '<tr><td colspan="5" class="text-center py-4 text-slate-500">No payments</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="glass-panel overflow-x-auto">
          <div class="p-3 border-b border-slate-700"><h4 class="font-orbitron text-white">Invoices / Penalties (${pens.length})</h4></div>
          <table class="data-grid w-full">
            <thead><tr><th>No</th><th>Desc</th><th class="text-right">Amount</th><th>Status</th></tr></thead>
            <tbody>${pens.length ? pens.map(p => `<tr>
              <td class="font-mono text-xs">${escapeHtml(p.invoice_number || '—')}</td>
              <td class="text-xs">${escapeHtml(p.description || '—')}</td>
              <td class="font-mono text-right">${ksh(p.amount)}</td>
              <td class="text-xs">${escapeHtml(p.status || '—')}</td>
            </tr>`).join('') : '<tr><td colspan="4" class="text-center py-4 text-slate-500">None</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="glass-panel overflow-x-auto">
          <div class="p-3 border-b border-slate-700"><h4 class="font-orbitron text-white">Messages (${msgs.length})</h4></div>
          <table class="data-grid w-full">
            <thead><tr><th>Type</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>${msgs.length ? msgs.map(m => `<tr>
              <td class="text-xs">${escapeHtml(m.message_type || '—')}</td>
              <td class="text-xs">${escapeHtml(m.status || '—')}</td>
              <td class="text-xs font-mono text-slate-400">${m.sent_at ? new Date(m.sent_at).toLocaleDateString() : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="3" class="text-center py-4 text-slate-500">None</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      ${docs.length ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Documents (${docs.length})</p>
        <div class="flex flex-wrap gap-2 text-xs font-mono">${docs.map(d => `<span class="bg-slate-800 rounded px-2 py-1">${escapeHtml(d.document_number || d.filename || d.doc_type || '—')}</span>`).join('')}</div>
      </div>` : ''}

      ${stmts.length ? `<div class="bg-slate-900 border border-slate-700 rounded p-3">
        <p class="text-xs text-slate-500 font-mono mb-2">Statements (${stmts.length})</p>
        <p class="text-sm">${stmts.map(s => escapeHtml(s.statement_number || s.id || 'statement')).join(', ')}</p>
      </div>` : ''}`;

    // Load deposit refund info for this archive
    if (a.tenant_code) {
      try {
        const { refunds } = await api.listDepositRefunds({ tenant: a.tenant_code, sort: 'newest' });
        const dr = refunds.find(r => r.tenant_code === a.tenant_code);
        if (dr) {
          document.getElementById('archive-dr-section')?.classList.remove('hidden');
          setTextEl('arch-dr-deposit', ksh(dr.deposit_paid));
          setTextEl('arch-dr-deductions', ksh(dr.deductions_total));
          setTextEl('arch-dr-refundable', ksh(dr.refundable_amount));
          const statusMap = { pending: 'Pending', due_soon: 'Due Soon', due_today: 'Due Today', overdue: 'Overdue', refunded: 'Refunded', partially_refunded: 'Partially Refunded', no_refund_due: 'No Refund Due' };
          const sEl = document.getElementById('arch-dr-status');
          sEl.textContent = statusMap[dr.refund_status] || dr.refund_status;
          sEl.className = 'font-bold ' + (dr.refund_status === 'refunded' ? 'text-green-400' : dr.refund_status === 'overdue' ? 'text-rose-400' : 'text-amber-400');
          setTextEl('arch-dr-due', fmtDate(dr.refund_due_date));
          setTextEl('arch-dr-refunded', ksh(dr.amount_refunded));
          setTextEl('arch-dr-method', dr.payment_method || '—');
          setTextEl('arch-dr-ref', dr.transaction_reference || '—');
        }
      } catch (_) {}
    }
  } catch (err) {
    body.innerHTML = `<p class="text-rose-400">${escapeHtml(err.message)}</p>`;
  }
}

async function deleteArchiveEntry(id) {
  if (!confirm('Permanently delete this archived tenancy record? This cannot be undone.')) return;
  try {
    await api.deleteArchive(id);
    loadArchive();
  } catch (err) {
    alert(err.message);
  }
}

async function loadPendingOverpayments() {
  const tbody = document.getElementById('pending-op-tbody');
  if (!tbody) return;
  const status = document.getElementById('pending-op-status')?.value || '';
  try {
    const { records } = await api.pendingOverpayments(status || undefined);
    tbody.innerHTML = records.length
      ? records.map((r) => {
          const pending = r.status === 'Pending Allocation';
          const actionCell = pending
            ? `<button type="button" class="qc-btn qc-btn-primary px-2 py-0.5 text-xs" data-op-resolve="${r.id}">Resolve</button>`
            : `<span class="text-xs font-mono text-slate-500">${escapeHtml(r.resolution_type === 'advance_rent' ? 'Advance Rent' : (r.resolution_type === 'credit_balance' ? 'Credit Balance' : 'Resolved'))}</span>`;
          return `<tr>
            <td class="font-mono text-xs text-cyan-400">${escapeHtml(r.tenant_name)}</td>
            <td class="font-mono text-xs">${escapeHtml(r.tenant_code)}${r.unit_code && r.unit_code !== r.tenant_code ? ` · ${escapeHtml(r.unit_code)}` : ''}</td>
            <td class="text-xs">${escapeHtml(r.property_name || '—')}</td>
            <td class="text-right font-mono text-xs">${ksh(r.payment_amount)}</td>
            <td class="text-right font-mono text-xs text-amber-400 font-bold">${ksh(r.overpayment_amount)}</td>
            <td class="font-mono text-xs">${escapeHtml(r.receipt_number || '—')}</td>
            <td class="font-mono text-xs">${escapeHtml(r.transaction_reference || '—')}</td>
            <td class="font-mono text-xs">${fmtDate(r.payment_date)}</td>
            <td>${statusBadge(r.status)}</td>
            <td>${actionCell}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="10" class="text-center py-6 text-slate-500">No pending overpayments found.</td></tr>';
    tbody.querySelectorAll('[data-op-resolve]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = records.find((x) => String(x.id) === btn.dataset.opResolve);
        if (r) openPendingOpResolve(r);
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-rose-400">${escapeHtml(err.message)}</td></tr>`;
  }
}

function openPendingOpResolve(r) {
  const modal = document.getElementById('pending-op-resolve-modal');
  if (!modal) return;
  document.getElementById('pending-op-resolve-id').value = r.id;
  document.getElementById('pending-op-resolve-tenant').textContent = `${r.tenant_name} (${r.tenant_code})`;
  document.getElementById('pending-op-resolve-amount').textContent = ksh(r.overpayment_amount);
  document.getElementById('pending-op-resolve-hint').textContent = '';
  modal.dataset.tenantCode = r.tenant_code;
  modal.dataset.overpayment = r.overpayment_amount;
  modal.style.display = 'flex';
}

async function resolvePendingOp(choice) {
  const modal = document.getElementById('pending-op-resolve-modal');
  const id = document.getElementById('pending-op-resolve-id').value;
  const hint = document.getElementById('pending-op-resolve-hint');
  const tenantCode = modal.dataset.tenantCode || '';
  const overpayment = Number(modal.dataset.overpayment || 0);
  hint.textContent = 'Resolving…';
  try {
    const result = await api.resolvePendingOverpayment(id, { choice });
    modal.style.display = 'none';
    loadPendingOverpayments();
    loadPayments();
    loadDashboard();
    if (tenantCode) loadTenantDashboard(tenantCode);
    const tenantId = result.tenant?.id || '';
    if (tenantId) showOverpaymentReview(result.messageBody, tenantId);
    else loadPendingOverpayments();
  } catch (err) {
    hint.textContent = err.message;
  }
}

document.getElementById('btn-pending-op-advance')?.addEventListener('click', async () => {
  const modal = document.getElementById('pending-op-resolve-modal');
  const overpayment = Number(modal.dataset.overpayment || 0);
  const tenantCode = modal.dataset.tenantCode || '';
  const id = document.getElementById('pending-op-resolve-id').value;
  const tenantId = await getTenantIdForAdvance(tenantCode);
  if (tenantId) {
    modal.style.display = 'none';
    await openAdvanceMonthsModal(tenantId, '', overpayment, tenantCode, id);
  } else {
    resolvePendingOp('advance_rent');
  }
});

async function getTenantIdForAdvance(tenantCode) {
  if (!tenantCode) return null;
  try {
    const t = await api.tenant(tenantCode);
    return t?.tenant?.id || null;
  } catch (_) {
    return null;
  }
}

document.getElementById('btn-pending-op-credit')?.addEventListener('click', () => {
  resolvePendingOp('credit_balance');
});

document.getElementById('btn-pending-op-close')?.addEventListener('click', () => {
  document.getElementById('pending-op-resolve-modal').style.display = 'none';
});

document.getElementById('btn-pending-overpayments-refresh')?.addEventListener('click', loadPendingOverpayments);

document.getElementById('pending-op-status')?.addEventListener('change', loadPendingOverpayments);

async function openMessageModal(tenantId) {
  const modal = document.getElementById('message-modal');
  const form = document.getElementById('message-form');
  const statusEl = document.getElementById('message-status');
  const sendBtn = document.getElementById('btn-send-message');
  
  form.reset();
  statusEl.classList.add('hidden');
  statusEl.textContent = '';
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send via WhatsApp';
  
  document.getElementById('message-tenant-id').value = tenantId;
  modal.classList.remove('hidden');

  try {
    const { tenant: t } = await api.tenant(tenantId);
    document.getElementById('message-modal-title').textContent = `Send WhatsApp: ${t.name} (${t.tenant_code})`;

    // Populate template dropdown
    const select = document.getElementById('message-template-select');
    if (!templatesCache.length) {
      const { templates } = await api.templates();
      templatesCache = templates;
    }
    select.innerHTML = '<option value="">No template (use custom message)</option>' +
      templatesCache.map((tpl) => `<option value="${tpl.id}">${escapeHtml(tpl.name)}</option>`).join('');

    const handleTemplateChange = (e) => {
      const tplId = e.target.value;
      const bodyTextarea = document.getElementById('message-body');
      if (!tplId) {
        bodyTextarea.value = '';
        return;
      }
      const selectedTpl = templatesCache.find((x) => String(x.id) === String(tplId));
      if (selectedTpl) {
        bodyTextarea.value = selectedTpl.body
          .replaceAll('{{client_name}}', t.name || '')
          .replaceAll('{{tenant_code}}', t.tenant_code || '')
          .replaceAll('{{house_name}}', t.property_name || '')
          .replaceAll('{{house_number}}', t.unit_label || '');
      }
    };
    
    const newSelect = select.cloneNode(true);
    select.parentNode.replaceChild(newSelect, select);
    newSelect.addEventListener('change', handleTemplateChange);
  } catch (err) {
    statusEl.textContent = 'Failed to load tenant info: ' + err.message;
    statusEl.className = 'text-rose-400 text-sm font-mono mt-2';
    statusEl.classList.remove('hidden');
  }
}

async function openPaymentModal() {
  const modal = document.getElementById('payment-modal');
  const select = document.getElementById('payment-tenant-select');
  const { tenants } = await api.tenants();
  select.innerHTML = tenants.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)})</option>`).join('');
  document.getElementById('payment-form').reset();
  ['mpesa', 'bank', 'cheque', 'cash'].forEach(m => {
    const el = document.getElementById('payment-fields-' + m);
    if (el) el.classList.add('hidden');
  });
  document.getElementById('payment-datetime-section')?.classList.add('hidden');
  const dtEl = document.getElementById('pay-datetime');
  if (dtEl) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    dtEl.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  modal.classList.remove('hidden');
}

async function loadHouses() {
  const tbody = document.getElementById('houses-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  try {
    const { houses } = await api.houses();
    housesCache = houses;
    if (!houses.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-500">No houses yet</td></tr>`;
      return;
    }
    tbody.innerHTML = houses.map((h) => renderHouseRow(h)).join('');
  } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-rose-400 text-center py-8">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderHouseRow(h) {
  const payMethod = h.payment_method === 'till' ? `Till ${escapeHtml(h.till_number || '')}${h.till_name ? ` (${escapeHtml(h.till_name)})` : ''}` : (h.payment_paybill ? `Paybill ${escapeHtml(h.payment_paybill)}` : '—');
  return `<tr data-house-row="${h.id}">
    <td class="font-mono text-purple-300 house-cell-display">${escapeHtml(h.paybill_number)}</td>
    <td class="text-white house-cell-display">${escapeHtml(h.house_name)}</td>
    <td class="font-mono house-cell-display">${escapeHtml(h.total_units)}</td>
    <td class="font-mono text-cyan-300">${Number(h.clients_count || 0)}</td>
    <td class="font-mono house-cell-display" style="font-size:12px">${payMethod}</td>
    <td class="house-cell-display">${escapeHtml(h.notes || '—')}</td>
    <td class="space-x-1 house-row-actions">
      <button type="button" class="action-btn" data-open-house-dashboard="${h.id}">Dashboard</button>
      <button type="button" class="action-btn house-inline-edit-btn" data-inline-edit-house="${h.id}">✏ Edit</button>
      <button type="button" class="action-btn action-btn-danger" data-delete-house="${h.id}">Delete</button>
    </td>
  </tr>`;
}

function activateInlineEdit(houseId) {
  const row = document.querySelector(`tr[data-house-row="${houseId}"]`);
  if (!row) return;
  const h = housesCache.find((x) => String(x.id) === String(houseId));
  if (!h) return;

  const cells = row.querySelectorAll('td.house-cell-display');
  const [payCell, nameCell, unitsCell, notesCell] = cells;

  payCell.innerHTML = `<span class="text-slate-400 font-mono text-xs">${escapeHtml(h.paybill_number)}</span>`;
  nameCell.innerHTML = `<input class="inline-edit-input" data-field="house_name" value="${escapeHtml(h.house_name)}" placeholder="House name" />`;
  unitsCell.innerHTML = `<input class="inline-edit-input inline-edit-input--sm" type="number" min="1" data-field="total_units" value="${h.total_units}" placeholder="Units" />`;
  notesCell.innerHTML = `<input class="inline-edit-input" data-field="notes" value="${escapeHtml(h.notes || '')}" placeholder="Notes (optional)" />`;

  const actionsCell = row.querySelector('td.house-row-actions');
  actionsCell.innerHTML = `
    <button type="button" class="action-btn action-btn-save" data-inline-save-house="${houseId}">💾 Save</button>
    <button type="button" class="action-btn" data-inline-cancel-house="${houseId}">✕ Cancel</button>
  `;

  payCell.querySelector('input')?.focus();
}

async function saveInlineHouseEdit(houseId) {
  const row = document.querySelector(`tr[data-house-row="${houseId}"]`);
  if (!row) return;

  const inputs = row.querySelectorAll('input[data-field]');
  const patch = {};
  let valid = true;

  inputs.forEach((inp) => {
    const field = inp.dataset.field;
    const val = inp.value.trim();
    if (field === 'total_units') {
      const n = Number(val);
      if (!val || isNaN(n) || n < 1) { inp.classList.add('inline-edit-error'); valid = false; }
      else { inp.classList.remove('inline-edit-error'); patch[field] = n; }
    } else if (field === 'paybill_number' || field === 'house_name') {
      if (!val) { inp.classList.add('inline-edit-error'); valid = false; }
      else { inp.classList.remove('inline-edit-error'); patch[field] = val; }
    } else {
      patch[field] = val;
    }
  });

  if (!valid) return;

  const saveBtn = row.querySelector(`[data-inline-save-house="${houseId}"]`);
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const { house } = await api.updateHouse(houseId, patch);
    const idx = housesCache.findIndex((x) => String(x.id) === String(houseId));
    if (idx !== -1) {
      housesCache[idx] = { ...housesCache[idx], ...house };
      row.outerHTML = renderHouseRow(housesCache[idx]);
    } else {
      await loadHouses();
    }
    await refreshHouseOptions();
  } catch (err) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save'; }
    alert(`Save failed: ${err.message}`);
  }
}

function renderDashboardTenantRow(t, isModal) {
  const isVacant = t.status === 'Vacant';
  const name = isVacant ? '—' : t.name;
  const phone = isVacant ? '—' : t.phone_number;
  const payment = isVacant ? '—' : statusBadge(t.payment_state);

  const actionButton = isVacant
    ? `<button type="button" class="qc-btn !py-0.5 !px-1.5 text-[10px] qc-btn-primary" data-house-tenant-occupy="${t.id}">Mark Occupied</button>`
    : `<button type="button" class="action-btn !py-0.5 !px-1.5 text-[10px] action-btn-danger" data-house-tenant-vacant="${t.id}">Mark Vacant</button>`;

  if (isModal) {
    return `<tr>
      <td class="font-mono text-purple-300">
        <div class="flex items-center justify-between gap-2">
          <a href="#tenant/${t.tenant_code}" class="hover:underline text-purple-300 font-semibold" onclick="document.getElementById('house-dashboard-modal').classList.add('hidden')">${escapeHtml(t.tenant_code)}</a>
          ${actionButton}
        </div>
      </td>
      <td class="text-white">${escapeHtml(name)}</td>
      <td class="font-mono text-sm">${escapeHtml(phone)}</td>
      <td>${statusBadge(t.status)}</td>
      <td>${payment}</td>
    </tr>`;
  }

  return `<tr>
    <td class="font-mono text-purple-300">
      <div class="flex items-center justify-between gap-2">
        <a href="#tenant/${t.tenant_code}" class="hover:underline text-purple-300 font-semibold">${escapeHtml(t.tenant_code)}</a>
        ${actionButton}
      </div>
    </td>
    <td class="text-white">${escapeHtml(name)}</td>
    <td class="font-mono text-sm">${escapeHtml(phone)}</td>
    <td>${statusBadge(t.status)}</td>
    <td>${payment}</td>
    <td class="space-x-1">
      ${isVacant ? '' : `<button type="button" class="action-btn action-btn-wa" data-message-tenant="${t.id}">💬 Msg</button>`}
      <button type="button" class="action-btn" data-house-tenant-edit="${t.id}">Edit</button>
      <button type="button" class="action-btn action-btn-danger" data-house-tenant-delete="${t.id}">Delete</button>
    </td>
  </tr>`;
}

async function openHouseDashboard(houseId) {
  const modal = document.getElementById('house-dashboard-modal');
  const tbody = document.getElementById('house-dashboard-tenants-tbody');
  document.getElementById('house-dashboard-title').textContent = 'Building dashboard';
  tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-500">Loading...</td></tr>`;
  modal.classList.remove('hidden');
  try {
    const data = await api.houseDashboard(houseId);
    const b = data.building || {};
    document.getElementById('house-dashboard-title').textContent = `${b.house_name || 'Building'} dashboard`;
    document.getElementById('house-metric-total-houses').textContent = b.total_units ?? 0;
    document.getElementById('house-metric-clients').textContent = b.total_clients ?? 0;
    document.getElementById('house-metric-vacants').textContent = b.vacant_units ?? 0;
    document.getElementById('house-metric-paid').textContent = b.paid_tenants ?? 0;
    document.getElementById('house-metric-unpaid').textContent = b.unpaid_tenants ?? 0;
    const vacantList = data.vacant_units_list || [];
    document.getElementById('house-vacants-list').textContent = vacantList.length
      ? vacantList.map((t) => t.tenant_code).join(', ')
      : 'No vacant units';

    const tenants = data.tenants || [];
    if (!tenants.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-500">No units in this building</td></tr>`;
      return;
    }
    tbody.innerHTML = tenants.map((t) => renderDashboardTenantRow(t, true)).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-500">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadHouseDashboardPage(houseId) {
  if (!houseId) return;
  const titleEl = document.getElementById('house-page-title');
  const subtitleEl = document.getElementById('house-page-subtitle');
  const tenantsTbody = document.getElementById('house-page-tenants-tbody');
  if (!titleEl || !tenantsTbody) return;

  titleEl.textContent = 'House dashboard';
  if (subtitleEl) subtitleEl.textContent = 'Loading…';
  tenantsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500">Loading...</td></tr>`;

  try {
    const [{ house }, dash] = await Promise.all([api.house(houseId), api.houseDashboard(houseId)]);
    const b = dash.building || {};

    titleEl.textContent = `${house.house_name} — ${house.total_units} unit${house.total_units !== 1 ? 's' : ''}`;
    if (subtitleEl) {
      let payLabel = '';
      if (house.payment_method === 'till') {
        payLabel = `Buy Goods Till ${house.till_number || '—'}${house.till_name ? ` (${house.till_name})` : ''}`;
      } else if (house.payment_paybill) {
        const acct = house.account_number_format ? house.account_number_format.replace(/\{\{tenant_code\}\}/g, 'X') : '';
        payLabel = `M-PESA Paybill ${house.payment_paybill}${acct ? `, Account ${acct}` : ''}`;
      } else {
        payLabel = 'M-PESA Paybill — (not configured)';
      }
      subtitleEl.textContent = `House: ${house.paybill_number} | ${payLabel}`;
    }

    document.getElementById('house-page-metric-total-houses').textContent = b.total_units ?? 0;
    document.getElementById('house-page-metric-clients').textContent = b.total_clients ?? 0;
    document.getElementById('house-page-metric-vacants').textContent = b.vacant_units ?? 0;
    document.getElementById('house-page-metric-paid').textContent = b.paid_tenants ?? 0;
    document.getElementById('house-page-metric-unpaid').textContent = b.unpaid_tenants ?? 0;

    // Maintenance metrics
    const m = b.maintenance || {};
    const mEl = document.getElementById('house-page-metric-maintenance');
    const mDetail = document.getElementById('house-page-metric-maintenance-detail');
    if (mEl) mEl.textContent = money(m.total_expenses || 0);
    if (mDetail) mDetail.textContent = `${m.total_issues || 0} issues | Tenant: ${money(m.tenant_responsible || 0)} | Mgmt: ${money(m.management_paid || 0)}`;
    const vacantList = dash.vacant_units_list || [];
    document.getElementById('house-page-vacants-list').textContent = vacantList.length
      ? vacantList.map((t) => t.tenant_code).join(', ')
      : 'No vacant units';

    const tenants = dash.tenants || [];
    if (!tenants.length) {
      tenantsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500">No units in this house</td></tr>`;
      return;
    }
    tenantsTbody.innerHTML = tenants.map((t) => renderDashboardTenantRow(t, false)).join('');
  } catch (err) {
    tenantsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500">${escapeHtml(err.message)}</td></tr>`;
  }
}

function togglePaymentFields() {
  const method = document.getElementById('house-edit-payment-method').value;
  const isTill = method === 'till';
  document.getElementById('house-edit-paybill-group').style.display = isTill ? 'none' : '';
  document.getElementById('house-edit-account-group').style.display = isTill ? 'none' : '';
  document.getElementById('house-edit-till-number-group').style.display = isTill ? '' : 'none';
  document.getElementById('house-edit-till-name-group').style.display = isTill ? '' : 'none';
}

async function openHouseModal(id = null) {
  const form = document.getElementById('house-edit-form');
  form.reset();
  document.getElementById('house-edit-form-id').value = id || '';
  document.getElementById('house-edit-title').textContent = id ? 'Edit house' : 'Add house';
  const paybillInput = document.getElementById('house-edit-paybill-number');
  if (paybillInput) paybillInput.readOnly = !!id;
  if (id) {
    const house = housesCache.find((h) => String(h.id) === String(id)) ||
      await (async () => {
        try { const res = await api.house(id); return res.house; } catch { return null; }
      })();
    if (house) {
      form.paybill_number.value = house.paybill_number;
      form.house_name.value = house.house_name;
      form.total_units.value = house.total_units;
      form.notes.value = house.notes || '';
      const gfToggle = document.getElementById('house-edit-garbage-fee-toggle');
      if (gfToggle) gfToggle.checked = !!house.garbage_fee_enabled;
      document.getElementById('house-edit-payment-method').value = house.payment_method || 'paybill';
      document.getElementById('house-edit-payment-paybill').value = house.payment_paybill || '';
      document.getElementById('house-edit-account-format').value = house.account_number_format || '';
      document.getElementById('house-edit-till-number').value = house.till_number || '';
      document.getElementById('house-edit-till-name').value = house.till_name || '';
      togglePaymentFields();
    }
  }
  houseEditReturnView = id ? 'house-dashboard' : 'houses';
  showView('house-edit');
}

async function loadTemplates() {
  const { templates } = await api.templates();
  templatesCache = templates;
  const select = document.getElementById('broadcast-template-select');
  if (select) {
    select.innerHTML = `<option value="">No template (use custom message)</option>${templates
      .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
      .join('')}`;
  }
  const list = document.getElementById('templates-list');
  if (list) {
    list.innerHTML = templates
      .map(
        (t) => `<div class="p-4 border border-slate-300 rounded bg-white shadow-sm">
          <div class="flex items-start justify-between gap-2 mb-2">
            <h4 class="text-lg font-bold text-slate-800">${escapeHtml(t.name)}</h4>
            <div class="space-x-1 shrink-0">
              <button type="button" class="action-btn" data-edit-template="${t.id}">Edit</button>
              <button type="button" class="action-btn action-btn-danger" data-delete-template="${t.id}">Delete</button>
            </div>
          </div>
          <p class="text-sm text-slate-600">${escapeHtml(t.body)}</p>
        </div>`
      )
      .join('');
  }
}

async function loadBroadcastCenter() {
  await refreshHouseOptions();
  await loadTemplates();
  toggleBroadcastHouseSelect();
}

function toggleBroadcastHouseSelect() {
  const type = document.getElementById('broadcast-target-type')?.value;
  const sel = document.getElementById('broadcast-house-select');
  if (!sel) return;
  sel.disabled = type !== 'house';
}

function openTemplateModal(id = null) {
  const modal = document.getElementById('template-modal');
  const form = document.getElementById('template-form');
  form.reset();
  document.getElementById('template-form-id').value = id || '';
  document.getElementById('template-modal-title').textContent = id ? 'Edit template' : 'Add template';
  if (id) {
    const tpl = templatesCache.find((t) => String(t.id) === String(id));
    if (tpl) {
      form.name.value = tpl.name;
      form.body.value = tpl.body;
    }
  }
  modal.classList.remove('hidden');
}

function startPolls() {
  if (metricsPoll) clearInterval(metricsPoll);
  if (waPoll) clearInterval(waPoll);
  metricsPoll = setInterval(() => {
    if (currentView === 'dashboard') loadDashboard();
  }, 30000);
  waPoll = setInterval(() => {
    if (currentView === 'whatsapp') refreshWhatsappBeacon();
  }, 4000);
}

function stopPolls() {
  clearInterval(metricsPoll);
  clearInterval(waPoll);
  metricsPoll = null;
  waPoll = null;
}

async function initSession() {
  if (!api.getToken()) {
    showView('login');
    return;
  }
  try {
    const { user } = await api.me();
    api.setUser(user);
    document.getElementById('nav-username').textContent = user.display_name || user.username;
    if (document.getElementById('nav-username-mobile')) document.getElementById('nav-username-mobile').textContent = user.display_name || user.username;
    if (document.getElementById('nav-role-mobile')) document.getElementById('nav-role-mobile').textContent = (user.role || 'operator').toUpperCase();
    document.getElementById('nav-users-link')?.classList.toggle('hidden', !isAdmin());
    const routed = applyRoute();
    if (!routed) showView('dashboard');
    startPolls();
  } catch (err) {
    console.error('Session initialization failed:', err);
    if (err.status === 401 || err.status === 403) {
      api.logout();
      showView('login');
    } else {
      const routed = applyRoute();
      if (!routed) showView('dashboard');
    }
  }
}

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const result = await api.login(
      document.getElementById('username').value.trim(),
      document.getElementById('password').value
    );
    api.setToken(result.token);
    api.setUser(result.user);
    document.getElementById('nav-username').textContent = result.user.display_name || result.user.username;
    if (document.getElementById('nav-username-mobile')) document.getElementById('nav-username-mobile').textContent = result.user.display_name || result.user.username;
    if (document.getElementById('nav-role-mobile')) document.getElementById('nav-role-mobile').textContent = (result.user.role || 'operator').toUpperCase();
    document.getElementById('nav-users-link')?.classList.toggle('hidden', !isAdmin());
    const routed = applyRoute();
    if (!routed) showView('dashboard');
    startPolls();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('logout-btn')?.addEventListener('click', () => {
  api.logout();
  stopPolls();
  activeHouseId = null;
  setHash('#');
  showView('login');
});

document.getElementById('logout-btn-mobile')?.addEventListener('click', () => {
  api.logout();
  stopPolls();
  activeHouseId = null;
  setHash('#');
  showView('login');
});

document.querySelectorAll('[data-nav]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    activeHouseId = null;
    setHash('#');
    showView(a.dataset.nav);
    
    // Auto-hide mobile menu
    const container = document.getElementById('nav-container');
    if (container && window.innerWidth < 1024) {
      container.classList.add('-translate-x-full');
      document.getElementById('mobile-menu-backdrop')?.classList.add('hidden');
    }
  });
});

document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
  document.getElementById('nav-container')?.classList.remove('-translate-x-full');
  document.getElementById('mobile-menu-backdrop')?.classList.remove('hidden');
});

document.getElementById('mobile-close-btn')?.addEventListener('click', () => {
  document.getElementById('nav-container')?.classList.add('-translate-x-full');
  document.getElementById('mobile-menu-backdrop')?.classList.add('hidden');
});

document.getElementById('mobile-menu-backdrop')?.addEventListener('click', () => {
  document.getElementById('nav-container')?.classList.add('-translate-x-full');
  document.getElementById('mobile-menu-backdrop')?.classList.add('hidden');
});

// ============================================================
// SIDEBAR TOGGLE (Desktop, lg+)
// ============================================================
(function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  if (!sidebar || !toggle) return;

  // Restore saved state
  const saved = localStorage.getItem('rental_sidebar_collapsed');
  if (saved === 'true') {
    sidebar.classList.add('collapsed');
  }

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('rental_sidebar_collapsed', sidebar.classList.contains('collapsed'));
  });
})();

document.querySelectorAll('.nav-jump').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.nav));
});

document.getElementById('btn-add-tenant')?.addEventListener('click', () => openTenantModal());
document.getElementById('btn-add-tenant-dash')?.addEventListener('click', () => openTenantModal());
document.getElementById('btn-add-house')?.addEventListener('click', () => openHouseModal());
document.getElementById('btn-add-template')?.addEventListener('click', () => openTemplateModal());
document.getElementById('tenant-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('tenant-modal').classList.add('hidden');
});
document.getElementById('btn-house-edit-back')?.addEventListener('click', () => {
  if (houseEditReturnView === 'house-dashboard') showView('house-dashboard');
  else showView('houses');
});

document.getElementById('btn-house-edit-cancel')?.addEventListener('click', () => {
  if (houseEditReturnView === 'house-dashboard') showView('house-dashboard');
  else showView('houses');
});
document.getElementById('house-dashboard-close')?.addEventListener('click', () => {
  document.getElementById('house-dashboard-modal').classList.add('hidden');
});
document.getElementById('template-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('template-modal').classList.add('hidden');
});

// First billing method toggle
document.getElementById('tenant-first-billing-method')?.addEventListener('change', (e) => {
  const method = e.target.value;
  const chargeField = document.getElementById('first-billing-charge-field');
  const daysField = document.getElementById('first-billing-days-field');
  const reasonField = document.getElementById('first-billing-reason-field');
  const chargeLabel = document.getElementById('first-billing-charge-label');
  const rentInput = document.querySelector('#tenant-form input[name="rent_amount"]');

  chargeField?.classList.toggle('hidden', !method);
  daysField?.classList.toggle('hidden', method !== 'chargeable_days');
  reasonField?.classList.toggle('hidden', method !== 'custom');

  if (method === 'half_month' && rentInput) {
    const rent = Number(rentInput.value || 0);
    const chargeInput = document.querySelector('#tenant-form input[name="first_billing_charge"]');
    if (chargeInput && !chargeInput.value) chargeInput.value = Math.round(rent / 2);
    if (chargeLabel) chargeLabel.textContent = 'Half-Month Charge (KES)';
  } else if (method === 'chargeable_days' && rentInput) {
    if (chargeLabel) chargeLabel.textContent = 'First Billing Cycle Charge (KES)';
  } else if (method === 'custom') {
    if (chargeLabel) chargeLabel.textContent = 'Custom First-Month Charge (KES)';
  }
});

document.getElementById('tenant-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = document.getElementById('tenant-form-id').value;
  const openingArrears = Number(form.arrears?.value || 0);
  const openingAdvance = Number(form.opening_advance_rent?.value || 0);
  if (!id && openingArrears > 0 && openingAdvance > 0) {
    alert('A new tenant cannot have both Opening Arrears and Opening Advance Rent at the same time.');
    return;
  }
  const agreementCharge = Number(form.agreement_charge?.value || 0);
  const agreementPaid = Number(form.agreement_paid?.value || 0);
  if (agreementPaid > agreementCharge) {
    alert('Agreement Paid cannot exceed Agreement Charge.');
    return;
  }
  const body = {
    name: form.name.value,
    tenant_code: form.tenant_code.value.trim(),
    phone_number: form.phone_number.value.trim(),
    national_id: form.national_id?.value.trim() || null,
    guardian_name: form.guardian_name?.value.trim() || null,
    guardian_id: form.guardian_id?.value.trim() || null,
    guardian_phone: form.guardian_phone?.value.trim() || null,
    guardian_relationship: form.guardian_relationship?.value.trim() || null,
    house_id: form.house_id.value,
    rent_amount: Number(form.rent_amount.value),
    standard_monthly_rent: form.standard_monthly_rent?.value ? Number(form.standard_monthly_rent.value) : null,
    first_billing_method: form.first_billing_method?.value || null,
    first_billing_charge: form.first_billing_charge?.value ? Number(form.first_billing_charge.value) : null,
    first_billing_days: form.first_billing_days?.value ? Number(form.first_billing_days.value) : null,
    first_billing_reason: form.first_billing_reason?.value.trim() || null,
    deposit_amount: Number(form.deposit_amount?.value || 0),
    deposit_paid: Number(form.deposit_paid?.value || 0),
    garbage_fee_amount: Number(form.garbage_fee_amount?.value || 0),
    water_charge_amount: Number(form.water_charge_amount?.value || 0),
    arrears: openingArrears,
    opening_advance_rent: openingAdvance,
    agreement_charge: agreementCharge,
    agreement_paid: agreementPaid,
    move_in_date: form.move_in_date?.value || null,
    rent_due_date: form.rent_due_date.value,
    rent_due_time: form.rent_due_time.value,
    status: form.status.value,
  };
  try {
    if (id && form.dataset.occupyMode === '1') {
      // Mark Occupied: backend resets the previous tenancy's financial rows
      // (preserved in the archive) and registers the new tenant on this unit.
      delete body.house_id;
      delete body.status;
      delete body.deposit_paid;
      await api.markOccupied(id, body);
    } else if (id) {
      await api.updateTenant(id, body);
    } else {
      await api.createTenant(body);
    }
    document.getElementById('tenant-modal').classList.add('hidden');
    loadTenants();
    if (currentView === 'dashboard') loadDashboard();
    if (currentView === 'house-dashboard') loadHouseDashboardPage(activeHouseId);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('house-edit-payment-method')?.addEventListener('change', togglePaymentFields);

document.getElementById('house-edit-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = document.getElementById('house-edit-form-id').value;
  const body = {
    paybill_number: form.paybill_number.value.trim(),
    house_name: form.house_name.value.trim(),
    total_units: Number(form.total_units.value),
    notes: form.notes.value.trim(),
    garbage_fee_enabled: form.garbage_fee_enabled?.checked || false,
    payment_method: document.getElementById('house-edit-payment-method').value,
    payment_paybill: document.getElementById('house-edit-payment-paybill').value.trim() || null,
    account_number_format: document.getElementById('house-edit-account-format').value.trim() || null,
    till_number: document.getElementById('house-edit-till-number').value.trim() || null,
    till_name: document.getElementById('house-edit-till-name').value.trim() || null,
  };
  try {
    if (id) await api.updateHouse(id, body);
    else await api.createHouse(body);
    if (houseEditReturnView === 'house-dashboard') showView('house-dashboard');
    else {
      await loadHouses();
      showView('houses');
    }
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('template-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = document.getElementById('template-form-id').value;
  const body = {
    name: form.name.value.trim(),
    body: form.body.value.trim(),
  };
  try {
    if (id) await api.updateTemplate(id, body);
    else await api.createTemplate(body);
    document.getElementById('template-modal').classList.add('hidden');
    await loadTemplates();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('tenants-tbody')?.addEventListener('click', async (e) => {
  const editId = e.target.dataset.editTenant;
  const delId = e.target.dataset.deleteTenant;
  const msgId = e.target.dataset.messageTenant;
  const profileId = e.target.dataset.tenantProfile;
  if (profileId) {
    activeTenantCode = profileId;
    setHash(`#tenant/${profileId}`);
    showView('tenant-dashboard');
  }
  if (editId) openTenantModal(editId);
  if (msgId) openMessageModal(msgId);
  if (delId && confirm('Delete this tenant?')) {
    try {
      await api.deleteTenant(delId);
      loadTenants();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('houses-tbody')?.addEventListener('click', async (e) => {
  const dashboardId = e.target.dataset.openHouseDashboard;
  const inlineEditId = e.target.dataset.inlineEditHouse;
  const inlineSaveId = e.target.dataset.inlineSaveHouse;
  const inlineCancelId = e.target.dataset.inlineCancelHouse;
  const delId = e.target.dataset.deleteHouse;

  if (dashboardId) {
    activeHouseId = dashboardId;
    setHash(`#house/${dashboardId}`);
    showView('house-dashboard');
  }
  if (inlineEditId) activateInlineEdit(inlineEditId);
  if (inlineSaveId) await saveInlineHouseEdit(inlineSaveId);
  if (inlineCancelId) {
    // Revert to display without saving
    const h = housesCache.find((x) => String(x.id) === String(inlineCancelId));
    if (h) {
      const row = document.querySelector(`tr[data-house-row="${inlineCancelId}"]`);
      if (row) row.outerHTML = renderHouseRow(h);
    }
  }
  if (delId && confirm('Delete this house?')) {
    try {
      await api.deleteHouse(delId);
      loadHouses();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('btn-house-back')?.addEventListener('click', () => {
  activeHouseId = null;
  setHash('#');
  showView('houses');
});

document.getElementById('btn-td-back')?.addEventListener('click', () => {
  activeTenantCode = null;
  setHash('#');
  showView('tenants');
});

document.getElementById('td-penalties-tbody')?.addEventListener('click', async (e) => {
  const payId = e.target.dataset.tdPayPenalty;
  const deleteId = e.target.dataset.tdDeletePenalty;
  if (payId) {
    if (!confirm('Mark this penalty as paid?')) return;
    try {
      await api.payPenalty(payId);
      if (activeTenantCode) loadTenantPenalties(activeTenantCode);
    } catch (err) { alert(err.message); }
  } else if (deleteId) {
    if (!confirm('Delete this penalty?')) return;
    try {
      await api.deletePenalty(deleteId);
      if (activeTenantCode) loadTenantPenalties(activeTenantCode);
    } catch (err) { alert(err.message); }
  }
});

document.getElementById('btn-house-edit')?.addEventListener('click', () => {
  if (!activeHouseId) return;
  openHouseModal(activeHouseId);
});

document.getElementById('btn-house-add-tenant')?.addEventListener('click', async () => {
  if (!activeHouseId) return;
  await openTenantModal(null);
  const sel = document.getElementById('tenant-house-select');
  if (sel) sel.value = String(activeHouseId);
});



async function handleUnitAction(e) {
  const editId = e.target.dataset.houseTenantEdit;
  const delId = e.target.dataset.houseTenantDelete;
  const occupyId = e.target.dataset.houseTenantOccupy;
  const vacantId = e.target.dataset.houseTenantVacant;
  const msgId = e.target.dataset.messageTenant;

  if (editId) openTenantModal(editId);
  if (occupyId) openTenantModal(occupyId);
  if (msgId) openMessageModal(msgId);
  if (vacantId && confirm('Mark this unit as VACANT? The tenancy will be closed and permanently archived (payments, invoices, statements, maintenance history and the exit invoice are preserved in the Tenancy Archive). Financial rows are only cleared when a new tenant occupies this unit.')) {
    try {
      await api.markUnitVacant(vacantId, {});
      if (currentView === 'house-dashboard') await loadHouseDashboardPage(activeHouseId);
      else await openHouseDashboard(activeHouseId);
      loadTenants();
      if (currentView === 'dashboard') loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  }
  if (delId && confirm('Delete this tenant/unit?')) {
    try {
      await api.deleteTenant(delId);
      if (currentView === 'house-dashboard') await loadHouseDashboardPage(activeHouseId);
      else await openHouseDashboard(activeHouseId);
      loadTenants();
      if (currentView === 'dashboard') loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  }
}

document.getElementById('house-page-tenants-tbody')?.addEventListener('click', handleUnitAction);
document.getElementById('house-dashboard-tenants-tbody')?.addEventListener('click', handleUnitAction);

document.getElementById('templates-list')?.addEventListener('click', async (e) => {
  const editId = e.target.dataset.editTemplate;
  const delId = e.target.dataset.deleteTemplate;
  if (editId) openTemplateModal(editId);
  if (delId && confirm('Delete this template?')) {
    try {
      await api.deleteTemplate(delId);
      loadTemplates();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('tenant-search')?.addEventListener('input', () => loadTenants());
document.getElementById('tenant-filter-status')?.addEventListener('change', () => loadTenants());

document.getElementById('btn-record-payment')?.addEventListener('click', () => openPaymentModal());
document.getElementById('payment-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('payment-modal').classList.add('hidden');
});

document.getElementById('payment-mode-select')?.addEventListener('change', (e) => {
  const mode = e.target.value;
  ['mpesa', 'bank', 'cheque', 'cash'].forEach(m => {
    const el = document.getElementById('payment-fields-' + m);
    if (el) el.classList.toggle('hidden', m !== (mode || '').toLowerCase().replace('-', ''));
  });
  document.getElementById('payment-datetime-section')?.classList.toggle('hidden', !mode);
  if (mode === 'M-Pesa') {
    document.getElementById('payment-fields-mpesa')?.classList.remove('hidden');
  } else if (mode === 'Bank') {
    document.getElementById('payment-fields-bank')?.classList.remove('hidden');
  } else if (mode === 'Cheque') {
    document.getElementById('payment-fields-cheque')?.classList.remove('hidden');
  } else if (mode === 'Cash') {
    document.getElementById('payment-fields-cash')?.classList.remove('hidden');
  }
});

document.getElementById('payment-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const mode = form.payment_mode?.value || '';
  try {
    const payload = {
      tenant_id: form.tenant_id.value,
      amount: Number(form.amount.value),
      payment_type: form.payment_type?.value || 'rent',
      payment_mode: mode || null,
      sender_account: form.sender_account?.value?.trim() || null,
      receiver_account: form.receiver_account?.value?.trim() || null,
      cheque_number: form.cheque_number?.value?.trim() || null,
      payment_datetime: form.payment_datetime?.value || null,
    };
    if (mode === 'M-Pesa') {
      payload.mpesa_reference = form.mpesa_reference?.value?.trim() || null;
    }
    await api.createPayment(payload);
    document.getElementById('payment-modal').classList.add('hidden');
    loadPayments();
    if (currentView === 'dashboard') loadDashboard();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('payment-filter')?.addEventListener('change', () => loadPayments());
document.getElementById('broadcast-target-type')?.addEventListener('change', toggleBroadcastHouseSelect);
document.getElementById('broadcast-template-select')?.addEventListener('change', (e) => {
  const id = e.target.value;
  const body = document.getElementById('broadcast-message-body');
  if (!body) return;
  if (!id) return;
  const tpl = templatesCache.find((t) => String(t.id) === String(id));
  if (tpl) body.value = tpl.body;
});

let lastParsedPayment = null;

async function parsePaymentMessageFlow() {
  const raw = document.getElementById('payment-raw-message')?.value || '';
  const hint = document.getElementById('payment-message-hint');
  const tenantSel = document.getElementById('payment-message-tenant-select');
  const amountEl = document.getElementById('payment-message-amount');
  const refEl = document.getElementById('payment-message-ref');
  const msgEl = document.getElementById('payment-generated-message');
  const copyBtn = document.getElementById('btn-copy-generated-message');
  const approveBtn = document.getElementById('btn-approve-from-message');

  lastParsedPayment = null;
  if (approveBtn) approveBtn.disabled = true;
  if (copyBtn) copyBtn.disabled = true;
  if (tenantSel) {
    tenantSel.innerHTML = '';
    tenantSel.disabled = true;
  }
  if (amountEl) amountEl.value = '';
  if (refEl) refEl.value = '';
  if (msgEl) msgEl.value = '';

  if (!raw.trim()) {
    if (hint) hint.textContent = 'Paste a message first.';
    return;
  }

  try {
    if (hint) hint.textContent = 'Parsing…';
    const result = await api.parsePaymentMessage(raw);
    lastParsedPayment = result;

    if (amountEl) amountEl.value = result.parsed?.amount ?? '';
    if (refEl) refEl.value = result.parsed?.mpesa_reference ?? '';
    if (msgEl) msgEl.value = result.generated_message || '';

    if (result.duplicate) {
      const d = result.duplicate;
      const approvedOn = d.approved_at ? new Date(d.approved_at).toLocaleDateString() : (d.payment_date || '—');
      if (hint) hint.innerHTML = `Approval Failed: M-Pesa Reference <b>${result.parsed?.mpesa_reference || d.mpesa_reference || '—'}</b> has already been used for an approved payment.<br>Existing Record — Tenant: ${d.tenant_name || '—'}, Property: ${d.property_name || '—'}, Unit: ${d.unit_number || '—'}, Amount: KES ${Number(d.amount || 0).toLocaleString()}, Date Approved: ${approvedOn}, Receipt Number: ${d.receipt_number || '—'}.`;
      hint.style.color = '#dc2626';
      if (approveBtn) approveBtn.disabled = true;
      lastParsedPayment = null;
      return;
    }
    if (hint) hint.style.color = '';

    const matches = result.matches || [];
    if (!matches.length) {
      if (hint) hint.textContent = 'No tenant match found. Ensure the message has the tenant phone, tenant code, or house paybill number.';
      return;
    }

    if (tenantSel) {
      tenantSel.innerHTML = matches
        .map((t) => {
          const houseName = t.linked_house_name || t.property_name || '';
          const houseNo = t.linked_house_number || t.unit_label || '';
          const label = `${t.name} (${t.tenant_code}) — ${houseName}${houseNo ? ` ${houseNo}` : ''}`;
          return `<option value="${t.id}">${escapeHtml(label)}</option>`;
        })
        .join('');
      tenantSel.disabled = false;
    }

    if (hint) hint.textContent = matches.length > 1 ? 'Multiple matches found — select the correct tenant.' : 'Tenant matched.';
    if (copyBtn) copyBtn.disabled = !result.generated_message;
    if (approveBtn) approveBtn.disabled = false;
  } catch (err) {
    if (hint) hint.textContent = `Parse failed: ${err.message}`;
  }
}

async function approvePaymentFromMessageFlow() {
  const raw = document.getElementById('payment-raw-message')?.value || '';
  const tenantId = document.getElementById('payment-message-tenant-select')?.value;
  const hint = document.getElementById('payment-message-hint');
  const approveBtn = document.getElementById('btn-approve-from-message');
  if (!raw.trim()) return alert('Paste the M-Pesa message first.');
  if (!tenantId) return alert('Select a tenant first.');

  if (!confirm('Approve this payment now? This will update the tenant due date and send WhatsApp confirmation (if configured).')) return;

  try {
    if (approveBtn) approveBtn.disabled = true;
    if (hint) hint.textContent = 'Approving…';
    const result = await api.approvePaymentFromMessage({ raw_message: raw, tenant_id: tenantId });
    const msgEl = document.getElementById('payment-generated-message');
    if (msgEl && result.generated_message) msgEl.value = result.generated_message;
    const wa = result.whatsapp || {};
    const waStatus = wa.status || 'Skipped';

    if (result.overpayment > 0) {
      if (hint) hint.textContent = 'Approved with overpayment. Please resolve.';
      showOverpaymentPrompt(result);
      loadPayments();
      loadDashboard();
      return;
    }

    if (approveBtn) approveBtn.disabled = false;
    let hintMsg = `Approved. WhatsApp: ${waStatus}`;
    if (waStatus === 'Failed' && wa.failureReason) hintMsg += ` (${wa.failureReason})`;
    if (waStatus === 'Pending') hintMsg += ' (awaiting delivery confirmation)';
    if (hint) hint.textContent = hintMsg;
    loadPayments();
    loadDashboard();
  } catch (err) {
    const detail = err.data?.message || err.message;
    if (hint) {
      hint.textContent = `Approve failed: ${detail}`;
      hint.style.color = err.status === 409 ? '#dc2626' : '';
    }
    if (approveBtn) approveBtn.disabled = false;
  }
}

document.getElementById('btn-parse-payment-message')?.addEventListener('click', parsePaymentMessageFlow);
document.getElementById('btn-approve-from-message')?.addEventListener('click', approvePaymentFromMessageFlow);
document.getElementById('btn-copy-generated-message')?.addEventListener('click', async () => {
  const msg = document.getElementById('payment-generated-message')?.value || '';
  if (!msg.trim()) return;
  try {
    await navigator.clipboard.writeText(msg);
    const hint = document.getElementById('payment-message-hint');
    if (hint) hint.textContent = 'Copied message.';
  } catch {
    alert('Copy failed. Select the text and copy manually.');
  }
});

document.getElementById('broadcast-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    target_type: form.target_type.value,
    house_id: form.house_id.value || null,
    template_id: form.template_id.value ? Number(form.template_id.value) : null,
    message_body: form.message_body.value.trim(),
  };
  try {
    const result = await api.sendBroadcast(payload);
    document.getElementById('broadcast-result').textContent =
      `Broadcast complete. Sent: ${result.sent}, Failed: ${result.failed}`;
  } catch (err) {
    document.getElementById('broadcast-result').textContent = `Broadcast failed: ${err.message}`;
  }
});

document.getElementById('btn-sync-historical-payments')?.addEventListener('click', async () => {
  if (!confirm('Run historical payment synchronization? This recomputes every tenant\'s balances from approved payment history and marks all approved payments as fully synced (Approved & Sent).')) return;
  const btn = document.getElementById('btn-sync-historical-payments');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    const result = await api.syncHistoricalPayments();
    let msg = `${result.message}\n\nApproved payments: ${result.totalApproved}\nMarked synced: ${result.syncedPayments}\nTenants recomputed: ${result.tenantsRepaired}`;
    if (result.failed && result.failed.length) msg += `\nFailed: ${result.failed.length}`;
    alert(msg);
    loadPayments();
    loadDashboard();
  } catch (err) {
    alert(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============================================================
// PHASE 6: STAFF ADVANCES
// ============================================================

async function loadStaffAdvances() {
  const employee = document.getElementById('sa-employee-filter')?.value || '';
  try {
    const records = await api.listStaffAdvances(employee || undefined);
    renderStaffAdvanceList(records);
    updateStaffAdvanceSummary(records);
  } catch (e) {
    console.error('Error loading staff advances:', e);
  }
}

function renderStaffAdvanceList(records) {
  const tbody = document.getElementById('sa-list-tbody');
  if (!tbody) return;
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No staff advances recorded</td></tr>';
    return;
  }
  tbody.innerHTML = records.map(r => {
    const outstanding = Number(r.outstanding || 0);
    const statusClass = r.status === 'Fully Recovered' ? 'text-green-400' :
      r.status === 'Partially Recovered' ? 'text-amber-400' :
      r.status === 'Written Off' ? 'text-slate-500' : 'text-rose-400';
    const buttons = [
      `<button onclick="showSaPayments(${r.id})" class="text-cyan-400 hover:text-cyan-300 text-xs" title="Record Payment">Payment</button>`,
      `<button onclick="downloadStaffAdvancePdf(${r.id})" class="text-emerald-400 hover:text-emerald-300 text-xs" title="Download Invoice PDF">PDF</button>`,
    ];
    if (r.status !== 'Fully Recovered' && r.status !== 'Written Off') {
      buttons.push(`<button onclick="editStaffAdvance(${r.id})" class="text-amber-400 hover:text-amber-300 text-xs" title="Edit">Edit</button>`);
    }
    buttons.push(`<button onclick="deleteStaffAdvance(${r.id})" class="text-rose-400 hover:text-rose-300 text-xs" title="Delete">Delete</button>`);
    return `<tr>
      <td>${r.employee_name || ''}</td>
      <td>${r.date_advanced ? new Date(r.date_advanced).toLocaleDateString() : ''}</td>
      <td>${r.reason || ''}</td>
      <td>${r.property_name || ''}${r.unit_code ? ' / ' + r.unit_code : ''}</td>
      <td class="text-right font-mono">${formatKes(r.amount)}</td>
      <td class="text-right font-mono text-green-400">${formatKes(r.amount_recovered)}</td>
      <td class="text-right font-mono text-rose-400">${formatKes(outstanding)}</td>
      <td><span class="${statusClass}">${r.status}</span></td>
      <td class="text-right space-x-2">${buttons.join(' ')}</td>
    </tr>`;
  }).join('');
}

function updateStaffAdvanceSummary(records) {
  const totalAdvanced = records.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalRecovered = records.reduce((s, r) => s + Number(r.amount_recovered || 0), 0);
  const totalOutstanding = records.reduce((s, r) => s + Number(r.outstanding || 0), 0);
  const activeCount = records.filter(r => r.status !== 'Fully Recovered' && r.status !== 'Written Off').length;
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('sa-total-advanced', formatKes(totalAdvanced));
  el('sa-total-recovered', formatKes(totalRecovered));
  el('sa-total-outstanding', formatKes(totalOutstanding));
  el('sa-active-count', activeCount.toString());
}

async function loadStaffAdvanceEmployees() {
  try {
    const employees = await api.listStaffAdvanceEmployees();
    const filter = document.getElementById('sa-employee-filter');
    if (filter) {
      const current = filter.value;
      filter.innerHTML = '<option value="">All Employees</option>' + employees.map(e => `<option value="${e}">${e}</option>`).join('');
      filter.value = current;
    }
  } catch (e) { console.error('Error loading employees:', e); }
}

function showSaForm(record) {
  const wrap = document.getElementById('sa-form-wrap');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  document.getElementById('sa-form-id').value = record ? record.id : '';
  document.getElementById('sa-employee').value = record ? record.employee_name : '';
  document.getElementById('sa-date').value = record ? (record.date_advanced || '').slice(0, 10) : new Date().toISOString().slice(0, 10);
  document.getElementById('sa-amount').value = record ? record.amount : '';
  document.getElementById('sa-reason').value = record ? record.reason || '' : '';
  document.getElementById('sa-recovery-method').value = record ? record.recovery_method || 'salary_deduction' : 'salary_deduction';
  document.getElementById('sa-expected-recovery').value = record ? record.expected_recovery_month || '' : '';
  document.getElementById('sa-status').value = record ? record.status || 'Pending' : 'Pending';
  document.getElementById('sa-notes').value = record ? record.notes || '' : '';
  document.getElementById('sa-form-result').textContent = '';
  document.getElementById('sa-property').value = record ? record.property_name || '' : '';
  document.getElementById('sa-unit').value = record ? record.unit_code || '' : '';
}

function hideSaForm() {
  document.getElementById('sa-form-wrap')?.classList.add('hidden');
}

async function saveStaffAdvance(e) {
  e.preventDefault();
  const id = document.getElementById('sa-form-id').value;
  const data = {
    employee_name: document.getElementById('sa-employee').value.trim(),
    date_advanced: document.getElementById('sa-date').value,
    amount: document.getElementById('sa-amount').value,
    reason: document.getElementById('sa-reason').value.trim(),
    property_name: document.getElementById('sa-property').value || null,
    unit_code: document.getElementById('sa-unit').value.trim() || null,
    recovery_method: document.getElementById('sa-recovery-method').value,
    expected_recovery_month: document.getElementById('sa-expected-recovery').value || null,
    status: document.getElementById('sa-status').value,
    notes: document.getElementById('sa-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('sa-form-result');
  try {
    if (id) {
      await api.updateStaffAdvance(id, data);
      resultEl.textContent = 'Staff advance updated.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    } else {
      await api.createStaffAdvance(data);
      resultEl.textContent = 'Staff advance created.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    }
    hideSaForm();
    loadStaffAdvances();
    loadStaffAdvanceEmployees();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editStaffAdvance(id) {
  try {
    const record = await api.getStaffAdvance(id);
    if (record) showSaForm(record);
  } catch (e) { alert('Error loading staff advance: ' + e.message); }
}

async function deleteStaffAdvance(id) {
  if (!confirm('Delete this staff advance? This cannot be undone.')) return;
  try {
    await api.deleteStaffAdvance(id);
    loadStaffAdvances();
    loadStaffAdvanceEmployees();
  } catch (e) { alert('Error: ' + e.message); }
}

async function showSaPayments(advanceId) {
  const modal = document.getElementById('sa-payment-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('sapm-advance-id').value = advanceId;
  document.getElementById('sapm-amount').value = '';
  document.getElementById('sapm-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('sapm-time').value = new Date().toTimeString().slice(0, 5);
  document.getElementById('sapm-method').value = '';
  document.getElementById('sapm-notes').value = '';
  document.getElementById('sapm-result').textContent = '';
  document.getElementById('sapm-sender-row').classList.add('hidden');
  document.getElementById('sapm-ref-row').classList.add('hidden');
  clearSapmSenderRef();
  try {
    const adv = await api.getStaffAdvance(advanceId);
    if (adv) {
      document.getElementById('sa-pay-title').textContent = `Recovery: ${adv.employee_name}`;
      document.getElementById('sa-pay-subtitle').textContent =
        `Advanced: ${formatKes(adv.amount)} | Recovered: ${formatKes(adv.amount_recovered)} | Outstanding: ${formatKes(adv.outstanding)}`;
    }
    await loadSaPaymentHistory(advanceId);
  } catch (e) { console.error(e); }
}

function clearSapmSenderRef() {
  const senderEl = document.getElementById('sapm-sender');
  const refEl = document.getElementById('sapm-reference');
  if (senderEl) senderEl.value = '';
  if (refEl) refEl.value = '';
}

function onSaMethodChange() {
  const method = document.getElementById('sapm-method').value;
  const senderRow = document.getElementById('sapm-sender-row');
  const refRow = document.getElementById('sapm-ref-row');
  const senderLabel = document.getElementById('sapm-sender-label');
  const refLabel = document.getElementById('sapm-ref-label');
  const senderEl = document.getElementById('sapm-sender');
  const refEl = document.getElementById('sapm-reference');
  senderRow.classList.add('hidden');
  refRow.classList.add('hidden');
  clearSapmSenderRef();
  if (method === 'M-PESA') {
    senderRow.classList.remove('hidden');
    refRow.classList.remove('hidden');
    senderLabel.textContent = 'M-Pesa Number';
    senderEl.placeholder = 'e.g. 254712345678';
    refLabel.textContent = 'M-Pesa Code';
    refEl.placeholder = 'e.g. QGH7B1YKP4';
  } else if (method === 'Bank Transfer') {
    senderRow.classList.remove('hidden');
    refRow.classList.remove('hidden');
    senderLabel.textContent = 'Bank Account Number';
    senderEl.placeholder = 'Sender account number';
    refLabel.textContent = 'Transaction Reference';
    refEl.placeholder = 'Reference number';
  } else if (method === 'Cash') {
    senderRow.classList.remove('hidden');
    senderLabel.textContent = 'Received By';
    senderEl.placeholder = 'Name of person receiving cash';
  } else if (method === 'Salary Deduction' || method === 'Other') {
    refRow.classList.remove('hidden');
    refLabel.textContent = 'Reference (optional)';
    refEl.placeholder = 'Reference number';
  }
}

function getSapmSenderRef() {
  const method = document.getElementById('sapm-method').value;
  const senderEl = document.getElementById('sapm-sender');
  const refEl = document.getElementById('sapm-reference');
  return {
    sender_account: senderEl ? senderEl.value.trim() || null : null,
    reference: refEl ? refEl.value.trim() || null : null,
  };
}

async function loadSaPaymentHistory(advanceId) {
  const container = document.getElementById('sapm-payment-history');
  if (!container) return;
  try {
    const payments = await api.getStaffAdvancePayments(advanceId);
    if (!payments.length) {
      container.innerHTML = '<p class="text-slate-500">No payments recorded.</p>';
      return;
    }
    container.innerHTML = `<table class="w-full text-xs">
      <thead><tr><th>Date</th><th>Method</th><th>From</th><th>Ref</th><th class="text-right">Amount</th><th></th></tr></thead>
      <tbody>${payments.map(p => {
        const dt = p.payment_date ? new Date(p.payment_date).toLocaleDateString() : '';
        const tm = p.payment_time ? ' ' + p.payment_time.slice(0, 5) : '';
        const method = p.payment_method || '';
        const from = p.sender_account || '';
        const ref = p.reference || '';
        return `<tr>
          <td>${dt}${tm}</td>
          <td>${method}</td>
          <td>${from}</td>
          <td>${ref}</td>
          <td class="text-right font-mono">${formatKes(p.amount)}</td>
          <td class="text-right"><button onclick="deleteSaPayment(${advanceId}, ${p.id})" class="text-rose-400 hover:text-rose-300 text-xs">Del</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  } catch (e) { container.textContent = 'Error loading payments'; }
}

async function saveSaPayment(e) {
  e.preventDefault();
  const advanceId = document.getElementById('sapm-advance-id').value;
  const { sender_account, reference } = getSapmSenderRef();
  const data = {
    amount: document.getElementById('sapm-amount').value,
    payment_date: document.getElementById('sapm-date').value,
    payment_time: document.getElementById('sapm-time').value || null,
    payment_method: document.getElementById('sapm-method').value || null,
    sender_account,
    reference,
    notes: document.getElementById('sapm-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('sapm-result');
  try {
    await api.recordStaffAdvancePayment(advanceId, data);
    resultEl.textContent = 'Payment recorded.';
    resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('sapm-amount').value = '';
    document.getElementById('sapm-notes').value = '';
    document.getElementById('sapm-method').value = '';
    document.getElementById('sapm-sender-row').classList.add('hidden');
    document.getElementById('sapm-ref-row').classList.add('hidden');
    clearSapmSenderRef();
    await loadSaPaymentHistory(advanceId);
    loadStaffAdvances();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteSaPayment(advanceId, paymentId) {
  if (!confirm('Delete this payment?')) return;
  try {
    await api.deleteStaffAdvancePayment(advanceId, paymentId);
    await loadSaPaymentHistory(advanceId);
    loadStaffAdvances();
  } catch (e) { alert('Error: ' + e.message); }
}

// ============================================================
// PHASE 6: EMPLOYEE RENT
// ============================================================

async function loadEmployeeRent() {
  const employee = document.getElementById('er-employee-filter')?.value || '';
  const period = document.getElementById('er-period-filter')?.value || '';
  try {
    const records = await api.listEmployeeRent(employee || undefined, period || undefined);
    renderEmployeeRentList(records);
    updateEmployeeRentSummary(records);
  } catch (e) {
    console.error('Error loading employee rent:', e);
  }
}

function renderEmployeeRentList(records) {
  const tbody = document.getElementById('er-list-tbody');
  if (!tbody) return;
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No employee rent records</td></tr>';
    return;
  }
  tbody.innerHTML = records.map(r => {
    const statusClass = r.status === 'Fully Paid' ? 'text-green-400' :
      r.status === 'Partially Paid' ? 'text-amber-400' : 'text-rose-400';
    const buttons = [
      `<button onclick="showErPayments(${r.id})" class="text-cyan-400 hover:text-cyan-300 text-xs" title="Record Payment">Pay</button>`,
      `<button onclick="downloadEmployeeRentPdf(${r.id})" class="text-emerald-400 hover:text-emerald-300 text-xs" title="Download Invoice PDF">PDF</button>`,
    ];
    if (Number(r.outstanding || 0) > 0) {
      buttons.push(`<button onclick="showErDeductModal(${r.id}, ${Number(r.outstanding || 0)})" class="text-purple-400 hover:text-purple-300 text-xs" title="Deduct from Salary">Deduct</button>`);
    }
    if (r.status !== 'Fully Paid') {
      buttons.push(`<button onclick="editEmployeeRent(${r.id})" class="text-amber-400 hover:text-amber-300 text-xs" title="Edit">Edit</button>`);
    }
    buttons.push(`<button onclick="deleteEmployeeRent(${r.id})" class="text-rose-400 hover:text-rose-300 text-xs" title="Delete">Del</button>`);
    return `<tr>
      <td>${r.employee_name || ''}</td>
      <td>${r.property_name || ''} / ${r.unit_code || ''}</td>
      <td>${r.rent_period || ''}</td>
      <td class="text-right font-mono">${formatKes(r.monthly_rent)}</td>
      <td class="text-right font-mono text-green-400">${formatKes(r.total_paid)}</td>
      <td class="text-right font-mono text-purple-400">${formatKes(r.total_deducted)}</td>
      <td class="text-right font-mono text-rose-400">${formatKes(r.outstanding)}</td>
      <td><span class="${statusClass}">${r.status}</span></td>
      <td class="text-right space-x-2">${buttons.join(' ')}</td>
    </tr>`;
  }).join('');
}

function updateEmployeeRentSummary(records) {
  const totalDue = records.reduce((s, r) => s + Number(r.previous_balance || 0) + Number(r.monthly_rent || 0), 0);
  const totalPaid = records.reduce((s, r) => s + Number(r.total_paid || 0), 0);
  const totalDeducted = records.reduce((s, r) => s + Number(r.total_deducted || 0), 0);
  const totalOutstanding = records.reduce((s, r) => s + Number(r.outstanding || 0), 0);
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('er-total-due', formatKes(totalDue));
  el('er-total-paid', formatKes(totalPaid));
  el('er-total-deducted', formatKes(totalDeducted));
  el('er-total-outstanding', formatKes(totalOutstanding));
  el('er-record-count', records.length.toString());
}

async function loadEmployeeRentEmployees() {
  try {
    const employees = await api.listEmployeeRentEmployees();
    const filter = document.getElementById('er-employee-filter');
    if (filter) {
      const current = filter.value;
      filter.innerHTML = '<option value="">All Employees</option>' + employees.map(e => `<option value="${e}">${e}</option>`).join('');
      filter.value = current;
    }
  } catch (e) { console.error('Error loading employees:', e); }
}

function showErForm(record) {
  const wrap = document.getElementById('er-form-wrap');
  if (!wrap) return;
  wrap.classList.remove('hidden');

  const propSel = document.getElementById('er-property');
  if (propSel && propSel.options.length <= 1) {
    api.houses().then(({ houses }) => {
      propSel.innerHTML = '<option value="">Select property</option>' +
        houses.map(h => `<option value="${escapeHtml(h.house_name)}">${escapeHtml(h.house_name)}</option>`).join('');
      if (record && record.property_name) propSel.value = record.property_name;
    }).catch(() => {});
  }

  document.getElementById('er-form-id').value = record ? record.id : '';
  document.getElementById('er-employee').value = record ? record.employee_name : '';
  document.getElementById('er-unit').value = record ? record.unit_code : '';
  document.getElementById('er-monthly-rent').value = record ? record.monthly_rent : '';
  document.getElementById('er-due-day').value = record ? record.rent_due_day : 5;
  document.getElementById('er-period').value = record ? record.rent_period : new Date().toISOString().slice(0, 7);
  document.getElementById('er-previous-balance').value = record ? record.previous_balance : 0;
  document.getElementById('er-notes').value = record ? record.notes || '' : '';
  document.getElementById('er-form-result').textContent = '';
  if (record && record.property_name) {
    const propSel = document.getElementById('er-property');
    if (propSel) {
      propSel.value = record.property_name;
      if (!propSel.value) {
        const opt = document.createElement('option');
        opt.value = record.property_name;
        opt.textContent = record.property_name;
        propSel.appendChild(opt);
        propSel.value = record.property_name;
      }
    }
  } else {
    document.getElementById('er-property').value = '';
  }
  updateErPreview();
}

function hideErForm() {
  document.getElementById('er-form-wrap')?.classList.add('hidden');
}

function updateErPreview() {
  const prevBal = Number(document.getElementById('er-previous-balance')?.value || 0);
  const monthly = Number(document.getElementById('er-monthly-rent')?.value || 0);
  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('er-prev-bal-display', formatKes(prevBal));
  el('er-monthly-display', formatKes(monthly));
  el('er-total-due-display', formatKes(prevBal + monthly));
}

async function saveEmployeeRent(e) {
  e.preventDefault();
  const id = document.getElementById('er-form-id').value;
  const data = {
    employee_name: document.getElementById('er-employee').value.trim(),
    property_name: document.getElementById('er-property').value,
    unit_code: document.getElementById('er-unit').value.trim(),
    monthly_rent: document.getElementById('er-monthly-rent').value,
    rent_due_day: document.getElementById('er-due-day').value,
    rent_period: document.getElementById('er-period').value,
    previous_balance: document.getElementById('er-previous-balance').value || 0,
    notes: document.getElementById('er-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('er-form-result');
  try {
    if (id) {
      await api.updateEmployeeRent(id, data);
      resultEl.textContent = 'Rent record updated.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    } else {
      await api.createEmployeeRent(data);
      resultEl.textContent = 'Rent record created.';
      resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    }
    hideErForm();
    loadEmployeeRent();
    loadEmployeeRentEmployees();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editEmployeeRent(id) {
  try {
    const record = await api.getEmployeeRent(id);
    if (record) showErForm(record);
  } catch (e) { alert('Error loading rent record: ' + e.message); }
}

async function deleteEmployeeRent(id) {
  if (!confirm('Delete this rent record? This cannot be undone.')) return;
  try {
    await api.deleteEmployeeRent(id);
    loadEmployeeRent();
    loadEmployeeRentEmployees();
  } catch (e) { alert('Error: ' + e.message); }
}

async function showErPayments(rentId) {
  const modal = document.getElementById('er-payment-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('erpm-rent-id').value = rentId;
  document.getElementById('erpm-amount').value = '';
  document.getElementById('erpm-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('erpm-method').value = '';
  document.getElementById('erpm-reference').value = '';
  document.getElementById('erpm-notes').value = '';
  document.getElementById('erpm-result').textContent = '';
  try {
    const rent = await api.getEmployeeRent(rentId);
    if (rent) {
      document.getElementById('er-pay-title').textContent = `Rent Payment: ${rent.employee_name}`;
      document.getElementById('er-pay-subtitle').textContent =
        `${rent.property_name} ${rent.unit_code} | Rent: ${formatKes(rent.monthly_rent)} | Paid: ${formatKes(rent.total_paid)} | Outstanding: ${formatKes(rent.outstanding)}`;
    }
    await loadErPaymentHistory(rentId);
  } catch (e) { console.error(e); }
}

async function loadErPaymentHistory(rentId) {
  const container = document.getElementById('erpm-payment-history');
  if (!container) return;
  try {
    const payments = await api.getEmployeeRentPayments(rentId);
    if (!payments.length) {
      container.innerHTML = '<p class="text-slate-500">No payments recorded.</p>';
      return;
    }
    container.innerHTML = `<table class="w-full text-xs">
      <thead><tr><th>Date</th><th>Method</th><th class="text-right">Amount</th><th>Ref</th><th></th></tr></thead>
      <tbody>${payments.map(p => `<tr>
        <td>${p.payment_date ? new Date(p.payment_date).toLocaleDateString() : ''}</td>
        <td>${p.payment_method || ''}</td>
        <td class="text-right font-mono">${formatKes(p.amount)}</td>
        <td>${p.reference || ''}</td>
        <td class="text-right"><button onclick="deleteErPayment(${rentId}, ${p.id})" class="text-rose-400 hover:text-rose-300 text-xs">Del</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
  } catch (e) { container.textContent = 'Error loading payments'; }
}

async function saveErPayment(e) {
  e.preventDefault();
  const rentId = document.getElementById('erpm-rent-id').value;
  const data = {
    amount: document.getElementById('erpm-amount').value,
    payment_date: document.getElementById('erpm-date').value,
    payment_method: document.getElementById('erpm-method').value || null,
    reference: document.getElementById('erpm-reference').value.trim() || null,
    notes: document.getElementById('erpm-notes').value.trim() || null,
  };
  const resultEl = document.getElementById('erpm-result');
  try {
    await api.recordEmployeeRentPayment(rentId, data);
    resultEl.textContent = 'Payment recorded.';
    resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('erpm-amount').value = '';
    document.getElementById('erpm-reference').value = '';
    document.getElementById('erpm-notes').value = '';
    await loadErPaymentHistory(rentId);
    loadEmployeeRent();
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteErPayment(rentId, paymentId) {
  if (!confirm('Delete this payment?')) return;
  try {
    await api.deleteEmployeeRentPayment(rentId, paymentId);
    await loadErPaymentHistory(rentId);
    loadEmployeeRent();
  } catch (e) { alert('Error: ' + e.message); }
}

async function showErDeductModal(rentId, outstanding) {
  const modal = document.getElementById('er-deduct-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.getElementById('erd-rent-id').value = rentId;
  document.getElementById('erd-rent-outstanding').value = outstanding;
  document.getElementById('erd-rent-out').textContent = formatKes(outstanding);
  document.getElementById('erd-amount').value = '';
  document.getElementById('erd-result').textContent = '';
  const salarySel = document.getElementById('erd-salary-record');
  salarySel.innerHTML = '<option value="">Loading...</option>';
  try {
    const month = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
    const salaries = await api.listSalaryRecords(month);
    const employeeName = '';
    const empName = document.getElementById('er-employee-filter')?.value || '';
    const filtered = empName ? salaries.filter(s => s.employee_name === empName) : salaries;
    salarySel.innerHTML = '<option value="">Select salary</option>' +
      filtered.map(s => `<option value="${s.id}">${s.employee_name} (${s.salary_month}) - Balance: ${formatKes(s.outstanding)}</option>`).join('');
  } catch (e) { salarySel.innerHTML = '<option value="">Error loading salaries</option>'; }
}

async function saveErDeduction(e) {
  e.preventDefault();
  const rentId = document.getElementById('erd-rent-id').value;
  const salaryRecordId = document.getElementById('erd-salary-record').value;
  const amount = document.getElementById('erd-amount').value;
  const resultEl = document.getElementById('erd-result');
  if (!salaryRecordId) {
    resultEl.textContent = 'Please select a salary record.';
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  try {
    await api.deductRentFromSalary(rentId, salaryRecordId, amount);
    resultEl.textContent = 'Deduction applied successfully.';
    resultEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    loadEmployeeRent();
    document.getElementById('erd-amount').value = '';
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

// ============================================================
// PHASE 6: STAFF ADVANCE ROLLOVER
// ============================================================

async function runStaffAdvanceRollover() {
  if (!confirm('Rollover all unrecovered staff advances to the next period?')) return;
  try {
    const advances = await api.listStaffAdvances();
    const unrecovered = advances.filter(a => a.status !== 'Fully Recovered' && a.status !== 'Written Off');
    if (!unrecovered.length) {
      alert('No unrecovered staff advances to rollover.');
      return;
    }
    let rolloverCount = 0;
    for (const adv of unrecovered) {
      if (adv.expected_recovery_month) {
        const parts = adv.expected_recovery_month.split('-');
        let nextMonth = parseInt(parts[1]) + 1;
        let nextYear = parseInt(parts[0]);
        if (nextMonth > 12) { nextMonth = 1; nextYear++; }
        const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
        await api.updateStaffAdvance(adv.id, { expected_recovery_month: nextMonthStr });
        rolloverCount++;
      }
    }
    alert(`Rolled over ${rolloverCount} staff advance(s).`);
    loadStaffAdvances();
  } catch (e) { alert('Error: ' + e.message); }
}

// ============================================================
// PHASE 6: EMPLOYEE RENT ROLLOVER
// ============================================================

async function runEmployeeRentRollover() {
  if (!confirm('Rollover all outstanding employee rent to the next month?')) return;
  try {
    const currentMonth = document.getElementById('er-period-filter')?.value || new Date().toISOString().slice(0, 7);
    const records = await api.listEmployeeRent(undefined, currentMonth);
    const outstanding = records.filter(r => Number(r.outstanding || 0) > 0);
    if (!outstanding.length) {
      alert('No outstanding employee rent to rollover.');
      return;
    }
    const parts = currentMonth.split('-');
    let nextMonth = parseInt(parts[1]) + 1;
    let nextYear = parseInt(parts[0]);
    if (nextMonth > 12) { nextMonth = 1; nextYear++; }
    const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
    let rolloverCount = 0;
    for (const rec of outstanding) {
      const existingRecords = await api.listEmployeeRent(rec.employee_name, nextMonthStr);
      const exists = existingRecords.find(r => r.property_name === rec.property_name && r.unit_code === rec.unit_code);
      if (!exists) {
        await api.createEmployeeRent({
          employee_name: rec.employee_name,
          property_name: rec.property_name,
          unit_code: rec.unit_code,
          monthly_rent: rec.monthly_rent,
          rent_due_day: rec.rent_due_day,
          rent_period: nextMonthStr,
          previous_balance: rec.outstanding,
          notes: `Rolled over from ${currentMonth}`,
        });
        rolloverCount++;
      }
    }
    alert(`Rolled over ${rolloverCount} rent record(s) to ${nextMonthStr}.`);
    loadEmployeeRent();
  } catch (e) { alert('Error: ' + e.message); }
}

// ============================================================
// PHASE 6: EVENT LISTENERS
// ============================================================

// Staff Advance navigation
document.getElementById('btn-back-staff-advance')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-new-staff-advance')?.addEventListener('click', () => showSaForm(null));
document.getElementById('btn-cancel-sa-form')?.addEventListener('click', hideSaForm);
document.getElementById('staff-advance-form')?.addEventListener('submit', saveStaffAdvance);
document.getElementById('sa-employee-filter')?.addEventListener('change', loadStaffAdvances);
document.getElementById('sa-payment-form')?.addEventListener('submit', saveSaPayment);
document.getElementById('sapm-method')?.addEventListener('change', onSaMethodChange);
document.getElementById('btn-close-sapm-modal')?.addEventListener('click', () => {
  document.getElementById('sa-payment-modal').style.display = 'none';
});

// Employee Rent navigation
document.getElementById('btn-back-employee-rent')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-new-employee-rent')?.addEventListener('click', () => showErForm(null));
document.getElementById('btn-cancel-er-form')?.addEventListener('click', hideErForm);
document.getElementById('employee-rent-form')?.addEventListener('submit', saveEmployeeRent);
document.getElementById('er-employee-filter')?.addEventListener('change', loadEmployeeRent);
document.getElementById('er-period-filter')?.addEventListener('change', loadEmployeeRent);
document.getElementById('er-payment-form')?.addEventListener('submit', saveErPayment);
document.getElementById('btn-close-erpm-modal')?.addEventListener('click', () => {
  document.getElementById('er-payment-modal').style.display = 'none';
});
document.getElementById('er-deduct-form')?.addEventListener('submit', saveErDeduction);
document.getElementById('btn-close-erd-modal')?.addEventListener('click', () => {
  document.getElementById('er-deduct-modal').style.display = 'none';
});

// Employee Rent preview
document.getElementById('er-previous-balance')?.addEventListener('input', updateErPreview);
document.getElementById('er-monthly-rent')?.addEventListener('input', updateErPreview);

// Expose functions to window
window.loadStaffAdvances = loadStaffAdvances;
window.showSaPayments = showSaPayments;
window.editStaffAdvance = editStaffAdvance;
window.deleteStaffAdvance = deleteStaffAdvance;
window.deleteSaPayment = deleteSaPayment;
window.showSaForm = showSaForm;
window.loadEmployeeRent = loadEmployeeRent;
window.showErPayments = showErPayments;
window.editEmployeeRent = editEmployeeRent;
window.deleteEmployeeRent = deleteEmployeeRent;
window.deleteErPayment = deleteErPayment;
window.showErForm = showErForm;
window.showErDeductModal = showErDeductModal;
window.runStaffAdvanceRollover = runStaffAdvanceRollover;
window.runEmployeeRentRollover = runEmployeeRentRollover;

async function downloadStaffAdvancePdf(id) {
  try {
    const result = await api.downloadStaffAdvanceInvoice(id);
    triggerFileDownload(result, null, 'Staff advance invoice downloaded');
  } catch (e) { alert('Error: ' + e.message); }
}

async function downloadEmployeeRentPdf(id) {
  try {
    const result = await api.downloadEmployeeRentInvoice(id);
    triggerFileDownload(result, null, 'Employee rent invoice downloaded');
  } catch (e) { alert('Error: ' + e.message); }
}

window.downloadStaffAdvancePdf = downloadStaffAdvancePdf;
window.downloadEmployeeRentPdf = downloadEmployeeRentPdf;

document.getElementById('payments-tbody')?.addEventListener('click', async (e) => {
  const approveId = e.target.dataset.approvePayment;
  const deleteId = e.target.dataset.deletePayment;

  if (approveId) {
    if (!confirm('Approve this payment and notify tenant on WhatsApp?')) return;
    try {
      const result = await api.approvePayment(approveId);

      if (result.overpayment > 0) {
        showOverpaymentPrompt(result);
        loadPayments();
        loadDashboard();
        return;
      }

      const wa = result.whatsapp || {};
      const waStatus = wa.status || 'Skipped';

      loadPayments();
      loadDashboard();

      if (waStatus === 'Failed') {
        const resendBtn = `<button onclick="resendPaymentWhatsApp('${approveId}')" style="background:#3b82f6;color:white;padding:4px 12px;border-radius:4px;border:none;cursor:pointer;margin-top:8px">Resend WhatsApp</button>`;
        alert(`Payment approved successfully.\n\nWhatsApp delivery failed${wa.failureReason ? ': ' + wa.failureReason : ''}.\n\nYou can resend using the button below.`);
        setTimeout(() => {
          const existing = document.getElementById('wa-resend-banner');
          if (existing) existing.remove();
          const banner = document.createElement('div');
          banner.id = 'wa-resend-banner';
          banner.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1e293b;border:1px solid #ef4444;padding:16px;border-radius:8px;z-index:9999;max-width:350px;color:#e2e8f0;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
          banner.innerHTML = `<div>WhatsApp delivery failed for this payment.</div>${resendBtn} <button onclick="this.parentElement.remove()" style="background:transparent;color:#94a3b8;border:none;cursor:pointer;margin-left:8px">Dismiss</button>`;
          document.body.appendChild(banner);
        }, 100);
      } else {
        alert(`Approved. WhatsApp: ${waStatus}`);
      }
    } catch (err) {
      alert(err.message);
    }
  } else if (deleteId) {
    if (!confirm('Are you sure you want to delete this payment record?')) return;
    try {
      await api.deletePayment(deleteId);
      loadPayments();
      loadDashboard();
    } catch (err) {
      alert(err.message);
    }
  }
});

document.getElementById('td-payments-tbody')?.addEventListener('click', async (e) => {
  const deleteId = e.target.dataset.tdDeletePayment;
  if (!deleteId) return;
  if (!confirm('Are you sure you want to delete this payment record?')) return;
  try {
    await api.deletePayment(deleteId);
    const hash = window.location.hash || '';
    const match = hash.match(/^#tenant\/(.+)/);
    if (match) loadTenantDashboard(match[1]);
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('wa-beacon-slot')?.addEventListener('click', (e) => {
  if (e.target.id === 'btn-wa-reset') handleWhatsappReset();
});

initSession();
window.removeInvoiceItem = removeInvoiceItem;

window.resendPaymentWhatsApp = async function(paymentId) {
  const banner = document.getElementById('wa-resend-banner');
  if (banner) banner.remove();
  try {
    const result = await api.resendPaymentWhatsApp(paymentId);
    const wa = result.whatsapp || {};
    if (wa.status === 'Failed') {
      alert(`Resend failed: ${wa.failureReason || 'Unknown error'}`);
    } else {
      alert(`WhatsApp resent successfully. Status: ${wa.status}`);
    }
  } catch (err) {
    alert('Resend failed: ' + err.message);
  }
};

window.addEventListener('hashchange', () => {
  if (!api.getToken()) return;
  applyRoute();
});


// --- INVOICES FEATURE ---

let invoiceItemCount = 0;

function addInvoiceItem() {
  const tbody = document.getElementById('invoice-items-tbody');
  if (!tbody) return;
  const id = ++invoiceItemCount;
  const tr = document.createElement('tr');
  tr.id = `invoice-item-${id}`;
  tr.innerHTML = `
    <td><input type="number" class="cyber-input p-1 w-full text-center invoice-calc" name="qty[]" value="1" min="1" /></td>
    <td><input type="text" class="cyber-input p-1 w-full" name="desc[]" placeholder="Item description" required /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right invoice-calc" name="price[]" value="0" min="0" /></td>
    <td class="text-right font-mono text-slate-300 align-middle">KES <span class="item-total">0</span></td>
    <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeInvoiceItem(${id})">×</button></td>
  `;
  tbody.appendChild(tr);
  
  tr.querySelectorAll('.invoice-calc').forEach(inp => {
    inp.addEventListener('input', calculateInvoiceTotals);
  });
  calculateInvoiceTotals();
}

function addDeductionItem() {
  const tbody = document.getElementById('invoice-items-tbody');
  if (!tbody) return;
  const id = ++invoiceItemCount;
  const tr = document.createElement('tr');
  tr.id = `invoice-item-${id}`;
  tr.innerHTML = `
    <td><input type="number" class="cyber-input p-1 w-full text-center invoice-calc" name="qty[]" value="1" min="1" /></td>
    <td><input type="text" class="cyber-input p-1 w-full text-rose-400" name="desc[]" placeholder="Deduction (e.g. Painting)" required /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right invoice-calc text-rose-400 deduction-price" name="price[]" value="0" step="any" placeholder="Deduction amount" /></td>
    <td class="text-right font-mono text-rose-400 align-middle">KES <span class="item-total">0</span></td>
    <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeInvoiceItem(${id})">×</button></td>
  `;
  tbody.appendChild(tr);

  tr.querySelectorAll('.invoice-calc').forEach(inp => {
    inp.addEventListener('input', calculateInvoiceTotals);
  });
  calculateInvoiceTotals();
}

function removeInvoiceItem(id) {
  const tr = document.getElementById(`invoice-item-${id}`);
  if (tr) {
    tr.remove();
    calculateInvoiceTotals();
  }
}

function calculateInvoiceTotals() {
  let subtotal = 0;
  let deductions = 0;
  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody) {
    const rows = tbody.querySelectorAll('tr');
    rows.forEach(row => {
      const qty = Number(row.querySelector('input[name="qty[]"]').value) || 0;
      let price = Number(row.querySelector('input[name="price[]"]').value) || 0;
      if (row.querySelector('.deduction-price')) price = -Math.abs(price);
      const total = qty * price;
      if (price < 0) {
        deductions += total;
      } else {
        subtotal += total;
      }
      row.querySelector('.item-total').textContent = total.toLocaleString();
    });
  }

  const grandTotal = subtotal + deductions;

  const subEl = document.getElementById('invoice-subtotal');
  const dedEl = document.getElementById('invoice-total-deductions');
  const grandEl = document.getElementById('invoice-grand-total');

  if (subEl) subEl.textContent = `KES ${subtotal.toLocaleString()}`;
  if (dedEl) dedEl.textContent = `KES ${Math.abs(deductions).toLocaleString()}`;
  if (grandEl) grandEl.textContent = `KES ${grandTotal.toLocaleString()}`;
}

async function loadInvoicesCenter() {
  const { tenants } = await api.tenants();
  window.invoiceTenantsCache = tenants;
  window.exitTenantsCache = tenants;
  window.rentInvoiceTenantsCache = tenants;
  const option = t => `<option value="${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)})"></option>`;
  const dl1 = document.getElementById('invoice-tenant-datalist');
  if (dl1) dl1.innerHTML = tenants.map(option).join('');
  const dl2 = document.getElementById('exit-tenant-datalist');
  if (dl2) dl2.innerHTML = tenants.map(option).join('');
  const dl3 = document.getElementById('rent-invoice-tenant-datalist');
  if (dl3) dl3.innerHTML = tenants.map(option).join('');

  showInvoiceTypeSelector();

  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody && tbody.children.length === 0) {
    addInvoiceItem();
  }

  const dateInput = document.getElementById('invoice-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }
  const exitDate = document.getElementById('exit-date');
  if (exitDate && !exitDate.value) {
    exitDate.value = new Date().toISOString().split('T')[0];
  }
}

function showInvoiceTypeSelector() {
  const selector = document.getElementById('invoice-type-selector');
  if (selector) selector.classList.remove('hidden');
  document.getElementById('maintenance-invoice-panel')?.classList.add('hidden');
  document.getElementById('exit-invoice-panel')?.classList.add('hidden');
  document.getElementById('rent-invoice-panel')?.classList.add('hidden');
  document.getElementById('maintenance-invoices-panel')?.classList.add('hidden');
  document.getElementById('salary-panel')?.classList.add('hidden');
  document.getElementById('staff-advance-panel')?.classList.add('hidden');
  document.getElementById('employee-rent-panel')?.classList.add('hidden');
}

function showInvoiceType(type) {
  document.getElementById('invoice-type-selector')?.classList.add('hidden');
  document.getElementById('maintenance-invoice-panel')?.classList.toggle('hidden', type !== 'maintenance');
  document.getElementById('exit-invoice-panel')?.classList.toggle('hidden', type !== 'exit');
  document.getElementById('rent-invoice-panel')?.classList.toggle('hidden', type !== 'rent');
  const mntPanel = document.getElementById('maintenance-invoices-panel');
  mntPanel?.classList.toggle('hidden', type !== 'maintenance-invoice');
  if (type === 'maintenance-invoice') { loadMaintenanceInvoices(); populatePropertyDropdowns(); }
  document.getElementById('salary-panel')?.classList.toggle('hidden', type !== 'salary');
  if (type === 'salary') loadSalaryDashboard();
  document.getElementById('staff-advance-panel')?.classList.toggle('hidden', type !== 'staff-advance');
  if (type === 'staff-advance') { loadStaffAdvances(); loadStaffAdvanceEmployees(); }
  document.getElementById('employee-rent-panel')?.classList.toggle('hidden', type !== 'employee-rent');
  if (type === 'employee-rent') { loadEmployeeRent(); loadEmployeeRentEmployees(); populatePropertyDropdowns(); }
}

function resolveTenant(searchInputId, cacheKey) {
  const searchVal = document.getElementById(searchInputId)?.value;
  const cache = window[cacheKey];
  return cache?.find(t => `${t.name} (${t.tenant_code})` === searchVal) || null;
}

function money(n) {
  return `KES ${Number(n || 0).toLocaleString()}`;
}

async function autoLoadOutstandingMaintenance() {
  const match = resolveTenant('invoice-tenant-search', 'invoiceTenantsCache');
  const tbody = document.getElementById('invoice-items-tbody');
  if (!tbody) return;
  if (!match) {
    tbody.innerHTML = '';
    invoiceItemCount = 0;
    addInvoiceItem();
    return;
  }
  const resEl = document.getElementById('invoice-result');
  if (resEl) {
    resEl.textContent = 'Loading outstanding charges...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  try {
    const summary = await api.getInvoiceTenantSummary(match.tenant_code);
    tbody.innerHTML = '';
    invoiceItemCount = 0;
    if (!summary.outstanding.length) {
      addInvoiceItem();
      if (resEl) {
        resEl.textContent = 'No outstanding charges found for this tenant.';
        resEl.className = 'text-sm font-mono text-slate-400 text-right mt-2';
      }
    } else {
      summary.outstanding.forEach(o => {
        const id = ++invoiceItemCount;
        const tr = document.createElement('tr');
        tr.id = `invoice-item-${id}`;
        tr.innerHTML = `
          <td><input type="number" class="cyber-input p-1 w-full text-center invoice-calc" name="qty[]" value="1" min="1" /></td>
          <td><input type="text" class="cyber-input p-1 w-full" name="desc[]" value="${escapeHtml(o.description)}" required /></td>
          <td><input type="number" class="cyber-input p-1 w-full text-right invoice-calc" name="price[]" value="${Number(o.amount || 0)}" min="0" /></td>
          <td class="text-right font-mono text-slate-300 align-middle">KES <span class="item-total">0</span></td>
          <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeInvoiceItem(${id})">×</button></td>
        `;
        tbody.appendChild(tr);
        tr.querySelectorAll('.invoice-calc').forEach(inp => inp.addEventListener('input', calculateInvoiceTotals));
      });
      calculateInvoiceTotals();
      if (resEl) {
        resEl.textContent = `Loaded ${summary.outstanding.length} outstanding charge(s). Remove any you do not want.`;
        resEl.className = 'text-sm font-mono text-cyan-400 text-right mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Failed to load outstanding charges: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

function buildMaintenancePayload() {
  const match = resolveTenant('invoice-tenant-search', 'invoiceTenantsCache');
  if (!match) throw new Error('Please select a valid tenant from the dropdown list.');
  const date = document.getElementById('invoice-date').value;
  const invoice_no = document.getElementById('invoice-manual-no').value.trim();
  const items = [];
  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody) {
    tbody.querySelectorAll('tr').forEach(row => {
      let price = Number(row.querySelector('input[name="price[]"]').value) || 0;
      if (row.querySelector('.deduction-price')) price = -Math.abs(price);
      items.push({
        qty: Number(row.querySelector('input[name="qty[]"]').value) || 1,
        description: row.querySelector('input[name="desc[]"]').value,
        unit_price: price,
      });
    });
  }
  if (!items.length) throw new Error('Add at least one line item.');
  return { tenant_id: match.id, date, invoice_no, invoice_type: 'maintenance', items };
}

function resetMaintenanceInvoice() {
  const form = document.getElementById('invoice-form');
  if (form) form.reset();
  const tbody = document.getElementById('invoice-items-tbody');
  if (tbody) tbody.innerHTML = '';
  invoiceItemCount = 0;
  addInvoiceItem();
  const dateInput = document.getElementById('invoice-date');
  if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
}

function triggerFileDownload(result, resEl, message) {
  const filename = result.filename || 'invoice.pdf';
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  if (resEl) {
    resEl.textContent = message || `Downloaded ${filename}`;
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
  }
}

async function runInvoiceAction(mode) {
  const resEl = document.getElementById('invoice-result');
  const btn = mode === 'send' ? document.getElementById('btn-send-invoice')
    : mode === 'both' ? document.getElementById('btn-invoice-both') : document.getElementById('btn-invoice-download');
  if (resEl) {
    resEl.textContent = mode === 'send' ? 'Generating PDF and sending...'
      : mode === 'both' ? 'Sending via WhatsApp and generating PDF...' : 'Generating PDF...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  if (btn) btn.disabled = true;

  try {
    const payload = buildMaintenancePayload();
    if (mode === 'download') {
      const result = await api.downloadInvoice(payload);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else if (mode === 'both') {
      const result = await api.sendAndDownloadInvoice(payload);
      triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
    } else {
      await api.sendInvoice({ ...payload, mode: 'send' });
      if (resEl) {
        resEl.textContent = 'Invoice sent successfully!';
        resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
      }
      resetMaintenanceInvoice();
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadExitSummary() {
  const match = resolveTenant('exit-tenant-search', 'exitTenantsCache');
  const infoBox = document.getElementById('exit-tenant-info');
  const resEl = document.getElementById('exit-result');
  window.exitSummaryLoaded = false;
  if (!match) {
    infoBox?.classList.add('hidden');
    return;
  }
  if (resEl) {
    resEl.textContent = 'Loading tenant balances...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  try {
    const summary = await api.getInvoiceTenantSummary(match.tenant_code);
    window.exitSummaryLoaded = true;
    window.exitSummary = summary;
    if (infoBox) infoBox.classList.remove('hidden');

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('exit-info-name', summary.tenant.name);
    set('exit-info-unit', `${summary.tenant.property_name} / ${summary.tenant.unit_label || summary.tenant.tenant_code}`);
    set('exit-info-rent', money(summary.tenant.rent_amount));
    set('exit-info-phone', summary.tenant.phone_number || '—');
    set('exit-deposit-required', money(summary.deposit.amount));
    set('exit-deposit-balance', money(summary.deposit.balance));
    const depPaid = document.getElementById('exit-deposit-paid');
    if (depPaid) depPaid.value = summary.deposit.paid;

    const ob = document.getElementById('exit-outstanding-tbody');
    ob.innerHTML = '';
    if (summary.outstanding.length) {
      summary.outstanding.forEach(o => {
        const tr = document.createElement('tr');
        tr.dataset.amount = Number(o.amount || 0);
        tr.innerHTML = `
          <td>${escapeHtml(o.description)}</td>
          <td class="text-right font-mono text-rose-400">${money(o.amount)}</td>
        `;
        ob.appendChild(tr);
      });
    } else {
      ob.innerHTML = '<tr><td class="text-slate-400">No outstanding balances.</td><td class="text-right font-mono text-slate-400">KES 0</td></tr>';
    }

    document.getElementById('exit-deductions-tbody').innerHTML = '';
    invoiceItemCount = 0;
    calculateExitSettlement();

    if (resEl) {
      resEl.textContent = summary.outstanding.length
        ? `Loaded ${summary.outstanding.length} outstanding balance(s).`
        : 'No outstanding balances found.';
      resEl.className = 'text-sm font-mono text-cyan-400 text-right mt-2';
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Failed to load tenant balances: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

function addExitDeduction() {
  const tbody = document.getElementById('exit-deductions-tbody');
  if (!tbody) return;
  const id = ++invoiceItemCount;
  const tr = document.createElement('tr');
  tr.id = `exit-deduction-${id}`;
  tr.innerHTML = `
    <td><input type="text" class="cyber-input p-1 w-full" name="exit-desc[]" placeholder="e.g. Repairs, Cleaning, Painting" required /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right exit-deduction-amount" name="exit-amount[]" value="0" min="0" required /></td>
    <td class="text-center align-middle"><button type="button" class="text-rose-400 hover:text-rose-300 px-2" onclick="removeExitDeduction(${id})">×</button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelector('.exit-deduction-amount').addEventListener('input', calculateExitSettlement);
  calculateExitSettlement();
}

function removeExitDeduction(id) {
  const tr = document.getElementById(`exit-deduction-${id}`);
  if (tr) {
    tr.remove();
    calculateExitSettlement();
  }
}
window.removeExitDeduction = removeExitDeduction;

function calculateExitSettlement() {
  const depositPaid = Number(document.getElementById('exit-deposit-paid')?.value) || 0;
  let outstandingTotal = 0;
  document.querySelectorAll('#exit-outstanding-tbody tr').forEach(row => {
    outstandingTotal += Number(row.dataset.amount || 0);
  });
  let deductionsTotal = 0;
  document.querySelectorAll('.exit-deduction-amount').forEach(inp => {
    deductionsTotal += Math.abs(Number(inp.value) || 0);
  });
  const totalDeductions = outstandingTotal + deductionsTotal;
  const settlement = depositPaid - totalDeductions;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('exit-outstanding-total', money(outstandingTotal));
  set('exit-deductions-total', money(deductionsTotal));
  set('exit-settle-deposit-paid', money(depositPaid));
  set('exit-settle-total-deductions', money(totalDeductions));

  const box = document.getElementById('exit-settlement-box');
  const label = document.getElementById('exit-settle-label');
  const result = document.getElementById('exit-settle-result');
  if (!box || !label || !result) return;
  if (!window.exitSummaryLoaded) {
    box.className = 'rounded-lg border p-4 text-center border-slate-600 bg-slate-800/40';
    label.textContent = 'Final Settlement';
    result.className = 'text-lg font-mono font-bold text-slate-300 mt-2';
    result.textContent = 'Select a tenant';
    return;
  }
  if (settlement >= 0) {
    box.className = 'rounded-lg border p-4 text-center border-emerald-600 bg-emerald-950/40';
    label.textContent = 'Deposit Refund';
    result.className = 'text-2xl font-mono font-bold text-emerald-400 mt-2';
    result.textContent = money(settlement);
  } else {
    box.className = 'rounded-lg border p-4 text-center border-rose-600 bg-rose-950/40';
    label.textContent = 'Amount Payable by Tenant';
    result.className = 'text-2xl font-mono font-bold text-rose-400 mt-2';
    result.textContent = money(Math.abs(settlement));
  }
}

function buildExitPayload() {
  if (!window.exitSummaryLoaded) throw new Error('Select the tenant first and wait for their balances to load.');
  const match = resolveTenant('exit-tenant-search', 'exitTenantsCache');
  if (!match) throw new Error('Please select a valid tenant from the dropdown list.');
  const date = document.getElementById('exit-date').value;
  const deductions = [];
  document.querySelectorAll('#exit-deductions-tbody tr').forEach(row => {
    const desc = row.querySelector('input[name="exit-desc[]"]')?.value;
    const amt = Math.abs(Number(row.querySelector('.exit-deduction-amount')?.value) || 0);
    if (desc && amt > 0) deductions.push({ description: desc, amount: amt });
  });
  return { tenant_id: match.id, date, invoice_type: 'exit', deductions };
}

async function runExitAction(mode) {
  const resEl = document.getElementById('exit-result');
  const btn = mode === 'send' ? document.getElementById('btn-send-exit-invoice')
    : mode === 'both' ? document.getElementById('btn-exit-both') : document.getElementById('btn-exit-download');
  if (resEl) {
    resEl.textContent = mode === 'download' ? 'Generating exit statement PDF...' : 'Generating and sending...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  if (btn) btn.disabled = true;

  try {
    const payload = buildExitPayload();
    if (mode === 'download') {
      const result = await api.downloadInvoice(payload);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else if (mode === 'both') {
      const result = await api.sendAndDownloadInvoice(payload);
      triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
    } else {
      const result = await api.sendInvoice({ ...payload, mode: 'send' });
      if (resEl) {
        resEl.textContent = `Exit statement sent successfully!${result.invoice_no ? ` (${result.invoice_no})` : ''}`;
        resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function loadRentInvoiceTenantInfo() {
  const match = resolveTenant('rent-invoice-tenant-search', 'rentInvoiceTenantsCache');
  const infoBox = document.getElementById('rent-invoice-info');
  if (!match) {
    infoBox?.classList.add('hidden');
    return;
  }
  if (infoBox) infoBox.classList.remove('hidden');
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('rent-invoice-info-name', match.name);
  set('rent-invoice-info-unit', `${match.property_name || ''} / ${match.unit_label || match.tenant_code}`);
  set('rent-invoice-info-rent', money(match.rent_amount));
  set('rent-invoice-info-phone', match.phone_number || '—');
}

function buildRentInvoicePayload() {
  const match = resolveTenant('rent-invoice-tenant-search', 'rentInvoiceTenantsCache');
  if (!match) throw new Error('Please select a valid tenant from the dropdown list.');
  return {
    tenant_id: match.id,
    billing_period: document.getElementById('rent-invoice-period').value || null,
  };
}

async function runRentInvoiceAction(mode) {
  const resEl = document.getElementById('rent-invoice-result');
  const btn = mode === 'send' ? document.getElementById('btn-send-rent-invoice')
    : mode === 'both' ? document.getElementById('btn-rent-invoice-both') : document.getElementById('btn-rent-invoice-download');
  if (resEl) {
    resEl.textContent = mode === 'download' ? 'Generating rent invoice PDF...' : 'Generating and sending rent invoice...';
    resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  }
  if (btn) btn.disabled = true;

  try {
    const payload = buildRentInvoicePayload();
    if (mode === 'download') {
      const result = await api.downloadRentInvoice(payload.tenant_id, payload.billing_period);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else if (mode === 'both') {
      const result = await api.sendAndDownloadRentInvoice(payload.tenant_id, payload.billing_period);
      triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
    } else {
      const result = await api.generateRentInvoice(payload.tenant_id, 'send', payload.billing_period);
      if (resEl) {
        resEl.textContent = `Rent invoice sent successfully!${result.invoice_no ? ` (${result.invoice_no})` : ''}`;
        resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ============================================================
// MANAGEMENT EXPENSES INVOICE
// ============================================================

const MNT_CATEGORY_FIELDS = {
  petty_cash: [
    { id: 'mnt-date-spent', label: 'Date Spent', type: 'date', required: true },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'e.g. Blue House' },
    { id: 'mnt-purpose', label: 'Purpose / Description', type: 'text', placeholder: 'What was the money used for?', required: true },
    { id: 'mnt-person', label: 'Person Who Used / Received', type: 'text', placeholder: 'e.g. John Doe' },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference or file name' },
  ],
  office_purchase: [
    { id: 'mnt-date-spent', label: 'Date Purchased', type: 'date', required: true },
    { id: 'mnt-item-purchased', label: 'Item Purchased', type: 'text', placeholder: 'e.g. Printer toner', required: true },
    { id: 'mnt-quantity', label: 'Quantity', type: 'number', placeholder: '1' },
    { id: 'mnt-supplier', label: 'Supplier', type: 'text', placeholder: 'e.g. OfficeMax' },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'e.g. Blue House' },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference or file name' },
  ],
  administration: [
    { id: 'mnt-date-spent', label: 'Date Spent', type: 'date', required: true },
    { id: 'mnt-purpose', label: 'Purpose / Description', type: 'text', placeholder: 'e.g. Internet bill payment', required: true },
    { id: 'mnt-person', label: 'Person / Vendor', type: 'text', placeholder: 'e.g. Safaricom' },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'If applicable' },
    { id: 'mnt-receipt', label: 'Supporting Document', type: 'text', placeholder: 'Receipt or reference' },
  ],
  staff_reimbursement: [
    { id: 'mnt-date-spent', label: 'Date of Expense', type: 'date', required: true },
    { id: 'mnt-purpose', label: 'Purpose / Description', type: 'text', placeholder: 'What expense is being reimbursed?', required: true },
    { id: 'mnt-person', label: 'Employee / Staff Name', type: 'text', placeholder: 'e.g. Peter Kamau', required: true },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference' },
  ],
  property_maintenance: [
    { id: 'mnt-date-spent', label: 'Date of Maintenance', type: 'date', required: true },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'e.g. Blue House', required: true },
    { id: 'mnt-purpose', label: 'Work Description', type: 'text', placeholder: 'e.g. Fix leaking pipe', required: true },
    { id: 'mnt-person', label: 'Technician / Vendor', type: 'text', placeholder: 'e.g. ABC Plumbing' },
    { id: 'mnt-receipt', label: 'Supporting Receipt / Document', type: 'text', placeholder: 'Receipt reference' },
  ],
  salary: [
    { id: 'mnt-date-spent', label: 'Payment Date', type: 'date', required: true },
    { id: 'mnt-person', label: 'Employee Name', type: 'text', placeholder: 'e.g. Peter Kamau', required: true },
    { id: 'mnt-purpose', label: 'Description', type: 'text', placeholder: 'e.g. August 2026 salary' },
  ],
  other: [
    { id: 'mnt-date-spent', label: 'Date', type: 'date', required: true },
    { id: 'mnt-purpose', label: 'Description', type: 'text', placeholder: 'What is this expense for?', required: true },
    { id: 'mnt-location', label: 'Location / Property', type: 'text', placeholder: 'If applicable' },
    { id: 'mnt-receipt', label: 'Supporting Document', type: 'text', placeholder: 'Receipt or reference' },
  ],
};

const MNT_STATUS_OPTIONS = {
  petty_cash: ['Pending', 'Approved', 'Paid'],
  office_purchase: ['Pending', 'Approved', 'Paid'],
  administration: ['Pending', 'Approved', 'Paid'],
  staff_reimbursement: ['Pending Reimbursement', 'Partially Reimbursed', 'Fully Reimbursed'],
  property_maintenance: ['Pending', 'Approved', 'Paid'],
  salary: ['Pending', 'Approved', 'Paid'],
  other: ['Pending', 'Approved', 'Paid'],
};

const MNT_CATEGORY_LABELS = {
  petty_cash: 'Petty Cash',
  office_purchase: 'Office Purchase',
  administration: 'Administration',
  staff_reimbursement: 'Staff Reimbursement',
  property_maintenance: 'Property Maintenance',
  salary: 'Salary',
  other: 'Other',
};

function renderMntDynamicFields(category) {
  const container = document.getElementById('mnt-dynamic-fields');
  if (!container) return;
  const fields = MNT_CATEGORY_FIELDS[category] || MNT_CATEGORY_FIELDS.other;
  container.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-3 gap-4">' +
    fields.map(f => {
      const req = f.required ? ' required' : '';
      const ph = f.placeholder ? ` placeholder="${f.placeholder}"` : '';
      const min = f.type === 'number' ? ' min="0" step="1"' : '';
      return `<div>
        <label class="form-label">${f.label}</label>
        <input type="${f.type}" id="${f.id}" class="cyber-input"${ph}${min}${req} />
      </div>`;
    }).join('') +
    '</div>' +
    '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">' +
    '<div><label class="form-label">Notes</label><input type="text" id="mnt-notes" class="cyber-input" placeholder="Additional notes" /></div>' +
    '</div>';

  const statusSel = document.getElementById('mnt-status');
  if (statusSel) {
    const opts = MNT_STATUS_OPTIONS[category] || MNT_STATUS_OPTIONS.other;
    statusSel.innerHTML = opts.map(s => `<option value="${s}"${s === 'Pending' ? ' selected' : ''}>${s}</option>`).join('');
  }
}

function collectMntItems() {
  const category = document.getElementById('mnt-category')?.value || 'other';
  const dynamicData = {};
  const fields = MNT_CATEGORY_FIELDS[category] || MNT_CATEGORY_FIELDS.other;
  fields.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) dynamicData[f.id] = el.value.trim();
  });
  const amount = Number(document.getElementById('mnt-amount')?.value || 0);
  const notes = document.getElementById('mnt-notes')?.value?.trim() || '';
  const purpose = dynamicData['mnt-purpose'] || '';
  const person = dynamicData['mnt-person'] || '';
  const location = dynamicData['mnt-location'] || '';
  const receipt = dynamicData['mnt-receipt'] || '';
  const dateSpent = dynamicData['mnt-date-spent'] || '';
  const itemPurchased = dynamicData['mnt-item-purchased'] || '';
  const quantity = dynamicData['mnt-quantity'] || '';

  const description = purpose || itemPurchased || 'Management expense';

  const item = {
    unit_code: location || '',
    problem: description,
    work_required: category,
    work_done: person || '',
    materials: JSON.stringify(dynamicData),
    priority: 'Medium',
    status: document.getElementById('mnt-status')?.value || 'Pending',
    labour_cost: amount,
    material_cost: 0,
  };
  return [item];
}

function resetMntForm() {
  const form = document.getElementById('maintenance-invoice-form');
  if (form) form.reset();
  document.getElementById('mnt-form-id').value = '';
  document.getElementById('mnt-source-wo-id').value = '';
  document.getElementById('mnt-source-wo-number').value = '';
  document.getElementById('mnt-source-issue-nos').value = '';
  document.getElementById('mnt-category').value = 'petty_cash';
  document.getElementById('mnt-status').value = 'Pending';
  renderMntDynamicFields('petty_cash');
  document.getElementById('mnt-form-result').textContent = '';
}

async function saveMaintenanceInvoice(e) {
  e.preventDefault();
  const resEl = document.getElementById('mnt-form-result');
  const id = document.getElementById('mnt-form-id').value;
  const woId = document.getElementById('mnt-source-wo-id').value;
  const woNumber = document.getElementById('mnt-source-wo-number').value;
  const issueNos = document.getElementById('mnt-source-issue-nos').value;
  const category = document.getElementById('mnt-category')?.value || 'other';
  const items = collectMntItems();
  const amount = Number(document.getElementById('mnt-amount')?.value || 0);
  if (amount <= 0) {
    resEl.textContent = 'Enter an amount greater than 0.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }

  const notes = document.getElementById('mnt-notes')?.value?.trim() || '';
  const dateSpent = document.getElementById('mnt-date-spent')?.value || '';
  const property = document.getElementById('mnt-location')?.value?.trim() ||
    document.getElementById('mnt-property')?.value?.trim() || '';
  const fullNotes = (woNumber ? `WO Source: ${woNumber} ` : '') + notes;

  const payload = {
    property_name: property,
    house_paybill_number: null,
    unit_codes: null,
    caretaker_name: null,
    date_reported: dateSpent || new Date().toISOString().slice(0, 10),
    status: document.getElementById('mnt-status')?.value || 'Pending',
    technician_name: null,
    technician_phone: null,
    items,
    notes: fullNotes || null,
  };

  resEl.textContent = 'Saving...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  try {
    let invoice;
    if (id) {
      const result = await api.updateMaintenanceInvoice(id, payload);
      invoice = result.invoice;
      resEl.textContent = 'Expense updated.';
    } else {
      const result = await api.createMaintenanceInvoice(payload);
      invoice = result.invoice;
      resEl.textContent = 'Expense saved.';
    }

    if (woId && invoice) {
      try {
        const issueNosArr = issueNos ? issueNos.split(',').map(Number).filter(n => n > 0) : [];
        await api.linkWoExpenses(invoice.id, woId, issueNosArr.length ? issueNosArr : null);
      } catch (_) { /* WO linking is best-effort */ }
    }

    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('maintenance-invoice-form-wrap').classList.add('hidden');
    resetMntForm();
    loadMaintenanceInvoices();
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editMaintenanceInvoice(id) {
  try {
    const { invoice } = await api.getMaintenanceInvoice(id);
    if (!invoice) return;
    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ''; };
    set('mnt-form-id', invoice.id);
    set('mnt-property', invoice.property_name);
    set('mnt-date-reported', invoice.date_reported);
    set('mnt-status', invoice.status);

    const item = Array.isArray(invoice.items) && invoice.items.length ? invoice.items[0] : {};
    const category = item.work_required || 'other';
    set('mnt-category', category);
    renderMntDynamicFields(category);

    const dynamicData = item.materials ? (typeof item.materials === 'string' ? JSON.parse(item.materials || '{}') : item.materials) : {};
    Object.keys(dynamicData).forEach(key => {
      const el = document.getElementById(key);
      if (el) el.value = dynamicData[key];
    });
    set('mnt-amount', item.labour_cost || invoice.grand_total);

    const notes = (invoice.notes || '').replace(/^WO Source: \S+\s*/, '').trim();
    set('mnt-notes', notes);

    if (invoice.notes && invoice.notes.startsWith('WO Source: ')) {
      const woRef = invoice.notes.replace('WO Source: ', '').split(' ')[0];
      set('mnt-source-wo-number', woRef);
    }

    document.getElementById('maintenance-invoice-form-wrap').classList.remove('hidden');
  } catch (err) {
    const resEl = document.getElementById('mnt-form-result');
    resEl.textContent = 'Failed to load expense: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteMaintenanceInvoice(id) {
  if (!confirm('Delete this management expense?')) return;
  try {
    await api.deleteMaintenanceInvoice(id);
    loadMaintenanceInvoices();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

async function loadMaintenanceInvoices() {
  const tbody = document.getElementById('mnt-list-tbody');
  if (!tbody) return;
  try {
    const { invoices } = await api.listMaintenanceInvoices();
    if (!invoices.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-center text-slate-500 py-6">No management expenses recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = invoices.map(inv => {
      const item = Array.isArray(inv.items) && inv.items.length ? inv.items[0] : {};
      const catKey = item.work_required || 'other';
      const category = MNT_CATEGORY_LABELS[catKey] || catKey;
      const description = item.problem || '—';
      const amount = Number(inv.grand_total || 0);
      const paid = Number(inv.paid_total || 0);
      const outstanding = Math.max(0, amount - paid);
      const notes = (inv.notes || '');
      const isWoSource = notes.startsWith('WO Source: ');
      const sourceLabel = isWoSource ? 'WO' : 'Manual';
      const sourceDetail = isWoSource ? notes.replace('WO Source: ', '').split(' ')[0] : '';
      return '<tr>' +
        '<td class="font-mono">' + escapeHtml(inv.mnt_number) + '</td>' +
        '<td>' + ((inv.date_reported || '').slice(0, 10) || '—') + '</td>' +
        '<td>' + escapeHtml(category) + '</td>' +
        '<td>' + escapeHtml(description) + '</td>' +
        '<td><span class="' + (isWoSource ? 'text-emerald-400' : 'text-slate-400') + '">' + sourceLabel + '</span>' + (sourceDetail ? ' <span class="text-slate-500 text-xs">' + escapeHtml(sourceDetail) + '</span>' : '') + '</td>' +
        '<td>' + escapeHtml(inv.property_name || inv.unit_codes || '—') + '</td>' +
        '<td class="text-right font-mono">' + money(amount) + '</td>' +
        '<td class="text-right font-mono text-green-400">' + (paid > 0 ? money(paid) : '—') + '</td>' +
        '<td class="text-right font-mono ' + (outstanding > 0 ? 'text-rose-400' : 'text-green-400') + '">' + (outstanding > 0 ? money(outstanding) : '—') + '</td>' +
        '<td>' + escapeHtml(inv.status || 'Pending') + '</td>' +
        '<td class="text-right whitespace-nowrap">' +
        '<button type="button" class="action-btn px-2 py-1 text-xs" onclick="editMaintenanceInvoice(' + inv.id + ')">Edit</button> ' +
        '<button type="button" class="action-btn px-2 py-1 text-xs text-purple-400 border-purple-400" onclick="downloadExpenseInvoice(' + inv.id + ')">Invoice</button> ' +
        '<button type="button" class="action-btn px-2 py-1 text-xs text-rose-400 border-rose-400" onclick="deleteMaintenanceInvoice(' + inv.id + ')">Del</button>' +
        '</td></tr>';
    }).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="11" class="text-center text-rose-400 py-6">Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

// ============================================================
// WORK ORDER EXPENSE MODAL
// ============================================================

async function showWoExpenseModal() {
  const modal = document.getElementById('wo-expense-modal');
  const loading = document.getElementById('wo-expense-loading');
  const list = document.getElementById('wo-expense-list');
  const houseFilter = document.getElementById('wo-expense-filter-house');

  modal.style.display = 'flex';
  loading.style.display = '';
  list.classList.add('hidden');
  list.innerHTML = '';

  try {
    const { houses } = await api.houses();
    if (houseFilter && houses.length) {
      houseFilter.innerHTML = '<option value="">All Properties</option>' +
        houses.map(h => `<option value="${escapeHtml(h.paybill_number)}">${escapeHtml(h.house_name)}</option>`).join('');
    }
  } catch (_) { /* ignore */ }

  try {
    const { expenses } = await api.listEligibleManagementExpenses();
    loading.style.display = 'none';
    if (!expenses.length) {
      list.innerHTML = '<p class="text-center text-slate-400 py-4">No eligible work order expenses found. All WO management expenses are already linked to an invoice.</p>';
      list.classList.remove('hidden');
      return;
    }
    renderWoExpenseList(expenses);
  } catch (err) {
    loading.style.display = 'none';
    list.innerHTML = '<p class="text-center text-rose-400 py-4">Failed to load: ' + escapeHtml(err.message) + '</p>';
    list.classList.remove('hidden');
  }
}

function renderWoExpenseList(expenses) {
  const list = document.getElementById('wo-expense-list');
  list.innerHTML = expenses.map(e =>
    `<div class="border border-slate-700 rounded p-3 mb-2 hover:border-cyan-500 cursor-pointer transition-colors" onclick="selectWoExpense(${e.wo_id}, '${escapeHtml(e.wo_number || '')}', '${escapeHtml((e.issue_nos || []).join(','))}', '${escapeHtml(e.property_name || '')}')">
      <div class="flex justify-between items-start">
        <div>
          <p class="text-sm font-medium text-white">WO: ${escapeHtml(e.wo_number || '—')}</p>
          <p class="text-xs text-slate-400">Property: ${escapeHtml(e.property_name || '—')}</p>
          <p class="text-xs text-slate-400">Description: ${escapeHtml(e.description || '—')}</p>
          <p class="text-xs text-slate-400">Technician: ${escapeHtml(e.technician_name || '—')}</p>
          ${e.materials ? `<p class="text-xs text-slate-400">Materials: ${escapeHtml(e.materials)}</p>` : ''}
          <p class="text-xs text-slate-400">Responsible: ${escapeHtml(e.responsible_party || '—')}</p>
        </div>
        <p class="text-sm font-mono text-cyan-400">${money(e.amount)}</p>
      </div>
    </div>`
  ).join('');
  list.classList.remove('hidden');
}

function selectWoExpense(woId, woNumber, issueNos, property) {
  document.getElementById('mnt-source-wo-id').value = woId;
  document.getElementById('mnt-source-wo-number').value = woNumber;
  document.getElementById('mnt-source-issue-nos').value = issueNos;
  document.getElementById('mnt-property').value = property;
  document.getElementById('mnt-category').value = 'property_maintenance';
  renderMntDynamicFields('property_maintenance');
  document.getElementById('mnt-status').value = 'Pending';
  document.getElementById('mnt-form-result').textContent = 'Work Order ' + woNumber + ' linked. Fill in amount and save.';
  document.getElementById('mnt-form-result').className = 'text-sm font-mono text-cyan-400 text-right mt-2';
  hideWoExpenseModal();
  document.getElementById('maintenance-invoice-form-wrap').classList.remove('hidden');
}

function hideWoExpenseModal() {
  document.getElementById('wo-expense-modal').style.display = 'none';
}

function filterWoExpenses() {
  const house = document.getElementById('wo-expense-filter-house')?.value || '';
  api.listEligibleManagementExpenses(house || null).then(({ expenses }) => {
    renderWoExpenseList(expenses);
  }).catch(() => {});
}

async function runMntGenerate(id, mode, phone_number) {
  const resEl = document.getElementById('mnt-list-result');
  try {
    if (mode === 'download') {
      const result = await api.downloadMaintenanceInvoice(id);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else {
      const phone = phone_number || prompt('Send via WhatsApp to phone number:');
      if (!phone) return;
      if (mode === 'both') {
        const result = await api.sendAndDownloadMaintenanceInvoice(id, phone);
        triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
      } else {
        const result = await api.generateMaintenanceInvoice(id, 'send', phone);
        if (resEl) {
          resEl.textContent = `Invoice sent successfully!`;
          resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
        }
        loadMaintenanceInvoices();
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

window.editMaintenanceInvoice = editMaintenanceInvoice;
window.deleteMaintenanceInvoice = deleteMaintenanceInvoice;
window.runMntGenerate = runMntGenerate;
window.showWoExpenseModal = showWoExpenseModal;
window.hideWoExpenseModal = hideWoExpenseModal;
window.selectWoExpense = selectWoExpense;
window.downloadSalaryInvoice = downloadSalaryInvoice;
window.downloadReimbursementInvoice = downloadReimbursementInvoice;
window.downloadExpenseInvoice = downloadExpenseInvoice;

// ============================================================
// SALARY MANAGEMENT
// ============================================================

async function loadSalaryDashboard() {
  const month = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
  const tbody = document.getElementById('salary-list-tbody');
  if (!tbody) return;
  try {
    const { records } = await api.listSalaryRecords(month);
    let totalExpected = 0, totalPaid = 0, totalOutstanding = 0;
    records.forEach(r => {
      totalExpected += Number(r.expected_salary || 0);
      totalPaid += Number(r.total_paid || 0);
      totalOutstanding += Number(r.outstanding || 0);
    });
    document.getElementById('sal-total-expected').textContent = money(totalExpected);
    document.getElementById('sal-total-paid').textContent = money(totalPaid);
    document.getElementById('sal-total-outstanding').textContent = money(totalOutstanding);
    document.getElementById('sal-employee-count').textContent = records.length;

    if (!records.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No salary records for this month. Click "+ Add Salary" to create one.</td></tr>';
      return;
    }
    tbody.innerHTML = records.map(r => {
      const totalObligation = Number(r.expected_salary || 0) + Number(r.previous_balance || 0);
      const statusClass = r.status === 'Fully Paid' ? 'text-green-400' : r.status === 'Partially Paid' ? 'text-amber-400' : 'text-slate-400';
      return `<tr>
        <td class="font-medium text-white">${escapeHtml(r.employee_name)}</td>
        <td class="font-mono">${escapeHtml(r.salary_month)}</td>
        <td class="text-right font-mono">${r.previous_balance > 0 ? money(r.previous_balance) : '—'}</td>
        <td class="text-right font-mono">${money(r.expected_salary)}</td>
        <td class="text-right font-mono text-cyan-400">${money(totalObligation)}</td>
        <td class="text-right font-mono text-green-400">${money(r.total_paid)}</td>
        <td class="text-right font-mono ${r.outstanding > 0 ? 'text-rose-400' : 'text-green-400'}">${r.outstanding > 0 ? money(r.outstanding) : '—'}</td>
        <td class="${statusClass}">${escapeHtml(r.status)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="action-btn px-2 py-1 text-xs" onclick="editSalaryRecord(${r.id})">Edit</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-green-400 border-green-400" onclick="openSalaryPaymentModal(${r.id}, '${escapeHtml(r.employee_name)}', ${totalObligation}, ${r.total_paid})">Pay</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-purple-400 border-purple-400" onclick="downloadSalaryInvoice(${r.id})">Invoice</button>
          <button type="button" class="action-btn px-2 py-1 text-xs" onclick="showSalaryHistory('${escapeHtml(r.employee_name)}')">History</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-rose-400 border-rose-400" onclick="deleteSalaryRecord(${r.id})">Del</button>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-rose-400 py-6">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function editSalaryRecord(id) {
  try {
    const { record } = await api.getSalaryRecord(id);
    if (!record) return;
    document.getElementById('sal-form-id').value = record.id;
    document.getElementById('sal-employee').value = record.employee_name || '';
    document.getElementById('sal-month').value = record.salary_month || '';
    document.getElementById('sal-previous-balance').value = record.previous_balance || 0;
    document.getElementById('sal-expected').value = record.expected_salary || '';
    document.getElementById('sal-notes').value = record.notes || '';
    updateSalaryPreview();
    document.getElementById('salary-form-wrap').classList.remove('hidden');
  } catch (err) {
    alert('Failed to load: ' + err.message);
  }
}

async function deleteSalaryRecord(id) {
  if (!confirm('Delete this salary record and all its payments?')) return;
  try {
    await api.deleteSalaryRecord(id);
    loadSalaryDashboard();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

async function openSalaryPaymentModal(recordId, employeeName, totalObligation, totalPaid) {
  const modal = document.getElementById('salary-payment-modal');
  const outstanding = totalObligation - totalPaid;
  document.getElementById('spm-record-id').value = recordId;
  document.getElementById('spm-total-obligation').value = totalObligation;
  document.getElementById('spm-amount').value = outstanding > 0 ? outstanding : '';
  document.getElementById('spm-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('spm-method').value = '';
  document.getElementById('spm-reference').value = '';
  document.getElementById('spm-notes').value = '';
  document.getElementById('spm-result').textContent = '';
  document.getElementById('sal-pay-title').textContent = 'Record Salary Payment';
  document.getElementById('sal-pay-subtitle').textContent = employeeName + ' — Outstanding: ' + money(outstanding);

  // Load payment history
  const histDiv = document.getElementById('spm-payment-history');
  histDiv.innerHTML = 'Loading...';
  try {
    const { payments } = await api.getSalaryPayments(recordId);
    if (!payments.length) {
      histDiv.innerHTML = '<p class="text-slate-500">No payments recorded yet.</p>';
    } else {
      histDiv.innerHTML = '<table class="w-full text-xs"><thead><tr><th class="text-left">Date</th><th class="text-right">Amount</th><th>Method</th><th>Ref</th><th></th></tr></thead><tbody>' +
        payments.map(p => `<tr>
          <td>${(p.payment_date || '').slice(0, 10)}</td>
          <td class="text-right font-mono">${money(p.amount)}</td>
          <td>${escapeHtml(p.payment_method || '—')}</td>
          <td>${escapeHtml(p.reference || '—')}</td>
          <td class="text-right"><button type="button" class="text-rose-400 text-xs hover:underline" onclick="deleteSalaryPaymentFromModal(${recordId}, ${p.id})">Del</button></td>
        </tr>`).join('') +
        '</tbody></table>';
    }
  } catch (_) { histDiv.innerHTML = '<p class="text-rose-400">Failed to load.</p>'; }

  modal.style.display = 'flex';
}

async function deleteSalaryPaymentFromModal(recordId, paymentId) {
  if (!confirm('Delete this payment?')) return;
  try {
    await api.deleteSalaryPayment(recordId, paymentId);
    // Reload dashboard and modal
    loadSalaryDashboard();
    const rec = await api.getSalaryRecord(recordId);
    if (rec.record) {
      const totalObligation = Number(rec.record.expected_salary || 0) + Number(rec.record.previous_balance || 0);
      openSalaryPaymentModal(recordId, rec.record.employee_name, totalObligation, rec.record.total_paid);
    }
  } catch (err) { alert('Failed: ' + err.message); }
}

async function showSalaryHistory(employee) {
  const modal = document.getElementById('salary-history-modal');
  const content = document.getElementById('sal-hist-content');
  document.getElementById('sal-hist-title').textContent = 'Salary History — ' + employee;
  content.innerHTML = 'Loading...';
  modal.style.display = 'flex';
  try {
    const { history } = await api.getSalaryHistory(employee);
    if (!history.length) {
      content.innerHTML = '<p class="text-slate-500">No salary records found.</p>';
      return;
    }
    content.innerHTML = '<table class="w-full text-xs"><thead><tr><th class="text-left">Month</th><th class="text-right">Expected</th><th class="text-right">Prev. Bal</th><th class="text-right">Paid</th><th class="text-right">Outstanding</th><th>Status</th></tr></thead><tbody>' +
      history.map(r => `<tr>
        <td class="font-mono">${escapeHtml(r.salary_month)}</td>
        <td class="text-right font-mono">${money(r.expected_salary)}</td>
        <td class="text-right font-mono">${r.previous_balance > 0 ? money(r.previous_balance) : '—'}</td>
        <td class="text-right font-mono text-green-400">${money(r.total_paid)}</td>
        <td class="text-right font-mono ${r.outstanding > 0 ? 'text-rose-400' : 'text-green-400'}">${r.outstanding > 0 ? money(r.outstanding) : '—'}</td>
        <td>${escapeHtml(r.status)}</td>
      </tr>`).join('') +
      '</tbody></table>';
  } catch (err) { content.innerHTML = '<p class="text-rose-400">Failed: ' + escapeHtml(err.message) + '</p>'; }
}

window.editSalaryRecord = editSalaryRecord;
window.deleteSalaryRecord = deleteSalaryRecord;
window.openSalaryPaymentModal = openSalaryPaymentModal;
window.showSalaryHistory = showSalaryHistory;
window.deleteSalaryPaymentFromModal = deleteSalaryPaymentFromModal;

function updateSalaryPreview() {
  const prevBal = Number(document.getElementById('sal-previous-balance')?.value || 0);
  const expected = Number(document.getElementById('sal-expected')?.value || 0);
  const el1 = document.getElementById('sal-prev-bal-display');
  const el2 = document.getElementById('sal-cur-display');
  const el3 = document.getElementById('sal-total-display');
  if (el1) el1.textContent = money(prevBal);
  if (el2) el2.textContent = money(expected);
  if (el3) el3.textContent = money(prevBal + expected);
}

async function saveSalary(e) {
  e.preventDefault();
  const resEl = document.getElementById('sal-form-result');
  const id = document.getElementById('sal-form-id').value;
  const payload = {
    employee_name: document.getElementById('sal-employee').value.trim(),
    salary_month: document.getElementById('sal-month').value,
    previous_balance: Number(document.getElementById('sal-previous-balance').value || 0),
    expected_salary: Number(document.getElementById('sal-expected').value || 0),
    notes: document.getElementById('sal-notes').value.trim() || null,
  };
  if (!payload.employee_name || !payload.salary_month || payload.expected_salary <= 0) {
    resEl.textContent = 'Fill in employee name, month, and expected salary.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  resEl.textContent = 'Saving...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  try {
    if (id) {
      await api.updateSalaryRecord(id, payload);
      resEl.textContent = 'Salary record updated.';
    } else {
      await api.createSalaryRecord(payload);
      resEl.textContent = 'Salary record created.';
    }
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('salary-form-wrap').classList.add('hidden');
    loadSalaryDashboard();
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function saveSalaryPayment(e) {
  e.preventDefault();
  const resEl = document.getElementById('spm-result');
  const recordId = document.getElementById('spm-record-id').value;
  const payload = {
    amount: Number(document.getElementById('spm-amount').value || 0),
    payment_date: document.getElementById('spm-date').value || new Date().toISOString().slice(0, 10),
    payment_method: document.getElementById('spm-method').value || null,
    reference: document.getElementById('spm-reference').value.trim() || null,
    notes: document.getElementById('spm-notes').value.trim() || null,
  };
  if (payload.amount <= 0) {
    resEl.textContent = 'Enter a valid amount.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  const totalObligation = Number(document.getElementById('spm-total-obligation').value || 0);
  resEl.textContent = 'Recording...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  try {
    await api.recordSalaryPayment(recordId, payload);
    resEl.textContent = 'Payment recorded.';
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    loadSalaryDashboard();
    // Reload modal
    const { record } = await api.getSalaryRecord(recordId);
    if (record) {
      openSalaryPaymentModal(recordId, record.employee_name, totalObligation, record.total_paid);
    }
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function runSalaryRollover() {
  const month = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
  if (!confirm('Roll over outstanding salary balances to the next month?')) return;
  try {
    const result = await api.rollOverSalaries(month);
    alert('Salary rollover complete. ' + result.carried_forward + ' employee balance(s) carried forward from ' + result.previous_month + '.');
    loadSalaryDashboard();
  } catch (err) {
    alert('Rollover failed: ' + err.message);
  }
}

// ============================================================
// MANAGEMENT EXPENSES HISTORY (Phase 5)
// ============================================================

async function searchManagementExpensesHistory() {
  const tbody = document.getElementById('meh-list-tbody');
  if (!tbody) return;
  const params = {};
  const month = document.getElementById('meh-month')?.value;
  const dateFrom = document.getElementById('meh-date-from')?.value;
  const dateTo = document.getElementById('meh-date-to')?.value;
  const property = document.getElementById('meh-property')?.value;
  const category = document.getElementById('meh-category')?.value;
  const status = document.getElementById('meh-status')?.value;
  const source = document.getElementById('meh-source')?.value;
  const employee = document.getElementById('meh-employee')?.value;
  const invoice = document.getElementById('meh-invoice')?.value;
  if (month) params.month = month;
  if (dateFrom) params.date_from = dateFrom;
  if (dateTo) params.date_to = dateTo;
  if (property) params.property = property;
  if (category) params.category = category;
  if (status) params.status = status;
  if (source) params.source = source;
  if (employee) params.employee = employee;
  if (invoice) params.invoice_number = invoice;

  tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-400 py-4">Loading...</td></tr>';
  try {
    const report = await api.getManagementExpensesReport(params);
    const expenses = report.expenses || [];

    // Update summary cards
    document.getElementById('meh-summary-cards').style.display = 'grid';
    document.getElementById('meh-total-incurred').textContent = money(report.summary.total_incurred);
    document.getElementById('meh-total-paid').textContent = money(report.summary.total_paid);
    document.getElementById('meh-total-outstanding').textContent = money(report.summary.total_outstanding);
    document.getElementById('meh-expense-count').textContent = expenses.length;

    if (!expenses.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">No expenses found matching the filters.</td></tr>';
      return;
    }
    tbody.innerHTML = expenses.map(e => {
      const date = e.date_reported ? String(e.date_reported).slice(0, 10) : (e.date_month || '—');
      const invNum = e.invoice_number || '—';
      const desc = e.description || '—';
      const prop = e.property_name || e.employee || '—';
      const srcBadge = e.source === 'Work Order' ? '<span class="text-emerald-400">WO</span>' :
                       e.source === 'Salary' ? '<span class="text-purple-400">Salary</span>' :
                       '<span class="text-slate-400">Manual</span>';
      return '<tr>' +
        '<td>' + date + '</td>' +
        '<td class="font-mono text-xs">' + escapeHtml(invNum) + '</td>' +
        '<td>' + escapeHtml(e.category || '—') + '</td>' +
        '<td>' + escapeHtml(desc) + '</td>' +
        '<td>' + escapeHtml(prop) + '</td>' +
        '<td>' + srcBadge + '</td>' +
        '<td class="text-right font-mono">' + money(e.amount) + '</td>' +
        '<td>' + escapeHtml(e.status || '—') + '</td>' +
        '</tr>';
    }).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-rose-400 py-6">Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function clearManagementExpensesHistory() {
  ['meh-month', 'meh-date-from', 'meh-date-to', 'meh-property', 'meh-employee', 'meh-invoice'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['meh-category', 'meh-status', 'meh-source'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('meh-summary-cards').style.display = 'none';
  document.getElementById('meh-list-tbody').innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">Click "Search" to load expenses.</td></tr>';
}

async function searchPropertyExpenseReport() {
  const property = document.getElementById('per-property')?.value?.trim();
  const month = document.getElementById('per-month')?.value;
  const resultDiv = document.getElementById('per-result');
  const reportDiv = document.getElementById('per-report');
  if (!property) { resultDiv.textContent = 'Enter a property name.'; return; }
  resultDiv.textContent = 'Loading...';
  reportDiv.classList.add('hidden');
  try {
    const report = await api.getPropertyExpenseReport(property, month || null);
    resultDiv.textContent = '';
    if (!report.categories.length) {
      reportDiv.innerHTML = '<p class="text-slate-400">No management expenses found for this property.</p>';
      reportDiv.classList.remove('hidden');
      return;
    }
    let html = '<h4 class="text-sm font-semibold text-white mb-3">' + escapeHtml(report.property) + ' — Total: ' + money(report.total) + '</h4>';
    html += '<table class="w-full text-left cyber-table text-sm"><thead><tr><th>Category</th><th class="text-right">Total</th><th class="text-right">Count</th></tr></thead><tbody>';
    report.categories.forEach(c => {
      html += '<tr><td>' + escapeHtml(c.category) + '</td><td class="text-right font-mono">' + money(c.total) + '</td><td class="text-right">' + c.expenses.length + '</td></tr>';
    });
    html += '<tr class="font-bold border-t border-slate-700"><td>Total</td><td class="text-right font-mono text-cyan-400">' + money(report.total) + '</td><td class="text-right">' + report.expense_count + '</td></tr>';
    html += '</tbody></table>';
    reportDiv.innerHTML = html;
    reportDiv.classList.remove('hidden');
  } catch (err) {
    resultDiv.textContent = 'Failed: ' + err.message;
  }
}

// ============================================================
// MONTHLY MANAGEMENT EXPENSES REPORT (Phase 5)
// ============================================================

async function generateMgmtExpensesReport() {
  const month = document.getElementById('mer-month')?.value;
  const dateFrom = document.getElementById('mer-date-from')?.value;
  const dateTo = document.getElementById('mer-date-to')?.value;
  const property = document.getElementById('mer-property')?.value;
  const category = document.getElementById('mer-category')?.value;
  const status = document.getElementById('mer-status')?.value;

  const hasDateRange = dateFrom || dateTo;
  const hasMonth = !!month;
  if (!hasDateRange && !hasMonth) {
    alert('Select a month, a single date, or a date range (From/To).');
    return;
  }

  const params = {};
  if (hasDateRange) {
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    else if (dateFrom && !dateTo) params.date_to = dateFrom;
  } else if (hasMonth) {
    params.month = month;
  }
  if (property) params.property = property;
  if (category) params.category = category;
  if (status) params.status = status;

  try {
    const report = await api.getManagementExpensesReport(params);
    document.getElementById('mer-empty').style.display = 'none';
    document.getElementById('mer-summary').classList.remove('hidden');

    document.getElementById('mer-total-incurred').textContent = money(report.summary.total_incurred);
    document.getElementById('mer-total-paid').textContent = money(report.summary.total_paid);
    document.getElementById('mer-total-outstanding').textContent = money(report.summary.total_outstanding);
    document.getElementById('mer-period').textContent = report.month;
    document.getElementById('mer-property-total').textContent = money(report.summary.property_expenses);
    document.getElementById('mer-general-total').textContent = money(report.summary.general_expenses);

    // By Category
    const catDiv = document.getElementById('mer-by-category');
    catDiv.innerHTML = Object.entries(report.by_category).map(([cat, amt]) =>
      '<div class="bg-slate-800/30 rounded p-3 text-center"><p class="text-xs text-slate-400">' + escapeHtml(cat) + '</p><p class="text-lg font-bold text-white font-mono">' + money(amt) + '</p></div>'
    ).join('');

    // By Source
    const srcDiv = document.getElementById('mer-by-source');
    srcDiv.innerHTML = Object.entries(report.by_source).map(([src, amt]) =>
      '<div class="bg-slate-800/30 rounded p-3 text-center"><p class="text-xs text-slate-400">' + escapeHtml(src) + '</p><p class="text-lg font-bold text-white font-mono">' + money(amt) + '</p></div>'
    ).join('');

    // Salary table
    const salSection = document.getElementById('mer-salary-section');
    const salTbody = document.getElementById('mer-salary-tbody');
    if (report.salary_records.length) {
      salSection.style.display = 'block';
      salTbody.innerHTML = report.salary_records.map(s => {
        const totalObligation = Number(s.amount || 0) + Number(s.previous_balance || 0);
        return '<tr><td>' + escapeHtml(s.employee || s.description) + '</td>' +
          '<td class="text-right font-mono">' + money(s.amount) + '</td>' +
          '<td class="text-right font-mono">' + (s.previous_balance > 0 ? money(s.previous_balance) : '—') + '</td>' +
          '<td class="text-right font-mono text-green-400">' + money(s.total_paid) + '</td>' +
          '<td class="text-right font-mono ' + (s.outstanding > 0 ? 'text-rose-400' : 'text-green-400') + '">' + (s.outstanding > 0 ? money(s.outstanding) : '—') + '</td>' +
          '<td>' + escapeHtml(s.status) + '</td></tr>';
      }).join('');
    } else {
      salSection.style.display = 'none';
    }

    // Full expense list
    const expTbody = document.getElementById('mer-expenses-tbody');
    expTbody.innerHTML = report.expenses.map(e => {
      const date = e.date_reported ? String(e.date_reported).slice(0, 10) : (e.date_month || '—');
      const srcBadge = e.source === 'Work Order' ? '<span class="text-emerald-400">WO</span>' :
                       e.source === 'Salary' ? '<span class="text-purple-400">Salary</span>' :
                       '<span class="text-slate-400">Manual</span>';
      return '<tr><td>' + date + '</td>' +
        '<td class="font-mono text-xs">' + escapeHtml(e.invoice_number || '—') + '</td>' +
        '<td>' + escapeHtml(e.category || '—') + '</td>' +
        '<td>' + escapeHtml(e.description || '—') + '</td>' +
        '<td>' + escapeHtml(e.property_name || e.employee || '—') + '</td>' +
        '<td>' + srcBadge + '</td>' +
        '<td class="text-right font-mono">' + money(e.amount) + '</td>' +
        '<td class="text-right font-mono text-green-400">' + (e.paid ? money(e.paid) : '—') + '</td>' +
        '<td class="text-right font-mono ' + ((e.outstanding || 0) > 0 ? 'text-rose-400' : 'text-green-400') + '">' + ((e.outstanding || 0) > 0 ? money(e.outstanding) : '—') + '</td>' +
        '<td>' + escapeHtml(e.status || '—') + '</td></tr>';
    }).join('');

  } catch (err) {
    alert('Failed to generate report: ' + err.message);
  }
}

function printMgmtExpensesReport() {
  window.print();
}

function getReportParams() {
  const month = document.getElementById('mer-month')?.value;
  const dateFrom = document.getElementById('mer-date-from')?.value;
  const dateTo = document.getElementById('mer-date-to')?.value;
  const property = document.getElementById('mer-property')?.value;
  const category = document.getElementById('mer-category')?.value;
  const status = document.getElementById('mer-status')?.value;
  const params = {};
  if (dateFrom || dateTo) {
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    else if (dateFrom && !dateTo) params.date_to = dateFrom;
  } else if (month) {
    params.month = month;
  }
  if (property) params.property = property;
  if (category) params.category = category;
  if (status) params.status = status;
  return params;
}

async function downloadMgmtExpensesReport() {
  const params = getReportParams();
  if (!params.month && !params.date_from) { alert('Generate a report first, then download.'); return; }
  try {
    const result = await api.downloadManagementExpensesReport(params);
    triggerFileDownload(result, null, 'Management expenses report downloaded');
  } catch (err) {
    alert('Failed to download report: ' + err.message);
  }
}

async function shareMgmtExpensesReport() {
  const params = getReportParams();
  if (!params.month && !params.date_from) { alert('Generate a report first, then share.'); return; }
  try {
    const result = await api.downloadManagementExpensesReport(params);
    if (result && result.blob) {
      const blob = result.blob;
      const url = URL.createObjectURL(blob);
      if (navigator.share) {
        const file = new File([blob], result.filename || 'report.pdf', { type: 'application/pdf' });
        navigator.share({ files: [file], title: 'Management Expenses Report' }).catch(() => {});
      } else {
        window.open(url, '_blank');
      }
    }
  } catch (err) {
    alert('Failed to share report: ' + err.message);
  }
}

async function downloadSalaryInvoice(recordId) {
  try {
    const result = await api.downloadSalaryInvoice(recordId);
    triggerFileDownload(result, null, 'Salary invoice downloaded');
  } catch (err) {
    alert('Failed to download salary invoice: ' + err.message);
  }
}

async function downloadReimbursementInvoice(invoiceId) {
  try {
    const result = await api.downloadReimbursementInvoice(invoiceId);
    triggerFileDownload(result, null, 'Reimbursement invoice downloaded');
  } catch (err) {
    alert('Failed to download reimbursement invoice: ' + err.message);
  }
}

async function downloadExpenseInvoice(invoiceId) {
  try {
    const result = await api.downloadExpenseInvoice(invoiceId);
    triggerFileDownload(result, null, 'Expense invoice downloaded');
  } catch (err) {
    alert('Failed to download expense invoice: ' + err.message);
  }
}

async function populatePropertyDropdowns() {
  try {
    const { houses } = await api.houses();
    const propertyNames = [...new Set(houses.map(h => h.house_name).filter(Boolean))].sort();
    ['meh-property', 'mer-property', 'mnt-property'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">All Properties</option>' +
        propertyNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      sel.value = current;
    });
  } catch (_) { /* ignore — dropdowns will stay as "All Properties" */ }
}

let woItemCount = 0;

const WO_PARTIES = ['Pending Assessment', 'Tenant', 'Management / Property Owner', 'Shared Cost'];
const WO_TRADES = ['', 'Plumbing', 'Electrical', 'Carpentry', 'Masonry', 'Painting', 'General Maintenance', 'Other'];
const WO_PAYMENT_STATUSES = ['Pending Assessment', 'Pending', 'Paid', 'Charged to Tenant'];

function renderWoMaterialsList(id) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const mats = JSON.parse(row.dataset.materials || '[]');
  const el = document.getElementById(`wo-mat-list-${id}`);
  if (!el) return;
  if (!mats.length) {
    el.innerHTML = '<p class="text-xs text-slate-500">No materials added.</p>';
    return;
  }
  let h = '<table class="w-full text-xs mt-1"><thead><tr class="text-slate-600"><th class="text-left py-1">Material</th><th class="w-16 text-right">Qty</th><th class="w-24 text-right">Unit Cost</th><th class="w-24 text-right">Total</th><th class="w-8"></th></tr></thead><tbody>';
  mats.forEach((m, mi) => {
    h += `<tr class="border-t border-slate-200">
      <td class="py-1 text-slate-900">${escapeHtml(m.name || '—')}</td>
      <td class="text-right text-slate-700">${m.quantity}</td>
      <td class="text-right text-slate-700">${Number(m.unit_cost).toLocaleString()}</td>
      <td class="text-right text-blue-700 font-mono">${Number(m.total).toLocaleString()}</td>
      <td class="text-center"><button type="button" class="text-rose-500 hover:text-rose-700" data-wo-rm-mat="${id}-${mi}">×</button></td>
    </tr>`;
  });
  const matTotal = mats.reduce((s, m) => s + Number(m.total || 0), 0);
  h += `<tr class="border-t border-slate-300 font-semibold"><td colspan="3" class="py-1 text-right text-slate-700">Material Total</td><td class="text-right text-blue-700 font-mono">${matTotal.toLocaleString()}</td><td></td></tr>`;
  h += '</tbody></table>';
  el.innerHTML = h;
  // Update the material_cost on the row
  row.dataset.materialCost = matTotal;
  recalcWoItemTotal(id);
}

function addWoMaterial(id) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const name = prompt('Material name (e.g. Kitchen tap):');
  if (!name) return;
  const qty = Number(prompt('Quantity:', '1')) || 1;
  const unitCost = Number(prompt('Unit cost (KES):', '0')) || 0;
  const supplier = prompt('Supplier (optional):') || '';
  const mats = JSON.parse(row.dataset.materials || '[]');
  mats.push({ id: mats.length + 1, name, quantity: qty, unit_cost: unitCost, total: qty * unitCost, supplier });
  row.dataset.materials = JSON.stringify(mats);
  renderWoMaterialsList(id);
}

function removeWoMaterial(id, mi) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const mats = JSON.parse(row.dataset.materials || '[]');
  mats.splice(mi, 1);
  row.dataset.materials = JSON.stringify(mats);
  renderWoMaterialsList(id);
}

function recalcWoItemTotal(id) {
  const row = document.getElementById(`wo-item-${id}`);
  if (!row) return;
  const matInputCost = Number(row.querySelector('input[name="wo-mat-cost[]"]')?.value || 0);
  const matStoredCost = Number(row.dataset.materialCost || 0);
  const matCost = matInputCost > 0 ? matInputCost : matStoredCost;
  const labourCost = Number(row.querySelector('input[name="wo-cost[]"]')?.value || 0);
  const total = matCost + labourCost;
  const totalEl = row.querySelector('.wo-total-display');
  if (totalEl) totalEl.value = total > 0 ? total : '';
  calculateWoTotals();
}

function addWoItem(unitVal, problemVal, partyVal, costVal, paymentStatusVal, materialsVal, workReqVal, tradeVal) {
  const tbody = document.getElementById('wo-items-tbody');
  if (!tbody) return;
  const id = ++woItemCount;
  const issueNo = tbody.querySelectorAll('tr[data-issue]').length + 1;
  const tr = document.createElement('tr');
  tr.id = `wo-item-${id}`;
  tr.dataset.issue = issueNo;
  tr.dataset.materials = JSON.stringify(Array.isArray(materialsVal) ? materialsVal : []);
  tr.dataset.materialCost = Array.isArray(materialsVal) ? materialsVal.reduce((s, m) => s + Number(m.total || 0), 0) : 0;

  const partyOptions = WO_PARTIES.map(p =>
    `<option${(partyVal || 'Pending Assessment') === p ? ' selected' : ''}>${p}</option>`
  ).join('');
  const tradeOptions = WO_TRADES.map(t =>
    `<option${(tradeVal || '') === t ? ' selected' : ''}>${t || '— Select —'}</option>`
  ).join('');

  const costValNum = Number(costVal || 0);

  const matSummary = Array.isArray(materialsVal) && materialsVal.length
    ? materialsVal.map(m => m.name).filter(Boolean).join(', ') : '';
  const matCostVal = Array.isArray(materialsVal) ? materialsVal.reduce((s, m) => s + Number(m.total || 0), 0) : 0;
  const labourVal = Number(costVal || 0);
  const totalVal = matCostVal + labourVal;

  tr.innerHTML = `
    <td class="font-mono text-slate-400 wo-issue-no">${issueNo}</td>
    <td><input type="text" class="cyber-input p-1 w-full" name="wo-unit[]" value="${escapeHtml(unitVal || '')}" /></td>
    <td><input type="text" class="cyber-input p-1 w-full" name="wo-problem[]" value="${escapeHtml(problemVal || '')}" /></td>
    <td><select class="cyber-input p-1 w-full" name="wo-trade[]">${tradeOptions}</select></td>
    <td>
      <select class="cyber-input p-1 w-full" name="wo-party[]" data-issue-id="${id}">${partyOptions}</select>
      <div class="wo-mgmt-note hidden mt-1">
        <input type="text" class="cyber-input p-1 w-full text-xs" name="wo-mgmt-note[]" placeholder="Reason (appears in PDF)" />
      </div>
    </td>
    <td><input type="number" class="cyber-input p-1 w-full text-right wo-mat-input" name="wo-mat-cost[]" value="${matCostVal || ''}" min="0" data-id="${id}" /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right wo-cost-input" name="wo-cost[]" value="${labourVal || ''}" min="0" data-id="${id}" /></td>
    <td><input type="number" class="cyber-input p-1 w-full text-right text-cyan-400 font-bold wo-total-display" value="${totalVal || ''}" readonly tabindex="-1" /></td>
    <td><select class="cyber-input p-1 w-full" name="wo-status[]">
      <option>New</option><option>Assigned</option><option>In Progress</option><option>Completed</option><option>Closed</option>
    </select></td>
    <td class="text-center">
      <button type="button" class="text-slate-400 hover:text-white px-1 text-xs" data-wo-toggle="${id}" title="Materials & notes">▼</button>
      <button type="button" class="text-rose-400 hover:text-rose-300 px-1 text-xs" data-wo-del-item="${id}">×</button>
    </td>
  `;
  tbody.appendChild(tr);

  // Show/hide management note based on responsibility selection
  const partySelect = tr.querySelector(`select[data-issue-id="${id}"]`);
  const mgmtNoteRow = tr.querySelector('.wo-mgmt-note');
  if (partySelect && mgmtNoteRow) {
    const toggleNote = () => {
      const isMgmt = (partySelect.value || '').toLowerCase().includes('management') || (partySelect.value || '').toLowerCase().includes('owner');
      mgmtNoteRow.classList.toggle('hidden', !isMgmt);
    };
    partySelect.addEventListener('change', toggleNote);
    toggleNote(); // initial state
  }

  // Detail panel row (hidden by default) — for materials and notes
  const detail = document.createElement('tr');
  detail.id = `wo-detail-${id}`;
  detail.className = 'hidden';
  detail.innerHTML = `
    <td colspan="10" class="!p-0 !border-t-0">
      <div class="p-4 bg-slate-800/30 border border-slate-700 border-t-0 rounded-b-lg">
        <div class="mb-3">
          <label class="form-label text-xs">Notes</label>
          <input type="text" class="cyber-input p-1 w-full" name="wo-notes[]" placeholder="Optional notes about this issue" />
        </div>
        <div>
          <div class="flex justify-between items-center mb-1">
            <label class="form-label text-xs">Materials Used</label>
            <button type="button" class="action-btn !py-0 !px-2 text-xs" data-wo-add-mat="${id}">+ Add Material</button>
          </div>
          <div id="wo-mat-list-${id}" class="bg-white rounded p-2 border border-slate-300">
            <p class="text-xs text-slate-500">No materials added.</p>
          </div>
        </div>
      </div>
    </td>
  `;
  tbody.appendChild(detail);

  // Wire up cost inputs for recalculation
  tr.querySelector('.wo-cost-input')?.addEventListener('input', function() { recalcWoItemTotal(id); });
  tr.querySelector('.wo-mat-input')?.addEventListener('input', function() { recalcWoItemTotal(id); });

  // Render materials if provided
  if (Array.isArray(materialsVal) && materialsVal.length) {
    renderWoMaterialsList(id);
  }
  calculateWoTotals();
}

function toggleWoDetail(id) {
  const detail = document.getElementById(`wo-detail-${id}`);
  if (detail) detail.classList.toggle('hidden');
}

function removeWoItem(id) {
  const tr = document.getElementById(`wo-item-${id}`);
  const detail = document.getElementById(`wo-detail-${id}`);
  if (tr) tr.remove();
  if (detail) detail.remove();
  renumberWoIssues();
  calculateWoTotals();
}

function renumberWoIssues() {
  const tbody = document.getElementById('wo-items-tbody');
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr[data-issue]');
  rows.forEach((row, idx) => {
    row.dataset.issue = idx + 1;
    const noEl = row.querySelector('.wo-issue-no');
    if (noEl) noEl.textContent = idx + 1;
  });
}

function calculateWoTotals() {
  let total = 0;
  let mgmtCost = 0;
  let tenantCost = 0;
  let issueCount = 0;
  document.querySelectorAll('#wo-items-tbody tr[data-issue]').forEach(row => {
    issueCount++;
    const labour = Number(row.querySelector('input[name="wo-cost[]"]')?.value) || 0;
    const matInput = Number(row.querySelector('input[name="wo-mat-cost[]"]')?.value) || 0;
    const matStored = Number(row.dataset.materialCost || 0);
    const matCost = matInput > 0 ? matInput : matStored;
    const totalCost = labour + matCost;
    total += totalCost;
    const party = row.querySelector('select[name="wo-party[]"]')?.value || '';
    if (party.toLowerCase().includes('tenant')) tenantCost += totalCost;
    else if (party.toLowerCase().includes('management') || party.toLowerCase().includes('owner')) mgmtCost += totalCost;
  });
  const el = document.getElementById('wo-total-cost');
  if (el) el.textContent = money(total);

  // Update summary section
  const summary = document.getElementById('wo-totals-summary');
  if (summary) {
    summary.classList.toggle('hidden', issueCount === 0);
    const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setTxt('wo-summary-total-issues', issueCount);
    setTxt('wo-summary-mgmt-cost', money(mgmtCost));
    setTxt('wo-summary-tenant-cost', money(tenantCost));
    setTxt('wo-summary-total-cost', money(total));
  }
}

function parseWoBulkInput() {
  const textarea = document.getElementById('wo-bulk-input');
  if (!textarea) return;
  const raw = textarea.value
    .replace(/\r\n/g, '\n')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2022/g, '-');
  const lines = raw.split('\n').map(l => l.trim());
  if (!lines.length) return;

  document.getElementById('wo-items-tbody').innerHTML = '';
  woItemCount = 0;

  let currentUnit = '';
  let issueCount = 0;

  for (const line of lines) {
    if (!line) continue; // skip blank lines

    // Format: "1. B602" — numbered unit header
    const unitHeader = line.match(/^\d+[\.\)]\s+([A-Za-z][A-Za-z0-9\-]{1,15})\s*$/);
    if (unitHeader) {
      currentUnit = unitHeader[1].trim();
      continue;
    }

    // Format: "- Kitchen sink blocked." — bullet issue for current unit
    const bullet = line.match(/^[\-•]\s+(.+)$/);
    if (bullet && currentUnit) {
      const problem = bullet[1].trim().replace(/\.$/, ''); // remove trailing period
      addWoItem(currentUnit, problem);
      issueCount++;
      continue;
    }

    // Format: "A401: Guest toilet shaking" — unit colon issue
    const unitColon = line.match(/^([A-Za-z][A-Za-z0-9\-]{1,15})\s*[:\-]\s+(.+)$/);
    if (unitColon) {
      currentUnit = unitColon[1].trim();
      const issues = unitColon[2].split(/\s*,\s*/).map(s => s.trim().replace(/\.$/, '')).filter(Boolean);
      issues.forEach(issue => { addWoItem(currentUnit, issue); issueCount++; });
      continue;
    }

    // Format: "A401:" — unit-only with colon (sets current unit)
    const unitOnlyColon = line.match(/^([A-Za-z][A-Za-z0-9\-]{1,15})\s*:?\s*$/);
    if (unitOnlyColon && /\d/.test(unitOnlyColon[1])) {
      currentUnit = unitOnlyColon[1].trim();
      continue;
    }

    // Format: "1. Guest toilet shaking" — numbered issue (uses current unit)
    const numberedIssue = line.match(/^\d+[\.\)]\s+(.+)$/);
    if (numberedIssue && currentUnit) {
      addWoItem(currentUnit, numberedIssue[1].trim().replace(/\.$/, ''));
      issueCount++;
      continue;
    }

    // Format: "Kitchen sink blocked" — plain text issue (uses current unit)
    if (currentUnit && line.length > 3 && !line.match(/^[A-Za-z][A-Za-z0-9\-]{1,15}:?\s*$/)) {
      addWoItem(currentUnit, line.replace(/\.$/, ''));
      issueCount++;
    }
  }

  calculateWoTotals();
  const units = [...new Set([...document.querySelectorAll('input[name="wo-unit[]"]')].map(i => i.value).filter(Boolean))];
  const unitsField = document.getElementById('wo-units');
  if (unitsField && units.length) unitsField.value = units.join(', ');
}

async function resetWoForm() {
  const form = document.getElementById('work-order-form');
  if (form) form.reset();
  document.getElementById('wo-form-id').value = '';
  document.getElementById('wo-items-tbody').innerHTML = '';
  document.getElementById('wo-bulk-input').value = '';
  woItemCount = 0;
  addWoItem();
  calculateWoTotals();

  // Populate house dropdown
  const propSelect = document.getElementById('wo-property');
  if (propSelect && propSelect.tagName === 'SELECT') {
    try {
      const { houses } = await api.houses();
      propSelect.innerHTML = '<option value="">— Select Property —</option>';
      (houses || []).forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.paybill_number || h.id || '';
        opt.dataset.mpesaPaybill = h.payment_paybill || '';
        opt.dataset.notes = h.notes || '';
        opt.textContent = h.house_name;
        propSelect.appendChild(opt);
      });
    } catch (_) {}
  }
}

// Auto-fill paybill and caretaker when house is selected
document.getElementById('wo-property')?.addEventListener('change', (e) => {
  const sel = e.target;
  const opt = sel.options[sel.selectedIndex];
  const houseId = opt?.value || '';
  const mpesaPaybill = opt?.dataset?.mpesaPaybill || '';
  const notes = opt?.dataset?.notes || '';

  // Hidden field stores house ID (FK value for save)
  document.getElementById('wo-house-id').value = houseId;
  // Visible field shows M-PESA paybill (for user reference)
  document.getElementById('wo-paybill').value = mpesaPaybill || houseId;

  // Parse caretaker from notes field
  if (notes) {
    const caretakerEl = document.getElementById('wo-caretaker');
    if (caretakerEl && !caretakerEl.value) {
      let name = notes.trim();
      name = name.replace(/^CARETAKER:\s*/i, '');
      name = name.replace(/\s*:?\s*\d{9,12}\s*$/, '').trim();
      name = name.replace(/:\s*$/, '').trim();
      if (name) caretakerEl.value = name;
    }
  }
});

function collectWoItems() {
  const items = [];
  const rows = document.querySelectorAll('#wo-items-tbody tr[data-issue]');
  rows.forEach((row, idx) => {
    const problem = row.querySelector('input[name="wo-problem[]"]')?.value;
    const detail = document.getElementById(`wo-detail-${row.id.replace('wo-item-', '')}`);
    const cost = Number(row.querySelector('input[name="wo-cost[]"]')?.value) || 0;
    const matInput = Number(row.querySelector('input[name="wo-mat-cost[]"]')?.value) || 0;
    const mats = JSON.parse(row.dataset.materials || '[]');
    const matCost = matInput > 0 ? matInput : (Number(row.dataset.materialCost || 0) || mats.reduce((s, m) => s + Number(m.total || 0), 0));
    if (!problem && cost === 0 && matCost === 0 && !mats.length) return;
    items.push({
      issue_no: idx + 1,
      unit_code: row.querySelector('input[name="wo-unit[]"]')?.value || '',
      problem: problem || '',
      work_required: row.querySelector('select[name="wo-trade[]"]')?.value || '',
      work_done: '',
      materials: mats,
      material_names: mats.map(m => m.name).filter(Boolean).join(', '),
      responsible_party: row.querySelector('select[name="wo-party[]"]')?.value || 'Pending Assessment',
      mgmt_note: row.querySelector('input[name="wo-mgmt-note[]"]')?.value || '',
      trade: row.querySelector('select[name="wo-trade[]"]')?.value || '',
      payment_status: '',
      status: row.querySelector('select[name="wo-status[]"]')?.value || 'New',
      labour_cost: cost,
      material_cost: matCost,
      total_cost: cost + matCost,
    });
  });
  return items;
}

async function saveWorkOrder(e) {
  e.preventDefault();
  const resEl = document.getElementById('wo-form-result');
  const items = collectWoItems();
  if (!items.length) {
    resEl.textContent = 'Add at least one work item.';
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    return;
  }
  const id = document.getElementById('wo-form-id').value;
  const propSel = document.getElementById('wo-property');
  const propName = propSel?.options?.[propSel.selectedIndex]?.textContent?.trim() || '';
  const payload = {
    property_name: propName,
    house_paybill_number: document.getElementById('wo-house-id').value.trim() || null,
    unit_codes: document.getElementById('wo-units').value.trim() || null,
    caretaker_name: document.getElementById('wo-caretaker').value.trim() || null,
    date_requested: document.getElementById('wo-date-requested').value || null,
    date_work_started: document.getElementById('wo-date-started').value || null,
    date_completed: null,
    date_assigned: document.getElementById('wo-date-assigned').value || null,
    expected_completion: document.getElementById('wo-expected').value || null,
    technician_name: document.getElementById('wo-technician').value.trim() || null,
    technician_phone: document.getElementById('wo-technician-phone').value.trim() || null,
    priority: document.getElementById('wo-priority').value,
    status: document.getElementById('wo-status').value,
    labour_involved: document.getElementById('wo-labour-involved').value.trim() || null,
    notes: document.getElementById('wo-notes').value.trim() || null,
    items,
  };
  resEl.textContent = 'Saving...';
  resEl.className = 'text-sm font-mono text-amber-400 text-right mt-2';
  try {
    if (id) {
      await api.updateWorkOrder(id, payload);
      resEl.textContent = 'Work order updated.';
    } else {
      await api.createWorkOrder(payload);
      resEl.textContent = 'Work order created.';
    }
    resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
    document.getElementById('work-order-form-wrap').classList.add('hidden');
    resetWoForm();
    loadWorkOrders();
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function editWorkOrder(id) {
  try {
    const { order } = await api.getWorkOrder(id);
    if (!order) return;

    // Load house dropdown first
    const propSelect = document.getElementById('wo-property');
    if (propSelect && propSelect.tagName === 'SELECT') {
      try {
        const { houses } = await api.houses();
        propSelect.innerHTML = '<option value="">— Select Property —</option>';
        (houses || []).forEach(h => {
          const opt = document.createElement('option');
          opt.value = h.paybill_number || h.id || '';
          opt.dataset.mpesaPaybill = h.payment_paybill || '';
          opt.dataset.notes = h.notes || '';
          opt.textContent = h.house_name;
          propSelect.appendChild(opt);
        });
      } catch (_) {}
    }

    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ''; };
    set('wo-form-id', order.id);
    set('wo-property', order.house_paybill_number); // selects the option by house ID
    set('wo-house-id', order.house_paybill_number); // FK value for save
    set('wo-units', order.unit_codes);
    set('wo-caretaker', order.caretaker_name);
    set('wo-date-requested', order.date_requested);
    set('wo-date-started', order.date_work_started);
    set('wo-date-assigned', order.date_assigned);
    set('wo-expected', order.expected_completion);
    set('wo-technician', order.technician_name);
    set('wo-technician-phone', order.technician_phone);
    set('wo-priority', order.priority);
    set('wo-status', order.status);
    set('wo-labour-involved', order.labour_involved);
    set('wo-notes', order.notes);

    // Trigger house change to set paybill
    if (propSelect) propSelect.dispatchEvent(new Event('change'));

    document.getElementById('wo-items-tbody').innerHTML = '';
    woItemCount = 0;
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
      addWoItem();
    } else {
      items.forEach(it => {
        addWoItem(it.unit_code, it.problem, it.responsible_party || 'Pending Assessment',
          it.labour_cost, it.payment_status || 'Pending Assessment',
          Array.isArray(it.materials) ? it.materials : [], it.work_required, it.trade || '');
      });
    }
    calculateWoTotals();
    document.getElementById('work-order-form-wrap').classList.remove('hidden');
  } catch (err) {
    const resEl = document.getElementById('wo-form-result');
    resEl.textContent = 'Failed to load work order: ' + err.message;
    resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
  }
}

async function deleteWorkOrder(id) {
  if (!confirm('Delete this work order?')) return;
  try {
    await api.deleteWorkOrder(id);
    loadWorkOrders();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

async function runWoGenerate(mode, id, phone_number) {
  const resEl = document.getElementById('wo-list-result');
  try {
    if (mode === 'download') {
      const result = await api.downloadWorkOrder(id);
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else {
      const phone = phone_number || prompt('Send via WhatsApp to phone number:');
      if (!phone) return;
      if (mode === 'both') {
        const result = await api.sendAndDownloadWorkOrder(id, phone);
        triggerFileDownload(result, resEl, `Sent via WhatsApp & downloaded ${result.filename}`);
      } else {
        const result = await api.generateWorkOrder(id, 'send', phone);
        if (resEl) {
          resEl.textContent = `Work order sent successfully!${result.work_order_no ? ` (${result.work_order_no})` : ''}`;
          resEl.className = 'text-sm font-mono text-green-400 text-right mt-2';
        }
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-right mt-2';
    }
  }
}

async function loadWorkOrders() {
  const tbody = document.getElementById('wo-list-tbody');
  if (!tbody) return;
  try {
    const { orders } = await api.listWorkOrders();
    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-slate-500 py-6">No work orders yet. Create one to get started.</td></tr>';
      return;
    }
    tbody.innerHTML = orders.map(wo => `
      <tr>
        <td class="font-mono">${escapeHtml(wo.wo_number)}</td>
        <td>${escapeHtml(wo.property_name || '—')}</td>
        <td>${escapeHtml(wo.unit_codes || '—')}</td>
        <td>${escapeHtml(wo.technician_name || '—')}</td>
        <td>${escapeHtml(wo.priority || 'Medium')}</td>
        <td>${escapeHtml(wo.status || 'Pending')}</td>
        <td class="text-right font-mono">${money(wo.total_cost)}</td>
        <td>${(wo.created_at || '').slice(0, 10)}</td>
        <td class="text-right whitespace-nowrap">
          <button type="button" class="action-btn px-2 py-1 text-xs" data-wo-edit="${wo.id}">Edit</button>
          <button type="button" class="action-btn px-2 py-1 text-xs" data-wo-pdf="${wo.id}">PDF</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-amber-400 border-amber-400" data-wo-send="${wo.id}">Send</button>
          <button type="button" class="action-btn px-2 py-1 text-xs text-rose-400 border-rose-400" data-wo-del="${wo.id}">Del</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-rose-400 py-6">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

document.querySelectorAll('[data-invoice-type]').forEach(btn => {
  btn.addEventListener('click', () => showInvoiceType(btn.dataset.invoiceType));
});
document.getElementById('btn-back-invoice-type')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-exit-type')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-rent-invoice')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-maintenance-invoices')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-back-salary')?.addEventListener('click', showInvoiceTypeSelector);
document.getElementById('btn-new-salary')?.addEventListener('click', () => {
  document.getElementById('sal-form-id').value = '';
  document.getElementById('sal-employee').value = '';
  document.getElementById('sal-month').value = document.getElementById('salary-month-select')?.value || new Date().toISOString().slice(0, 7);
  document.getElementById('sal-previous-balance').value = '0';
  document.getElementById('sal-expected').value = '';
  document.getElementById('sal-notes').value = '';
  updateSalaryPreview();
  document.getElementById('salary-form-wrap').classList.toggle('hidden');
});
document.getElementById('btn-cancel-salary-form')?.addEventListener('click', () => {
  document.getElementById('salary-form-wrap').classList.add('hidden');
});
document.getElementById('salary-form')?.addEventListener('submit', saveSalary);
document.getElementById('salary-payment-form')?.addEventListener('submit', saveSalaryPayment);
document.getElementById('btn-close-spm-modal')?.addEventListener('click', () => {
  document.getElementById('salary-payment-modal').style.display = 'none';
});
document.getElementById('btn-close-sal-hist-modal')?.addEventListener('click', () => {
  document.getElementById('salary-history-modal').style.display = 'none';
});
document.getElementById('btn-salary-rollover')?.addEventListener('click', runSalaryRollover);
document.getElementById('sal-previous-balance')?.addEventListener('input', updateSalaryPreview);
document.getElementById('sal-expected')?.addEventListener('input', updateSalaryPreview);
document.getElementById('btn-meh-search')?.addEventListener('click', searchManagementExpensesHistory);
document.getElementById('btn-meh-clear')?.addEventListener('click', clearManagementExpensesHistory);
document.getElementById('btn-per-search')?.addEventListener('click', searchPropertyExpenseReport);
document.getElementById('btn-mer-generate')?.addEventListener('click', generateMgmtExpensesReport);
document.getElementById('btn-mer-print')?.addEventListener('click', printMgmtExpensesReport);
document.getElementById('btn-mer-download')?.addEventListener('click', downloadMgmtExpensesReport);
document.getElementById('btn-mer-share')?.addEventListener('click', shareMgmtExpensesReport);
document.getElementById('salary-month-select')?.addEventListener('change', loadSalaryDashboard);
// Set default salary month
if (document.getElementById('salary-month-select')) {
  document.getElementById('salary-month-select').value = new Date().toISOString().slice(0, 7);
}
document.getElementById('rent-invoice-tenant-search')?.addEventListener('change', loadRentInvoiceTenantInfo);
document.getElementById('rent-invoice-form')?.addEventListener('submit', (e) => { e.preventDefault(); runRentInvoiceAction('send'); });
document.getElementById('btn-rent-invoice-download')?.addEventListener('click', () => runRentInvoiceAction('download'));
document.getElementById('btn-rent-invoice-both')?.addEventListener('click', () => runRentInvoiceAction('both'));
document.getElementById('btn-new-maintenance-invoice')?.addEventListener('click', () => {
  resetMntForm();
  document.getElementById('maintenance-invoice-form-wrap').classList.remove('hidden');
});
document.getElementById('btn-add-wo-expense')?.addEventListener('click', showWoExpenseModal);
document.getElementById('btn-cancel-mnt-form')?.addEventListener('click', () => {
  document.getElementById('maintenance-invoice-form-wrap').classList.add('hidden');
});
document.getElementById('maintenance-invoice-form')?.addEventListener('submit', saveMaintenanceInvoice);
document.getElementById('btn-add-invoice-item')?.addEventListener('click', addInvoiceItem);
document.getElementById('mnt-category')?.addEventListener('change', (e) => {
  renderMntDynamicFields(e.target.value);
});
document.getElementById('btn-close-wo-expense-modal')?.addEventListener('click', hideWoExpenseModal);
document.getElementById('wo-expense-filter-house')?.addEventListener('change', filterWoExpenses);
document.getElementById('wo-expense-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideWoExpenseModal();
});
document.getElementById('btn-new-work-order')?.addEventListener('click', () => {
  resetWoForm();
  document.getElementById('work-order-form-wrap').classList.toggle('hidden');
});
document.getElementById('btn-add-wo-item')?.addEventListener('click', () => addWoItem());
document.getElementById('btn-cancel-wo-form')?.addEventListener('click', () => {
  document.getElementById('work-order-form-wrap').classList.add('hidden');
});
document.getElementById('work-order-form')?.addEventListener('submit', saveWorkOrder);
document.getElementById('btn-parse-wo-bulk')?.addEventListener('click', parseWoBulkInput);
document.getElementById('btn-clear-wo-bulk')?.addEventListener('click', () => {
  document.getElementById('wo-bulk-input').value = '';
  document.getElementById('wo-items-tbody').innerHTML = '';
  woItemCount = 0;
  addWoItem();
  calculateWoTotals();
});

// Work order list action buttons (event delegation)
document.getElementById('wo-list-tbody')?.addEventListener('click', async (e) => {
  const editId = e.target.dataset.woEdit;
  const pdfId = e.target.dataset.woPdf;
  const sendId = e.target.dataset.woSend;
  const delId = e.target.dataset.woDel;
  if (editId) editWorkOrder(Number(editId));
  else if (pdfId) runWoGenerate('download', Number(pdfId));
  else if (sendId) runWoGenerate('both', Number(sendId));
  else if (delId) deleteWorkOrder(Number(delId));
});

// Work order item buttons (event delegation)
document.getElementById('wo-items-tbody')?.addEventListener('click', (e) => {
  const delItemId = e.target.dataset.woDelItem;
  const toggleId = e.target.dataset.woToggle;
  const addMatId = e.target.dataset.woAddMat;
  const rmMatKey = e.target.dataset.woRmMat;
  if (delItemId) removeWoItem(Number(delItemId));
  else if (toggleId) toggleWoDetail(Number(toggleId));
  else if (addMatId) addWoMaterial(Number(addMatId));
  else if (rmMatKey) {
    const [rowId, matIdx] = rmMatKey.split('-').map(Number);
    removeWoMaterial(rowId, matIdx);
  }
});

document.getElementById('btn-add-deduction')?.addEventListener('click', addDeductionItem);
document.getElementById('btn-load-outstanding')?.addEventListener('click', autoLoadOutstandingMaintenance);
document.getElementById('invoice-tenant-search')?.addEventListener('change', autoLoadOutstandingMaintenance);
document.getElementById('exit-tenant-search')?.addEventListener('change', () => {
  const match = resolveTenant('exit-tenant-search', 'exitTenantsCache');
  if (match) openExitInvoiceModal(match.tenant_code);
});
document.getElementById('btn-add-exit-deduction')?.addEventListener('click', addExitDeduction);
document.getElementById('exit-deposit-paid')?.addEventListener('input', calculateExitSettlement);
document.getElementById('invoice-form')?.addEventListener('submit', (e) => { e.preventDefault(); runInvoiceAction('send'); });
document.getElementById('btn-invoice-download')?.addEventListener('click', () => runInvoiceAction('download'));
document.getElementById('btn-invoice-both')?.addEventListener('click', () => runInvoiceAction('both'));
document.getElementById('exit-invoice-form')?.addEventListener('submit', (e) => { e.preventDefault(); runExitAction('send'); });
document.getElementById('btn-exit-download')?.addEventListener('click', () => runExitAction('download'));
document.getElementById('btn-exit-both')?.addEventListener('click', () => runExitAction('both'));

document.getElementById('message-modal-cancel')?.addEventListener('click', () => {
  document.getElementById('message-modal').classList.add('hidden');
});

document.getElementById('btn-statement-download')?.addEventListener('click', () => runStatementGeneration('download'));
document.getElementById('btn-statement-send')?.addEventListener('click', () => runStatementGeneration('send'));
document.getElementById('btn-statement-both')?.addEventListener('click', () => runStatementGeneration('both'));
document.getElementById('btn-statement-close')?.addEventListener('click', () => {
  document.getElementById('statement-modal').classList.add('hidden');
});

// Exit Invoice modal handlers
document.getElementById('btn-ei-add-line')?.addEventListener('click', () => {
  const tbody = document.getElementById('ei-lines-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.setAttribute('data-ei-line', String(tbody.children.length));
  tr.innerHTML = `
    <td><select class="qc-input text-sm w-36" data-ei-cat>
      ${['maintenance','repair','cleaning','painting','utility','deduction','other'].map(c =>
        `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}
    </select></td>
    <td><input type="text" class="qc-input text-sm w-56" data-ei-desc placeholder="Description" /></td>
    <td><input type="number" min="0" class="qc-input text-sm w-32 text-right" data-ei-amt value="0" /></td>
    <td><button type="button" class="action-btn action-btn-danger !py-1 !px-2 text-xs" data-ei-del>✕</button></td>`;
  tbody.appendChild(tr);
  tr.querySelector('[data-ei-del]').addEventListener('click', () => {
    tr.remove();
    recalcEiTotals();
  });
  tr.querySelectorAll('[data-ei-amt], [data-ei-desc]').forEach((el) => el.addEventListener('input', recalcEiTotals));
  const amt = tr.querySelector('[data-ei-amt]');
  if (amt) amt.focus();
});
document.getElementById('btn-ei-save-draft')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-ei-save-draft');
  btn.disabled = true;
  try { await saveEiDraft(); } catch (err) { setEiStatusMsg('Error: ' + (err.message || err)); }
  finally { btn.disabled = false; }
});
document.getElementById('btn-ei-finalize')?.addEventListener('click', () => {
  const btn = document.getElementById('btn-ei-finalize');
  btn.disabled = true;
  finalizeEi().finally(() => { btn.disabled = false; });
});
document.getElementById('btn-ei-download')?.addEventListener('click', () => runExitInvoiceAction('download'));
document.getElementById('btn-ei-send')?.addEventListener('click', () => runExitInvoiceAction('send'));
document.getElementById('btn-ei-both')?.addEventListener('click', () => runExitInvoiceAction('both'));
document.getElementById('btn-ei-mark-vacant-yes')?.addEventListener('click', markVacantFromEi);
document.getElementById('btn-ei-mark-vacant-no')?.addEventListener('click', () => {
  document.getElementById('ei-mark-vacant-panel')?.classList.add('hidden');
  setEiStatusMsg('Unit kept OCCUPIED. You can download or send the exit invoice again, or mark vacant later.');
});
document.getElementById('btn-ei-cancel')?.addEventListener('click', () => {
  document.getElementById('exit-invoice-modal').classList.add('hidden');
});
document.getElementById('btn-ei-close-final')?.addEventListener('click', () => {
  document.getElementById('exit-invoice-modal').classList.add('hidden');
});
document.getElementById('btn-ei-edit')?.addEventListener('click', startEditFinalizedEi);
document.getElementById('btn-ei-save-finalized')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-ei-save-finalized');
  btn.disabled = true;
  try { await saveFinalizedEi(); } catch (err) { setEiStatusMsg('Error: ' + (err.message || err)); }
  finally { btn.disabled = false; }
});
document.getElementById('btn-ei-cancel-edit')?.addEventListener('click', cancelEditEi);
document.getElementById('btn-ei-delete')?.addEventListener('click', deleteExitInvoice);
document.getElementById('ei-move-out-date')?.addEventListener('change', () => {});
document.getElementById('ei-exit-reason')?.addEventListener('input', () => {});

// Rent treatment radio handlers
document.querySelectorAll('input[name="ei-rent-treatment"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const proRatedRow = document.getElementById('ei-pro-rated-row');
    if (proRatedRow) proRatedRow.classList.toggle('hidden', radio.value !== 'pro_rated');
    recalcEiTotals();
  });
});

// Deposit treatment radio handler
document.querySelectorAll('input[name="ei-deposit-treatment"]').forEach(radio => {
  radio.addEventListener('change', recalcEiTotals);
});

// Pro-rated days input handler
document.getElementById('ei-pro-rated-days')?.addEventListener('input', recalcEiTotals);

// Archive view handlers
document.getElementById('btn-archive-refresh')?.addEventListener('click', loadArchive);
document.getElementById('archive-filter-form')?.addEventListener('submit', (e) => { e.preventDefault(); loadArchive(); });
document.getElementById('btn-archive-clear')?.addEventListener('click', () => {
  ['archive-q', 'archive-house', 'archive-unit', 'archive-exit-date'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  loadArchive();
});
document.getElementById('archive-tbody')?.addEventListener('click', (e) => {
  const viewBtn = e.target.closest('[data-archive-view]');
  const delBtn = e.target.closest('[data-archive-del]');
  if (viewBtn) openArchiveDetail(viewBtn.dataset.archiveView);
  if (delBtn) deleteArchiveEntry(delBtn.dataset.archiveDel);
});
document.getElementById('occupancy-house')?.addEventListener('change', loadOccupancyHistory);
document.getElementById('btn-archive-detail-close')?.addEventListener('click', () => {
  document.getElementById('archive-detail-modal').classList.add('hidden');
});

document.getElementById('message-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const tenantId = document.getElementById('message-tenant-id').value;
  const message = document.getElementById('message-body').value.trim();
  const statusEl = document.getElementById('message-status');
  const btn = document.getElementById('btn-send-message');

  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Sending...';
  statusEl.className = 'text-amber-500 text-sm font-mono mt-2';
  btn.disabled = true;

  try {
    await api.sendMessage(tenantId, message);
    statusEl.textContent = '✓ Message sent successfully!';
    statusEl.className = 'text-green-500 text-sm font-mono mt-2';
    setTimeout(() => {
      document.getElementById('message-modal').classList.add('hidden');
    }, 1500);
  } catch (err) {
    statusEl.textContent = 'Failed to send: ' + err.message;
    statusEl.className = 'text-rose-400 text-sm font-mono mt-2';
    btn.disabled = false;
  }
});

document.getElementById('report-type-select')?.addEventListener('change', (e) => {
  const val = e.target.value;
  const houseHint = document.getElementById('report-house-hint');
  const monthContainer = document.getElementById('report-month-container');
  if (val === 'deposits' || val === 'payments') {
    if (monthContainer) monthContainer.classList.remove('hidden');
    if (houseHint) houseHint.textContent = 'Leave empty for all houses, or pick a specific house.';
  } else {
    if (monthContainer) monthContainer.classList.add('hidden');
    if (val === 'vacant') {
      if (houseHint) houseHint.textContent = 'Leave empty for all houses, or pick a specific house to generate a unit-level vacancy report.';
    } else {
      if (houseHint) houseHint.textContent = 'Leave empty for all houses, or pick a specific house.';
    }
  }
});

async function runReportAction(mode) {
  const btn = mode === 'download'
    ? document.getElementById('btn-download-report')
    : document.getElementById('btn-send-report');
  const resEl = document.getElementById('report-result');
  const phone = document.getElementById('report-phone').value.trim();
  const reportType = document.getElementById('report-type-select')?.value || 'payments';
  const houseId = document.getElementById('report-house-select')?.value || null;
  const month = document.getElementById('report-month-select')?.value || null;

  if (btn) btn.disabled = true;
  if (resEl) {
    resEl.textContent = mode === 'download' ? 'Generating Excel file...' : 'Generating and sending...';
    resEl.className = 'text-sm font-mono text-amber-400 text-center mt-2';
  }

  try {
    if (mode === 'download') {
      let result;
      if (reportType === 'vacant') {
        result = await api.downloadVacantReport(houseId);
      } else if (reportType === 'outstanding') {
        result = await api.downloadOutstandingReport(houseId);
      } else if (reportType === 'unpaid') {
        result = await api.downloadUnpaidReport(houseId);
      } else if (reportType === 'deposits') {
        result = await api.downloadDepositsReport(houseId, month);
      } else if (reportType === 'payments' && month) {
        result = await api.downloadCollectionReport(houseId, month);
      } else {
        result = await api.downloadPaymentReport(houseId);
      }
      triggerFileDownload(result, resEl, `Downloaded ${result.filename}`);
    } else {
      if (!phone) throw new Error('Enter a WhatsApp number to send the report.');
      if (reportType === 'vacant') {
        await api.sendVacantReport(phone, houseId);
      } else if (reportType === 'outstanding') {
        await api.sendOutstandingReport(phone, houseId);
      } else if (reportType === 'unpaid') {
        await api.sendUnpaidReport(phone, houseId);
      } else if (reportType === 'deposits') {
        await api.sendDepositsReport(phone, houseId, month);
      } else if (reportType === 'payments' && month) {
        await api.sendCollectionReport(houseId, month, phone);
      } else {
        await api.sendPaymentReport(phone, houseId);
      }
      if (resEl) {
        resEl.textContent = 'Report sent successfully via WhatsApp!';
        resEl.className = 'text-sm font-mono text-green-400 text-center mt-2';
      }
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-center mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById('report-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  runReportAction('send');
});
document.getElementById('btn-download-report')?.addEventListener('click', () => runReportAction('download'));

document.getElementById('btn-run-rollover')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-run-rollover');
  const resEl = document.getElementById('rollover-result');
  if (!confirm('Run rollover now? This will add unpaid rent as arrears for all overdue tenants.')) return;
  if (btn) btn.disabled = true;
  if (resEl) {
    resEl.textContent = 'Running rollover...';
    resEl.className = 'text-sm font-mono text-amber-400 text-center mt-2';
  }
  try {
    const result = await api.runRollover();
    const count = result.tenants_updated || 0;
    if (resEl) {
      resEl.textContent = count > 0
        ? `Rollover complete — ${count} tenant(s) updated with new arrears.`
        : 'Rollover complete — no tenants needed rollover.';
      resEl.className = 'text-sm font-mono text-green-400 text-center mt-2';
    }
  } catch (err) {
    if (resEl) {
      resEl.textContent = 'Error: ' + err.message;
      resEl.className = 'text-sm font-mono text-rose-400 text-center mt-2';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

/* ---------------- DOCUMENTS HUB ---------------- */

let documentsShareDocId = null;

function docsTypeLabel(type) {
  return {
    receipt: 'Payment Receipt',
    invoice: 'Invoice',
    exit_invoice: 'Exit Invoice',
    report: 'Report',
  }[type] || (type || 'Document');
}

function formatDocsDate(iso) {
  if (!iso) return '—';
  let d;
  if (String(iso).includes('T')) d = new Date(iso);
  else d = new Date(String(iso) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadDocuments() {
  const tenantSel = document.getElementById('documents-tenant');
  if (tenantSel && tenantSel.options.length <= 1) {
    try {
      const { tenants } = await api.tenants();
      tenantSel.innerHTML = '<option value="">All Tenants</option>' +
        tenants.map(t => `<option value="${escapeHtml(t.tenant_code)}">${escapeHtml(t.name)} (${escapeHtml(t.tenant_code)})</option>`).join('');
    } catch (err) {
      /* keep tenant filter empty on failure */
    }
  }
  await runDocumentsSearch();
}

async function runDocumentsSearch() {
  const params = {};
  const type = document.getElementById('documents-type')?.value;
  const tenant = document.getElementById('documents-tenant')?.value;
  const q = document.getElementById('documents-q')?.value.trim();
  const from = document.getElementById('documents-from')?.value;
  const to = document.getElementById('documents-to')?.value;
  if (type) params.doc_type = type;
  if (tenant) params.tenant_code = tenant;
  if (q) params.q = q;
  if (from) params.from = from;
  if (to) params.to = to;

  const tbody = document.getElementById('documents-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-500 py-6">Loading documents...</td></tr>';
  }

  try {
    const result = await api.documents(params);
    renderDocuments(result.documents || [], result.total || 0);
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-rose-400 py-6">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderDocuments(documents, total) {
  const tbody = document.getElementById('documents-tbody');
  const countEl = document.getElementById('documents-count');
  if (countEl) countEl.textContent = `${documents.length} shown / ${total} total`;
  if (!tbody) return;

  if (!documents.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-slate-500 py-6">No documents found.</td></tr>';
    return;
  }

  tbody.innerHTML = documents.map(d => `
    <tr>
      <td><span class="sys-tag">${escapeHtml(docsTypeLabel(d.doc_type).toUpperCase())}</span></td>
      <td class="font-mono">${escapeHtml(d.doc_number || '—')}</td>
      <td>
        <div class="font-semibold">${escapeHtml(d.title || 'Document')}</div>
        ${d.tenant_name ? `<div class="text-xs text-slate-400">${escapeHtml(d.tenant_name)}</div>` : ''}
      </td>
      <td class="text-slate-300">
        ${escapeHtml(d.house_name || d.property_name || '—')}
        ${d.unit_label ? ` <span class="font-mono text-xs">(${escapeHtml(d.unit_label)})</span>` : ''}
      </td>
      <td>${formatDocsDate(d.doc_date)}</td>
      <td class="text-right font-mono">${d.amount != null ? formatKes(d.amount) : '—'}</td>
      <td class="text-right whitespace-nowrap">
        <button type="button" class="action-btn text-xs" data-doc-action="download" data-doc-id="${d.id}">Download</button>
        <button type="button" class="action-btn text-xs" data-doc-action="print" data-doc-id="${d.id}">Print</button>
        <button type="button" class="action-btn text-green-400 border-green-400 hover:bg-green-400/20 text-xs" data-doc-action="share" data-doc-id="${d.id}">WhatsApp</button>
      </td>
    </tr>
  `).join('');
}

async function downloadDocumentFile(doc) {
  const res = await fetch(`/api/documents/${doc.id}/download`, {
    headers: { Authorization: `Bearer ${api.getToken()}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.filename || 'document.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function openDocumentForPrint(doc) {
  const res = await fetch(`/api/documents/${doc.id}/print`, {
    headers: { Authorization: `Bearer ${api.getToken()}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to open document');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

document.getElementById('documents-filter-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  runDocumentsSearch();
});
document.getElementById('btn-documents-refresh')?.addEventListener('click', () => loadDocuments());
document.getElementById('btn-documents-clear')?.addEventListener('click', () => {
  ['documents-type', 'documents-tenant', 'documents-q', 'documents-from', 'documents-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  runDocumentsSearch();
});
document.getElementById('documents-tbody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-doc-action]');
  if (!btn) return;
  const id = btn.dataset.docId;
  try {
    const { document: doc } = await api.document(id);
    if (!doc) throw new Error('Document not found');
    const action = btn.dataset.docAction;
    if (action === 'download') {
      btn.disabled = true;
      try { await downloadDocumentFile(doc); } finally { btn.disabled = false; }
    } else if (action === 'print') {
      btn.disabled = true;
      try { await openDocumentForPrint(doc); } finally { btn.disabled = false; }
    } else if (action === 'share') {
      documentsShareDocId = doc.id;
      const phoneEl = document.getElementById('documents-share-phone');
      if (phoneEl) phoneEl.value = doc.tenant_phone || '';
      const statusEl = document.getElementById('documents-share-status');
      if (statusEl) statusEl.textContent = '';
      const shareModal = document.getElementById('documents-share-modal');
      if (shareModal) shareModal.classList.remove('hidden');
    }
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
});
document.getElementById('btn-documents-share-cancel')?.addEventListener('click', () => {
  const shareModal = document.getElementById('documents-share-modal');
  if (shareModal) shareModal.classList.add('hidden');
  documentsShareDocId = null;
});
document.getElementById('btn-documents-share-send')?.addEventListener('click', async () => {
  if (!documentsShareDocId) return;
  const btn = document.getElementById('btn-documents-share-send');
  const phone = document.getElementById('documents-share-phone')?.value.trim();
  const statusEl = document.getElementById('documents-share-status');
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Sending...';
    statusEl.className = 'text-sm font-mono text-amber-400';
  }
  try {
    await api.shareDocument(documentsShareDocId, phone);
    if (statusEl) {
      statusEl.textContent = 'Sent successfully!';
      statusEl.className = 'text-sm font-mono text-green-400';
    }
    setTimeout(() => {
      const shareModal = document.getElementById('documents-share-modal');
      if (shareModal) shareModal.classList.add('hidden');
      documentsShareDocId = null;
    }, 1200);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'text-sm font-mono text-rose-400';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function loadReceiptMode() {
  // Receipt numbers are now lifetime continuous (GEHPM-RCT-YYYYMM-NNNNNN).
  const el = document.getElementById('receipt-mode-label');
  if (el) el.remove();
}

document.getElementById('btn-receipt-mode-test')?.remove();
document.getElementById('btn-receipt-mode-prod')?.remove();

document.getElementById('btn-receipt-reset-test')?.remove();

document.getElementById('import-excel-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (event) => {
    const btn = document.getElementById('btn-import-tenant');
    try {
      const base64 = event.target.result;
      if (btn) {
        btn.textContent = 'Importing...';
        btn.disabled = true;
      }

      const h_id = currentView === 'house-dashboard' ? activeHouseId : null;
      const res = await api.importTenants(base64, h_id);
      
      let msg = `Import complete!\nSuccess: ${res.successCount}\nSkipped: ${res.skipCount}`;
      if (res.errors && res.errors.length) {
        msg += `\n\nErrors:\n${res.errors.join('\n')}`;
      }
      alert(msg);
      
      if (currentView === 'house-dashboard') {
        loadHouseDashboardPage(activeHouseId);
      } else {
        loadTenants();
      }
    } catch (err) {
      alert('Error importing: ' + err.message);
    } finally {
      if (btn) {
        btn.textContent = 'Import Excel';
        btn.disabled = false;
      }
      e.target.value = '';
    }
  };
  reader.readAsDataURL(file);
});

async function loadUsers() {
  try {
    const { users } = await api.users();
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.display_name || '-')}</td>
        <td><span class="sys-tag">[${u.role.toUpperCase()}]</span></td>
        <td>
          <span class="${u.is_active ? 'text-green-400' : 'text-rose-400'} font-mono text-sm">
            ${u.is_active ? 'ACTIVE' : 'INACTIVE'}
          </span>
        </td>
        <td class="font-mono text-xs">${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}</td>
        <td class="text-right">
          <button type="button" class="qc-btn text-xs mr-2" data-edit-user='${escapeHtml(JSON.stringify(u))}'>Edit</button>
          <button type="button" class="qc-btn qc-btn-danger text-xs" data-delete-user="${u.id}">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    alert('Failed to load users: ' + err.message);
  }
}

document.getElementById('btn-add-user')?.addEventListener('click', () => {
  document.getElementById('user-id').value = '';
  document.getElementById('user-form').reset();
  document.getElementById('user-username').disabled = false;
  document.getElementById('user-modal-title').textContent = 'Add User';
  document.getElementById('user-modal').classList.remove('hidden');
});

document.getElementById('btn-user-cancel')?.addEventListener('click', () => {
  document.getElementById('user-modal').classList.add('hidden');
});

document.getElementById('users-tbody')?.addEventListener('click', async (e) => {
  if (e.target.dataset.editUser) {
    const u = JSON.parse(e.target.dataset.editUser);
    document.getElementById('user-id').value = u.id;
    document.getElementById('user-username').value = u.username;
    document.getElementById('user-username').disabled = true;
    document.getElementById('user-display-name').value = u.display_name || '';
    document.getElementById('user-role').value = u.role;
    document.getElementById('user-is-active').checked = u.is_active;
    document.getElementById('user-password').value = '';
    document.getElementById('user-modal-title').textContent = 'Edit User';
    document.getElementById('user-modal').classList.remove('hidden');
  } else if (e.target.dataset.deleteUser) {
    if (confirm('Are you sure you want to completely delete this user account?')) {
      try {
        await api.deleteUser(e.target.dataset.deleteUser);
        loadUsers();
      } catch (err) {
        alert(err.message);
      }
    }
  }
});

document.getElementById('user-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btn-save-user');
  const errEl = document.getElementById('user-error');
  btn.disabled = true;
  errEl.classList.add('hidden');

  const id = document.getElementById('user-id').value;
  const data = {
    username: document.getElementById('user-username').value.trim(),
    display_name: document.getElementById('user-display-name').value.trim(),
    role: document.getElementById('user-role').value,
    is_active: document.getElementById('user-is-active').checked,
    password: document.getElementById('user-password').value
  };

  try {
    if (id) {
      await api.updateUser(id, data);
    } else {
      await api.createUser(data);
    }
    document.getElementById('user-modal').classList.add('hidden');
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// PWA Install
let deferredInstallPrompt = null;
const installBtn = document.getElementById('btn-install-pwa');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      alert('Open this app in Chrome or Samsung Internet, then use the browser menu to "Add to Home Screen".');
      return;
    }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredInstallPrompt = null;
    }
  });
}

// ===== Invoice Register & Archive =====
let irExitMode = false;
let irViewId = null;
let irShareId = null;

function irTypeLabel(type) {
  return {
    rent: 'Rent',
    maintenance: 'Maintenance',
    penalty: 'Penalty',
    exit: 'Exit',
    other: 'Other',
  }[type] || (type || 'Invoice');
}

function irStatusClass(status) {
  if (status === 'Downloaded & Sent') return 'badge-sent';
  if (status === 'Sent via WhatsApp') return 'badge-delivered';
  if (status === 'Downloaded') return 'badge-active';
  return 'badge-pending';
}

function irRegisterBadge(status) {
  return `<span class="status-badge ${irStatusClass(status)}"><span class="status-dot"></span>${escapeHtml(status || 'Generated')}</span>`;
}

// ---- Monthly Reports ----------------------------------------------------
const FULL_MONTHS_MR = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function loadMonthlyReports() {
  const sel = document.getElementById('mr-month-select');
  if (!sel) return;
  try {
    const { reports } = await api.listMonthlyReports();
    window._mrReports = reports;
    const existing = sel.value;
    const seen = new Set();
    sel.innerHTML = '<option value="">Select month...</option>';
    (reports || []).forEach(r => {
      if (seen.has(r.month)) return;
      seen.add(r.month);
      const opt = document.createElement('option');
      opt.value = r.month;
      const [y, m] = r.month.split('-');
      opt.textContent = `${FULL_MONTHS_MR[parseInt(m, 10) - 1]} ${y}`;
      sel.appendChild(opt);
    });
    if (existing) sel.value = existing;
  } catch (err) {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }

  const propSel = document.getElementById('mr-property-select');
  if (propSel && propSel.options.length <= 1) {
    try {
      const { houses } = await api.houses();
      propSel.innerHTML = '<option value="">All Properties</option>';
      (houses || []).forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.paybill_number;
        opt.textContent = h.house_name;
        propSel.appendChild(opt);
      });
    } catch (_) {}
  }
}

async function loadReportData(month) {
  const view = document.getElementById('mr-report-view');
  const empty = document.getElementById('mr-empty');
  if (!month) { if (view) view.classList.add('hidden'); if (empty) empty.classList.remove('hidden'); return; }
  try {
    const housePaybill = document.getElementById('mr-property-select')?.value || '';
    const { report } = await api.getMonthlyReport(month, housePaybill || undefined);
    const data = typeof report.report_data === 'string' ? JSON.parse(report.report_data) : report.report_data;
    if (view) view.classList.remove('hidden');
    if (empty) empty.classList.add('hidden');

    const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
    const rev = data.revenue || {};
    const mnt = data.maintenance || {};

    document.getElementById('mr-revenue').textContent = money(rev.total_collected);
    document.getElementById('mr-revenue-count').textContent = `${rev.payment_count || 0} payments`;
    document.getElementById('mr-expenses').textContent = money(mnt.total_expenses);
    document.getElementById('mr-expenses-detail').textContent = `Mat: ${money(mnt.total_material_costs)} | Labour: ${money(mnt.total_labour_costs)}`;
    document.getElementById('mr-outstanding').textContent = money(mnt.outstanding_recovery);
    document.getElementById('mr-recovery-detail').textContent = `Recovered: ${money(mnt.recovered_from_tenants)} of ${money(mnt.tenant_responsible_repairs)}`;

    // Management expenses table
    const mgmtTbody = document.getElementById('mr-mgmt-tbody');
    const mgmt = data.management_expenses || [];
    mgmtTbody.innerHTML = mgmt.length ? mgmt.map(e => `<tr>
      <td class="font-mono">${escapeHtml(e.wo_number || '')}</td><td>${e.issue_no || ''}</td>
      <td>${escapeHtml(e.unit || '')}</td><td>${escapeHtml(e.problem || '')}</td>
      <td class="text-right">${money(e.material_cost)}</td><td class="text-right">${money(e.labour_cost)}</td>
      <td class="text-right font-semibold">${money(e.total_cost)}</td>
      <td>${escapeHtml(e.responsible_party || '')}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="text-center text-slate-500 py-4">No management expenses this month</td></tr>';

    // Tenant recoveries table
    const tenantTbody = document.getElementById('mr-tenant-tbody');
    const tenant = data.tenant_recoveries || [];
    tenantTbody.innerHTML = tenant.length ? tenant.map(e => `<tr>
      <td class="font-mono">${escapeHtml(e.wo_number || '')}</td><td>${e.issue_no || ''}</td>
      <td>${escapeHtml(e.unit || '')}</td><td>${escapeHtml(e.tenant || '')}</td>
      <td>${escapeHtml(e.problem || '')}</td><td class="text-right">${money(e.total_cost)}</td>
      <td class="text-right">${money(e.amount_recovered)}</td>
      <td class="text-right">${money(e.total_cost - e.amount_recovered)}</td>
      <td><span class="status-badge ${e.recovery_status === 'Paid' ? 'badge-active' : 'badge-pending'}">${escapeHtml(e.recovery_status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="9" class="text-center text-slate-500 py-4">No tenant recoveries this month</td></tr>';

    // Summary grid
    document.getElementById('mr-summary-grid').innerHTML = `
      <div><span class="text-slate-400">Total Repairs:</span> <span class="font-mono">${money(mnt.total_expenses)}</span></div>
      <div><span class="text-slate-400">Mgmt Paid:</span> <span class="font-mono">${money(mnt.management_paid_repairs)}</span></div>
      <div><span class="text-slate-400">Tenant Responsible:</span> <span class="font-mono">${money(mnt.tenant_responsible_repairs)}</span></div>
      <div><span class="text-slate-400">Recovered:</span> <span class="font-mono">${money(mnt.recovered_from_tenants)}</span></div>
      <div><span class="text-slate-400">Outstanding:</span> <span class="font-mono">${money(mnt.outstanding_recovery)}</span></div>
      <div><span class="text-slate-400">Material Costs:</span> <span class="font-mono">${money(mnt.total_material_costs)}</span></div>
      <div><span class="text-slate-400">Labour Costs:</span> <span class="font-mono">${money(mnt.total_labour_costs)}</span></div>
      <div><span class="text-slate-400">Charges Raised:</span> <span class="font-mono">${money(mnt.charges_raised)}</span></div>
    `;

    // Property / Unit Performance
    const occ = data.occupancy || {};
    document.getElementById('mr-occupied').textContent = occ.occupied || 0;
    document.getElementById('mr-vacant').textContent = occ.vacant || 0;
    document.getElementById('mr-new-tenants').textContent = occ.new_tenants || 0;
    document.getElementById('mr-exiting').textContent = occ.exiting_tenants || 0;
    document.getElementById('mr-paid-count').textContent = occ.paid_count || 0;
    document.getElementById('mr-partial-count').textContent = occ.partial_count || 0;
    document.getElementById('mr-unpaid-count').textContent = occ.unpaid_count || 0;
    document.getElementById('mr-collection-pct').textContent = (occ.collection_pct || 0) + '%';

    // Penalties
    const penalties = data.penalties || [];
    document.getElementById('mr-penalty-summary').innerHTML = `
      <div><span class="text-slate-400">Total Penalties:</span> <span class="font-mono">${money(penalties.reduce((s, p) => s + Number(p.amount || 0), 0))}</span></div>
      <div><span class="text-slate-400">Paid:</span> <span class="font-mono text-green-400">${money(penalties.filter(p => p.status === 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0))}</span></div>
      <div><span class="text-slate-400">Outstanding:</span> <span class="font-mono text-rose-400">${money(penalties.filter(p => p.status !== 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0))}</span></div>
    `;
    document.getElementById('mr-penalties-tbody').innerHTML = penalties.length ? penalties.map(p => `<tr>
      <td>${escapeHtml(p.tenant_name || '')}</td>
      <td>${escapeHtml(p.description || '')}</td>
      <td>${escapeHtml(p.category || '')}</td>
      <td class="text-right font-mono">${money(p.amount)}</td>
      <td><span class="status-badge ${p.status === 'Paid' ? 'badge-active' : 'badge-pending'}">${escapeHtml(p.status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="5" class="text-center text-slate-500 py-4">No penalties this month</td></tr>';

    // Exit Invoices
    const exits = data.exit_invoices || [];
    document.getElementById('mr-exit-summary').innerHTML = exits.length
      ? `<span class="text-slate-400">${exits.length} exit invoice(s) finalized this month</span>`
      : '';
    document.getElementById('mr-exits-tbody').innerHTML = exits.length ? exits.map(e => `<tr>
      <td class="font-mono text-xs">${escapeHtml(e.exit_number || '')}</td>
      <td>${escapeHtml(e.tenant_name || '')}</td>
      <td>${escapeHtml(e.unit_label || '')}</td>
      <td>${escapeHtml(e.rent_treatment || '')}</td>
      <td class="text-right font-mono">${money(e.deductions_total)}</td>
      <td class="text-right font-mono">${money(e.deposit_refund)}</td>
      <td class="text-right font-mono font-semibold">${money(e.final_settlement)}</td>
      <td><span class="status-badge ${e.status === 'Finalized' ? 'badge-active' : 'badge-pending'}">${escapeHtml(e.status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="8" class="text-center text-slate-500 py-4">No exit invoices this month</td></tr>';

    // Notices to Vacate
    const notices = data.notices_to_vacate || [];
    document.getElementById('mr-notices-summary').innerHTML = notices.length
      ? `<span class="text-slate-400">${notices.length} tenant(s) gave notice this month</span>`
      : '';
    document.getElementById('mr-notices-tbody').innerHTML = notices.length ? notices.map(n => `<tr>
      <td>${escapeHtml(n.tenant_name || '')}</td>
      <td>${escapeHtml(n.tenant_code || '')}</td>
      <td class="font-mono text-xs">${escapeHtml(n.notice_date || '')}</td>
      <td class="font-mono text-xs">${escapeHtml(n.expected_vacate || '')}</td>
      <td><span class="status-badge badge-pending">${escapeHtml(n.status || '')}</span></td>
    </tr>`).join('') : '<tr><td colspan="5" class="text-center text-slate-500 py-4">No notices to vacate this month</td></tr>';

  } catch (err) {
    if (view) view.classList.add('hidden');
    if (empty) { empty.classList.remove('hidden'); empty.textContent = 'No report found for this month. Run monthly rollover first.'; }
  }
}

document.getElementById('mr-month-select')?.addEventListener('change', (e) => loadReportData(e.target.value));
document.getElementById('mr-property-select')?.addEventListener('change', () => {
  const month = document.getElementById('mr-month-select')?.value;
  if (month) loadReportData(month);
});
document.getElementById('btn-refresh-report')?.addEventListener('click', async () => {
  const month = document.getElementById('mr-month-select')?.value;
  const housePaybill = document.getElementById('mr-property-select')?.value || '';
  if (!month) return;
  try {
    await api.refreshMonthlyReport(month, housePaybill || undefined);
    await loadReportData(month);
  } catch (err) { alert(err.message); }
});

async function loadInvoiceRegister() {
  await Promise.all([loadInvoiceRegisterMonthly(), runInvoiceRegisterSearch()]);
}

async function loadInvoiceRegisterMonthly() {
  const container = document.getElementById('ir-monthly');
  if (!container) return;
  container.innerHTML = '<div class="text-slate-500 text-sm col-span-full">Loading monthly summary…</div>';
  try {
    const { months } = await api.invoiceRegisterMonthly();
    if (!months || !months.length) {
      container.innerHTML = '<div class="text-slate-500 text-sm col-span-full">No invoices issued yet.</div>';
      return;
    }
    container.innerHTML = months.map(m => `
      <button type="button" data-ir-month="${m.month}" class="glass-panel p-4 text-left hover:border-cyan-400/50 transition-colors">
        <div class="text-xs font-mono text-slate-400">${escapeHtml(m.month)}</div>
        <div class="text-lg font-bold mt-1">${m.total}</div>
        <div class="text-xs text-slate-400 mt-1">
          Rent ${m.rent || 0} · Maint ${m.maintenance || 0} · Pen ${m.penalty || 0} · Exit ${m.exit || 0}
        </div>
      </button>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div class="text-rose-400 text-sm col-span-full">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function runInvoiceRegisterSearch() {
  const params = {};
  const q = document.getElementById('ir-q')?.value.trim();
  const type = document.getElementById('ir-type')?.value;
  const status = document.getElementById('ir-status')?.value;
  const month = document.getElementById('ir-month')?.value;
  if (q) params.q = q;
  if (type) params.invoice_type = type;
  if (status) params.status = status;
  if (month) params.month = month;
  if (irExitMode) params.invoice_type = 'exit';

  const tbody = document.getElementById('ir-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">Loading invoice register…</td></tr>';
  }

  try {
    const result = await api.invoiceRegister(params);
    renderInvoiceRegister(result.records || [], result.total || 0);
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-rose-400 py-6">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderInvoiceRegister(records, total) {
  const tbody = document.getElementById('ir-tbody');
  const countEl = document.getElementById('ir-count');
  if (countEl) countEl.textContent = `${records.length} shown / ${total} total`;
  if (!tbody) return;

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-slate-500 py-6">No invoices found in register.</td></tr>';
    return;
  }

  tbody.innerHTML = records.map(r => `
    <tr>
      <td><span class="sys-tag">${escapeHtml(irTypeLabel(r.invoice_type).toUpperCase())}</span></td>
      <td class="font-mono">${escapeHtml(r.invoice_number || '—')}</td>
      <td>
        <div class="font-semibold">${escapeHtml(r.tenant_name || '—')}</div>
        ${r.tenant_code ? `<div class="text-xs text-slate-400 font-mono">${escapeHtml(r.tenant_code)}</div>` : ''}
      </td>
      <td class="text-slate-300">
        ${escapeHtml(r.property_name || '—')}
        ${r.unit_label ? ` <span class="font-mono text-xs">(${escapeHtml(r.unit_label)})</span>` : ''}
      </td>
      <td>${formatDocsDate(r.generated_at)}</td>
      <td class="text-right font-mono">${r.amount != null ? formatKes(r.amount) : '—'}</td>
      <td>${irRegisterBadge(r.status)}</td>
      <td class="text-right whitespace-nowrap">
        <button type="button" class="action-btn text-xs" data-ir-action="view" data-ir-id="${r.id}" ${r.document_id ? '' : 'disabled title="No stored PDF attached"'} ${r.document_id ? '' : 'style="opacity:0.4;cursor:not-allowed"'}>View</button>
        <button type="button" class="action-btn text-xs" data-ir-action="download" data-ir-id="${r.id}" ${r.document_id ? '' : 'disabled style="opacity:0.4;cursor:not-allowed"'}>Download</button>
        <button type="button" class="action-btn text-green-400 border-green-400 hover:bg-green-400/20 text-xs" data-ir-action="send" data-ir-id="${r.id}" ${r.document_id ? '' : 'disabled style="opacity:0.4;cursor:not-allowed"'}>WhatsApp</button>
      </td>
    </tr>
  `).join('');
}

async function openInvoiceRegisterView(id) {
  try {
    const { register } = await api.invoiceRegisterById(id);
    if (!register) throw new Error('Register entry not found');
    irViewId = register.id;
    const titleEl = document.getElementById('ir-view-title');
    const metaEl = document.getElementById('ir-view-meta');
    if (titleEl) titleEl.textContent = `${irTypeLabel(register.invoice_type)} Invoice ${register.invoice_number}`;
    if (metaEl) {
      metaEl.innerHTML = `
        <span>Tenant: <b>${escapeHtml(register.tenant_name || '—')}</b> (${escapeHtml(register.tenant_code || '—')})</span>
        <span>Status: ${irRegisterBadge(register.status)}</span>
        ${register.move_out_date ? `<span>Move-out: <b>${escapeHtml(register.move_out_date)}</b></span>` : ''}
        ${register.approved_by ? `<span>Approved by: <b>${escapeHtml(register.approved_by)}</b></span>` : ''}
      `;
    }
    const frame = document.getElementById('ir-view-frame');
    if (frame) {
      frame.src = 'about:blank';
      try {
        const { blob } = await api.viewRegisterDocument(register.id);
        if (blob) frame.src = URL.createObjectURL(blob);
      } catch (err) {
        if (metaEl) metaEl.innerHTML = `<span class="text-rose-400">${escapeHtml(err.message)}</span>`;
      }
    }
    const modal = document.getElementById('ir-view-modal');
    if (modal) modal.classList.remove('hidden');
  } catch (err) {
    alert('Failed to open invoice: ' + err.message);
  }
}

async function downloadInvoiceRegisterFile(id) {
  const { blob, filename } = await api.downloadRegisterDocument(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'invoice.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('ir-filter-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  runInvoiceRegisterSearch();
});
document.getElementById('btn-ir-refresh')?.addEventListener('click', () => loadInvoiceRegister());
document.getElementById('btn-ir-clear')?.addEventListener('click', () => {
  ['ir-type', 'ir-status', 'ir-month', 'ir-q'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  runInvoiceRegisterSearch();
});
document.getElementById('btn-ir-all')?.addEventListener('click', () => {
  irExitMode = false;
  const qEl = document.getElementById('ir-q');
  if (qEl) qEl.value = '';
  const mEl = document.getElementById('ir-month');
  if (mEl) mEl.value = '';
  loadInvoiceRegister();
});
document.getElementById('btn-ir-exit')?.addEventListener('click', () => {
  irExitMode = true;
  const qEl = document.getElementById('ir-q');
  if (qEl) qEl.value = '';
  const mEl = document.getElementById('ir-month');
  if (mEl) mEl.value = '';
  loadInvoiceRegister();
});
document.getElementById('ir-monthly')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ir-month]');
  if (!btn) return;
  const monthInput = document.getElementById('ir-month');
  if (monthInput) monthInput.value = btn.dataset.irMonth;
  runInvoiceRegisterSearch();
});
document.getElementById('ir-tbody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-ir-action]');
  if (!btn) return;
  const id = btn.dataset.irId;
  const action = btn.dataset.irAction;
  try {
    if (action === 'view') {
      openInvoiceRegisterView(id);
    } else if (action === 'download') {
      btn.disabled = true;
      try { await downloadInvoiceRegisterFile(id); } finally { btn.disabled = false; }
    } else if (action === 'send') {
      const { register } = await api.invoiceRegisterById(id);
      irShareId = register.id;
      const phoneEl = document.getElementById('ir-share-phone');
      if (phoneEl) phoneEl.value = register.house_paybill_number || '';
      const statusEl = document.getElementById('ir-share-status');
      if (statusEl) statusEl.textContent = '';
      document.getElementById('ir-share-modal')?.classList.remove('hidden');
    }
  } catch (err) {
    alert('Action failed: ' + err.message);
  }
});
document.getElementById('btn-ir-view-download')?.addEventListener('click', async () => {
  if (!irViewId) return;
  try {
    await downloadInvoiceRegisterFile(irViewId);
  } catch (err) {
    alert('Download failed: ' + err.message);
  }
});
document.getElementById('btn-ir-view-send')?.addEventListener('click', () => {
  if (!irViewId) return;
  irShareId = irViewId;
  const phoneEl = document.getElementById('ir-share-phone');
  if (phoneEl) phoneEl.value = '';
  const statusEl = document.getElementById('ir-share-status');
  if (statusEl) statusEl.textContent = '';
  document.getElementById('ir-share-modal')?.classList.remove('hidden');
});
document.getElementById('btn-ir-view-close')?.addEventListener('click', () => {
  const frame = document.getElementById('ir-view-frame');
  if (frame) frame.src = 'about:blank';
  document.getElementById('ir-view-modal')?.classList.add('hidden');
  irViewId = null;
});
document.getElementById('btn-ir-share-cancel')?.addEventListener('click', () => {
  document.getElementById('ir-share-modal')?.classList.add('hidden');
  irShareId = null;
});
document.getElementById('btn-ir-share-send')?.addEventListener('click', async () => {
  if (!irShareId) return;
  const btn = document.getElementById('btn-ir-share-send');
  const phone = document.getElementById('ir-share-phone')?.value.trim();
  const statusEl = document.getElementById('ir-share-status');
  if (btn) btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'Sending…';
    statusEl.className = 'text-sm font-mono text-amber-400';
  }
  try {
    await api.resendInvoiceRegister(irShareId, phone);
    if (statusEl) {
      statusEl.textContent = 'Sent successfully!';
      statusEl.className = 'text-sm font-mono text-green-400';
    }
    runInvoiceRegisterSearch();
    if (irViewId) openInvoiceRegisterView(irViewId);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message;
      statusEl.className = 'text-sm font-mono text-rose-400';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============================================================
// DEPOSIT REFUNDS
// ============================================================

let drCurrentFilter = 'all';
let drCurrentSort = 'status';
let drCurrentSearch = '';
let drDetailId = null;

async function loadDepositRefunds() {
  try {
    const [{ summary }, { refunds }] = await Promise.all([
      api.getDepositRefundSummary(),
      api.listDepositRefunds({
        status: drCurrentFilter,
        sort: drCurrentSort,
        search: drCurrentSearch,
      }),
    ]);
    renderDepositRefundSummary(summary);
    renderDepositRefundTable(refunds);
  } catch (err) {
    console.error('[DepositRefunds] Load failed:', err);
  }
}

function renderDepositRefundSummary(s) {
  setTextEl('dr-sum-pending', s.pending || 0);
  setTextEl('dr-sum-pending-amt', formatKes(s.pending_amount || 0));
  setTextEl('dr-sum-due-soon', s.due_soon || 0);
  setTextEl('dr-sum-due-soon-amt', formatKes(s.due_soon_amount || 0));
  setTextEl('dr-sum-due-today', s.due_today || 0);
  setTextEl('dr-sum-due-today-amt', formatKes(s.due_today_amount || 0));
  setTextEl('dr-sum-overdue', s.overdue || 0);
  setTextEl('dr-sum-overdue-amt', formatKes(s.overdue_amount || 0));
  setTextEl('dr-sum-refunded', s.refunded || 0);
  setTextEl('dr-sum-refunded-amt', formatKes(s.refunded_amount || 0));
}

function getDrCountdown(refund) {
  if (refund.refund_status === 'refunded') return '<span class="text-green-400">REFUNDED</span>';
  if (refund.refund_status === 'no_refund_due') return '<span class="text-slate-500">N/A</span>';
  if (!refund.refund_due_date) return '<span class="text-slate-500">—</span>';
  const due = new Date(refund.refund_due_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const diff = Math.floor((due - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return '<span class="text-rose-400 font-bold">' + Math.abs(diff) + 'd overdue</span>';
  if (diff === 0) return '<span class="text-amber-400 font-bold">Due today</span>';
  if (diff <= 7) return '<span class="text-amber-400">' + diff + ' days</span>';
  return '<span class="text-slate-300">' + diff + ' days</span>';
}

function getDrStatusBadge(status) {
  const map = {
    pending: '<span class="status-badge badge-pending"><span class="status-dot"></span>Pending</span>',
    due_soon: '<span class="status-badge badge-pending"><span class="status-dot"></span>Due Soon</span>',
    due_today: '<span class="status-badge badge-expired"><span class="status-dot"></span>Due Today</span>',
    overdue: '<span class="status-badge badge-expired"><span class="status-dot"></span>Overdue</span>',
    refunded: '<span class="status-badge badge-active"><span class="status-dot"></span>Refunded</span>',
    partially_refunded: '<span class="status-badge badge-pending"><span class="status-dot"></span>Partial</span>',
    no_refund_due: '<span class="status-badge badge-vacant"><span class="status-dot"></span>No Refund</span>',
  };
  return map[status] || status;
}

function renderDepositRefundTable(refunds) {
  const tbody = document.getElementById('dr-tbody');
  if (!tbody) return;
  if (!refunds.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-slate-500">' +
      '<div class="text-lg mb-2">No Deposit Refunds</div>' +
      '<div class="text-sm">There are currently no deposit refunds requiring action.</div>' +
      '</td></tr>';
    return;
  }
  tbody.innerHTML = refunds.map(r => {
    const name = escapeHtml(r.tenant_name || r.tenant_code);
    const code = escapeHtml(r.tenant_code);
    const prop = escapeHtml(r.property_name || '—');
    const unit = escapeHtml(r.unit_label || '—');
    return '<tr class="hover:bg-slate-800/50">' +
      '<td><p class="text-white font-semibold text-sm">' + name + '</p><p class="text-xs text-slate-400 font-mono">' + code + '</p></td>' +
      '<td><p class="text-sm">' + prop + '</p><p class="text-xs text-purple-300 font-mono">' + unit + '</p></td>' +
      '<td class="font-mono text-sm">' + fmtDate(r.exit_date) + '</td>' +
      '<td class="text-right font-mono font-bold text-green-400">' + formatKes(r.refundable_amount) + '</td>' +
      '<td class="font-mono text-sm">' + fmtDate(r.refund_due_date) + '</td>' +
      '<td class="font-mono text-sm">' + getDrCountdown(r) + '</td>' +
      '<td>' + getDrStatusBadge(r.refund_status) + '</td>' +
      '<td class="text-right"><button type="button" data-dr-view="' + r.id + '" class="action-btn">View</button></td>' +
      '</tr>';
  }).join('');
}

document.getElementById('dr-tbody')?.addEventListener('click', async (e) => {
  const viewId = e.target.dataset.drView;
  if (viewId) openDrDetail(viewId);
});

document.getElementById('dr-search')?.addEventListener('input', (() => {
  let t;
  return () => { clearTimeout(t); t = setTimeout(() => {
    drCurrentSearch = document.getElementById('dr-search').value;
    loadDepositRefunds();
  }, 400); };
})());

document.getElementById('dr-status-filter')?.addEventListener('change', (e) => {
  drCurrentFilter = e.target.value;
  loadDepositRefunds();
});

document.getElementById('dr-sort')?.addEventListener('change', (e) => {
  drCurrentSort = e.target.value;
  loadDepositRefunds();
});

document.getElementById('btn-dr-clear')?.addEventListener('click', () => {
  drCurrentFilter = 'all';
  drCurrentSort = 'status';
  drCurrentSearch = '';
  document.getElementById('dr-search').value = '';
  document.getElementById('dr-status-filter').value = 'all';
  document.getElementById('dr-sort').value = 'status';
  loadDepositRefunds();
});

document.querySelectorAll('[data-dr-filter]').forEach(card => {
  card.addEventListener('click', () => {
    drCurrentFilter = card.dataset.drFilter;
    document.getElementById('dr-status-filter').value = drCurrentFilter;
    loadDepositRefunds();
  });
});

async function openDrDetail(id) {
  drDetailId = id;
  const modal = document.getElementById('dr-detail-modal');
  try {
    const { refund } = await api.getDepositRefund(id);
    if (!refund) return;

    document.getElementById('dr-detail-status').innerHTML = getDrStatusBadge(refund.refund_status);
    setTextEl('dr-detail-tenant', refund.tenant_name || refund.tenant_code);
    setTextEl('dr-detail-phone', refund.tenant_phone || '—');
    setTextEl('dr-detail-property', refund.property_name || '—');
    setTextEl('dr-detail-unit', refund.unit_label || '—');
    document.getElementById('dr-detail-exit-number').textContent = refund.exit_number || '—';
    setTextEl('dr-detail-exit-date', fmtDate(refund.exit_date));
    setTextEl('dr-detail-due-date', fmtDate(refund.refund_due_date));

    const countdownEl = document.getElementById('dr-detail-countdown');
    countdownEl.innerHTML = getDrCountdown(refund);
    countdownEl.className = refund.refund_status === 'overdue' ? 'text-rose-400 font-bold' :
      refund.refund_status === 'due_today' ? 'text-amber-400 font-bold' : 'font-bold';

    setTextEl('dr-detail-deposit-paid', formatKes(refund.deposit_paid));
    setTextEl('dr-detail-dep-rent', '-' + formatKes(refund.deposit_applied_to_rent));
    setTextEl('dr-detail-dep-ded', '-' + formatKes(refund.deposit_applied_to_deductions));
    setTextEl('dr-detail-deductions', formatKes(refund.deductions_total));
    setTextEl('dr-detail-refundable', formatKes(refund.refundable_amount));

    const linesPanel = document.getElementById('dr-detail-lines-panel');
    const linesTbody = document.getElementById('dr-detail-lines-tbody');
    let lines = [];
    try { lines = typeof refund.ei_lines === 'string' ? JSON.parse(refund.ei_lines) : (refund.ei_lines || []); } catch (_) {}
    if (lines.length) {
      linesPanel.classList.remove('hidden');
      linesTbody.innerHTML = lines.map(l => {
        const cat = escapeHtml(l.category || l.label || '—');
        const desc = escapeHtml(l.description || l.label || '—');
        const amt = formatKes(l.amount);
        return '<tr><td class="text-sm">' + cat + '</td><td class="text-sm">' + desc + '</td><td class="text-right font-mono text-rose-400">' + amt + '</td></tr>';
      }).join('');
    } else {
      linesPanel.classList.add('hidden');
    }

    const txPanel = document.getElementById('dr-detail-transaction-panel');
    if (refund.refund_status === 'refunded' || refund.refund_status === 'partially_refunded') {
      txPanel.classList.remove('hidden');
      setTextEl('dr-detail-amount-refunded', formatKes(refund.amount_refunded));
      setTextEl('dr-detail-remaining', formatKes(refund.remaining_amount));
      setTextEl('dr-detail-refund-date', refund.refund_date ? fmtDate(refund.refund_date) + (refund.refund_time ? ' ' + refund.refund_time.slice(0, 5) : '') : '—');
      setTextEl('dr-detail-method', refund.payment_method || '—');
      setTextEl('dr-detail-ref', refund.transaction_reference || '—');
      setTextEl('dr-detail-refunded-by', refund.refunded_by || '—');
      setTextEl('dr-detail-remarks', refund.remarks || '—');
    } else {
      txPanel.classList.add('hidden');
    }

    const canRefund = refund.refund_status !== 'refunded' && refund.refund_status !== 'no_refund_due' && Number(refund.refundable_amount) > 0;
    document.getElementById('btn-dr-record-refund').style.display = canRefund ? '' : 'none';
    document.getElementById('btn-dr-view-exit-invoice').style.display = refund.exit_invoice_id ? '' : 'none';

    modal.classList.remove('hidden');
  } catch (err) {
    console.error('[DepositRefunds] Detail load failed:', err);
  }
}

document.getElementById('btn-dr-detail-close')?.addEventListener('click', () => {
  document.getElementById('dr-detail-modal').classList.add('hidden');
});

document.getElementById('dr-detail-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('dr-detail-modal')) {
    document.getElementById('dr-detail-modal').classList.add('hidden');
  }
});

document.getElementById('btn-dr-view-exit-invoice')?.addEventListener('click', async () => {
  if (!drDetailId) return;
  try {
    const { refund } = await api.getDepositRefund(drDetailId);
    if (refund?.exit_invoice_id) {
      document.getElementById('dr-detail-modal').classList.add('hidden');
      openExitInvoiceModal(refund.tenant_code);
    }
  } catch (err) {
    console.error('[DepositRefunds] Failed to load exit invoice:', err);
  }
});

document.getElementById('btn-dr-record-refund')?.addEventListener('click', async () => {
  if (!drDetailId) return;
  try {
    const { refund } = await api.getDepositRefund(drDetailId);
    if (!refund) return;
    const outstanding = Number(refund.refundable_amount || 0) - Number(refund.amount_refunded || 0);
    document.getElementById('dr-record-id').value = refund.id;
    setTextEl('dr-record-tenant', refund.tenant_name || refund.tenant_code);
    setTextEl('dr-record-outstanding', formatKes(outstanding));
    document.getElementById('dr-record-amount').max = outstanding;
    document.getElementById('dr-record-amount').value = outstanding;
    document.getElementById('dr-record-method').value = '';
    document.getElementById('dr-record-ref').value = '';
    document.getElementById('dr-record-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('dr-record-time').value = new Date().toISOString().slice(11, 16);
    document.getElementById('dr-record-remarks').value = '';
    document.getElementById('dr-detail-modal').classList.add('hidden');
    document.getElementById('dr-record-modal').classList.remove('hidden');
  } catch (err) {
    console.error('[DepositRefunds] Record refund load failed:', err);
  }
});

document.getElementById('btn-dr-record-cancel')?.addEventListener('click', () => {
  document.getElementById('dr-record-modal').classList.add('hidden');
  document.getElementById('dr-detail-modal').classList.remove('hidden');
});

document.getElementById('dr-record-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('dr-record-modal')) {
    document.getElementById('dr-record-modal').classList.add('hidden');
  }
});

document.getElementById('dr-record-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('dr-record-id').value;
  const amount = document.getElementById('dr-record-amount').value;
  const method = document.getElementById('dr-record-method').value;
  const ref = document.getElementById('dr-record-ref').value;
  const date = document.getElementById('dr-record-date').value;
  const time = document.getElementById('dr-record-time').value;
  const remarks = document.getElementById('dr-record-remarks').value;

  if (!amount || Number(amount) <= 0) return alert('Please enter a valid refund amount.');
  if (!method) return alert('Please select a payment method.');
  if (method === 'M-Pesa' && !ref.trim()) return alert('M-Pesa transaction reference is required.');

  try {
    const result = await api.recordDepositRefund(id, {
      amount: Number(amount),
      payment_method: method,
      transaction_reference: ref,
      refund_date: date,
      refund_time: time,
      remarks,
    });
    if (result.error) return alert(result.error);
    document.getElementById('dr-record-modal').classList.add('hidden');
    loadDepositRefunds();
    openDrDetail(id);
  } catch (err) {
    alert('Failed to record refund: ' + (err.message || err));
  }
});

window.openDrDetail = openDrDetail;

// ─── WhatsApp Module (QR-Linked) ────────────────────────────────────────────
let _waPolling = null;
let _waQrPolling = null;

async function waLoadStatus() {
  try {
    const data = await api.waStatus();
    const dot = document.getElementById('wa-status-dot');
    const text = document.getElementById('wa-status-text');
    const info = document.getElementById('wa-session-info');
    const stats = document.getElementById('wa-stats-row');
    const btnConnect = document.getElementById('btn-wa-connect');
    const btnDisconnect = document.getElementById('btn-wa-disconnect');
    const btnLogout = document.getElementById('btn-wa-logout');
    const btnTest = document.getElementById('btn-wa-test');
    const qrPanel = document.getElementById('wa-qr-panel');

    if (!dot) return;

    const state = data.state || 'disconnected';
    const stateColors = { connected: 'bg-green-500', qr_required: 'bg-amber-500', connecting: 'bg-blue-500', disconnected: 'bg-slate-400', error: 'bg-red-500' };
    const stateLabels = { connected: 'CONNECTED', qr_required: 'QR CODE READY', connecting: 'CONNECTING…', disconnected: 'NOT CONNECTED', error: 'ERROR', authenticating: 'AUTHENTICATING…', disconnecting: 'DISCONNECTING…' };

    dot.className = `w-2 h-2 rounded-full ${stateColors[state] || 'bg-slate-500'}`;
    text.textContent = stateLabels[state] || state.toUpperCase();

    if (state === 'connected') {
      info.classList.remove('hidden');
      document.getElementById('wa-phone-display').textContent = data.sessionInfo?.phone || 'Connected';
      document.getElementById('wa-platform-display').textContent = data.sessionInfo?.platform ? `Platform: ${data.sessionInfo.platform}` : '';
      document.getElementById('wa-connected-since').textContent = data.connectedAt ? `Connected since: ${new Date(data.connectedAt).toLocaleString()}` : '';
      btnConnect.style.display = 'none';
      btnDisconnect.style.display = '';
      btnLogout.style.display = '';
      btnTest.style.display = '';
      qrPanel.classList.add('hidden');
      waStopQrPolling();
    } else if (state === 'qr_required') {
      info.classList.add('hidden');
      btnConnect.style.display = 'none';
      btnDisconnect.style.display = 'none';
      btnLogout.style.display = 'none';
      btnTest.style.display = 'none';
      qrPanel.classList.remove('hidden');
      waShowQr(data.qrCode);
      waStartQrPolling();
    } else {
      info.classList.add('hidden');
      btnConnect.style.display = '';
      btnDisconnect.style.display = 'none';
      btnLogout.style.display = 'none';
      btnTest.style.display = 'none';
      qrPanel.classList.add('hidden');
      waStopQrPolling();
    }

    if (state === 'connected') {
      stats.classList.remove('hidden');
      waLoadStats();
    } else {
      stats.classList.add('hidden');
    }
  } catch (err) {
    console.error('[WA] Status error:', err);
  }
}

function waShowQr(qrData) {
  const container = document.getElementById('wa-qr-container');
  if (!container) return;
  if (qrData) {
    container.innerHTML = `<img src="${qrData}" alt="WhatsApp QR Code" class="w-64 h-64 rounded-lg">`;
    document.getElementById('wa-qr-status').textContent = 'Waiting for scan…';
    document.getElementById('wa-qr-status').className = 'text-sm text-amber-600';
  } else {
    container.innerHTML = '<div class="w-64 h-64 bg-white rounded-lg flex items-center justify-center"><p class="text-slate-500 text-sm">Generating QR code…</p></div>';
  }
}

async function waConnect() {
  try {
    document.getElementById('btn-wa-connect').textContent = 'Connecting…';
    document.getElementById('btn-wa-connect').disabled = true;
    await api.waConnect();
    waStartPolling();
  } catch (err) {
    alert('Failed to connect: ' + (err.message || err));
    document.getElementById('btn-wa-connect').textContent = 'Connect WhatsApp';
    document.getElementById('btn-wa-connect').disabled = false;
  }
}

async function waDisconnect() {
  if (!confirm('Disconnect WhatsApp session?')) return;
  try {
    await api.waDisconnect();
    waLoadStatus();
  } catch (err) {
    alert('Failed to disconnect: ' + (err.message || err));
  }
}

async function waLogout() {
  if (!confirm('Logout and clear session? This will remove all session data.')) return;
  try {
    await api.waLogout();
    waLoadStatus();
  } catch (err) {
    alert('Failed to logout: ' + (err.message || err));
  }
}

async function waSendTest() {
  const phone = prompt('Enter phone number to send test message:');
  if (!phone) return;
  try {
    const result = await api.waSendTest(phone, 'Test message from Rental Management System ✓');
    alert(result.message || 'Test message sent!');
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

async function waSendTestMsg() {
  const phone = document.getElementById('wa-test-phone')?.value;
  const msg = document.getElementById('wa-test-msg')?.value;
  if (!phone || !msg) return alert('Enter phone and message');
  try {
    const result = await api.waSendTest(phone, msg);
    alert(result.message || 'Sent!');
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

async function waLoadStats() {
  try {
    const stats = await api.waQueueStats();
    setText('wa-stat-today', stats.today || 0);
    setText('wa-stat-sent', stats.sent || 0);
    setText('wa-stat-failed', stats.failed || 0);
    setText('wa-stat-queued', stats.queued || 0);
  } catch (_) {}
}

async function waLoadMessages(page = 1) {
  try {
    const data = await api.waMessages({ page, limit: 20 });
    const tbody = document.getElementById('wa-messages-tbody');
    if (!tbody) return;
    const messages = data.messages || [];
    if (messages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-slate-500">No messages yet</td></tr>';
      return;
    }
    tbody.innerHTML = messages.map(m => `
      <tr class="text-sm">
        <td class="py-2 pr-3">${escapeHtml(m.tenant_name || '—')}</td>
        <td class="py-2 pr-3 font-mono text-xs">${escapeHtml(m.phone_number || '—')}</td>
        <td class="py-2 pr-3">${escapeHtml(m.message_type || 'text')}</td>
        <td class="py-2 pr-3"><span class="px-2 py-0.5 rounded text-xs ${m.status === 'sent' ? 'bg-green-900 text-green-300' : m.status === 'failed' ? 'bg-red-900 text-red-300' : 'bg-slate-700 text-slate-300'}">${escapeHtml(m.status)}</span></td>
        <td class="py-2 pr-3">${escapeHtml(m.direction)}</td>
        <td class="py-2 text-xs text-slate-400">${m.created_at ? new Date(m.created_at).toLocaleString() : '—'}</td>
      </tr>
    `).join('');
    const totalPages = data.totalPages || 1;
    const pag = document.getElementById('wa-messages-pagination');
    if (pag && totalPages > 1) {
      let btns = '';
      for (let i = 1; i <= totalPages; i++) {
        btns += `<button class="qc-btn text-xs ${i === page ? 'qc-btn-primary' : ''}" onclick="waLoadMessages(${i})">${i}</button>`;
      }
      pag.innerHTML = btns;
    }
  } catch (err) {
    console.error('[WA] Messages error:', err);
  }
}

async function waLoadSettings() {
  try {
    const data = await api.waSettings();
    const settings = data.settings || {};
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.checked = settings[key] !== 'false'; };
    set('wa-set-welcome', 'auto_welcome_tenant');
    set('wa-set-invoice', 'auto_rent_invoice');
    set('wa-set-reminder', 'auto_rent_reminder');
    set('wa-set-overdue', 'auto_overdue_rent');
    set('wa-set-payment', 'auto_payment_received');
    set('wa-set-maintenance', 'auto_maintenance_created');
    set('wa-set-maint-update', 'auto_maintenance_updates');
    set('wa-set-announce', 'auto_general_announcement');
    const remindDays = document.getElementById('wa-set-remind-days');
    const overdueDays = document.getElementById('wa-set-overdue-days');
    if (remindDays) remindDays.value = settings.rent_reminder_days_before || 3;
    if (overdueDays) overdueDays.value = settings.rent_overdue_days_after || 1;
  } catch (_) {}
}

async function waSaveSettings() {
  const get = (id) => document.getElementById(id)?.checked ? 'true' : 'false';
  const settings = {
    auto_welcome_tenant: get('wa-set-welcome'),
    auto_rent_invoice: get('wa-set-invoice'),
    auto_rent_reminder: get('wa-set-reminder'),
    auto_overdue_rent: get('wa-set-overdue'),
    auto_payment_received: get('wa-set-payment'),
    auto_maintenance_created: get('wa-set-maintenance'),
    auto_maintenance_updates: get('wa-set-maint-update'),
    auto_general_announcement: get('wa-set-announce'),
    rent_reminder_days_before: document.getElementById('wa-set-remind-days')?.value || '3',
    rent_overdue_days_after: document.getElementById('wa-set-overdue-days')?.value || '1',
  };
  try {
    await api.waUpdateSettings(settings);
    alert('Settings saved!');
  } catch (err) {
    alert('Failed to save: ' + (err.message || err));
  }
}

async function waLoadTemplates() {
  try {
    const data = await api.waTemplates();
    const list = document.getElementById('wa-templates-list');
    if (!list) return;
    const keys = data.templates || [];
    if (keys.length === 0) {
      list.innerHTML = '<p class="text-slate-500 text-sm">No templates</p>';
      return;
    }
    list.innerHTML = keys.map(k => `
      <div class="flex items-center justify-between p-2 rounded bg-slate-800/50">
        <span class="text-sm font-mono">${escapeHtml(k)}</span>
        <button class="qc-btn text-xs" onclick="waPreviewTemplate('${k}')">Preview</button>
      </div>
    `).join('');
  } catch (_) {}
}

async function waPreviewTemplate(key) {
  try {
    const data = await api.waTemplatePreview(key);
    alert(data.rendered || 'No preview available');
  } catch (err) {
    alert('Failed: ' + (err.message || err));
  }
}

function waStartPolling() {
  waStopPolling();
  _waPolling = setInterval(waLoadStatus, 5000);
  waLoadStatus();
}

function waStopPolling() {
  if (_waPolling) { clearInterval(_waPolling); _waPolling = null; }
}

function waStartQrPolling() {
  waStopQrPolling();
  _waQrPolling = setInterval(async () => {
    try {
      const data = await api.waQR();
      if (data.qrCode) waShowQr(data.qrCode);
    } catch (_) {}
  }, 3000);
}

function waStopQrPolling() {
  if (_waQrPolling) { clearInterval(_waQrPolling); _waQrPolling = null; }
}

// Initialize WhatsApp view when navigated to
(function () {
  const origShowView = showView;
  window.showView = function (name) {
    origShowView(name);
    if (name === 'whatsapp') {
      waLoadStatus();
      waLoadSettings();
      waLoadMessages();
      waLoadTemplates();
      waStartPolling();
    } else {
      waStopPolling();
      waStopQrPolling();
    }
  };
})();

window.waConnect = waConnect;
window.waDisconnect = waDisconnect;
window.waLogout = waLogout;
window.waSendTest = waSendTest;
window.waSendTestMsg = waSendTestMsg;
window.waLoadMessages = waLoadMessages;
window.waSaveSettings = waSaveSettings;
window.waPreviewTemplate = waPreviewTemplate;
