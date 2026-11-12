const crypto = require('crypto');
const { AppError } = require('../config/errors');

/** Synchronizer-token CSRF: token lives in the session, forms echo it back in `_csrf`. */
function csrfToken(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  next();
}

function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.session.csrf || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new AppError(403, 'CSRF_INVALID', 'Invalid or missing CSRF token'));
  }
  return next();
}

module.exports = { csrfToken, csrfProtect };
