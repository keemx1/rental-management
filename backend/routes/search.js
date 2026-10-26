'use strict';

/**
 * Universal Global Search — /api/search?q=...
 * One endpoint across the entire system; every item carries a `kind` the
 * frontend maps to a DIRECT deep link to the exact record.
 */
const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const result = await store.globalSearch(req.query.q, Number(req.query.limit) || 6);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

module.exports = router;
