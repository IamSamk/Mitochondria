const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const users = require('./users.service');
const academics = require('../academics/academics.service');

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);

async function formData() {
  const [roles, departments] = await Promise.all([
    users.listRoles(),
    academics.listDepartments({ includeInactive: true })
  ]);
  return { roles, departments };
}

router.get('/', asyncHandler(async (req, res) => {
  const list = await users.listUsers({
    q: (req.query.q || '').trim(),
    role: req.query.role || '',
    active: req.query.active || ''
  });
  const roles = await users.listRoles();
  res.render('admin/users', { users: list, roles, filters: req.query, title: 'Users' });
}));

router.get('/new', asyncHandler(async (req, res) => {
  res.render('admin/user-form', {
    mode: 'create', user: null, form: {}, errors: [], ...(await formData()), title: 'New user'
  });
}));

router.post('/', [
  body('email').isEmail().withMessage('Enter a valid email').normalizeEmail(),
  body('fullName').trim().isLength({ min: 2, max: 120 }).withMessage('Full name must be 2-120 characters'),
  body('roleId').isInt({ min: 1 }).withMessage('Select a role'),
  body('departmentId').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid department'),
  body('password').isLength({ min: 8, max: 200 }).withMessage('Password must be at least 8 characters')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    return res.status(422).render('admin/user-form', {
      mode: 'create', user: null, form: req.body, errors: errorsOf(req), ...(await formData()), title: 'New user'
    });
  }
  try {
    await users.createUser({
      email: req.body.email,
      fullName: req.body.fullName,
      roleId: Number(req.body.roleId),
      departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
      password: req.body.password
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'User created.');
    return res.redirect('/admin/users');
  } catch (e) {
    if (e.status === 422) {
      return res.status(422).render('admin/user-form', {
        mode: 'create', user: null, form: req.body, errors: [e.message], ...(await formData()), title: 'New user'
      });
    }
    throw e;
  }
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const user = await users.getUser(req.params.id);
  res.render('admin/user-form', {
    mode: 'edit',
    user,
    form: { ...user, fullName: user.full_name, roleId: user.role_id, departmentId: user.department_id },
    errors: [],
    ...(await formData()),
    title: 'Edit user'
  });
}));

router.post('/:id', [
  body('email').isEmail().withMessage('Enter a valid email').normalizeEmail(),
  body('fullName').trim().isLength({ min: 2, max: 120 }).withMessage('Full name must be 2-120 characters'),
  body('roleId').isInt({ min: 1 }).withMessage('Select a role'),
  body('departmentId').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid department')
], asyncHandler(async (req, res) => {
  const user = await users.getUser(req.params.id);
  const render = async (errs) => res.status(422).render('admin/user-form', {
    mode: 'edit', user, form: { ...user, ...req.body }, errors: errs, ...(await formData()), title: 'Edit user'
  });
  if (!validationResult(req).isEmpty()) return render(errorsOf(req));
  try {
    await users.updateUser(req.params.id, {
      email: req.body.email,
      fullName: req.body.fullName,
      roleId: Number(req.body.roleId),
      departmentId: req.body.departmentId ? Number(req.body.departmentId) : null,
      isActive: req.body.isActive === 'true' || req.body.isActive === 'on'
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', 'User updated.');
    return res.redirect('/admin/users');
  } catch (e) {
    if (e.status === 422) return render([e.message]);
    throw e;
  }
}));

router.post('/:id/reset-password', [
  body('password').isLength({ min: 8, max: 200 }).withMessage('Password must be at least 8 characters')
], asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    setFlash(req, 'danger', validationResult(req).array()[0].msg);
    return res.redirect('/admin/users');
  }
  await users.resetPassword(req.params.id, req.body.password, req.session.user.id, req.ip);
  setFlash(req, 'success', 'Password reset. Other sessions for that user were signed out.');
  res.redirect('/admin/users');
}));

router.post('/:id/toggle', asyncHandler(async (req, res) => {
  const user = await users.getUser(req.params.id);
  if (Number(user.id) === Number(req.session.user.id)) {
    setFlash(req, 'danger', 'You cannot deactivate your own account.');
    return res.redirect('/admin/users');
  }
  try {
    await users.updateUser(user.id, {
      email: user.email,
      fullName: user.full_name,
      roleId: user.role_id,
      departmentId: user.department_id,
      isActive: !user.is_active
    }, req.session.user.id, req.ip);
    setFlash(req, 'success', user.is_active ? 'User deactivated.' : 'User activated.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/admin/users');
}));

module.exports = router;
