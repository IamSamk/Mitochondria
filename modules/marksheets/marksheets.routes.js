const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { csrfProtect } = require('../../middleware/csrf.middleware');
const marksheets = require('./marksheets.service');

const router = express.Router();
router.use(requireAuth, requireRole('FACULTY'));

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
}).single('file');

function receiveCsv(req, res, next) {
  csvUpload(req, res, (err) => {
    if (!err) return next();
    setFlash(req, 'danger', err.code === 'LIMIT_FILE_SIZE'
      ? 'That CSV is larger than the 2 MB limit.'
      : 'CSV upload failed.');
    return res.redirect(`/faculty/marksheets/${req.params.examId}`);
  });
}

function entriesFrom(req, students) {
  return students.filter((s) => s.is_active).map((s) => ({
    studentId: s.id,
    marks: req.body[`mark_${s.id}`]
  }));
}

router.get('/', asyncHandler(async (req, res) => {
  const sheets = await marksheets.listExamsForFaculty(req.session.user.id);
  res.render('faculty/marksheets', { sheets, title: 'Student Marksheets' });
}));

router.get('/:examId', asyncHandler(async (req, res, next) => {
  try {
    const sheet = await marksheets.getSheet(req.params.examId, { facultyId: req.session.user.id });
    res.render('faculty/marksheet', { ...sheet, title: `${sheet.exam.name} — marksheet` });
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
    return res.redirect('/faculty/marksheets');
  }
}));

router.post('/:examId', asyncHandler(async (req, res, next) => {
  try {
    const sheet = await marksheets.getSheet(req.params.examId, { facultyId: req.session.user.id });
    const result = await marksheets.saveMarks(
      req.params.examId, entriesFrom(req, sheet.students), req.session.user, req.ip);
    setFlash(req, 'success',
      `Marksheet saved: ${result.saved} mark(s) stored${result.cleared ? `, ${result.cleared} cleared` : ''}. You can edit these again any time.`);
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/marksheets/${req.params.examId}`);
}));

router.post('/:examId/import', receiveCsv, csrfProtect, asyncHandler(async (req, res, next) => {
  try {
    const fileText = req.file ? req.file.buffer.toString('utf8') : '';
    const csvText = fileText || req.body.csv || '';
    const result = await marksheets.importMarks(req.params.examId, csvText, req.session.user, req.ip);
    const suffix = result.errors.length ? ` ${result.errors.length} row(s) skipped: ${result.errors.slice(0, 3).join('; ')}` : '';
    setFlash(req, result.errors.length ? 'warning' : 'success',
      `Imported ${result.saved} mark(s).${suffix}`);
  } catch (e) {
    if (!e.status || e.status >= 500) return next(e);
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/faculty/marksheets/${req.params.examId}`);
}));

module.exports = router;
