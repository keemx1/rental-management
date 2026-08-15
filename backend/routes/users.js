const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const store = require('../storage/store');
const { hashPassword, publicUser, validateUsername, validatePassword, validateRole } = require('../services/userAccounts');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const users = await store.listUsers();
    res.json({ users: users.map(publicUser) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { username, password, display_name, role } = req.body;
    
    const unValid = validateUsername(username);
    if (!unValid.ok) return res.status(400).json({ error: unValid.error });
    
    const pwValid = validatePassword(password);
    if (!pwValid.ok) return res.status(400).json({ error: pwValid.error });

    const roleValid = validateRole(role);
    if (!roleValid.ok) return res.status(400).json({ error: roleValid.error });

    const existing = await store.findUserByUsername(unValid.value);
    if (existing) return res.status(400).json({ error: 'Username already exists' });

    const hashed = await hashPassword(pwValid.value);

    const user = await store.createUser({
      username: unValid.value,
      password_hash: hashed,
      display_name: display_name ? String(display_name).trim() : '',
      role: roleValid.value,
      is_active: true
    });

    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, role, is_active, password } = req.body;
    
    const patch = {};
    if (display_name !== undefined) patch.display_name = String(display_name).trim();
    if (is_active !== undefined) patch.is_active = Boolean(is_active);
    
    if (role !== undefined) {
      const roleValid = validateRole(role);
      if (!roleValid.ok) return res.status(400).json({ error: roleValid.error });
      patch.role = roleValid.value;
    }

    if (password) {
      const pwValid = validatePassword(password);
      if (!pwValid.ok) return res.status(400).json({ error: pwValid.error });
      patch.password_hash = await hashPassword(pwValid.value);
    }

    const updated = await store.updateUser(id, patch);
    if (!updated) return res.status(404).json({ error: 'User not found' });

    res.json({ user: publicUser(updated) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (String(id) === String(req.user.id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    await store.deleteUser(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
