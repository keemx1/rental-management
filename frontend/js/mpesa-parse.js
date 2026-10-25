/**
 * Client-side M-Pesa message parser — offline PARSE.
 *
 * This is a verbatim port of `parseMpesaMessage()` in
 * backend/routes/payments.js. Keep the two in sync: any change to the
 * backend parser must be mirrored here (and vice versa) so offline and
 * online parsing produce identical results.
 */
function parseMpesaMessage(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const amountMatch = text.match(/(\d[\d,]*(?:\.\d{1,2})?)\s*(?:Ksh|KES)/i) || text.match(/\b(?:Ksh|KES)\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
  const phoneMatch = text.match(/\b(?:254|0)?7\d{8}\b/);
  const tenantCodeMatch = text.match(/\bT\d{3,}\b/i);
  const houseNumberMatch = text.match(/\b(?:house|unit)\s*[:\-]?\s*([A-Za-z0-9\-]+)\b/i);
  const accountNumberMatch = text.match(/#([A-Z0-9]+)/i);

  // Reference: try known patterns first, then fallback
  let mpesa_reference = null;
  const refDotMatch = text.match(/\bRef\.?\s*([A-Za-z0-9]{6,20})\b/i);
  const txIdMatch = text.match(/Transaction\s+(?:ID|No|Ref)[.:]*\s*([A-Za-z0-9]{6,20})\b/i);
  if (refDotMatch) {
    mpesa_reference = refDotMatch[1].toUpperCase();
  } else if (txIdMatch) {
    mpesa_reference = txIdMatch[1].toUpperCase();
  } else {
    const refMatch = text.match(/\b[A-Z0-9]{10,12}\b/);
    mpesa_reference = refMatch ? refMatch[0] : null;
  }

  const amount = amountMatch ? Number(String(amountMatch[1]).replace(/,/g, '')) : null;

  // Extract payment date from message — formats: DD/MM/YY, YYYY-MM-DD, DD/MM/YYYY, DD Mon YYYY
  let payment_date = null;
  const dateMatchYY = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/);
  const dateMatchYYYYSlash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const dateMatchYYYY = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const monthNames = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const dateMatchMon = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i);
  if (dateMatchYYYY) {
    const [, y, m, d] = dateMatchYYYY;
    payment_date = `${y}-${m}-${d}`;
  } else if (dateMatchMon) {
    const [, d, mon, y] = dateMatchMon;
    payment_date = `${y}-${monthNames[mon.toLowerCase()]}-${d.padStart(2, '0')}`;
  } else if (dateMatchYYYYSlash) {
    const [, d, m, y] = dateMatchYYYYSlash;
    payment_date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  } else if (dateMatchYY) {
    const [, d, m, y2] = dateMatchYY;
    const fullYear = Number(y2) < 100 ? 2000 + Number(y2) : Number(y2);
    payment_date = `${fullYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  let phone_number = phoneMatch ? phoneMatch[0] : null;
  if (phone_number) {
    const digits = phone_number.replace(/\D/g, '');
    const last9 = digits.slice(-9);
    phone_number = last9.length === 9 ? `254${last9}` : digits;
  }

  return {
    raw: text,
    amount,
    mpesa_reference,
    phone_number,
    payment_date,
    tenant_code: tenantCodeMatch ? tenantCodeMatch[0].toUpperCase() : null,
    house_number: houseNumberMatch ? houseNumberMatch[1] : null,
    accountNumber: accountNumberMatch ? accountNumberMatch[1] : null,
  };
}

/**
 * Match parsed message fields against cached tenants (offline lookup).
 * Mirrors the server's findTenantsForPaymentLookup heuristics:
 * phone number, tenant code / account number, house paybill number.
 */
function matchTenantsOffline(parsed, tenants) {
  if (!parsed || !Array.isArray(tenants)) return [];
  const norm = (v) => String(v || '').replace(/\D/g, '').slice(-9);
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const key = t.tenant_code;
    if (key && !seen.has(key)) { seen.add(key); out.push(t); }
  };
  if (parsed.phone_number) {
    const want = norm(parsed.phone_number);
    tenants.forEach((t) => { if (t.phone_number && norm(t.phone_number) === want) push(t); });
  }
  const code = (parsed.accountNumber || parsed.tenant_code || '').toUpperCase();
  if (code) {
    tenants.forEach((t) => { if (String(t.tenant_code || '').toUpperCase() === code) push(t); });
  }
  if (parsed.house_number) {
    const hn = String(parsed.house_number).toLowerCase();
    tenants.forEach((t) => {
      if (String(t.house_paybill_number || '').toLowerCase() === hn) push(t);
    });
  }
  return out;
}

export { parseMpesaMessage, matchTenantsOffline };
