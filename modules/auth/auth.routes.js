const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('./auth.service');
const { logAudit } = require('../audit/audit.service');
const { requireAuth } = require('../../middleware/auth.middleware');

const router = express.Router();

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX = process.env.NODE_ENV === 'test' ? 1000 : 10;

const loginLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
  limit: LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('auth/login', { error: 'Too many login attempts. Try again later.' })
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login', { error: null });
});

router.post('/login', loginLimiter,
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
  body('password').isString().isLength({ min: 1, max: 200 }),
  async (req, res, next) => {
    try {
      if (!validationResult(req).isEmpty()) return res.status(422).render('auth/login', { error: 'Enter a valid email and password.' });
      const user = await authenticate(req.body.email, req.body.password, req.ip);
      if (!user) return res.status(401).render('auth/login', { error: 'Invalid email or password.' });
      // Regenerate to prevent session fixation.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = user;
        req.session.save((e) => (e ? next(e) : res.redirect('/dashboard')));
      });
    } catch (e) { next(e); }
  });

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await logAudit({ actorId: req.session.user.id, action: 'LOGOUT', entityType: 'user', entityId: req.session.user.id, ip: req.ip });
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('emp.sid');
      res.redirect('/login');
    });
  } catch (e) { next(e); }
});

module.exports = router;
