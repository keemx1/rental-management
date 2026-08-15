/**
 * Admin user account helpers — validation and password hashing.
 */
const bcrypt = require('bcryptjs');

const SIMPLE_USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_USERNAME_LENGTH = 255;
const BCRYPT_ROUNDS = 12;

function validateUsername(username) {
  const value = String(username || '').trim();

  if (value.length < 3) {
    return { ok: false, error: 'Sign-in ID must be at least 3 characters' };
  }

  if (value.length > MAX_USERNAME_LENGTH) {
    return {
      ok: false,
      error: `Sign-in ID must be at most ${MAX_USERNAME_LENGTH} characters`,
    };
  }

  const isEmail = EMAIL_RE.test(value);
  const isSimple = SIMPLE_USERNAME_RE.test(value);

  if (!isEmail && !isSimple) {
    return {
      ok: false,
      error: 'Use a valid email (e.g. you@gmail.com) or a simple username (letters, numbers, . _ -)',
    };
  }

  return { ok: true, value };
}

function validatePassword(password, { minLength = 8 } = {}) {
  const value = String(password || '');
  if (value.length < minLength) {
    return { ok: false, error: `Password must be at least ${minLength} characters` };
  }
  return { ok: true, value };
}

function validateRole(role) {
  const value = String(role || '').trim();
  if (!['admin', 'operator'].includes(value)) {
    return { ok: false, error: 'Role must be admin or operator' };
  }
  return { ok: true, value };
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name || null,
    role: row.role,
    is_active: row.is_active !== false,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

module.exports = {
  validateUsername,
  validatePassword,
  validateRole,
  hashPassword,
  verifyPassword,
  publicUser,
};
