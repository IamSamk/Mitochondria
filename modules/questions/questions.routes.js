const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const academics = require('../academics/academics.service');
const questions = require('./questions.service');

const router = express.Router();
router.use(requireAuth, requireRole('FACULTY'));

const errorsOf = (req) => validationResult(req).array().map((e) => e.msg);
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

async function assignedCourses(facultyId) {
  const ids = await academics.facultyCourseIds(facultyId);
  if (!ids.length) return [];
  const courses = await academics.listCourses();
  return courses.filter((c) => ids.includes(Number(c.id)));
}

function optionRows(form) {
  const labels = [].concat(form.optionLabel || []);
  const bodies = [].concat(form.optionBody || []);
  const correct = String(form.correctOption ?? '');
  return LETTERS.map((label, i) => ({
    label,
    body: bodies[i] || '',
    isCorrect: String(i) === correct,
    index: i
  }));
}

function formFromQuestion(q, options) {
  return {
    courseId: q.course_id,
    questionType: q.question_type,
    body: q.body,
    marks: q.marks,
    difficulty: q.difficulty,
    unit: q.unit,
    topic: q.topic,
    modelAnswer: q.model_answer,
    optionBody: options.map((o) => o.body),
    correctOption: options.findIndex((o) => o.is_correct)
  };
}

async function renderForm(req, res, { mode, question, form, options, errors, status = 200 }) {
  return res.status(status).render('faculty/question-form', {
    mode, question, form, optionRows: options || optionRows(form), letters: LETTERS,
    courses: await assignedCourses(req.session.user.id), errors,
    types: questions.TYPES, difficulties: questions.DIFFICULTIES,
    title: mode === 'create' ? 'New question' : 'Edit question'
  });
}

router.get('/', asyncHandler(async (req, res) => {
  const list = await questions.listQuestions({
    facultyId: req.session.user.id,
    courseId: req.query.courseId || '',
    type: req.query.type || '',
    q: (req.query.q || '').trim(),
    includeArchived: req.query.archived === '1'
  });
  res.render('faculty/questions', {
    questions: list, courses: await assignedCourses(req.session.user.id),
    filters: req.query, types: questions.TYPES, title: 'Question Bank'
  });
}));

router.get('/new', asyncHandler(async (req, res) => {
  await renderForm(req, res, {
    mode: 'create', question: null,
    form: { questionType: 'SHORT', difficulty: 'MEDIUM', marks: 5, courseId: req.query.courseId || '' },
    options: optionRows({}), errors: []
  });
}));

router.post('/', [
  body('courseId').isInt({ min: 1 }).withMessage('Select a course'),
  body('questionType').isIn(questions.TYPES).withMessage('Select a question type'),
  body('body').trim().isLength({ min: 5, max: 5000 }).withMessage('Question text must be 5-5000 characters'),
  body('marks').isFloat({ gt: 0, max: 100 }).withMessage('Marks must be between 0.01 and 100'),
  body('difficulty').optional({ values: 'falsy' }).isIn(questions.DIFFICULTIES),
  body('unit').optional({ values: 'falsy' }).isLength({ max: 120 }),
  body('topic').optional({ values: 'falsy' }).isLength({ max: 120 }),
  body('modelAnswer').optional({ values: 'falsy' }).isLength({ max: 5000 })
], asyncHandler(async (req, res) => {
  const form = { ...req.body, courseId: Number(req.body.courseId) };
  if (!validationResult(req).isEmpty()) {
    return renderForm(req, res, { mode: 'create', question: null, form, errors: errorsOf(req), status: 422 });
  }
  try {
    await questions.createQuestion(form, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Question added to the bank.');
    res.redirect('/faculty/questions');
  } catch (e) {
    if (e.status !== 422) throw e;
    return renderForm(req, res, { mode: 'create', question: null, form, errors: [e.message], status: 422 });
  }
}));

router.get('/:id/edit', asyncHandler(async (req, res) => {
  const { question, options } = await questions.getQuestion(req.params.id, req.session.user.id);
  if (question.is_archived) {
    setFlash(req, 'danger', 'Archived questions cannot be edited.');
    return res.redirect('/faculty/questions?archived=1');
  }
  await renderForm(req, res, { mode: 'edit', question, form: formFromQuestion(question, options), options: optionRows(formFromQuestion(question, options)), errors: [] });
}));

router.post('/:id', [
  body('courseId').isInt({ min: 1 }).withMessage('Select a course'),
  body('questionType').isIn(questions.TYPES).withMessage('Select a question type'),
  body('body').trim().isLength({ min: 5, max: 5000 }).withMessage('Question text must be 5-5000 characters'),
  body('marks').isFloat({ gt: 0, max: 100 }).withMessage('Marks must be between 0.01 and 100'),
  body('difficulty').optional({ values: 'falsy' }).isIn(questions.DIFFICULTIES)
], asyncHandler(async (req, res) => {
  const { question } = await questions.getQuestion(req.params.id, req.session.user.id);
  const form = { ...req.body, courseId: Number(req.body.courseId) };
  const render = async (errs) => renderForm(req, res, {
    mode: 'edit', question, form, errors: errs, status: 422
  });
  if (!validationResult(req).isEmpty()) return render(errorsOf(req));
  try {
    await questions.updateQuestion(req.params.id, form, req.session.user.id, req.ip);
    setFlash(req, 'success', 'Question updated.');
    res.redirect('/faculty/questions');
  } catch (e) {
    if (e.status !== 422) throw e;
    return render([e.message]);
  }
}));

router.post('/:id/archive', asyncHandler(async (req, res) => {
  try {
    const { question } = await questions.getQuestion(req.params.id, req.session.user.id);
    await questions.setArchived(question.id, !question.is_archived, req.session.user.id, req.ip);
    setFlash(req, 'success', question.is_archived ? 'Question restored.' : 'Question archived.');
  } catch (e) {
    if (e.status !== 422) throw e;
    setFlash(req, 'danger', e.message);
  }
  res.redirect('/faculty/questions');
}));

module.exports = router;
