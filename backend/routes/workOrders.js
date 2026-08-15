const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');
const whatsapp = require('../config/whatsapp');
const { generateAndStoreWorkOrder } = require('../services/documentStore');

const router = express.Router();
router.use(requireAuthActive);

const VALID_STATUSES = ['Pending', 'Approved', 'Assigned', 'In Progress', 'Completed'];
const VALID_PRIORITIES = ['Low', 'Medium', 'High'];

router.get('/', async (req, res) => {
  try {
    const { status, limit, offset } = req.query;
    const orders = await store.listWorkOrders({ status, limit, offset });
    const count = orders.length;
    res.json({ orders, count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list work orders: ' + err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await store.getWorkOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Work order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load work order: ' + err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { items, status, priority } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'At least one work item is required' });
    }
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
    }
    const order = await store.createWorkOrder(req.body);
    res.status(201).json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create work order: ' + err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { status, priority } = req.body;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
    }

    // Fetch current order to detect status transition to 'Completed'
    const current = await store.getWorkOrder(Number(req.params.id));
    const order = await store.updateWorkOrder(req.params.id, req.body);
    if (!order) return res.status(404).json({ error: 'Work order not found' });

    // When status transitions to 'Completed', auto-create maintenance charges
    if (status === 'Completed' && current && current.status !== 'Completed') {
      try {
        const charges = await store.createMaintenanceChargesFromWO(order.id);
        order._maintenance_charges = charges;
        order._charges_created = charges.length;
      } catch (err) {
        console.error('[WorkOrders] Auto-create maintenance charges failed:', err.message);
      }
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update work order: ' + err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteWorkOrder(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Work order not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete work order: ' + err.message });
  }
});

router.post('/:id/generate', async (req, res) => {
  try {
    const mode = req.body.mode || 'download';
    const doc = await generateAndStoreWorkOrder(req.params.id);
    if (!doc) return res.status(500).json({ error: 'Failed to generate work order PDF' });

    if (mode === 'download') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Work-Order-Number', doc.doc_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream work order PDF' });
      });
    }

    const phone = req.body.phone_number;
    if (!phone) return res.status(400).json({ error: 'phone_number is required for WhatsApp delivery' });

    try {
      await whatsapp.sendMediaMessage(phone, doc.file_path, `Hello, please find attached work order ${doc.doc_number} for ${doc.property_name || 'the property'}.`);
    } catch (err) {
      return res.status(500).json({ error: 'WhatsApp delivery failed: ' + err.message });
    }

    if (mode === 'both') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
      res.setHeader('X-Work-Order-Number', doc.doc_number);
      return res.sendFile(doc.file_path, err => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to stream work order PDF' });
      });
    }

    res.json({ success: true, message: 'Work order sent successfully', work_order_no: doc.doc_number });
  } catch (err) {
    res.status(500).json({ error: 'Work order operation failed: ' + err.message });
  }
});

module.exports = router;
