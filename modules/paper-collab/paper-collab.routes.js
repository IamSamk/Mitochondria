const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const papers = require('../question-papers/question-papers.service');
const collab = require('./paper-collab.service');

const router = express.Router();
router.use(requireAuth);

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

function returnTo(req, fallback) {
  const candidate = (req.body && req.body.returnTo) || req.get('referer') || '';
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  return fallback;
}

function fallbackFor(req, paperId) {
  const role = req.session.user.role;
  if (role === 'FACULTY') return `/faculty/papers/${paperId}`;
  if (role === 'SUBJECT_HEAD' || role === 'DEPARTMENT_HEAD') return `/head/papers/${paperId}`;
  if (role === 'REVIEWER') return `/reviewer/papers/${paperId}`;
  return '/dashboard';
}

async function renderPasswordPrompt(req, res, { status = 401, error = null } = {}) {
  const version = await papers.getVersionDetail(req.params.versionId);
  res.status(status).render('paper-collab/password', {
    version, error, maxUploadMb: null,
    title: `Password required — set ${version.set_code}`
  });
}

async function handleDownload(req, res) {
  const password = (req.body && req.body.password) || req.query.password || '';
  try {
    const { detail, absPath } = await collab.requestDownload(
      req.params.versionId, req.session.user, { password }, req.ip);
    res.download(absPath, `paper-${detail.set_code}-v${detail.version_no}.pdf`);
  } catch (e) {
    if (e.code === 'PASSWORD_REQUIRED') {
      return renderPasswordPrompt(req, res, { status: 401 });
    }
    if (e.code === 'FORBIDDEN') {
      const version = await papers.getVersionDetail(req.params.versionId);
      if (version.download_password_hash) {
        return renderPasswordPrompt(req, res, { status: 403, error: e.message });
      }
    }
    throw e;
  }
}

router.get('/versions/:versionId/download', asyncHandler(handleDownload));
router.post('/versions/:versionId/download', asyncHandler(handleDownload));

router.post('/:paperId/comments', [
  body('body').trim().isLength({ min: 1, max: 5000 }).withMessage('Write a comment before posting')
], asyncHandler(async (req, res, next) => {
  const paperId = Number(req.params.paperId);
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect(returnTo(req, fallbackFor(req, paperId)));
  }
  try {
    await collab.addComment({
      paperId,
      versionId: req.body.versionId ? Number(req.body.versionId) : null,
      paperQuestionId: req.body.paperQuestionId ? Number(req.body.paperQuestionId) : null,
      body: req.body.body
    }, req.session.user, req.ip);
    setFlash(req, 'success', 'Comment posted.');
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
  }
  res.redirect(returnTo(req, fallbackFor(req, paperId)));
}));

router.post('/:paperId/password', asyncHandler(async (req, res, next) => {
  const paperId = Number(req.params.paperId);
  try {
    await collab.setDownloadPassword(paperId, req.session.user, req.body.password, req.ip);
    setFlash(req, 'success', (req.body.password || '').trim()
      ? 'Download password updated. Other users must now supply it to download this paper.'
      : 'Download password removed. Paper access is back to role-based only.');
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
  }
  res.redirect(returnTo(req, fallbackFor(req, paperId)));
}));

router.post('/:paperId/lock/clear', asyncHandler(async (req, res, next) => {
  const paperId = Number(req.params.paperId);
  try {
    await collab.clearLock(paperId, req.session.user, req.ip);
    setFlash(req, 'success', 'Download freeze cleared. Review the recorded attempts before re-enabling access.');
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
  }
  res.redirect(returnTo(req, fallbackFor(req, paperId)));
}));

module.exports = router;
