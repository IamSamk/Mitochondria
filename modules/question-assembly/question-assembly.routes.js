const express = require('express');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const { setFlash } = require('../../middleware/flash.middleware');
const qa = require('./question-assembly.service');
const academics = require('../academics/academics.service');

const router = express.Router();
router.use(requireAuth);

// Faculty: contribute
router.get('/contributions', requireRole('FACULTY','SUBJECT_HEAD','CONTROLLER','ADMIN'),
  asyncHandler(async (req, res) => {
    const list = await qa.listContributions({ courseId: req.query.courseId || '', status: req.query.status || '', topic: (req.query.topic||'').trim() });
    const courses = await academics.listCourses();
    res.render('question-assembly/contributions', { contributions: list, courses, filters: req.query, title: 'Question Pool' });
  }));

router.post('/contributions', requireRole('FACULTY'),
  [body('courseId').isInt({min:1}), body('body').trim().isLength({min:3}), body('marks').isFloat({gt:0}), body('questionType').isIn(['MCQ','SHORT','DESCRIPTIVE']), body('difficulty').isIn(['EASY','MEDIUM','HARD'])],
  asyncHandler(async (req, res) => {
    if (!validationResult(req).isEmpty()) { setFlash(req,'danger',validationResult(req).array()[0].msg); return res.redirect('/faculty/assembly/contributions'); }
    try {
      await qa.createContribution({ courseId: Number(req.body.courseId), body: req.body.body, marks: Number(req.body.marks), questionType: req.body.questionType, difficulty: req.body.difficulty, topic: req.body.topic, answerKey: req.body.answerKey }, req.session.user.id, req.ip);
      setFlash(req, 'success', 'Question contributed to the pool.');
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      setFlash(req, 'danger', e.message);
    }
    res.redirect('/faculty/assembly/contributions');
  }));

// Review
router.post('/contributions/:id/review', requireRole('SUBJECT_HEAD','REVIEWER','CONTROLLER','ADMIN'),
  [body('clarity').isInt({min:1,max:5}), body('difficultyAccuracy').isInt({min:1,max:5}), body('correctness').isInt({min:1,max:5})],
  asyncHandler(async (req, res) => {
    if (!validationResult(req).isEmpty()) { setFlash(req,'danger',validationResult(req).array()[0].msg); return res.redirect('/faculty/assembly/contributions'); }
    try {
      await qa.reviewContribution(req.params.id, req.session.user.id, {
        clarity: Number(req.body.clarity), difficultyAccuracy: Number(req.body.difficultyAccuracy),
        correctness: Number(req.body.correctness), comments: req.body.comments
      }, req.ip);
      setFlash(req, 'success', 'Review recorded.');
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      setFlash(req, 'danger', e.message);
    }
    res.redirect('/faculty/assembly/contributions');
  }));

router.post('/contributions/:id/status', requireRole('SUBJECT_HEAD','CONTROLLER','ADMIN'),
  [body('status').isIn(['APPROVED','REJECTED','PENDING'])],
  asyncHandler(async (req, res) => {
    try {
      await qa.setContributionStatus(req.params.id, req.body.status, req.session.user.id, req.ip);
      setFlash(req, 'success', 'Status updated.');
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      setFlash(req, 'danger', e.message);
    }
    res.redirect('/faculty/assembly/contributions');
  }));

// Assembly
router.get('/assemblies', requireRole('CONTROLLER','SUBJECT_HEAD','ADMIN'),
  asyncHandler(async (req, res) => {
    res.render('question-assembly/assemblies', { title: 'Question Assemblies' });
  }));

router.post('/assemblies', requireRole('CONTROLLER','SUBJECT_HEAD','ADMIN'),
  [body('examId').isInt({min:1}), body('setCode').trim().isLength({min:1,max:1})],
  asyncHandler(async (req, res) => {
    try {
      const a = await qa.createAssembly({ examId: Number(req.body.examId), setCode: req.body.setCode }, req.session.user.id, req.ip);
      setFlash(req, 'success', 'Assembly created.');
      res.redirect(`/faculty/assembly/assemblies/${a.id}`);
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      setFlash(req, 'danger', e.message);
      res.redirect('/faculty/assembly/assemblies');
    }
  }));

router.get('/assemblies/:id', requireRole('CONTROLLER','SUBJECT_HEAD','ADMIN'),
  asyncHandler(async (req, res, next) => {
    try {
      const assembly = await qa.getAssembly(req.params.id);
      res.render('question-assembly/assembly-detail', { assembly, title: `Assembly #${assembly.id}` });
    } catch (e) {
      if (!e.status || e.status >= 500) return next(e);
      setFlash(req, 'danger', e.message);
      res.redirect('/faculty/assembly/assemblies');
    }
  }));

router.post('/assemblies/:id/auto', requireRole('CONTROLLER','SUBJECT_HEAD','ADMIN'),
  asyncHandler(async (req, res) => {
    try {
      const topics = (req.body.topics || '').split(',').map((t) => t.trim()).filter(Boolean);
      const mix = {};
      if (req.body.easy) mix.EASY = Number(req.body.easy);
      if (req.body.medium) mix.MEDIUM = Number(req.body.medium);
      if (req.body.hard) mix.HARD = Number(req.body.hard);
      const result = await qa.autoAssemble(req.params.id, { topics, difficultyMix: mix, totalMarks: req.body.totalMarks ? Number(req.body.totalMarks) : null }, req.session.user.id, req.ip);
      setFlash(req, 'success', `Selected ${result.selected} questions (${result.total} marks).`);
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      setFlash(req, 'danger', e.message);
    }
    res.redirect(`/faculty/assembly/assemblies/${req.params.id}`);
  }));

router.post('/assemblies/:id/materialize', requireRole('CONTROLLER','SUBJECT_HEAD','ADMIN'),
  asyncHandler(async (req, res) => {
    try {
      const result = await qa.materializeToPaper(req.params.id, req.session.user.id, req.ip);
      setFlash(req, 'success', 'Assembly converted to a paper draft.');
      res.redirect(`/faculty/papers/versions/${result.versionId}/builder`);
    } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      setFlash(req, 'danger', e.message);
      res.redirect(`/faculty/assembly/assemblies/${req.params.id}`);
    }
  }));

module.exports = router;
