const helmet = require('helmet');

const INSECURE_JWT_VALUES = new Set([
  'dev_insecure_secret_change_in_production',
  'change_me_to_a_secure_random_string_min_32_chars',
]);

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function assertProductionSecrets() {
  if (!isProduction()) return;
  const secret = process.env.JWT_SECRET || '';
  if (
    !secret ||
    secret.length < 32 ||
    INSECURE_JWT_VALUES.has(secret) ||
    /change_me/i.test(secret)
  ) {
    console.error('[Security] Production requires JWT_SECRET (32+ chars) in .env');
    process.exit(1);
  }
}

function buildCorsOptions() {
  const allowed = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!isProduction()) return { origin: true, credentials: true };
  if (!allowed.length) return { origin: false, credentials: true };
  return {
    origin(origin, cb) {
      if (!origin || allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  };
}

function buildHelmetMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
}

function getTrustProxySetting() {
  const v = process.env.TRUST_PROXY;
  if (v === '1' || v === 'true') return 1;
  return false;
}

module.exports = {
  isProduction,
  assertProductionSecrets,
  buildCorsOptions,
  buildHelmetMiddleware,
  getTrustProxySetting,
};
