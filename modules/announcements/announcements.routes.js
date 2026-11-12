const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const announcements = require('./announcements.service');

const router = express.Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const list = await announcements.listForUser({
    departmentId: req.session.user.departmentId || null,
    role: req.session.user.role
  });
  res.render('announcements/index', { announcements: list, title: 'Announcements' });
}));

router.post('/', requireRole('CONTROLLER', 'FACULTY', 'ADMIN', 'SUBJECT_HEAD'),
  [body('title').trim().isLength({ min: 3, max: 200 }), body('body').trim().isLength({ min: 3, max: 5000 })],
  asyncHandler(async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      setFlash(req, 'danger', validationResult(req).array()[0].msg);
      return res.redirect('/announcements');
    }
    try {
      await announcements.create({
        title: req.body.title, body: req.body.body,
        audienceRole: req.body.audienceRole || null,
        departmentId: req.body.departmentId ? Number(req.body.departmentId) : req.session.user.departmentId
      }, req.session.user.id, req.ip);
      setFlash(req, 'success', 'Announcement posted.');
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      setFlash(req, 'danger', e.message);
    }
    res.redirect('/announcements');
  }));

module.exports = router;
