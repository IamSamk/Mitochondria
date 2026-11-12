const fs = require('fs');
const path = require('path');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { resolveStoragePath } = require('../../config/upload');
const { NotFoundError } = require('../../config/errors');
const evaluations = require('./evaluations.service');

const router = express.Router();
router.use(requireAuth, requireRole('VERIFIER'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

router.get('/', asyncHandler(async (req, res) => {
  const list = await evaluations.listEvaluations({
    status: req.query.status || '',
    examId: req.query.examId || '',
    q: (req.query.q || '').trim()
  });
  const counts = list.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  res.render('verifier/marks', {
    evaluations: list, counts, filters: req.query,
    title: 'Marks to Verify'
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await evaluations.getEvaluationDetail(req.params.id);
  res.render('evaluations/mark-detail', {
    ...detail, mode: 'verifier', title: `Verify marks for ${detail.evaluation.student_code}`
  });
}));

router.post('/:id/verify', asyncHandler(async (req, res) => {
  try {
    await evaluations.verifyEvaluation(req.params.id, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Marks verified. The controller can now finalize them.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/verifier/marks/${req.params.id}`);
}));

router.post('/:id/reopen', [
  body('reason').trim().isLength({ min: 3, max: 500 }).withMessage('Give a short reason for sending the marks back')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(`/verifier/marks/${req.params.id}`);
  }
  try {
    await evaluations.requestCorrection(req.params.id, req.session.user.id, req.body.reason, req.ip);
    setFlash(req, 'success', 'Marks sent back to the evaluator for correction.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/verifier/marks/${req.params.id}`);
}));

router.get('/:id/script', asyncHandler(async (req, res) => {
  const detail = await evaluations.getEvaluationDetail(req.params.id);
  const abs = resolveStoragePath(detail.evaluation.file_path);
  if (!fs.existsSync(abs)) throw new NotFoundError('The stored script file is missing');
  res.download(abs, path.basename(detail.evaluation.original_name || `script-${detail.evaluation.script_id}.pdf`));
}));

module.exports = router;
