function healthDetailedAuth(req, res, next) {
  const expected = process.env.HEALTH_CHECK_SECRET;
  if (!expected) {
    req.healthDetailed = process.env.NODE_ENV !== 'production';
    return next();
  }
  const provided = req.headers['x-health-key'] || req.query.key;
  req.healthDetailed = provided === expected;
  return next();
}

module.exports = { healthDetailedAuth };
