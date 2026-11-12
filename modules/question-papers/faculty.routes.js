const fs = require('fs');
const path = require('path');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { NotFoundError } = require('../../config/errors');
const academics = require('../academics/academics.service');
const papers = require('./question-papers.service');
const collab = require('../paper-collab/paper-collab.service');

const router = express.Router();
router.use(requireAuth, requireRole('FACULTY'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

async function renderNewPaper(req, res, { errors = [], form = {}, status = 200 } = {}) {
  const exams = await papers.listExamsForFaculty(req.session.user.id);
  res.status(status).render('faculty/paper-form', {
    exams, errors, form, setCodes: papers.SET_CODES, title: 'New question paper'
  });
}

router.get('/', asyncHandler(async (req, res) => {
  const [list, exams] = await Promise.all([
    papers.listPapersForFaculty(req.session.user.id),
    papers.listExamsForFaculty(req.session.user.id)
  ]);
  res.render('faculty/papers', {
    papers: list, exams, filters: req.query, title: 'Question Papers'
  });
}));

router.get('/new', asyncHandler((req, res) => renderNewPaper(req, res, { form: req.query })));

router.post('/new', [
  body('examId').isInt({ min: 1 }).withMessage('Select an examination'),
  body('setCode').trim().isLength({ min: 1, max: 1 }).withMessage('Select a set code')
    .matches(/^[A-Za-z]$/).withMessage('Set code must be a single letter A-Z')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    return renderNewPaper(req, res, { errors: errorsOf(req), form: req.body, status: 422 });
  }
  try {
    const { paper, version } = await papers.createPaper({
      examId: Number(req.body.examId),
      setCode: req.body.setCode
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', `Set ${paper.set_code} created. Add questions to the paper.`);
    return res.redirect(`/faculty/papers/versions/${version.id}/builder`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    return renderNewPaper(req, res, { errors: [e.message], form: req.body, status: 422 });
  }
}));

router.get('/versions/:versionId/builder', asyncHandler(async (req, res) => {
  const builder = await papers.getBuilder(req.params.versionId, req.session.user.id);
  res.render('faculty/paper-builder', {
    ...builder, title: `Build set ${builder.version.set_code}`
  });
}));

router.post('/versions/:versionId/questions', [
  body('questionId').isInt({ min: 1 }).withMessage('Select a question'),
  body('sectionTitle').optional({ values: 'falsy' }).trim().isLength({ max: 80 })
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(`/faculty/papers/versions/${req.params.versionId}/builder`);
  }
  try {
    await papers.addQuestion(req.params.versionId, {
      questionId: Number(req.body.questionId),
      sectionTitle: req.body.sectionTitle
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Question added to the paper.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/papers/versions/${req.params.versionId}/builder`);
}));

router.post('/versions/:versionId/questions/:paperQuestionId/delete', asyncHandler(async (req, res) => {
  try {
    await papers.removeQuestion(req.params.versionId, req.params.paperQuestionId,
      req.session.user.id, req.ip);
    setFlash(req, 'success', 'Question removed from the paper.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/papers/versions/${req.params.versionId}/builder`);
}));

router.post('/versions/:versionId/submit', asyncHandler(async (req, res) => {
  try {
    const version = await papers.submitVersion(req.params.versionId, req.session.user.id, req.ip);
    setFlash(req, 'success', `Version ${version.version_no} submitted for review with a generated PDF.`);
    return res.redirect(`/faculty/papers/${version.paper_id}`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
    return res.redirect(`/faculty/papers/versions/${req.params.versionId}/builder`);
  }
}));

router.post('/versions/:versionId/save', asyncHandler(async (req, res) => {
  try {
    const version = await papers.saveDraft(req.params.versionId, req.session.user.id, req.ip);
    setFlash(req, 'success', `Draft saved at ${new Date(version.draft_saved_at).toISOString().slice(11, 16)} UTC. You can keep editing and save again.`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/papers/versions/${req.params.versionId}/builder`);
}));

router.post('/versions/:versionId/finalize', asyncHandler(async (req, res) => {
  try {
    const version = await papers.finalizeVersion(req.params.versionId, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Paper finalized. The controller can now release it for printing.');
    return res.redirect(`/faculty/papers/${version.paper_id}`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
    return res.redirect(`/faculty/papers/${req.body.paperId || ''}`);
  }
}));

router.get('/versions/:versionId/download', asyncHandler(async (req, res) => {
  const { detail, absPath } = await collab.requestDownload(
    req.params.versionId, req.session.user, { password: req.query.password || '' }, req.ip);
  if (!fs.existsSync(absPath)) throw new NotFoundError('The paper PDF could not be generated');
  res.download(absPath, `paper-${detail.set_code}-v${detail.version_no}.pdf`);
}));

router.get('/:paperId', asyncHandler(async (req, res) => {
  const detail = await papers.getPaperDetail(req.params.paperId);
  await academics.assertFacultyAssigned(req.session.user.id, detail.paper.course_id);
  const [comments, access] = await Promise.all([
    collab.listComments(req.params.paperId),
    collab.accessSummary(req.params.paperId)
  ]);
  const latest = detail.latest;
  res.render('faculty/paper-detail', {
    ...detail,
    ...access,
    comments,
    canEdit: latest && latest.status === 'DRAFT',
    canRevise: latest && latest.status === 'REJECTED',
    canFinalize: latest && latest.status === 'APPROVED' && !latest.is_finalized,
    title: `Set ${detail.paper.set_code} — ${detail.paper.exam_name}`
  });
}));

router.post('/:paperId/revisions', asyncHandler(async (req, res) => {
  try {
    const version = await papers.createRevision(req.params.paperId, req.session.user.id, req.ip);
    setFlash(req, 'success', `Version ${version.version_no} started from the rejected version.`);
    return res.redirect(`/faculty/papers/versions/${version.id}/builder`);
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
    return res.redirect(`/faculty/papers/${req.params.paperId}`);
  }
}));

module.exports = router;
