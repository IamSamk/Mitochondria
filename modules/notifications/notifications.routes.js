const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const notifications = require('./notifications.service');

const router = express.Router();
router.use(requireAuth);

router.get('/count', asyncHandler(async (req, res) => {
  res.json({ success: true, data: { count: await notifications.unreadCount(req.session.user.id) } });
}));

router.post('/:id/read', asyncHandler(async (req, res) => {
  await notifications.markRead(req.params.id, req.session.user.id);
  res.redirect(req.get('referer') || '/dashboard');
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  await notifications.markAllRead(req.session.user.id);
  setFlash(req, 'success', 'All notifications marked as read.');
  res.redirect(req.get('referer') || '/dashboard');
}));

module.exports = router;
