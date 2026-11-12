const express = require('express');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();

router.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const stats = {};
    if (req.session.user.role === 'ADMIN') {
      stats.users = (await query('SELECT count(*)::int AS n FROM users WHERE is_active')).rows[0].n;
      stats.departments = (await query('SELECT count(*)::int AS n FROM departments')).rows[0].n;
      stats.courses = (await query('SELECT count(*)::int AS n FROM courses')).rows[0].n;
    }
    res.render('dashboard', { stats, title: 'Dashboard' });
  } catch (e) { next(e); }
});

// Example of a role-restricted area; real admin modules will mount under /admin.
router.get('/admin', requireAuth, requireRole('ADMIN'), (req, res) => res.redirect('/dashboard'));

module.exports = router;
