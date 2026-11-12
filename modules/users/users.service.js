const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');

async function listRoles() {
  const { rows } = await query('SELECT id, code, name FROM roles ORDER BY id');
  return rows;
}

async function listUsers({ q = '', role = '', active = '' } = {}) {
  const params = [];
  const where = [];
  if (q) { params.push(`%${q}%`); where.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`); }
  if (role) { params.push(role); where.push(`r.code = $${params.length}`); }
  if (active === 'true' || active === 'false') { params.push(active === 'true'); where.push(`u.is_active = $${params.length}`); }
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
            r.id AS role_id, r.code AS role_code, r.name AS role_name,
            d.id AS department_id, d.code AS department_code, d.name AS department_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN departments d ON d.id = u.department_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY u.full_name
      LIMIT 500`, params);
  return rows;
}

async function getUser(id) {
  const { rows } = await query(
    `SELECT u.*, r.code AS role_code, r.name AS role_name
       FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, [id]);
  if (!rows[0]) throw new NotFoundError('User not found');
  return rows[0];
}

async function createUser({ email, fullName, roleId, departmentId, password }, actorId, ip) {
  const hash = await bcrypt.hash(password, 10);
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO users(email, full_name, password_hash, role_id, department_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, role_id, department_id, is_active`,
        [email.toLowerCase(), fullName.trim(), hash, roleId, departmentId || null]);
      await logAudit({ actorId, action: 'USER_CREATED', entityType: 'user', entityId: rows[0].id,
        metadata: { email: rows[0].email, roleId }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A user with this email already exists');
    if (e.code === '23503') throw new ValidationError('Selected role or department does not exist');
    throw e;
  }
}

async function updateUser(id, { email, fullName, roleId, departmentId, isActive }, actorId, ip) {
  if (Number(id) === Number(actorId) && !isActive) {
    throw new ValidationError('You cannot deactivate your own account');
  }
  try {
    return await withTransaction(async (db) => {
      const before = await db.query(
        `SELECT u.is_active, r.code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 FOR UPDATE`, [id]);
      if (!before.rows[0]) throw new NotFoundError('User not found');

      // Never allow the platform to be left without an active administrator.
      if (before.rows[0].code === 'ADMIN' && (!isActive || (await roleCode(roleId, db)) !== 'ADMIN')) {
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id=u.role_id
            WHERE r.code='ADMIN' AND u.is_active AND u.id <> $1`, [id]);
        if (rows[0].n === 0) throw new ValidationError('At least one active administrator must remain');
      }

      const { rows } = await db.query(
        `UPDATE users SET email=$1, full_name=$2, role_id=$3, department_id=$4, is_active=$5,
                updated_at=now() WHERE id=$6 RETURNING id, email, full_name, role_id, department_id, is_active`,
        [email.toLowerCase(), fullName.trim(), roleId, departmentId || null, isActive, id]);
      await logAudit({ actorId, action: 'USER_UPDATED', entityType: 'user', entityId: id,
        metadata: { email: rows[0].email, roleId, isActive }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A user with this email already exists');
    throw e;
  }
}

async function roleCode(roleId, db) {
  const { rows } = await db.query('SELECT code FROM roles WHERE id=$1', [roleId]);
  if (!rows[0]) throw new ValidationError('Selected role does not exist');
  return rows[0].code;
}

async function resetPassword(id, password, actorId, ip) {
  const hash = await bcrypt.hash(password, 10);
  await withTransaction(async (db) => {
    const { rows } = await db.query(
      'UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2 RETURNING id', [hash, id]);
    if (!rows[0]) throw new NotFoundError('User not found');
    // Invalidate every other session for the affected account.
    await db.query('DELETE FROM user_sessions WHERE sess->\'user\'->>\'id\' = $1', [String(id)]);
    await logAudit({ actorId, action: 'PASSWORD_RESET', entityType: 'user', entityId: id, ip }, db);
  });
}

async function selfProfile(userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, r.code AS role_code, d.name AS department_name,
            u.last_login_at, u.created_at
       FROM users u JOIN roles r ON r.id=u.role_id
       LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`, [userId]);
  if (!rows[0]) throw new NotFoundError('User not found');
  return rows[0];
}

async function updateOwnProfile(userId, { fullName }, actorId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE users SET full_name=$1, updated_at=now() WHERE id=$2
       RETURNING id, email, full_name`,
      [fullName.trim(), userId]);
    if (!rows[0]) throw new NotFoundError('User not found');
    await logAudit({
      actorId: actorId || userId, action: 'PROFILE_UPDATED', entityType: 'user',
      entityId: userId, metadata: { fullName: rows[0].full_name }, ip
    }, db);
    return rows[0];
  });
}

async function changePassword(userId, { currentPassword, newPassword }, currentSid, actorId, ip) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id=$1', [userId]);
  if (!rows[0]) throw new NotFoundError('User not found');
  const matches = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!matches) throw new ValidationError('Current password is incorrect');
  if (currentPassword === newPassword) {
    throw new ValidationError('Choose a password different from your current one');
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await withTransaction(async (db) => {
    await db.query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [hash, userId]);
    // Keep the session that performed the change; sign out every other device.
    await db.query(
      `DELETE FROM user_sessions WHERE sess->'user'->>'id' = $1 AND sid <> $2`,
      [String(userId), currentSid]);
    await logAudit({
      actorId: actorId || userId, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: userId, ip
    }, db);
  });
}

module.exports = {
  listRoles, listUsers, getUser, createUser, updateUser, resetPassword, selfProfile,
  updateOwnProfile, changePassword
};
