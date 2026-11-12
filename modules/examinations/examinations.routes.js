const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const { query } = require('../../config/database');
const academics = require('../academics/academics.service');
const exams = require('./examinations.service');
const notifications = require('../notifications/notifications.service');

const router = express.Router();
router.use(requireAuth, requireRole('CONTROLLER'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);
const EXAM_TYPES = ['MIDTERM', 'FINAL', 'QUIZ', 'PRACTICAL', 'INTERNAL'];

const validators = [
  body('courseId').isInt({ min: 1 }).withMessage('Select a course'),
  body('name').trim().isLength({ min: 3, max: 160 }).withMessage('Exam name must be 3-160 characters'),
  body('examType').isIn(EXAM_TYPES).withMessage('Select an exam type'),
  body('examDate').isISO8601().withMessage('Enter a valid exam date'),
  body('durationMinutes').isInt({ min: 10, max: 600 }).withMessage('Duration must be 10-600 minutes'),
  body('maxMarks').isFloat({ gt: 0, max: 9999 }).withMessage('Max marks must be greater than zero'),
  body('instructions').optional({ values: 'falsy' }).isLength({ max: 5000 }),
  body('paperDeadline').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid paper deadline'),
  body('evaluationDeadline').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid evaluation deadline')
];

function examPayload(req) {
  return {
    courseId: Number(req.body.courseId),
    name: req.body.name,
    examType: req.body.examType,
    examDate: req.body.examDate,
    durationMinutes: Number(req.body.durationMinutes),
    maxMarks: Number(req.body.maxMarks),
    instructions: req.body.instructions,
    paperDeadline: req.body.paperDeadline ? new Date(req.body.paperDeadline).toISOString() : null,
    evaluationDeadline: req.body.evaluationDeadline ? new Date(req.body.evaluationDeadline).toISOString() : null
  };
}

async function renderForm(res, { mode, exam, form, errors, status = 200 }) {
  const courses = await academics.listCourses();
  return res.status(status).render('controller/exam-form', {
    mode, exam, form, errors, courses, examTypes: EXAM_TYPES, title: mode === 'create' ? 'New examination' : 'Edit examination'
  });
}

router.get('/', asyncHandler(async (req, res) => {
  const list = await exams.listExams({
    courseId: req.query.courseId || '',
    status: req.query.status || '',
    q: (req.query.q || '').trim()
  });
  const courses = await academics.listCourses({ includeInactive: true });
  res.render('controller/exams', { exams: list, courses, statuses: exams.STATUSES, filters: req.query, title: 'Examinations' });
}));

router.get('/new', asyncHandler(async (req, res) => {
  await renderForm(res, { mode: 'create', exam: null, form: {}, errors: [] });
}));

router.post('/', validators, asyncHandler(async (req, res) => {
  if (!validationResult(req).isEmpty()) {
    return renderForm(res, { mode: 'create', exam: null, form: req.body, errors: errorsOf(req), status: 422 });
  }
  try {
    const exam = await exams.createExam(examPayload(req), req.session.user.id, req.ip);
    // Notify students in the exam's department (non-fatal).
    try {
      const courseRows = await query('SELECT department_id FROM courses WHERE id=$1', [exam.course_id]);
      const deptId = courseRows.rows[0] && courseRows.rows[0].department_id;
      if (deptId) {
        await notifications.notifyDepartment(deptId, ['STUDENT'], {
          type: 'EXAM_SCHEDULED',
          title: `New exam scheduled: ${exam.name}`,
          body: `${exam.name} on ${new Date(exam.exam_date).toISOString().slice(0,10)} (${exam.duration_minutes} min).`,
          link: '/student/exams'
        });
      }
    } catch (e) { /* notification failure must not fail exam creation */ }
    setFlash(req, 'success', 'Examination created.');
    res.redirect(`/controller/exams/${exam.id}`);
  } catch (e) {
    if (e.status !== 422) throw e;
    return renderForm(res, { mode: 'create', exam: null, form: req.body, errors: [e.message], status: 422 });
  }
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await exams.examDetail(req.params.id);
  res.render('controller/exam-detail', {
    ...detail, nextStatus: exams.NEXT_STATUS[detail.exam.status] || null, title: detail.exam.name
  });
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const exam = await exams.getExam(req.params.id);
  if (exam.status === 'CLOSED') {
    setFlash(req, 'danger', 'Closed examinations cannot be edited.');
    return res.redirect(`/controller/exams/${exam.id}`);
  }
  await renderForm(res, {
    mode: 'edit',
    exam,
    form: {
      ...exam,
      courseId: exam.course_id,
      examType: exam.exam_type,
      examDate: exam.exam_date instanceof Date ? exam.exam_date.toISOString().slice(0, 10) : String(exam.exam_date).slice(0, 10),
      durationMinutes: exam.duration_minutes,
      maxMarks: exam.max_marks,
      paperDeadline: exam.paper_deadline ? new Date(exam.paper_deadline).toISOString().slice(0, 16) : '',
      evaluationDeadline: exam.evaluation_deadline ? new Date(exam.evaluation_deadline).toISOString().slice(0, 16) : ''
    },
    errors: []
  });
}));

router.post('/:id', validators, asyncHandler(async (req, res) => {
  const exam = await exams.getExam(req.params.id);
  if (!validationResult(req).isEmpty()) {
    return renderForm(res, { mode: 'edit', exam, form: req.body, errors: errorsOf(req), status: 422 });
  }
  try {
    await exams.updateExam(req.params.id, examPayload(req), req.session.user.id, req.ip);
    setFlash(req, 'success', 'Examination updated.');
    res.redirect(`/controller/exams/${req.params.id}`);
  } catch (e) {
    if (e.status !== 422) throw e;
    return renderForm(res, { mode: 'edit', exam, form: req.body, errors: [e.message], status: 422 });
  }
}));

router.post('/:id/status', [
  body('status').isIn(exams.STATUSES).withMessage('Invalid status')
], asyncHandler(async (req, res) => {
  try {
    const updated = await exams.advanceStatus(req.params.id, req.body.status, req.session.user.id, req.ip);
    setFlash(req, 'success', `Examination moved to ${updated.status.replaceAll('_', ' ').toLowerCase()}.`);
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect(`/controller/exams/${req.params.id}`);
}));

module.exports = router;
