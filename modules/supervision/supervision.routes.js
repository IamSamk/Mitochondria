const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const papers = require('../question-papers/question-papers.service');
const supervision = require('./supervision.service');

const router = express.Router();
router.use(requireAuth, requireRole('SUBJECT_HEAD', 'DEPARTMENT_HEAD'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);
const VETOABLE = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'];

router.get('/papers', asyncHandler(async (req, res) => {
  const departmentId = await supervision.userDepartmentId(req.session.user.id);
  const list = await papers.listForHead(departmentId);
  res.render('supervision/papers', { papers: list, title: 'Department Papers' });
}));

router.get('/papers/:paperId', asyncHandler(async (req, res, next) => {
  try {
    const departmentId = await supervision.userDepartmentId(req.session.user.id);
    const detail = await supervision.paperDetail(req.params.paperId, departmentId);
    const latest = detail.latest;
    const own = latest && Number(detail.paper.created_by) === Number(req.session.user.id);
    const isSubjectHead = req.session.user.role === 'SUBJECT_HEAD';
    res.render('supervision/paper-detail', {
      ...detail,
      isSubjectHead,
      canApprove: Boolean(isSubjectHead && latest && latest.status === 'SUBMITTED' && !own),
      canVeto: Boolean(isSubjectHead && latest && VETOABLE.includes(latest.status) && !own),
      title: `Set ${detail.paper.set_code} — ${detail.paper.exam_name}`
    });
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
    return res.redirect('/head/papers');
  }
}));

router.post('/papers/:versionId/head-review', [
  body('decision').isIn(['APPROVED', 'VETOED']).withMessage('Choose approve or veto'),
  body('comments').optional({ values: 'falsy' }).trim().isLength({ max: 5000 })
], asyncHandler(async (req, res, next) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(req.get('referer') || '/head/papers');
  }
  try {
    const version = await papers.headReviewVersion(
      req.params.versionId, req.session.user.id, req.body.decision, req.body.comments, req.ip);
    setFlash(req, 'success', req.body.decision === 'APPROVED'
      ? 'Head approval recorded. The paper is now in the reviewer queue.'
      : 'Veto recorded. The paper is back with the subject teacher for revision.');
    return res.redirect(`/head/papers/${version.paper_id}`);
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
    return res.redirect(req.get('referer') || '/head/papers');
  }
}));

router.get('/marksheets', asyncHandler(async (req, res) => {
  const departmentId = await supervision.userDepartmentId(req.session.user.id);
  const sheets = await supervision.listMarksheets(departmentId);
  res.render('supervision/marksheets', { sheets, title: 'Department Marksheets' });
}));

router.get('/marksheets/:examId', asyncHandler(async (req, res, next) => {
  try {
    const departmentId = await supervision.userDepartmentId(req.session.user.id);
    const sheet = await supervision.getMarksheet(req.params.examId, departmentId);
    res.render('supervision/marksheet', { ...sheet, title: `${sheet.exam.name} — marksheet` });
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
    return res.redirect('/head/marksheets');
  }
}));

router.get('/logistics', asyncHandler(async (req, res) => {
  const departmentId = await supervision.userDepartmentId(req.session.user.id);
  const exams = await supervision.listLogistics(departmentId);
  res.render('supervision/logistics', { exams, title: 'Department Logistics' });
}));

router.get('/logistics/:examId', asyncHandler(async (req, res, next) => {
  try {
    const departmentId = await supervision.userDepartmentId(req.session.user.id);
    const plan = await supervision.getLogistics(req.params.examId, departmentId);
    res.render('supervision/logistics-plan', { ...plan, title: `${plan.exam.name} — logistics` });
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
    return res.redirect('/head/logistics');
  }
}));

module.exports = router;
