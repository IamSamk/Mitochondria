const fs = require('fs');
const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { NotFoundError, ValidationError } = require('../../config/errors');
const papers = require('../question-papers/question-papers.service');
const collab = require('../paper-collab/paper-collab.service');

const router = express.Router();
router.use(requireAuth, requireRole('PRINTING'));

router.get('/', asyncHandler(async (req, res) => {
  const released = await papers.listReleased();
  res.render('printing/papers', { released, title: 'Released Papers' });
}));

router.get('/:versionId/download', asyncHandler(async (req, res) => {
  const version = await papers.getVersionDetail(req.params.versionId);
  if (version.status !== 'RELEASED_FOR_PRINTING') {
    throw new ValidationError('Only papers released for printing can be downloaded');
  }
  const { detail, absPath } = await collab.requestDownload(
    req.params.versionId, req.session.user, { password: req.query.password || '' }, req.ip);
  if (!fs.existsSync(absPath)) throw new NotFoundError('The paper PDF could not be generated');
  res.download(absPath, `paper-${detail.set_code}-v${detail.version_no}.pdf`);
}));

module.exports = router;
