const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const portal = require('./student-portal.service');
const notifications = require('../notifications/notifications.service');

const router = express.Router();
router.use(requireAuth, requireRole('STUDENT'));

router.get('/dashboard', asyncHandler(async (req, res) => {
  const { student, exams } = await portal.upcomingExams(req.session.user.id);
  const notes = await portal.notifications(req.session.user.id, 8);
  const { results } = await portal.results(req.session.user.id);
  res.render('student/dashboard', {
    student, exams: exams.slice(0, 6), results: results.slice(0, 6),
    notifications: notes, title: 'Student Dashboard'
  });
}));

router.get('/exams', asyncHandler(async (req, res) => {
  const { student, exams } = await portal.upcomingExams(req.session.user.id);
  res.render('student/exams', { student, exams, title: 'My Exams' });
}));

router.get('/results', asyncHandler(async (req, res) => {
  const { student, results } = await portal.results(req.session.user.id);
  res.render('student/results', { student, results, title: 'My Results' });
}));

router.get('/seat', asyncHandler(async (req, res) => {
  const { student, seats } = await portal.seats(req.session.user.id);
  res.render('student/seat', { student, seats, title: 'My Seat' });
}));

router.get('/revaluation', asyncHandler(async (req, res) => {
  const { student } = await portal.upcomingExams(req.session.user.id);
  res.render('student/revaluation', { student, title: 'Revaluation' });
}));

router.get('/notifications', asyncHandler(async (req, res) => {
  const notes = await portal.notifications(req.session.user.id, 50);
  res.render('student/notifications', { notifications: notes, title: 'Notifications' });
}));

router.post('/notifications/:id/read', asyncHandler(async (req, res) => {
  await notifications.markRead(req.params.id, req.session.user.id);
  res.redirect('/student/notifications');
}));

module.exports = router;
