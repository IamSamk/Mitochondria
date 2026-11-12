const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { ValidationError } = require('../../config/errors');
const logistics = require('./logistics.service');

const router = express.Router();
router.use(requireAuth, requireRole('FACULTY'));

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError('Enter a valid date and time');
  return date.toISOString();
}

router.get('/', asyncHandler(async (req, res) => {
  const exams = await logistics.listExamsForFaculty(req.session.user.id);
  res.render('faculty/logistics', { exams, title: 'Seating & Invigilation' });
}));

router.get('/:examId', asyncHandler(async (req, res, next) => {
  try {
    const plan = await logistics.getPlan(req.params.examId, { facultyId: req.session.user.id });
    res.render('faculty/logistics-plan', { ...plan, title: `${plan.exam.name} — logistics` });
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
    return res.redirect('/faculty/logistics');
  }
}));

router.post('/:examId/seating/generate', asyncHandler(async (req, res) => {
  try {
    const result = await logistics.generateSeating(req.params.examId, {
      roomName: req.body.roomName,
      capacity: req.body.capacity
    }, req.session.user, req.ip);
    setFlash(req, 'success', `Generated ${result.students} seats across ${result.rooms} room(s). Edit any row below.`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/logistics/${req.params.examId}`);
}));

router.post('/:examId/seating/:id', asyncHandler(async (req, res) => {
  try {
    await logistics.updateSeating(req.params.examId, req.params.id, {
      roomName: req.body.roomName, seatNo: req.body.seatNo
    }, req.session.user, req.ip);
    setFlash(req, 'success', 'Seat updated.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/logistics/${req.params.examId}`);
}));

router.post('/:examId/seating/:id/delete', asyncHandler(async (req, res) => {
  try {
    await logistics.deleteSeating(req.params.examId, req.params.id, req.session.user, req.ip);
    setFlash(req, 'success', 'Seat removed.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/logistics/${req.params.examId}`);
}));

router.post('/:examId/invigilation/generate', asyncHandler(async (req, res) => {
  try {
    const result = await logistics.generateInvigilation(req.params.examId, req.session.user, req.ip);
    setFlash(req, 'success', `Assigned ${result.assignments} invigilator slot(s) across ${result.rooms} room(s). Edit any row below.`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/logistics/${req.params.examId}`);
}));

router.post('/:examId/invigilation/:id', asyncHandler(async (req, res) => {
  try {
    await logistics.updateInvigilation(req.params.examId, req.params.id, {
      roomName: req.body.roomName,
      invigilatorId: req.body.invigilatorId,
      startsAt: isoOrNull(req.body.startsAt),
      endsAt: isoOrNull(req.body.endsAt)
    }, req.session.user, req.ip);
    setFlash(req, 'success', 'Invigilation updated.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/logistics/${req.params.examId}`);
}));

router.post('/:examId/invigilation/:id/delete', asyncHandler(async (req, res) => {
  try {
    await logistics.deleteInvigilation(req.params.examId, req.params.id, req.session.user, req.ip);
    setFlash(req, 'success', 'Invigilation slot removed.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/logistics/${req.params.examId}`);
}));

module.exports = router;
