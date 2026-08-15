const express = require('express');
const store = require('../storage/store');
const { signToken, requireAuthActive } = require('../middleware/auth');
const { verifyPassword, publicUser } = require('../services/userAccounts');
const { loginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const { password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const user = await store.findUserByUsername(username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }
    await store.updateUser(user.id, { last_login_at: new Date().toISOString() });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', requireAuthActive, async (req, res) => {
  try {
    const user = await store.findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve user details' });
  }
});

module.exports = router;
