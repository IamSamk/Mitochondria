const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const templates = require('./seating-templates.service');
const logistics = require('../logistics/logistics.service');

const router = express.Router();
router.use(requireAuth, requireRole('FACULTY'));

router.get('/templates', asyncHandler(async (req, res) => {
  const list = await templates.listTemplates(req.session.user.id);
  res.render('faculty/seating-templates', { templates: list, title: 'Seating Templates' });
}));

router.post('/templates', asyncHandler(async (req, res) => {
  try {
    await templates.createTemplate({
      name: req.body.name, rows: req.body.rows, cols: req.body.cols
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Template created.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/faculty/seating-templates/templates');
}));

router.post('/templates/:id/delete', asyncHandler(async (req, res) => {
  try {
    await templates.deleteTemplate(req.params.id, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Template deleted.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/faculty/seating-templates/templates');
}));

router.get('/plans/:examId', asyncHandler(async (req, res, next) => {
  try {
    const plan = await logistics.getPlan(req.params.examId, { facultyId: req.session.user.id });
    const instances = await templates.listRoomInstances(req.params.examId);
    const tmplList = await templates.listTemplates(req.session.user.id);
    res.render('faculty/seating-template-plan', {
      ...plan, instances, templates: tmplList, title: `${plan.exam.name} — template seating`
    });
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
    res.redirect('/faculty/logistics');
  }
}));

router.post('/plans/:examId/rooms', asyncHandler(async (req, res) => {
  try {
    await templates.addRoomInstance(req.params.examId, req.body.templateId, req.body.roomNumber,
      req.session.user.id, req.ip);
    setFlash(req, 'success', 'Room instance added.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/seating-templates/plans/${req.params.examId}`);
}));

router.post('/plans/:examId/generate', asyncHandler(async (req, res) => {
  try {
    const result = await templates.generateFromTemplates(req.params.examId, req.session.user.id, req.ip);
    setFlash(req, 'success', `Placed ${result.placed} students across ${result.rooms} room(s). ${result.unplaced} unplaced.`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/seating-templates/plans/${req.params.examId}`);
}));

module.exports = router;
