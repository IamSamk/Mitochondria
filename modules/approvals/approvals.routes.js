const fs = require('fs');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { NotFoundError, ValidationError } = require('../../config/errors');
const papers = require('../question-papers/question-papers.service');
const collab = require('../paper-collab/paper-collab.service');
const approvals = require('./approvals.service');

const router = express.Router();
router.use(requireAuth, requireRole('REVIEWER'));

const REVIEWABLE = ['UNDER_REVIEW'];
const DOWNLOADABLE = ['SUBMITTED', 'UNDER_REVIEW', 'REJECTED', 'APPROVED', 'RELEASED_FOR_PRINTING'];
const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

router.get('/', asyncHandler(async (req, res) => {
  const [queue, recent] = await Promise.all([
    approvals.listQueue(),
    approvals.recentDecisions(req.session.user.id)
  ]);
  res.render('reviewer/papers', { queue, recent, title: 'Papers to Review' });
}));

router.get('/:versionId', asyncHandler(async (req, res) => {
  const version = await papers.getVersionDetail(req.params.versionId);
  const comments = await collab.listComments(version.paper_id);
  res.render('reviewer/paper-detail', {
    version, comments,
    reviewable: REVIEWABLE.includes(version.status),
    title: `Review set ${version.set_code} v${version.version_no}`
  });
}));

router.post('/:versionId/decision', [
  body('decision').isIn(['APPROVED', 'REJECTED']).withMessage('Choose approve or reject'),
  body('comments').optional({ values: 'falsy' }).trim().isLength({ max: 5000 })
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(`/reviewer/papers/${req.params.versionId}`);
  }
  try {
    await papers.reviewVersion(req.params.versionId, req.session.user.id,
      req.body.decision, req.body.comments, req.ip);
    setFlash(req, 'success',
      req.body.decision === 'APPROVED'
        ? 'Paper approved. The controller can release it for printing.'
        : 'Paper rejected. The faculty member can start a new version.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/reviewer/papers/${req.params.versionId}`);
}));

router.get('/:versionId/download', asyncHandler(async (req, res) => {
  const version = await papers.getVersionDetail(req.params.versionId);
  if (!DOWNLOADABLE.includes(version.status)) {
    throw new ValidationError('This paper is not available for review');
  }
  const { detail, absPath } = await collab.requestDownload(
    req.params.versionId, req.session.user, { password: req.query.password || '' }, req.ip);
  if (!fs.existsSync(absPath)) throw new NotFoundError('The paper PDF could not be generated');
  res.download(absPath, `paper-${detail.set_code}-v${detail.version_no}.pdf`);
}));

module.exports = router;
