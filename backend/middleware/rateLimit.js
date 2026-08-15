const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
  skipSuccessfulRequests: true,
});

module.exports = { loginLimiter };
