const path = require('path');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { ensureScriptFile } = require('../../config/upload');
const evaluations = require('./evaluations.service');

const router = express.Router();
router.use(requireAuth, requireRole('CONTROLLER'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

router.get('/', asyncHandler(async (req, res) => {
  const filters = {
    status: req.query.status || '',
    examId: req.query.examId || '',
    q: (req.query.q || '').trim()
  };
  const [list, counts, exams] = await Promise.all([
    evaluations.listEvaluations(filters),
    evaluations.countEvaluationsByStatus(filters),
    evaluations.examOptions()
  ]);
  res.render('controller/marks', {
    evaluations: list, counts, exams, filters: req.query,
    title: 'Marks'
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await evaluations.getEvaluationDetail(req.params.id);
  res.render('evaluations/mark-detail', {
    ...detail, mode: 'controller', title: `Marks for ${detail.evaluation.student_code}`
  });
}));

router.post('/:id/finalize', asyncHandler(async (req, res) => {
  try {
    const ev = await evaluations.finalizeEvaluation(req.params.id, req.session.user.id, req.ip);
    // Notify the linked student, if any.
    try {
      const { query } = require('../../config/database');
      const { rows } = await query(
        `SELECT st.user_id, e.name AS exam_name FROM evaluations ev
           JOIN answer_scripts s ON s.id = ev.script_id
           JOIN students st ON st.id = s.student_id
           JOIN examinations e ON e.id = s.exam_id
          WHERE ev.id = $1`, [req.params.id]);
      const r = rows[0];
      if (r && r.user_id) {
        const notifications = require('../notifications/notifications.service');
        await notifications.notify([r.user_id], {
          type: 'RESULT_PUBLISHED',
          title: `Result published: ${r.exam_name}`,
          body: 'Your marks have been finalized. View your result in the student portal.',
          link: '/student/results'
        });
      }
    } catch (e) { /* non-fatal */ }
    setFlash(req, 'success', 'Marks finalized.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/controller/marks/${req.params.id}`);
}));

router.post('/:id/reopen', [
  body('reason').trim().isLength({ min: 3, max: 500 }).withMessage('Give a short reason for reopening the marks')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(`/controller/marks/${req.params.id}`);
  }
  try {
    await evaluations.reopenEvaluation(req.params.id, req.session.user.id, req.body.reason, req.ip);
    setFlash(req, 'success', 'Marks reopened. The evaluator can correct and resubmit them.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/controller/marks/${req.params.id}`);
}));

router.get('/:id/script', asyncHandler(async (req, res) => {
  const detail = await evaluations.getEvaluationDetail(req.params.id);
  const abs = await ensureScriptFile({ id: detail.evaluation.script_id, file_path: detail.evaluation.file_path });
  res.download(abs, path.basename(detail.evaluation.original_name || `script-${detail.evaluation.script_id}.pdf`));
}));

module.exports = router;
