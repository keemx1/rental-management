function requireRole(...allowedRoles) {
  const allowed = new Set(allowedRoles);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    return next();
  };
}

const requireAdmin = requireRole('admin');

module.exports = { requireRole, requireAdmin };
