const fs = require('fs');
const path = require('path');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { csrfProtect } = require('../../middleware/csrf.middleware');
const { uploadAnswerScript, resolveStoragePath, maxUploadMb } = require('../../config/upload');
const { NotFoundError } = require('../../config/errors');
const scripts = require('./answer-scripts.service');

const router = express.Router();
router.use(requireAuth, requireRole('CONTROLLER'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

async function renderNew(req, res, status = 200) {
  const [exams, students, papers] = await Promise.all([
    scripts.listOpenExams(),
    scripts.listStudents(),
    scripts.listPapersForUpload()
  ]);
  res.status(status).render('controller/script-form', {
    exams, students, papers, form: req.query, errors: [], maxUploadMb, title: 'Upload answer script'
  });
}

function receiveUpload(req, res, next) {
  uploadAnswerScript(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That PDF is larger than the upload limit.'
      : err.message || 'Upload failed';
    setFlash(req, 'danger', message);
    const examId = req.body && req.body.examId ? `?examId=${encodeURIComponent(req.body.examId)}` : '';
    return res.redirect(`/controller/scripts/new${examId}`);
  });
}

router.get('/', asyncHandler(async (req, res) => {
  const list = await scripts.listScripts({
    examId: req.query.examId || '',
    status: req.query.status || '',
    q: (req.query.q || '').trim()
  });
  const exams = await scripts.listOpenExams();
  res.render('controller/scripts', {
    scripts: list, exams, statuses: scripts.STATUSES,
    filters: req.query, title: 'Answer Scripts'
  });
}));

router.get('/new', asyncHandler((req, res) => renderNew(req, res)));

router.post('/', receiveUpload, csrfProtect, [
  body('examId').isInt({ min: 1 }).withMessage('Select an examination'),
  body('studentId').isInt({ min: 1 }).withMessage('Select a student'),
  body('paperId').isInt({ min: 1 }).withMessage('Select the paper set'),
  body('expectedPages').optional({ values: 'falsy' }).isInt({ min: 1, max: 500 })
    .withMessage('Expected pages must be a positive number')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(`/controller/scripts/new?examId=${encodeURIComponent(req.body.examId || '')}`);
  }
  try {
    const script = await scripts.uploadScript({
      examId: Number(req.body.examId),
      studentId: Number(req.body.studentId),
      paperId: Number(req.body.paperId),
      expectedPages: req.body.expectedPages ? Number(req.body.expectedPages) : null
    }, req.file, req.session.user.id, req.ip);
    setFlash(req, 'success', `Script uploaded (${script.page_count} page${script.page_count === 1 ? '' : 's'}).`);
    return res.redirect(`/controller/scripts/${script.id}`);
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
    return res.redirect(`/controller/scripts/new?examId=${encodeURIComponent(req.body.examId || '')}`);
  }
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await scripts.getScriptDetail(req.params.id);
  const faculty = await scripts.listFacultyForCourse(detail.script.course_id);
  res.render('controller/script-detail', {
    ...detail, faculty, statuses: scripts.STATUSES, title: `Script ${detail.script.student_code}`
  });
}));

router.get('/:id/download', asyncHandler(async (req, res) => {
  const script = await scripts.getScript(req.params.id);
  const abs = resolveStoragePath(script.file_path);
  if (!fs.existsSync(abs)) throw new NotFoundError('The stored script file is missing');
  res.download(abs, path.basename(script.original_name || `script-${script.id}.pdf`));
}));

router.post('/:id/verify', asyncHandler(async (req, res) => {
  try {
    await scripts.verifyScript(req.params.id, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Script verified. It can now be allocated to faculty.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/controller/scripts/${req.params.id}`);
}));

router.post('/:id/hold', [
  body('reason').trim().isLength({ min: 3, max: 500 }).withMessage('Give a short reason for the hold')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(`/controller/scripts/${req.params.id}`);
  }
  try {
    await scripts.holdScript(req.params.id, req.body.reason, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Script put on hold.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/controller/scripts/${req.params.id}`);
}));

router.post('/:id/release-hold', asyncHandler(async (req, res) => {
  try {
    await scripts.releaseHold(req.params.id, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Hold released and the script marked verified.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/controller/scripts/${req.params.id}`);
}));

router.post('/:id/allocate', [
  body('facultyId').isInt({ min: 1 }).withMessage('Select a faculty member'),
  body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 500 })
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(`/controller/scripts/${req.params.id}`);
  }
  try {
    await scripts.allocateScript(
      req.params.id, Number(req.body.facultyId), req.body.reason,
      req.session.user.id, req.ip);
    setFlash(req, 'success', 'Script allocated to faculty.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/controller/scripts/${req.params.id}`);
}));

module.exports = router;
