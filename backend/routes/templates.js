const express = require('express');
const { requireAuthActive } = require('../middleware/auth');
const store = require('../storage/store');

const router = express.Router();
router.use(requireAuthActive);

router.get('/', async (req, res) => {
  try {
    const templates = await store.listTemplates();
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, body, key } = req.body;
    if (!name || !body) return res.status(400).json({ error: 'name and body required' });
    const template = await store.createTemplate({ name, body, key });
    res.status(201).json({ template });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const patch = {};
    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.body !== undefined) patch.body = req.body.body;
    if (req.body.key !== undefined) patch.key = req.body.key;
    const template = await store.updateTemplate(req.params.id, patch);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await store.deleteTemplate(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

module.exports = router;
