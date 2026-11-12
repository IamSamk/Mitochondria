const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { query } = require('../../config/database');
const academics = require('./academics.service');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

async function renderPage(req, res, status = 200) {
  const [departments, courses, assignments, faculty] = await Promise.all([
    academics.listDepartments({ includeInactive: true }),
    academics.listCourses({ includeInactive: true }),
    academics.listAssignments(),
    query(`SELECT u.id, u.full_name, u.email FROM users u JOIN roles r ON r.id=u.role_id
            WHERE r.code='FACULTY' AND u.is_active ORDER BY u.full_name`).then((r) => r.rows)
  ]);
  return res.status(status).render('admin/academics', {
    departments, courses, assignments, faculty, errors: [], form: {}, title: 'Departments & Courses'
  });
}

router.get('/', asyncHandler((req, res) => renderPage(req, res)));

router.post('/departments', [
  body('code').trim().isLength({ min: 2, max: 16 }).withMessage('Department code must be 2-16 characters'),
  body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Department name is required')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect('/admin/academics');
  }
  try {
    await academics.createDepartment(req.body, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Department created.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/academics');
}));

router.post('/departments/:id', [
  body('code').trim().isLength({ min: 2, max: 16 }),
  body('name').trim().isLength({ min: 2, max: 120 })
], asyncHandler(async (req, res) => {
  try {
    await academics.updateDepartment(req.params.id, {
      code: req.body.code, name: req.body.name,
      isActive: req.body.isActive === 'true' || req.body.isActive === 'on'
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Department updated.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/academics');
}));

router.post('/courses', [
  body('departmentId').isInt({ min: 1 }).withMessage('Select a department'),
  body('code').trim().isLength({ min: 2, max: 16 }).withMessage('Course code must be 2-16 characters'),
  body('title').trim().isLength({ min: 2, max: 160 }).withMessage('Course title is required'),
  body('credits').optional({ values: 'falsy' }).isInt({ min: 1, max: 12 })
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', errorsOf(req)[0]);
    return res.redirect('/admin/academics');
  }
  try {
    await academics.createCourse({
      departmentId: Number(req.body.departmentId),
      code: req.body.code,
      title: req.body.title,
      credits: req.body.credits ? Number(req.body.credits) : null
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Course created.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/academics');
}));

router.post('/courses/:id', [
  body('departmentId').isInt({ min: 1 }),
  body('code').trim().isLength({ min: 2, max: 16 }),
  body('title').trim().isLength({ min: 2, max: 160 })
], asyncHandler(async (req, res) => {
  try {
    await academics.updateCourse(req.params.id, {
      departmentId: Number(req.body.departmentId),
      code: req.body.code,
      title: req.body.title,
      credits: req.body.credits ? Number(req.body.credits) : null,
      isActive: req.body.isActive === 'true' || req.body.isActive === 'on'
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Course updated.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/academics');
}));

router.post('/assignments', [
  body('facultyId').isInt({ min: 1 }).withMessage('Select a faculty member'),
  body('courseId').isInt({ min: 1 }).withMessage('Select a course')
], asyncHandler(async (req, res) => {
  try {
    await academics.assignFaculty(Number(req.body.facultyId), Number(req.body.courseId), req.session.user.id, req.ip);
    setFlash(req, 'success', 'Faculty assigned to course.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/academics');
}));

router.post('/assignments/:id/delete', asyncHandler(async (req, res) => {
  try {
    await academics.removeAssignment(req.params.id, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Assignment removed.');
  } catch (e) {
    if (e.status !== 404) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/academics');
}));

module.exports = router;
