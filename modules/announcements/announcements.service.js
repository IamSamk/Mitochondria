const { query, withTransaction } = require('../../config/database');
const { ValidationError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');

async function listForUser(user) {
  const params = [];
  const where = [];
  if (user.departmentId) {
    params.push(user.departmentId);
    where.push(`(a.department_id IS NULL OR a.department_id = $${params.length})`);
  } else {
    where.push(`a.department_id IS NULL`);
  }
  if (user.role) {
    params.push(user.role);
    where.push(`(a.audience_role IS NULL OR a.audience_role = $${params.length})`);
  }
  const { rows } = await query(
    `SELECT a.*, u.full_name AS author_name
       FROM announcements a
       JOIN users u ON u.id = a.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.created_at DESC
      LIMIT 20`, params);
  return rows;
}

async function create({ title, body, audienceRole, departmentId }, userId, ip) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!t || !b) throw new ValidationError('Title and body are required');
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO announcements(title, body, audience_role, department_id, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [t, b, audienceRole || null, departmentId || null, userId]);
    await logAudit({ actorId: userId, action: 'ANNOUNCEMENT_CREATED', entityType: 'announcement',
      entityId: rows[0].id, metadata: { audienceRole, departmentId }, ip }, db);
    return rows[0];
  });
}

module.exports = { listForUser, create };
