const { ForbiddenError } = require('../config/errors');

/** Deny-by-default: user must hold one of the listed role codes (server-side check). */
function requireRole(...allowed) {
  return (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return next(new ForbiddenError('Login required'));
    if (!allowed.includes(user.role)) return next(new ForbiddenError());
    return next();
  };
}

module.exports = { requireRole };
