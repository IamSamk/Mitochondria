const fs = require('fs');
const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { NotFoundError, ValidationError } = require('../../config/errors');
const papers = require('./question-papers.service');

const router = express.Router();
router.use(requireAuth, requireRole('CONTROLLER'));

router.get('/', asyncHandler(async (req, res) => {
  const [pending, released] = await Promise.all([
    papers.listAllPapers({ examId: req.query.examId || '', status: 'APPROVED' }),
    papers.listReleased()
  ]);
  const filteredReleased = req.query.examId
    ? released.filter((r) => String(r.exam_id) === String(req.query.examId))
    : released;
  res.render('controller/papers', {
    pending, released: filteredReleased, filters: req.query, title: 'Paper Releases'
  });
}));

router.post('/:versionId/release', asyncHandler(async (req, res) => {
  try {
    await papers.releaseVersion(req.params.versionId, req.session.user.id, req.body.note, req.ip);
    setFlash(req, 'success', 'Paper released for printing.');
  } catch (e) {
    if (!e.status || e.status >= 500) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/controller/papers');
}));

router.get('/:versionId/download', asyncHandler(async (req, res) => {
  const version = await papers.getVersionDetail(req.params.versionId);
  if (!['APPROVED', 'RELEASED_FOR_PRINTING'].includes(version.status)) {
    throw new ValidationError('Only approved or released papers can be downloaded');
  }
  const { detail, absPath } = await papers.ensureVersionPdf(req.params.versionId);
  if (!fs.existsSync(absPath)) throw new NotFoundError('The paper PDF could not be generated');
  res.download(absPath, `paper-${detail.set_code}-v${detail.version_no}.pdf`);
}));

module.exports = router;
