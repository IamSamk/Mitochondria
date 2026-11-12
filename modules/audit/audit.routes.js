const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { query } = require('../../config/database');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

const PAGE_SIZE = 50;

router.get('/', asyncHandler(async (req, res) => {
  const action = (req.query.action || '').trim();
  const entityType = (req.query.entityType || '').trim();
  const actor = (req.query.actor || '').trim();
  const from = (req.query.from || '').trim();
  const to = (req.query.to || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);

  const params = [];
  const where = [];
  if (action) { params.push(`%${action}%`); where.push(`a.action ILIKE $${params.length}`); }
  if (entityType) { params.push(entityType); where.push(`a.entity_type = $${params.length}`); }
  if (actor) { params.push(`%${actor}%`); where.push(`u.email ILIKE $${params.length}`); }
  if (from) { params.push(from); where.push(`a.created_at >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`a.created_at < ($${params.length}::date + interval '1 day')`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (await query(
    `SELECT count(*)::int AS n FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ${whereSql}`, params)).rows[0].n;
  params.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const { rows } = await query(
    `SELECT a.*, u.email AS actor_email, u.full_name AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
      ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  res.render('admin/audit', {
    logs: rows,
    filters: { action, entityType, actor, from, to },
    page, pages, total,
    title: 'Audit Log'
  });
}));

module.exports = router;
