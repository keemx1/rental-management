'use strict';

/**
 * Documents Hub letters: placeholder resolution + PDF generation.
 * Read-only against tenant/house records — source rows are never modified.
 */

const { getTemplate } = require('./letterTemplates');
const store = require('../storage/store');

// UPPERCASE aliases ({{TENANT_NAME}} etc.) resolve to the same data keys —
// matching is case-insensitive so hand-typed variables always resolve.
const PLACEHOLDER_ALIASES = {
  TENANT_NAME: 'tenant_name',
  UNIT_NUMBER: 'unit_label',
  PROPERTY_NAME: 'property_name',
  TENANT_PHONE: 'phone_number',
  PHONE_NUMBER: 'phone_number',
  TENANT_ID: 'national_id',
  ARREARS: 'arrears_amount',
  TOTAL_DUE: 'outstanding_balance',
  AMOUNT_PAID: 'last_payment_amount',
  PAYMENT_DATE: 'last_payment_date',
  RENT_PERIOD: 'rent_period',
  PENALTY: 'penalty',
  PROPERTY_ADDRESS: 'property_address',
  NEXT_OF_KIN_NAME: 'next_of_kin_name',
  NEXT_OF_KIN_PHONE: 'next_of_kin_phone',
  NEXT_OF_KIN_RELATIONSHIP: 'next_of_kin_relationship',
  PLOT_ACCOUNT: 'house_paybill_number',
  MONTHLY_RENT: 'monthly_rent',
  DEPOSIT: 'deposit',
  PAYMENT_MODE: 'property_payment_details',
  PROPERTY_PAYMENT_DETAILS: 'property_payment_details',
  NATIONAL_ID: 'national_id',
  RENT_AMOUNT: 'rent_amount',
  DEPOSIT_AMOUNT: 'deposit_amount',
  ARREARS_AMOUNT: 'arrears_amount',
  OUTSTANDING_BALANCE: 'outstanding_balance',
  GARBAGE_BALANCE: 'garbage_balance',
  WATER_BALANCE: 'water_balance',
  TERM_DISPLAY: 'term_display',
  CHARGES_TABLE: 'charges_table',
  LAST_PAYMENT_AMOUNT: 'last_payment_amount',
  LAST_PAYMENT_DATE: 'last_payment_date',
  LAST_PAYMENT_REF: 'last_payment_ref',
  LANDLORD_NAME: 'landlord_name',
  RECIPIENT_NAME: 'recipient_name',
  TODAY: 'today',
  DATE: 'today',
};

// A placeholder resolves when the data object carries the key (directly or
// via alias). Used by validation BEFORE fill() blanks unknowns.
function isResolvableVar(name, data) {
  if (!data) return false;
  if (data[name] !== undefined && data[name] !== null) return true;
  const canon = PLACEHOLDER_ALIASES[String(name).toUpperCase()];
  return !!(canon && data[canon] !== undefined && data[canon] !== null);
}

// Curated placeholder catalog for the editor insert-dropdown. Every code
// here resolves through fill()/validation (blank when the database has no
// value) — codes are uppercase canonical form, matching is case-insensitive.
const PLACEHOLDER_CATALOG = [
  { code: 'TENANT_NAME', label: 'Tenant full name', group: 'Tenant' },
  { code: 'TENANT_PHONE', label: 'Tenant phone number', group: 'Tenant' },
  { code: 'TENANT_ID', label: 'Tenant ID number', group: 'Tenant' },
  { code: 'UNIT_NUMBER', label: 'Unit / house number', group: 'Tenant' },
  { code: 'PROPERTY_NAME', label: 'Property name', group: 'Tenant' },
  { code: 'PLOT_ACCOUNT', label: 'Plot / account (property paybill)', group: 'Tenant' },
  { code: 'MONTHLY_RENT', label: 'Monthly rent for this unit', group: 'Tenant' },
  { code: 'DEPOSIT', label: 'Deposit for this unit', group: 'Tenant' },
  { code: 'NEXT_OF_KIN_NAME', label: 'Next of kin name', group: 'Next of kin' },
  { code: 'NEXT_OF_KIN_PHONE', label: 'Next of kin phone', group: 'Next of kin' },
  { code: 'NEXT_OF_KIN_RELATIONSHIP', label: 'Next of kin relationship', group: 'Next of kin' },
  { code: 'PROPERTY_ADDRESS', label: 'Property address (registered name)', group: 'Property & payment' },
  { code: 'PAYMENT_MODE', label: 'Property payment instructions', group: 'Property & payment' },
  { code: 'ARREARS', label: 'Rent arrears', group: 'Financial' },
  { code: 'OUTSTANDING_BALANCE', label: 'Total outstanding balance', group: 'Financial' },
  { code: 'TOTAL_DUE', label: 'Total due', group: 'Financial' },
  { code: 'WATER_BALANCE', label: 'Water balance', group: 'Financial' },
  { code: 'GARBAGE_BALANCE', label: 'Garbage balance', group: 'Financial' },
  { code: 'PENALTY', label: 'Pending penalties total', group: 'Financial' },
  { code: 'AMOUNT_PAID', label: 'Last payment amount', group: 'Financial' },
  { code: 'PAYMENT_DATE', label: 'Last payment date', group: 'Financial' },
  { code: 'LAST_PAYMENT_REF', label: 'Last payment reference', group: 'Financial' },
  { code: 'RENT_PERIOD', label: 'Current rent period', group: 'Financial' },
  { code: 'TERM_DISPLAY', label: 'Agreement term', group: 'Tenancy' },
  { code: 'CHARGES_TABLE', label: 'Charges table', group: 'Tenancy' },
  { code: 'LANDLORD_NAME', label: 'Landlord name (where asked)', group: 'Tenancy' },
  { code: 'TODAY', label: "Today's date", group: 'Tenancy' },
  { code: 'RECIPIENT_NAME', label: 'Recipient name', group: 'Tenancy' },
];

const MONTHS_FULL = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

function ordinalDay(n) {
  const d = Number(n) || 0;
  if (d % 100 >= 11 && d % 100 <= 13) return `${d}th`;
  switch (d % 10) {
    case 1: return `${d}st`;
    case 2: return `${d}nd`;
    case 3: return `${d}rd`;
    default: return `${d}th`;
  }
}

function fmtDateLong(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${ordinalDay(Number(m[3]))} ${MONTHS_FULL[Number(m[2]) - 1]} ${m[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${ordinalDay(d.getDate())} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtMonth(ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(ym || '');
  return `${MONTHS_FULL[Number(m[2]) - 1]} ${m[1]}`;
}

function fmtKes(n) {
  return Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function splitLines(v) {
  return String(v || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Build the full placeholder map: explicit form values win, then tenant
// record, then house record, then computed defaults.
async function resolveLetterData(templateKey, tenantCode, values = {}, user = null) {
  const template = getTemplate(templateKey);
  if (!template) throw new Error('Unknown document template');
  const v = { ...(values || {}) };
  // Empty form fields must fall back to system values, not zero them out.
  for (const k of Object.keys(v)) {
    if (v[k] === '') delete v[k];
  }

  let tenant = null;
  let house = null;
  if (tenantCode) {
    try { tenant = await store.getTenant(tenantCode); } catch (_) { tenant = null; }
    if (tenant && (tenant.house_id || tenant.house_paybill_number)) {
      try { house = await store.getHouse(tenant.house_id || tenant.house_paybill_number); } catch (_) { house = null; }
    }
  }

  const t = (k) => (tenant ? tenant[k] : null);
  const arrears = Number((tenant && tenant.arrears) || 0);
  const garbageBalance = Math.max(0, Number((tenant && tenant.garbage_fee_amount) || 0) - Number((tenant && tenant.garbage_fee_paid) || 0));
  const waterBalance = Math.max(0, Number((tenant && tenant.water_charge_amount) || 0) - Number((tenant && tenant.water_charge_paid) || 0));
  const rentShortfall = Math.max(0, Number((tenant && tenant.rent_amount) || 0) - Number((tenant && tenant.rent_paid_this_month) || 0));
  const outstandingBalance = arrears + rentShortfall + garbageBalance + waterBalance;
  // Latest approved payment (for receipts/references in letters). Read-only.
  let lastPayment = null;
  if (tenant && tenant.tenant_code) {
    try {
      const { query } = require('../config/database');
      const lp = await query(
        `SELECT amount, payment_date::text AS payment_date, mpesa_reference, receipt_number
         FROM payments WHERE tenant_code = $1 AND status = 'Approved'
         ORDER BY payment_date DESC, id DESC LIMIT 1`,
        [tenant.tenant_code]
      );
      lastPayment = lp.rows[0] || null;
    } catch (_) { lastPayment = null; }
  }
  // Pending penalties total — the existing system calculation (same helper
  // the payment-approval flow uses), read-only.
  let penaltyTotal = 0;
  if (tenant && tenant.tenant_code) {
    try { penaltyTotal = await store.getOutstandingPenalties(tenant.tenant_code, null); }
    catch (_) { penaltyTotal = 0; }
  }
  const data = {
    tenant_name: v.tenant_name || t('name') || '',
    // Form-provided landlord name where a template asks for it; blank
    // otherwise so {{LANDLORD_NAME}} resolves instead of blocking.
    landlord_name: v.landlord_name || '',
    unit_label: v.unit_label || t('unit_label') || t('tenant_code') || '',
    property_name: v.property_name || t('property_name') || (house ? house.house_name : '') || '',
    // Properties have no separate address column — the registered property
    // name is the address on record.
    property_address: (house && house.house_name) || t('property_name') || '',
    house_paybill_number: (house && house.paybill_number) || t('house_paybill_number') || t('house_id') || '',
    phone_number: v.phone_number || t('phone_number') || '',
    national_id: v.national_id || t('national_id') || '',
    national_id_block: v.national_id || (tenant ? tenant.national_id : '') || '___',
    // Next of kin comes from the tenant profile (guardian_* columns).
    next_of_kin_name: v.next_of_kin_name || t('guardian_name') || '',
    next_of_kin_phone: v.next_of_kin_phone || t('guardian_phone') || '',
    next_of_kin_relationship: v.next_of_kin_relationship || t('guardian_relationship') || '',
    // Rent & deposit for this tenant/unit, straight from the tenancy record.
    monthly_rent: `KES ${fmtKes(v.monthly_rent ?? v.rent_amount ?? t('rent_amount') ?? 0)}`,
    deposit: `KES ${fmtKes(v.deposit ?? v.deposit_amount ?? t('deposit_amount') ?? 0)}`,
    // Pending penalties from the system ledger (KES 0 when none). Blank with
    // no tenant record to query.
    penalty: tenant ? `KES ${fmtKes(penaltyTotal)}` : '',
    // Current rent period label (e.g. October 2026); explicit form values win.
    rent_period: fmtMonth(v.rent_period || new Date().toISOString().slice(0, 7)),
    rent_amount: fmtKes(v.rent_amount ?? t('rent_amount') ?? 0),
    deposit_amount: fmtKes(v.deposit_amount ?? t('deposit_amount') ?? 0),
    arrears_amount: fmtKes(v.arrears_amount ?? arrears),
    garbage_balance: fmtKes(v.garbage_balance ?? garbageBalance),
    water_balance: fmtKes(v.water_balance ?? waterBalance),
    outstanding_balance: fmtKes(v.outstanding_balance ?? outstandingBalance),
    last_payment_amount: lastPayment ? fmtKes(lastPayment.amount) : '',
    last_payment_date: lastPayment ? fmtDateLong(lastPayment.payment_date) : '',
    last_payment_ref: lastPayment ? (lastPayment.mpesa_reference || lastPayment.receipt_number || '') : '',
    // Agreement term display: monthly tenancies never show 0/blank/artificial expiry.
    term_display: (() => {
      const raw = v.duration_months ?? v.term_months ?? '';
      const n = Number(raw);
      if (raw === '' || raw == null || n <= 0 || n === 1) return 'Monthly / Month-to-Month';
      return `${n} months`;
    })(),
    // Renting-agreement charges table (auto from system records; water
    // deposit row shows — when not configured, never KES 0/blank/undefined).
    charges_table: (() => {
      const rent = fmtKes(v.rent_amount ?? t('rent_amount') ?? 0);
      const dep = fmtKes(v.deposit_amount ?? t('deposit_amount') ?? 0);
      // Garbage is automatic, never user-selected: tenant record first,
      // else the house garbage rule (plots default KES 2,000 non-refundable).
      let gar = Number(v.garbage_amount ?? (tenant ? tenant.garbage_fee_amount : 0) ?? 0) || 0;
      if (!(gar > 0) && (house && (house.garbage_fee_enabled === true || house.garbage_fee_enabled === 't'))) {
        gar = 2000;
      }
      const wdep = Number(v.water_deposit ?? 0) || 0;
      const row = (item, val) => `${item}: ${val}`;
      const lines = [
        row('Agreement Term', 'Monthly / Month-to-Month'),
        row('Monthly Rent', `KES ${rent}`),
        row('Security Deposit (refundable)', `KES ${dep}`),
        row('Garbage Fee (non-refundable)', gar > 0 ? `KES ${fmtKes(gar)} — Non-Refundable` : '—'),
        row('Water Deposit', wdep > 0 ? `KES ${fmtKes(wdep)}` : '—'),
      ];
      return lines.join('\n');
    })(),
    move_in_date: fmtDateLong(v.move_in_date || t('move_in_date')),
    rent_due_date: fmtDateLong(v.rent_due_date || t('rent_due_date')),
    today: fmtDateLong(todayISO()),
    doc_number: v.doc_number || 'DRAFT',
    sender_name: v.sender_name || (user && (user.display_name || user.username)) || 'Management',
    sender_title: v.sender_title || 'Property Manager',
  };

  // Property-specific payment details: the exact channels configured for the
  // tenant's own property (house record first, tenant-joined columns second).
  // Only real configured values are ever shown — no generic instructions.
  data.property_payment_details = (() => {
    const method = String((house && house.payment_method) || t('payment_method') || 'paybill').toLowerCase();
    const paybill = (house && house.payment_paybill) || t('payment_paybill') || '';
    const acctFmt = (house && house.account_number_format) || t('account_number_format') || '';
    const till = (house && house.till_number) || t('till_number') || '';
    const tillName = (house && house.till_name) || t('till_name') || '';
    const code = (tenant && tenant.tenant_code) || '';
    const account = String(acctFmt || '').replace(/\{\{\s*TENANT_CODE\s*\}\}/gi, code).trim();
    if (method === 'till' && till) {
      return `Till Number: ${till}${tillName ? ` (${tillName})` : ''}`;
    }
    if (paybill) {
      return `Paybill: ${paybill}${account ? `\nAccount Number: ${account}` : ''}`;
    }
    if (account) {
      return `Account Number: ${account}`;
    }
    return '';
  })();

  // Dates / months / numbers from the form.
  for (const f of (template.fields || [])) {
    const raw = v[f.name];
    if (raw === undefined || raw === null || raw === '') {
      if (f.default === 'today') data[f.name] = fmtDateLong(todayISO());
      else if (f.default === 'this_month') data[f.name] = new Date().toISOString().slice(0, 7);
      else if (f.default !== undefined) data[f.name] = f.default;
      else data[f.name] = '';
      continue;
    }
    if (f.type === 'date') data[f.name] = fmtDateLong(raw);
    else if (f.type === 'month') data[f.name + '_raw'] = raw;
    else data[f.name] = raw;
  }
  // Friendly month labels + KES formatting for known numeric/date fields.
  // Labels fall back to defaulted data so form defaults (this_month etc.)
  // resolve even when the caller sends no values.
  if (v.fee_period || data.fee_period) data.fee_period_label = fmtMonth(v.fee_period || data.fee_period);
  if (v.billing_month || data.billing_month) data.billing_month_label = fmtMonth(v.billing_month || data.billing_month);
  data.severity_warning = (() => {
    const s = String(v.demand_severity || '');
    if (/FINAL/.test(s)) {
      return 'TAKE NOTICE that failure to settle within the stated period shall leave management with no option but to commence recovery proceedings, including eviction and referral for collection, without further reference to you.\n\n';
    }
    if (/FIRST/.test(s)) {
      return 'Please note that continued non-payment shall attract further enforcement measures in accordance with your tenancy terms.\n\n';
    }
    return '';
  })();
  const kesFields = ['arrears_amount', 'fee_amount', 'total_amount', 'proposal_amount', 'old_rent', 'new_rent', 'waived_amount'];
  for (const k of kesFields) {
    if (v[k] !== undefined && v[k] !== null && v[k] !== '') data[k] = fmtKes(v[k]);
  }
  if (v.old_rate !== undefined && v.old_rate !== '') data.old_rate = fmtKes(v.old_rate);
  if (v.new_rate !== undefined && v.new_rate !== '') data.new_rate = fmtKes(v.new_rate);

  // Conditional blocks used inside bodies.
  const B = (cond, text) => (cond ? text : '');
  data.demand_note_block = B(v.demand_note, `\n\n${v.demand_note}`);
  data.new_contact_block = B(v.new_contact, ` on ${v.new_contact}`);
  data.new_caretaker_phone_block = B(v.new_caretaker_phone, ` (Tel: ${v.new_caretaker_phone})`);
  data.action_required_block = B(v.action_required, `\n\nACTION REQUIRED: ${v.action_required}`);
  data.deadline_block = B(v.deadline_date, `\n\nDeadline: ${fmtDateLong(v.deadline_date)}`);
  data.waived_amount_block = B(v.waived_amount, ` of KES ${fmtKes(v.waived_amount)}`);
  data.valid_until_block = B(v.valid_until, `, valid until ${fmtDateLong(v.valid_until)}`);
  data.proposal_amount_block = B(v.proposal_amount, `\n\nProposed Amount: KES ${fmtKes(v.proposal_amount)}`);
  data.collection_day_block = B(v.collection_day, `\n\nCollection Day: ${v.collection_day}`);
  data.sign_venue_block = B(v.sign_venue, ` at ${v.sign_venue}`);
  data.contact_phone_block = B(v.contact_phone, `\nSite Contact: ${v.contact_phone}`);
  data.bedrooms_block = B(v.bedrooms, ` (${v.bedrooms})`);
  data.amount_due_block = B(v.amount_due, ` of KES ${fmtKes(v.amount_due)}`);
  data.notice_note_block = B(v.notice_note, `\n\n${v.notice_note}`);
  data.agreement_note_block = B(v.agreement_note, `\n\n${v.agreement_note}`);
  if (v.billing_month) data.billing_month_label = fmtMonth(v.billing_month);
  data.landlord_id_block = v.landlord_id || '___';
  data.letter_salutation = v.recipient_name ? `Dear ${v.recipient_name},` : 'Dear Sir/Madam,';
  data.unit_line_block = data.unit_label ? `, House ${data.unit_label}` : '';

  // Recipient address block by template mode.
  if (template.recipient === 'tenant') {
    data.recipient_block = `${data.tenant_name}\nHouse ${data.unit_label}, ${data.property_name}`;
    data.recipient_name = data.recipient_name || data.tenant_name;
  } else if (template.recipient === 'landlord') {
    data.recipient_block = `${v.landlord_name || ''}${v.landlord_address ? '\n' + v.landlord_address : ''}`;
    data.recipient_name = data.recipient_name || v.landlord_name || '';
  } else if (template.recipient === 'custom') {
    data.recipient_block = `${v.recipient_name || ''}${v.recipient_address ? '\n' + v.recipient_address : ''}`;
    data.recipient_name = data.recipient_name || v.recipient_name || '';
  } else {
    data.recipient_block = '';
  }

  // List-type fields render as bulleted lines.
  data.schedule_items = splitLines(v.schedule_items).map((s) => `• ${s}`).join('\n');
  data.invoice_items = splitLines(v.invoice_items).map((s) => `• ${s}`).join('\n');

  // Subject + body with every placeholder substituted.
  // UPPERCASE aliases resolve to the same data — matching is case-insensitive.
  const fill = (text) => String(text || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (data[k] !== undefined && data[k] !== null) return String(data[k]);
    const canon = PLACEHOLDER_ALIASES[String(k).toUpperCase()];
    if (canon && data[canon] !== undefined && data[canon] !== null) return String(data[canon]);
    return '';
  });
  // Final safety pass: substitute any remaining {{ }} variables in an
  // already-composed body (e.g. hand-typed at Generate time) so raw
  // placeholders can never reach a PDF when the data exists.
  const finalizeBody = (bodyText) => fill(bodyText);
  return {
    template,
    subject: fill(template.subject),
    recipient_block: fill(data.recipient_block),
    data,
    // Raw (unformatted) values so numeric/date form fields can be
    // auto-filled without parsing display strings.
    raw: {
      tenant_name: data.tenant_name,
      unit_label: data.unit_label,
      property_name: data.property_name,
      phone_number: data.phone_number,
      national_id: (tenant && tenant.national_id) || v.national_id || '',
      rent_amount: Number(v.rent_amount ?? (tenant ? tenant.rent_amount : 0) ?? 0) || 0,
      deposit_amount: Number(v.deposit_amount ?? (tenant ? tenant.deposit_amount : 0) ?? 0) || 0,
      arrears_amount: Number(v.arrears_amount ?? arrears) || 0,
      garbage_balance: Number(v.garbage_balance ?? garbageBalance) || 0,
      water_balance: Number(v.water_balance ?? waterBalance) || 0,
      move_in_date: v.move_in_date || (tenant ? tenant.move_in_date : '') || '',
      rent_due_date: v.rent_due_date || (tenant ? tenant.rent_due_date : '') || '',
    },
    renderBody: (bodyText) => fill(bodyText == null ? template.body : bodyText),
    finalizeBody: (bodyText) => fill(bodyText),
  };
}

function bodyToHtml(bodyText) {
  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(bodyText || '')
    .split('\n')
    .map((line) => line.trim() ? `<p>${esc(line)}</p>` : '')
    .join('');
}

// Styled letter-body renderer (GEHPM formatting & emphasis rules). Anchors
// on the FINAL filled text + resolved data, so every path (create, batch,
// finalize-from-draft, custom notices, preview) renders identically while
// stored bodies stay plain text:
//   - each resolved data value → designated placeholder style (bold blue)
//   - property payment-details lines → bold black (rule: payment details)
//   - critical warnings (cash-payment sentence, FINAL take-notice, !!
//     marker lines) → bold red
function styledBodyToHtml(finalBody, data) {
  const PH = 'font-weight:700;color:#1e40af';
  const PAYC = 'font-weight:700;color:#000000';
  const WARNC = 'font-weight:700;color:#cc0000';
  const d = data || {};
  const segs = [];
  const pushSeg = (text, cls) => {
    for (const line of String(text ?? '').split('\n')) {
      const s = line.trim();
      if (!s || s.length < 2 || s === '—' || /^_+$/.test(s)) continue;
      segs.push({ s, cls });
    }
  };
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    pushSeg(v, k === 'property_payment_details' ? 'pay' : 'ph');
  }
  // Longest first so overlapping values match whole; pay wins ties.
  segs.sort((a, b) => b.s.length - a.s.length);
  const clsOf = new Map();
  for (const { s, cls } of segs) {
    if (!clsOf.has(s) || cls === 'pay') clsOf.set(s, cls);
  }
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chunks = [];
  const S = '', E = '';
  let html = String(finalBody || '');
  if (clsOf.size) {
    const pattern = new RegExp([...clsOf.keys()].map(escRe).join('|'), 'g');
    html = html.replace(pattern, (m) => {
      chunks.push(`<span style="${clsOf.get(m) === 'pay' ? PAYC : PH}">${escHtml(m)}</span>`);
      return `${S}${chunks.length - 1}${E}`;
    });
  }
  // Critical warnings → bold red (patterns tolerate already-styled spans).
  for (const re of [
    /cash payment to the caretaker[\s\S]*?will not be acknowledged\.?/i,
    /take notice that failure to settle[\s\S]*?without further reference to you\./i,
  ]) {
    html = html.replace(re, (m) => {
      chunks.push(`<span style="${WARNC}">${m}</span>`);
      return `${S}${chunks.length - 1}${E}`;
    });
  }
  return html
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return '';
      const warnLine = t.match(/^!!([\s\S]*)$/);
      const content = (warnLine ? warnLine[1] : t).trim();
      if (!content) return '';
      const styled = escHtml(content).replace(/(\d+)/g, (_, n) => chunks[Number(n)]);
      return warnLine ? `<p><span style="${WARNC}">${styled}</span></p>` : `<p>${styled}</p>`;
    })
    .join('');
}

// Validation gate: blocks Preview/Generate/finalize when the final document
// would contain unresolved variables, blank system fields, or invalid data.
// Returns an array of human-readable problems (empty = valid).
function validateLetterContent({ subject, recipient, body, data }) {
  const problems = [];
  const check = (label, text) => {
    const t = String(text || '');
    const vars = [...new Set([...t.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
    for (const v of vars) {
      // With data: only flag placeholders that would NOT resolve (fill()
      // silently blanks them). Without data: any placeholder is a problem.
      if (!data || !isResolvableVar(v, data)) {
        problems.push(`${label}: unresolved variable {{${v}}}`);
      }
    }
    if (/(^|[^A-Za-z])undefined([^A-Za-z]|$)/.test(t)) problems.push(`${label}: contains the word "undefined"`);
    if (/(^|[^A-Za-z])null([^A-Za-z]|$)/.test(t)) problems.push(`${label}: contains the word "null"`);
    if (/NaN/.test(t)) problems.push(`${label}: contains an invalid number (NaN)`);
  };
  check('Subject', subject);
  check('Recipient', recipient);
  check('Body', body);
  // Missing-checks only for fields actually passed in (raw partial passes
  // validate provided inputs only; the filled pass always passes finals).
  if (subject !== undefined && !String(subject || '').trim()) problems.push('Subject: missing (required)');
  if (body !== undefined && !String(body || '').trim()) problems.push('Body: missing (required)');
  return [...new Set(problems)];
}

// Two-pass validation: raw (pre-fill) catches placeholders that would be
// silently blanked; filled catches missing/undefined/null/NaN in finals.
function validateLetterPair(rawInput, filledInput, data) {
  return [...new Set([
    ...validateLetterContent({ ...(rawInput || {}), ...(data ? { data } : {}) }),
    ...validateLetterContent(filledInput || {}),
  ])];
}

module.exports = {
  resolveLetterData,
  bodyToHtml,
  styledBodyToHtml,
  fmtDateLong,
  validateLetterContent,
  validateLetterPair,
  PLACEHOLDER_ALIASES,
  PLACEHOLDER_CATALOG,
};