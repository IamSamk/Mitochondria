const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const users = require('../users/users.service');

const router = express.Router();
router.use(requireAuth);

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

router.get('/', asyncHandler(async (req, res) => {
  const profile = await users.selfProfile(req.session.user.id);
  res.render('account/profile', { profile, title: 'My account' });
}));

router.post('/profile', [
  body('fullName').trim().isLength({ min: 2, max: 120 }).withMessage('Full name must be 2-120 characters')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect('/account');
  }
  try {
    const updated = await users.updateOwnProfile(
      req.session.user.id, { fullName: req.body.fullName }, req.session.user.id, req.ip);
    req.session.user.fullName = updated.full_name;
    setFlash(req, 'success', 'Your display name was updated.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/account');
}));

router.post('/password', [
  body('currentPassword').isString().isLength({ min: 1, max: 200 })
    .withMessage('Enter your current password'),
  body('newPassword').isLength({ min: 8, max: 200 })
    .withMessage('New password must be at least 8 characters'),
  body('confirmPassword').custom((value, { req }) => value === req.body.newPassword)
    .withMessage('New password and confirmation do not match')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect('/account');
  }
  try {
    await users.changePassword(req.session.user.id, {
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword
    }, req.sessionID, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Password changed. Other sessions were signed out.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/account');
}));

module.exports = router;
