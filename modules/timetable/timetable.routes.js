const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const timetable = require('./timetable.service');

const router = express.Router();
router.use(requireAuth, requireRole('CONTROLLER','FACULTY','ADMIN'));

router.get('/', asyncHandler(async (req, res) => {
  const { query } = require('../../config/database');
  const exams = (await query('SELECT id, name, exam_date FROM examinations ORDER BY exam_date DESC, id DESC LIMIT 200')).rows;
  res.render('timetable/index', { exams, title: 'Exam Timetable' });
}));

router.post('/solve', asyncHandler(async (req, res) => {
  const ids = String(req.body.examIds || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (!ids.length) { setFlash(req, 'danger', 'Provide exam IDs.'); return res.redirect('/timetable'); }
  try {
    const result = await timetable.solveForExams(ids);
    res.render('timetable/result', { ...result, title: 'Timetable Solution' });
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
    res.redirect('/timetable');
  }
}));

router.get('/slots/:examId', asyncHandler(async (req, res) => {
  const slots = await timetable.listSlots(req.params.examId);
  res.render('timetable/slots', { examId: req.params.examId, slots, title: 'Exam Slots' });
}));

router.post('/slots', [
  body('examId').isInt({min:1}), body('slotStart').isISO8601(), body('slotEnd').isISO8601()
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) { setFlash(req, 'danger', validationResult(req).array()[0].msg); return res.redirect('/timetable'); }
  try {
    await timetable.createSlot({ examId: Number(req.body.examId), slotStart: new Date(req.body.slotStart).toISOString(), slotEnd: new Date(req.body.slotEnd).toISOString(), venue: req.body.venue }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Slot created.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/timetable/slots/${req.body.examId}`);
}));

module.exports = router;
