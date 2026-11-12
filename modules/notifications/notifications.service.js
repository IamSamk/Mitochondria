const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../config/errors');

async function unreadCount(userId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [userId]);
  return rows[0].n;
}

async function listForUser(userId, { unreadOnly = false, limit = 50 } = {}) {
  const params = [userId];
  const where = ['user_id = $1'];
  if (unreadOnly) where.push('read_at IS NULL');
  const { rows } = await query(
    `SELECT * FROM notifications WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $2`, [userId, limit]);
  return rows;
}

async function markRead(id, userId) {
  await query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND user_id = $2`, [id, userId]);
}

async function markAllRead(userId) {
  await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
}

async function notify(userIds, { type, title, body = null, link = null }) {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return [];
  if (!type || !title) throw new ValidationError('Notification type and title are required');
  return withTransaction(async (db) => {
    const inserted = [];
    for (const uid of ids) {
      const { rows } = await db.query(
        `INSERT INTO notifications(user_id, type, title, body, link)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [uid, type, title, body, link]);
      inserted.push(rows[0]);
    }
    return inserted;
  });
}

async function notifyRole(roleCode, payload) {
  const { rows } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
      WHERE r.code=$1 AND u.is_active`, [roleCode]);
  return notify(rows.map((r) => r.id), payload);
}

async function notifyDepartment(departmentId, roleCodes, payload) {
  const { rows } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
      WHERE u.is_active AND u.department_id=$1 AND r.code = ANY($2::text[])`,
    [departmentId, roleCodes]);
  return notify(rows.map((r) => r.id), payload);
}

module.exports = { unreadCount, listForUser, markRead, markAllRead, notify, notifyRole, notifyDepartment };
