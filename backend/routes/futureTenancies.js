'use strict';

const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const futureTenancies = require('../storage/futureTenancies');
const whatsapp = require('../config/whatsapp');
const { sessionManager } = require('../whatsapp/session-manager');

const router = express.Router();
router.use(requireAuthActive);

// ─── List Future Tenancies ─────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const tenancies = await futureTenancies.listFutureTenancies(req.query);
    res.json({ future_tenancies: tenancies });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list future tenancies' });
  }
});

// ─── Get Future Tenancy ────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const tenancy = await futureTenancies.getFutureTenancy(req.params.id);
    if (!tenancy) return res.status(404).json({ error: 'Future tenancy not found' });
    res.json({ future_tenancy: tenancy });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get future tenancy' });
  }
});

// ─── Get Future Tenancy Payments ───────────────────────────────────────────

router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await futureTenancies.listFuturePayments(req.params.id);
    res.json({ future_payments: payments });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list future payments' });
  }
});

// ─── Create Future Tenancy (Reserve Unit) ─────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const {
      property_name, unit_label, house_paybill, tenant_name, phone_number,
      national_id, tenant_code, allocated_month, rent_amount, deposit_amount, notes,
    } = req.body;

    if (!property_name || !tenant_name || !allocated_month) {
      return res.status(400).json({ error: 'property_name, tenant_name, and allocated_month are required' });
    }

    const tenancy = await futureTenancies.createFutureTenancy({
      property_name, unit_label, house_paybill, tenant_name, phone_number,
      national_id, tenant_code, allocated_month, rent_amount, deposit_amount, notes,
    });

    res.status(201).json({ future_tenancy: tenancy });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create future tenancy' });
  }
});

// ─── Update Future Tenancy ─────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  try {
    const tenancy = await futureTenancies.updateFutureTenancy(req.params.id, req.body);
    if (!tenancy) return res.status(404).json({ error: 'Future tenancy not found' });
    res.json({ future_tenancy: tenancy });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update future tenancy' });
  }
});

// ─── Cancel Future Tenancy ─────────────────────────────────────────────────

router.post('/:id/cancel', async (req, res) => {
  try {
    const tenancy = await futureTenancies.cancelFutureTenancy(req.params.id);
    if (!tenancy) return res.status(404).json({ error: 'Future tenancy not found' });
    res.json({ future_tenancy: tenancy });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel future tenancy' });
  }
});

// ─── Record Future Payment ─────────────────────────────────────────────────

router.post('/:id/payments', async (req, res) => {
  try {
    const { amount, payment_date, payment_time, allocated_month, payment_mode, mpesa_reference, purpose, notes } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount is required' });
    if (!allocated_month) return res.status(400).json({ error: 'allocated_month is required' });

    const tenancy = await futureTenancies.getFutureTenancy(req.params.id);
    if (!tenancy) return res.status(404).json({ error: 'Future tenancy not found' });
    if (tenancy.status !== 'RESERVED') return res.status(400).json({ error: 'Cannot add payments to non-RESERVED tenancy' });

    const payment = await futureTenancies.createFuturePayment({
      future_tenancy_id: req.params.id,
      amount, payment_date, payment_time, allocated_month,
      payment_mode, mpesa_reference, purpose, notes,
    });

    res.status(201).json({ future_payment: payment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record future payment' });
  }
});

// ─── Approve Future Payment ────────────────────────────────────────────────

router.post('/payments/:paymentId/approve', async (req, res) => {
  try {
    const payment = await futureTenancies.approveFuturePayment(req.params.paymentId);
    if (!payment) return res.status(404).json({ error: 'Future payment not found' });

    // Send WhatsApp confirmation
    const tenancy = await futureTenancies.getFutureTenancy(payment.future_tenancy_id);
    if (tenancy && tenancy.phone_number) {
      const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const [allocYear, allocMonth] = (payment.allocated_month || '').split('-').map(Number);
      const allocMonthName = FULL_MONTHS[(allocMonth || 1) - 1] || 'Unknown';

      let msg = `Dear ${tenancy.tenant_name.toUpperCase()},\n\n`;
      msg += `Your payment of KES ${Number(payment.amount).toLocaleString('en-KE', { minimumFractionDigits: 0 })} has been successfully received by GUTENBERG ELITE HOME & PROPERTY MANAGEMENTS`;
      if (tenancy.unit_label) msg += ` for House No. ${tenancy.unit_label}`;
      if (tenancy.property_name) msg += `, ${tenancy.property_name}`;
      msg += `.\n\n`;
      msg += `The payment has been allocated as a ${payment.purpose || 'down payment'} toward your ${allocMonthName} ${allocYear} tenancy.\n\n`;
      msg += `Amount Received: KES ${Number(payment.amount).toLocaleString('en-KE', { minimumFractionDigits: 0 })}\n`;
      msg += `Allocated To: ${allocMonthName} ${allocYear}\n`;
      msg += `Payment Purpose: ${payment.purpose || 'Down Payment'}\n`;
      if (payment.mpesa_reference) msg += `Transaction Ref: ${payment.mpesa_reference}\n`;
      msg += `\nYour payment has been recorded in our system and will be accounted for when your tenancy commences.\n\nThank you.`;

      try {
        if (sessionManager && typeof sessionManager.sendText === 'function') {
          const normalized = tenancy.phone_number.replace(/[^0-9+]/g, '');
          const phone = normalized.startsWith('+') ? normalized.slice(1) : normalized.startsWith('254') ? normalized : '254' + normalized.replace(/^0/, '');
          await sessionManager.sendText(phone, msg);
        }
      } catch (waErr) {
        console.warn('[FutureTenancy] WhatsApp send failed:', waErr.message);
      }
    }

    res.json({ future_payment: payment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve future payment' });
  }
});

// ─── Cancel Future Payment ─────────────────────────────────────────────────

router.post('/payments/:paymentId/cancel', async (req, res) => {
  try {
    const payment = await futureTenancies.cancelFuturePayment(req.params.paymentId);
    if (!payment) return res.status(404).json({ error: 'Future payment not found' });
    res.json({ future_payment: payment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel future payment' });
  }
});

// ─── Activate Future Tenancy → Creates Active Tenant ───────────────────────

router.post('/:id/activate', async (req, res) => {
  try {
    const result = await futureTenancies.activateFutureTenancy(req.params.id, store);
    res.json({
      message: 'Future tenancy activated successfully',
      tenant: result.tenant,
      total_paid: result.totalPaid,
      deposit_paid: result.depositPaid,
      rent_paid: result.rentPaid,
      other_paid: result.otherPaid,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to activate future tenancy' });
  }
});

// ─── Summary ───────────────────────────────────────────────────────────────

router.get('/summary/stats', async (req, res) => {
  try {
    const summary = await futureTenancies.getFutureTenancySummary();
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get summary' });
  }
});

module.exports = router;
