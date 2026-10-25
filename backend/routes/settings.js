/**
 * Company / Document settings — Official GEHPM softcopy stamp management.
 * Admin-only mutations; any authenticated user may read status (needed for
 * conditional UI), image bytes served to authenticated users for preview.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuthActive, requireAdmin } = require('../middleware/auth');
const stamp = require('../services/officialStamp');
const signature = require('../services/officialSignature');

const router = express.Router();
router.use(requireAuthActive);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/stamp', (req, res) => {
  try {
    res.json(stamp.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read stamp status' });
  }
});

router.get('/stamp/image', (req, res) => {
  try {
    const uri = stamp.getStampDataUri();
    if (!uri) return res.status(404).json({ error: 'No active stamp' });
    const m = uri.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
    if (!m) return res.status(500).json({ error: 'Stamp data invalid' });
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to serve stamp image' });
  }
});

router.post('/stamp', requireAdmin, (req, res) => {
  upload.single('file')(req, res, (uploadErr) => {
    try {
      if (uploadErr) {
        const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({ error: tooBig ? 'File exceeds the 5 MB limit' : 'Upload failed: ' + uploadErr.message });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      const status = stamp.saveStamp(req.file.buffer, req.file.originalname, req.user?.username);
      res.json({ ok: true, stamp: status });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Failed to save stamp' });
    }
  });
});

router.patch('/stamp', requireAdmin, (req, res) => {
  try {
    const { active } = req.body || {};
    const status = stamp.setStampActive(active !== false, req.user?.username);
    res.json({ ok: true, stamp: status });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update stamp' });
  }
});

router.delete('/stamp', requireAdmin, (req, res) => {
  try {
    const status = stamp.removeStamp();
    res.json({ ok: true, stamp: status });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to remove stamp' });
  }
});

// ─── Authorized signature (pre-assigned on letter documents) ────────────────

router.get('/signature', (req, res) => {
  try {
    res.json(signature.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read signature status' });
  }
});

router.get('/signature/image', (req, res) => {
  try {
    const uri = signature.getSigDataUri();
    if (!uri) return res.status(404).json({ error: 'No active signature' });
    const m = uri.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
    if (!m) return res.status(500).json({ error: 'Signature data invalid' });
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to serve signature image' });
  }
});

router.post('/signature', requireAdmin, (req, res) => {
  upload.single('file')(req, res, (uploadErr) => {
    try {
      if (uploadErr) {
        const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({ error: tooBig ? 'File exceeds the 5 MB limit' : 'Upload failed: ' + uploadErr.message });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ error: 'No file uploaded' });
      }
      const status = signature.saveSignature(req.file.buffer, req.file.originalname, req.body?.holder_name, req.user?.username);
      res.json({ ok: true, signature: status });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Failed to save signature' });
    }
  });
});

router.patch('/signature', requireAdmin, (req, res) => {
  try {
    const { active, holder_name } = req.body || {};
    let status = signature.getStatus();
    if (holder_name !== undefined) status = signature.setSignatureHolder(holder_name, req.user?.username);
    if (active !== undefined) status = signature.setSignatureActive(active !== false, req.user?.username);
    res.json({ ok: true, signature: status });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update signature' });
  }
});

router.delete('/signature', requireAdmin, (req, res) => {
  try {
    const status = signature.removeSignature();
    res.json({ ok: true, signature: status });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to remove signature' });
  }
});

module.exports = router;
