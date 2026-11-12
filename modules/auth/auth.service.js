const bcrypt = require('bcryptjs');
const { query } = require('../../config/database');
const { logAudit } = require('../audit/audit.service');

// Pre-computed hash so unknown-email logins take similar time (avoids user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/** Returns the session user object on success, or null. Generic failure on purpose. */
async function authenticate(email, password, ip) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.password_hash, u.is_active, r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = lower($1)`, [email]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.is_active) {
    await logAudit({ actorId: user ? user.id : null, action: 'LOGIN_FAILED', entityType: 'user', entityId: user ? user.id : null, ip });
    return null;
  }
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await logAudit({ actorId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, ip });
  return { id: Number(user.id), email: user.email, fullName: user.full_name, role: user.role };
}

module.exports = { authenticate };
