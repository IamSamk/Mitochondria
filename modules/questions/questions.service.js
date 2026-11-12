const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const academics = require('../academics/academics.service');

const TYPES = ['MCQ', 'SHORT', 'DESCRIPTIVE'];
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'];

async function listQuestions({ facultyId, courseId = '', type = '', q = '', includeArchived = false }) {
  const courseIds = await academics.facultyCourseIds(facultyId);
  if (!courseIds.length) return [];
  const params = [courseIds];
  const where = ['q.course_id = ANY($1::bigint[])'];
  if (!includeArchived) where.push('NOT q.is_archived');
  if (courseId) {
    if (!courseIds.includes(Number(courseId))) throw new ValidationError('You are not assigned to this course');
    params.push(courseId); where.push(`q.course_id = $${params.length}`);
  }
  if (type) { params.push(type); where.push(`q.question_type = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(q.body ILIKE $${params.length} OR q.topic ILIKE $${params.length})`); }
  const { rows } = await query(
    `SELECT q.*, c.code AS course_code, c.title AS course_title,
            (SELECT count(*)::int FROM question_options o WHERE o.question_id = q.id) AS option_count
       FROM questions q JOIN courses c ON c.id = q.course_id
      WHERE ${where.join(' AND ')}
      ORDER BY q.created_at DESC`, params);
  return rows;
}

async function getQuestion(id, facultyId) {
  const { rows } = await query(
    `SELECT q.*, c.code AS course_code, c.title AS course_title
       FROM questions q JOIN courses c ON c.id=q.course_id WHERE q.id=$1`, [id]);
  if (!rows[0]) throw new NotFoundError('Question not found');
  await academics.assertFacultyAssigned(facultyId, rows[0].course_id);
  const options = await query(
    'SELECT id, label, body, is_correct FROM question_options WHERE question_id=$1 ORDER BY label', [id]);
  return { question: rows[0], options: options.rows };
}

function normalizeOptions(body) {
  const labels = [].concat(body.optionLabel || []);
  const bodies = [].concat(body.optionBody || []);
  const correct = String(body.correctOption || '');
  const options = labels.map((label, i) => ({
    label: String(label).trim().toUpperCase(),
    body: String(bodies[i] || '').trim(),
    isCorrect: String(i) === correct
  })).filter((o) => o.label && o.body);
  return { options, correct };
}

function validateQuestionPayload(body) {
  if (!TYPES.includes(body.questionType)) return 'Select a valid question type';
  if (!body.body || body.body.trim().length < 5) return 'Question text must be at least 5 characters';
  const marks = Number(body.marks);
  if (!(marks > 0) || marks > 100) return 'Marks must be between 0.01 and 100';
  if (body.difficulty && !DIFFICULTIES.includes(body.difficulty)) return 'Invalid difficulty';
  if (body.questionType === 'MCQ') {
    const { options } = normalizeOptions(body);
    if (options.length < 2 || options.length > 8) return 'MCQ questions need 2-8 non-empty options';
    if (options.filter((o) => o.isCorrect).length !== 1) return 'Select exactly one correct MCQ option';
    return null;
  }
  return null;
}

async function createQuestion(data, actorId, ip) {
  await academics.assertFacultyAssigned(actorId, data.courseId);
  const problem = validateQuestionPayload(data);
  if (problem) throw new ValidationError(problem);
  const { options } = normalizeOptions(data);
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO questions(course_id, created_by, question_type, body, marks, difficulty, unit, topic, model_answer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.courseId, actorId, data.questionType, data.body.trim(), Number(data.marks),
        data.difficulty || null, data.unit || null, data.topic || null, data.modelAnswer || null]);
    const question = rows[0];
    if (data.questionType === 'MCQ') {
      for (const o of options) {
        await db.query(
          'INSERT INTO question_options(question_id, label, body, is_correct) VALUES ($1,$2,$3,$4)',
          [question.id, o.label, o.body, o.isCorrect]);
      }
    }
    await logAudit({ actorId, action: 'QUESTION_CREATED', entityType: 'question', entityId: question.id,
      metadata: { courseId: data.courseId, type: data.questionType }, ip }, db);
    return question;
  });
}

async function updateQuestion(id, data, actorId, ip) {
  const current = await getQuestion(id, actorId);
  if (current.question.is_archived) throw new ValidationError('Archived questions cannot be edited');
  await academics.assertFacultyAssigned(actorId, data.courseId);
  const problem = validateQuestionPayload(data);
  if (problem) throw new ValidationError(problem);
  const { options } = normalizeOptions(data);
  return withTransaction(async (db) => {
    await db.query(
      `UPDATE questions SET course_id=$1, question_type=$2, body=$3, marks=$4, difficulty=$5,
              unit=$6, topic=$7, model_answer=$8, updated_at=now() WHERE id=$9`,
      [data.courseId, data.questionType, data.body.trim(), Number(data.marks), data.difficulty || null,
        data.unit || null, data.topic || null, data.modelAnswer || null, id]);
    await db.query('DELETE FROM question_options WHERE question_id=$1', [id]);
    if (data.questionType === 'MCQ') {
      for (const o of options) {
        await db.query(
          'INSERT INTO question_options(question_id, label, body, is_correct) VALUES ($1,$2,$3,$4)',
          [id, o.label, o.body, o.isCorrect]);
      }
    }
    await logAudit({ actorId, action: 'QUESTION_UPDATED', entityType: 'question', entityId: id, ip }, db);
  });
}

async function setArchived(id, archived, actorId, ip) {
  await getQuestion(id, actorId);
  await withTransaction(async (db) => {
    await db.query('UPDATE questions SET is_archived=$1, updated_at=now() WHERE id=$2', [archived, id]);
    await logAudit({ actorId, action: archived ? 'QUESTION_ARCHIVED' : 'QUESTION_RESTORED',
      entityType: 'question', entityId: id, ip }, db);
  });
}

/** Questions in a course that a faculty member may add to a paper. */
async function availableForCourse(courseId) {
  const { rows } = await query(
    `SELECT id, question_type, body, marks, difficulty, unit, topic
       FROM questions WHERE course_id=$1 AND NOT is_archived ORDER BY created_at DESC`, [courseId]);
  return rows;
}

module.exports = { TYPES, DIFFICULTIES, listQuestions, getQuestion, createQuestion, updateQuestion, setArchived, availableForCourse, validateQuestionPayload };
