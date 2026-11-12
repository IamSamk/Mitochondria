const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const academics = require('../academics/academics.service');
const students = require('./students.service');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

const validators = [
  body('studentCode').trim().isLength({ min: 2, max: 20 })
    .withMessage('Student code must be 2-20 characters')
    .matches(/^[A-Za-z0-9-]+$/).withMessage('Student code may only contain letters, numbers and hyphens'),
  body('fullName').trim().isLength({ min: 2, max: 120 }).withMessage('Full name must be 2-120 characters'),
  body('departmentId').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid department')
];

async function departments() {
  return academics.listDepartments({ includeInactive: true });
}

router.get('/', asyncHandler(async (req, res) => {
  const list = await students.listStudents({
    q: (req.query.q || '').trim(),
    departmentId: req.query.departmentId || '',
    active: req.query.active || ''
  });
  res.render('admin/students', {
    students: list,
    departments: await departments(),
    filters: req.query,
    title: 'Students'
  });
}));

router.get('/new', asyncHandler(async (req, res) => {
  res.render('admin/student-form', {
    mode: 'create', student: null, form: {}, errors: [],
    departments: await departments(), title: 'Add student'
  });
}));

router.post('/', validators, asyncHandler(async (req, res) => {
  const render = async (errs, status = 422) => res.status(status).render('admin/student-form', {
    mode: 'create', student: null, form: req.body, errors: errs,
    departments: await departments(), title: 'Add student'
  });
  if (!validationResult(req).isEmpty()) return render(errorsOf(req));
  try {
    await students.createStudent({
      studentCode: req.body.studentCode,
      fullName: req.body.fullName,
      departmentId: req.body.departmentId ? Number(req.body.departmentId) : null
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Student added to the registry.');
    return res.redirect('/admin/students');
  } catch (e) {
    if (e.status === 422) return render([e.message]);
    throw e;
  }
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const student = await students.getStudent(req.params.id);
  res.render('admin/student-form', {
    mode: 'edit',
    student,
    form: {
      studentCode: student.student_code,
      fullName: student.full_name,
      departmentId: student.department_id,
      isActive: student.is_active
    },
    errors: [],
    departments: await departments(),
    title: 'Edit student'
  });
}));

router.post('/:id', validators, asyncHandler(async (req, res) => {
  const student = await students.getStudent(req.params.id);
  const render = async (errs) => res.status(422).render('admin/student-form', {
    mode: 'edit', student, form: req.body, errors: errs,
    departments: await departments(), title: 'Edit student'
  });
  if (!validationResult(req).isEmpty()) return render(errorsOf(req));
  try {
    await students.updateStudent(req.params.id, {
      studentCode: req.body.studentCode,
      fullName: req.body.fullName,
      departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
      isActive: req.body.isActive === 'true' || req.body.isActive === 'on'
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Student record updated.');
    return res.redirect('/admin/students');
  } catch (e) {
    if (e.status === 422) return render([e.message]);
    throw e;
  }
}));

router.post('/:id/toggle', asyncHandler(async (req, res) => {
  try {
    const student = await students.getStudent(req.params.id);
    const updated = await students.setActive(
      student.id, !student.is_active, req.session.user.id, req.ip);
    setFlash(req, 'success', updated.is_active ? 'Student reactivated.' : 'Student deactivated.');
  } catch (e) {
    if (e.status !== 404) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/students');
}));

module.exports = router;
