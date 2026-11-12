const fs = require('fs');
const path = require('path');
const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { resolveStoragePath } = require('../../config/upload');
const { NotFoundError } = require('../../config/errors');
const evaluations = require('./evaluations.service');

const router = express.Router();
router.use(requireAuth, requireRole('FACULTY'));

router.get('/', asyncHandler(async (req, res) => {
  const queue = await evaluations.listFacultyQueue(req.session.user.id);
  const counts = queue.reduce((acc, row) => {
    const key = row.evaluation_status || 'NOT_STARTED';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  res.render('faculty/evaluations', {
    queue, counts,
    title: 'My Evaluations'
  });
}));

router.post('/scripts/:scriptId/start', asyncHandler(async (req, res) => {
  try {
    const evaluation = await evaluations.startEvaluation(
      req.params.scriptId, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Evaluation started. Enter marks for each question.');
    return res.redirect(`/faculty/evaluations/${evaluation.id}`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
    return res.redirect('/faculty/evaluations');
  }
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await evaluations.getFacultyEvaluation(req.params.id, req.session.user.id);
  const readOnly = !['DRAFT', 'REOPENED'].includes(detail.evaluation.status);
  res.render('evaluations/evaluation-form', {
    ...detail, readOnly,
    title: `Evaluate ${detail.evaluation.student_code}`
  });
}));

router.post('/:id/draft', asyncHandler(async (req, res) => {
  try {
    await evaluations.saveDraft(req.params.id, req.session.user.id, req.body, req.ip);
    setFlash(req, 'success', 'Draft marks saved.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/evaluations/${req.params.id}`);
}));

router.post('/:id/submit', asyncHandler(async (req, res) => {
  try {
    await evaluations.submitEvaluation(req.params.id, req.session.user.id, req.body, req.ip);
    setFlash(req, 'success', 'Marks submitted for verification.');
    return res.redirect('/faculty/evaluations');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
    return res.redirect(`/faculty/evaluations/${req.params.id}`);
  }
}));

router.get('/:id/script', asyncHandler(async (req, res) => {
  const detail = await evaluations.getFacultyEvaluation(req.params.id, req.session.user.id);
  const abs = resolveStoragePath(detail.evaluation.file_path);
  if (!fs.existsSync(abs)) throw new NotFoundError('The stored script file is missing');
  res.download(abs, path.basename(detail.evaluation.original_name || `script-${detail.evaluation.script_id}.pdf`));
}));

module.exports = router;
