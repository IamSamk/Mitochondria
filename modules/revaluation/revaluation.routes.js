const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const revaluation = require('./revaluation.service');
const notifications = require('../notifications/notifications.service');

const router = express.Router();

// Student routes
const studentRouter = express.Router();
studentRouter.use(requireAuth, requireRole('STUDENT'));
studentRouter.get('/', asyncHandler(async (req, res) => {
  const studentId = await revaluation.studentForUser(req.session.user.id);
  const [windows, requests] = await Promise.all([
    revaluation.openWindowsForStudent(studentId),
    revaluation.listRequestsForStudent(studentId)
  ]);
  res.render('revaluation/student', { windows, requests, title: 'Revaluation' });
}));
studentRouter.post('/', [
  body('examId').isInt({ min: 1 }),
  body('reason').trim().isLength({ min: 5, max: 2000 })
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', validationResult(req).array()[0].msg);
    return res.redirect('/student/revaluation');
  }
  try {
    await revaluation.submitRequest(req.session.user.id, {
      examId: Number(req.body.examId), reason: req.body.reason
    }, req.ip);
    setFlash(req, 'success', 'Revaluation request submitted.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/student/revaluation');
}));

// Staff routes (controller/verifier/faculty)
const staffRouter = express.Router();
staffRouter.use(requireAuth, requireRole('CONTROLLER', 'VERIFIER', 'FACULTY', 'SUBJECT_HEAD'));
staffRouter.get('/', asyncHandler(async (req, res) => {
  const requests = await revaluation.listRequestsForReview({
    examId: req.query.examId || '', status: req.query.status || ''
  });
  const { query } = require('../../config/database');
  const exams = (await query('SELECT id, name FROM examinations ORDER BY exam_date DESC, id DESC LIMIT 200')).rows;
  res.render('revaluation/staff', { requests, exams, filters: req.query, title: 'Revaluation Requests' });
}));
staffRouter.post('/:id/review', [
  body('status').isIn(['UNDER_REVIEW','APPROVED','REJECTED','CLOSED']),
  body('newMarks').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 2000 })
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', validationResult(req).array()[0].msg);
    return res.redirect('/revaluation');
  }
  try {
    await revaluation.reviewRequest(req.params.id, req.session.user.id, {
      status: req.body.status,
      newMarks: req.body.newMarks ? Number(req.body.newMarks) : null,
      notes: req.body.notes
    }, req.ip);
    setFlash(req, 'success', 'Request updated.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/revaluation');
}));
staffRouter.post('/windows', [
  body('examId').isInt({ min: 1 }),
  body('opensAt').isISO8601(),
  body('closesAt').isISO8601(),
  body('feeAmount').optional({ values: 'falsy' }).isFloat({ min: 0 })
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', validationResult(req).array()[0].msg);
    return res.redirect('/revaluation');
  }
  try {
    await revaluation.createWindow({
      examId: Number(req.body.examId),
      opensAt: new Date(req.body.opensAt).toISOString(),
      closesAt: new Date(req.body.closesAt).toISOString(),
      feeAmount: req.body.feeAmount ? Number(req.body.feeAmount) : 0
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Revaluation window created.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/revaluation');
}));

router.use('/student/revaluation', studentRouter);
router.use('/revaluation', staffRouter);

module.exports = router;
