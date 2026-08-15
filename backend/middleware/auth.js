const jwt = require('jsonwebtoken');
const store = require('../storage/store');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_insecure_secret_change_in_production';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, username: payload.username, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireActiveUser(req, res, next) {
  try {
    const row = await store.findUserById(req.user.id);
    if (!row) return res.status(401).json({ error: 'User account no longer exists' });
    if (row.is_active === false) return res.status(403).json({ error: 'Account is deactivated' });
    req.user = { id: row.id, username: row.username, role: row.role };
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'Authentication check failed' });
  }
}

function requireAuthActive(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    requireActiveUser(req, res, next).catch(next);
  });
}

function requireAdmin(req, res, next) {
  requireAuthActive(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    next();
  });
}

module.exports = { signToken, requireAuth, requireActiveUser, requireAuthActive, requireAdmin, JWT_SECRET };
