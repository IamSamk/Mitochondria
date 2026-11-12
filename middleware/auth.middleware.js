const { query } = require('../config/database');

const wantsJson = (req) => req.accepts(['html', 'json']) === 'json' && !req.accepts('html');

/**
 * Require a logged-in user who is still active in the database
 * (so deactivating a compromised account takes effect immediately).
 */
async function requireAuth(req, res, next) {
  try {
    const u = req.session && req.session.user;
    if (u) {
      const { rows } = await query('SELECT is_active FROM users WHERE id = $1', [u.id]);
      if (rows[0] && rows[0].is_active) return next();
      return req.session.destroy(() => (wantsJson(req)
        ? res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Account inactive' } })
        : res.redirect('/login')));
    }
    if (wantsJson(req)) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHENTICATED', message: 'Login required' } });
    }
    return res.redirect('/login');
  } catch (e) { return next(e); }
}

module.exports = { requireAuth };
