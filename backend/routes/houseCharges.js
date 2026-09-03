'use strict';

const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const { pool } = require('../config/database');

const router = express.Router();
router.use(requireAuthActive);

// ─── List charges for a house ──────────────────────────────────────────────

router.get('/:houseId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM house_charges WHERE house_paybill = $1 ORDER BY sort_order, id`,
      [req.params.houseId]
    );
    res.json({ charges: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list charges' });
  }
});

// ─── Create a charge ───────────────────────────────────────────────────────

router.post('/:houseId', async (req, res) => {
  try {
    const { charge_name, amount, frequency, enabled } = req.body;
    if (!charge_name) return res.status(400).json({ error: 'charge_name is required' });
    const result = await pool.query(
      `INSERT INTO house_charges (house_paybill, charge_name, amount, frequency, enabled)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.houseId, charge_name, Number(amount) || 0, frequency || 'one-time', enabled !== false]
    );
    res.status(201).json({ charge: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create charge' });
  }
});

// ─── Update a charge ───────────────────────────────────────────────────────

router.put('/:houseId/:chargeId', async (req, res) => {
  try {
    const { charge_name, amount, frequency, enabled } = req.body;
    const result = await pool.query(
      `UPDATE house_charges
       SET charge_name = COALESCE($1, charge_name),
           amount = COALESCE($2, amount),
           frequency = COALESCE($3, frequency),
           enabled = COALESCE($4, enabled),
           updated_at = NOW()
       WHERE id = $5 AND house_paybill = $6
       RETURNING *`,
      [charge_name, amount != null ? Number(amount) : null, frequency, enabled, req.params.chargeId, req.params.houseId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Charge not found' });
    res.json({ charge: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update charge' });
  }
});

// ─── Toggle a charge on/off ────────────────────────────────────────────────

router.patch('/:houseId/:chargeId/toggle', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE house_charges SET enabled = NOT enabled, updated_at = NOW()
       WHERE id = $1 AND house_paybill = $2
       RETURNING *`,
      [req.params.chargeId, req.params.houseId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Charge not found' });
    res.json({ charge: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle charge' });
  }
});

// ─── Delete a charge ───────────────────────────────────────────────────────

router.delete('/:houseId/:chargeId', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM house_charges WHERE id = $1 AND house_paybill = $2`,
      [req.params.chargeId, req.params.houseId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete charge' });
  }
});

module.exports = router;
