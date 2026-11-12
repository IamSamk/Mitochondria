const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const papers = require('../question-papers/question-papers.service');

const EVALUATION_SELECT = `
  SELECT ev.*, s.exam_id, s.paper_id, s.student_id, s.file_path, s.original_name,
         s.page_count, s.status AS script_status,
         st.student_code, st.full_name AS student_name,
         e.name AS exam_name, e.exam_date, e.max_marks, e.status AS exam_status, e.course_id,
         c.code AS course_code, c.title AS course_title,
         p.set_code,
         u.full_name AS evaluator_name
    FROM evaluations ev
    JOIN answer_scripts s ON s.id = ev.script_id
    JOIN students st ON st.id = s.student_id
    JOIN examinations e ON e.id = s.exam_id
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN question_papers p ON p.id = s.paper_id
    JOIN users u ON u.id = ev.evaluator_id`;

async function listFacultyQueue(facultyId) {
  const { rows } = await query(
    `SELECT sa.id AS allocation_id, sa.allocated_at,
            s.id AS script_id, s.status AS script_status, s.page_count, s.original_name,
            st.student_code, st.full_name AS student_name,
            e.id AS exam_id, e.name AS exam_name, e.exam_date, e.max_marks, e.status AS exam_status,
            c.code AS course_code, c.title AS course_title, p.set_code,
            ev.id AS evaluation_id, ev.status AS evaluation_status,
            ev.total_marks AS evaluation_marks, ev.updated_at AS evaluation_updated_at
       FROM script_allocations sa
       JOIN answer_scripts s ON s.id = sa.script_id
       JOIN students st ON st.id = s.student_id
       JOIN examinations e ON e.id = s.exam_id
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN question_papers p ON p.id = s.paper_id
       LEFT JOIN evaluations ev ON ev.script_id = s.id
      WHERE sa.faculty_id = $1 AND sa.is_current
      ORDER BY e.exam_date DESC, st.student_code`, [facultyId]);
  return rows;
}

async function listEvaluations({ status = '', examId = '', q = '', evaluatorId = '' } = {}) {
  const params = [];
  const where = [];
  if (status) { params.push(status); where.push(`ev.status = $${params.length}`); }
  if (examId) { params.push(examId); where.push(`s.exam_id = $${params.length}`); }
  if (evaluatorId) { params.push(evaluatorId); where.push(`ev.evaluator_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(st.student_code ILIKE $${params.length} OR st.full_name ILIKE $${params.length}
      OR e.name ILIKE $${params.length})`);
  }
  const { rows } = await query(
    `${EVALUATION_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ev.updated_at DESC, ev.id DESC`, params);
  return rows;
}

/** Summary-card counts ignore the status filter but respect exam/search filters. */
async function countEvaluationsByStatus({ examId = '', q = '' } = {}) {
  const params = [];
  const where = [];
  if (examId) { params.push(examId); where.push(`s.exam_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(st.student_code ILIKE $${params.length} OR st.full_name ILIKE $${params.length}
      OR e.name ILIKE $${params.length})`);
  }
  const { rows } = await query(
    `SELECT ev.status, count(*)::int AS n
       FROM evaluations ev
       JOIN answer_scripts s ON s.id = ev.script_id
       JOIN students st ON st.id = s.student_id
       JOIN examinations e ON e.id = s.exam_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY ev.status`, params);
  return rows.reduce((acc, row) => { acc[row.status] = row.n; return acc; }, {});
}

async function examOptions() {
  const { rows } = await query(
    `SELECT e.id, e.name, e.exam_date
       FROM examinations e
      WHERE EXISTS (
        SELECT 1 FROM answer_scripts s
          JOIN evaluations ev ON ev.script_id = s.id
         WHERE s.exam_id = e.id)
      ORDER BY e.exam_date DESC, e.id DESC`);
  return rows;
}

async function getEvaluationById(id) {
  const { rows } = await query(`${EVALUATION_SELECT} WHERE ev.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Evaluation not found');
  return rows[0];
}

async function assertEvaluator(evaluation, facultyId) {
  if (Number(evaluation.evaluator_id) !== Number(facultyId)) {
    throw new ForbiddenError('This script is allocated to another faculty member');
  }
}

async function getEvaluationDetail(id) {
  const evaluation = await getEvaluationById(id);
  const version = evaluation.paper_id ? await papers.versionForEvaluation(evaluation.paper_id) : null;
  const questions = version
    ? (await query('SELECT * FROM paper_questions WHERE version_id = $1 ORDER BY position', [version.id])).rows
    : [];
  const marks = (await query(
    'SELECT * FROM question_marks WHERE evaluation_id = $1', [id])).rows;
  const marksByQuestion = {};
  for (const m of marks) marksByQuestion[m.paper_question_id] = m;
  const history = (await query(
    `SELECT ms.*, u.full_name AS actor_name
       FROM marks_submissions ms JOIN users u ON u.id = ms.actor_id
      WHERE ms.evaluation_id = $1 ORDER BY ms.created_at, ms.id`, [id])).rows;
  const allocation = (await query(
    `SELECT sa.*, u.full_name AS faculty_name
       FROM script_allocations sa JOIN users u ON u.id = sa.faculty_id
      WHERE sa.script_id = $1 AND sa.is_current`, [evaluation.script_id])).rows[0] || null;
  return { evaluation, version, questions, marksByQuestion, history, allocation };
}

async function getFacultyEvaluation(id, facultyId) {
  const detail = await getEvaluationDetail(id);
  await assertEvaluator(detail.evaluation, facultyId);
  return detail;
}

function parseMarks(body, questions) {
  const entries = [];
  for (const q of questions) {
    const raw = body[`mark_${q.id}`];
    let value = null;
    if (raw !== undefined && String(raw).trim() !== '') {
      value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > Number(q.marks)) {
        throw new ValidationError(`Marks for question ${q.display_no} must be between 0 and ${Number(q.marks)}`);
      }
    }
    entries.push({
      paperQuestionId: q.id,
      marks: value,
      comment: String(body[`comment_${q.id}`] || '').trim().slice(0, 500) || null
    });
  }
  const total = entries.reduce((sum, e) => sum + (e.marks || 0), 0);
  const missing = entries.filter((e) => e.marks === null).length;
  return { entries, total, missing };
}

async function applyMarks(db, evaluationId, entries) {
  for (const entry of entries) {
    if (entry.marks === null) {
      await db.query(
        'DELETE FROM question_marks WHERE evaluation_id = $1 AND paper_question_id = $2',
        [evaluationId, entry.paperQuestionId]);
    } else {
      await db.query(
        `INSERT INTO question_marks(evaluation_id, paper_question_id, marks_awarded, comment)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (evaluation_id, paper_question_id)
         DO UPDATE SET marks_awarded = EXCLUDED.marks_awarded, comment = EXCLUDED.comment`,
        [evaluationId, entry.paperQuestionId, entry.marks, entry.comment]);
    }
  }
}

async function startEvaluation(scriptId, facultyId, ip) {
  return withTransaction(async (db) => {
    const allocation = (await db.query(
      `SELECT sa.id FROM script_allocations sa
        WHERE sa.script_id = $1 AND sa.faculty_id = $2 AND sa.is_current`, [scriptId, facultyId])).rows[0];
    if (!allocation) throw new ForbiddenError('This script is not allocated to you');

    const script = (await db.query(
      `SELECT s.*, e.status AS exam_status FROM answer_scripts s
         JOIN examinations e ON e.id = s.exam_id WHERE s.id = $1 FOR UPDATE`, [scriptId])).rows[0];
    if (!script) throw new NotFoundError('Answer script not found');
    if (script.exam_status === 'CLOSED') throw new ValidationError('This examination is closed');
    if (!script.paper_id) throw new ValidationError('This script has no paper set assigned; ask the controller');

    const version = await papers.versionForEvaluation(script.paper_id);
    if (!version) throw new ValidationError('No paper version is available for this script');

    const existing = (await db.query(
      'SELECT * FROM evaluations WHERE script_id = $1 FOR UPDATE', [scriptId])).rows[0];
    let evaluation = existing;
    if (!evaluation) {
      evaluation = (await db.query(
        `INSERT INTO evaluations(script_id, evaluator_id, status) VALUES ($1,$2,'DRAFT') RETURNING *`,
        [scriptId, facultyId])).rows[0];
      await logAudit({
        actorId: facultyId, action: 'EVALUATION_STARTED', entityType: 'evaluation',
        entityId: evaluation.id, metadata: { scriptId, versionId: version.id }, ip
      }, db);
    }
    if (!['EVALUATED', 'MARKS_SUBMITTED'].includes(script.status)) {
      await db.query(`UPDATE answer_scripts SET status = 'UNDER_EVALUATION' WHERE id = $1`, [scriptId]);
    }
    return evaluation;
  });
}

async function saveDraft(evaluationId, facultyId, body, ip) {
  const detail = await getFacultyEvaluation(evaluationId, facultyId);
  if (!['DRAFT', 'REOPENED'].includes(detail.evaluation.status)) {
    throw new ValidationError('This evaluation has been submitted and can no longer be edited');
  }
  if (!detail.questions.length) throw new ValidationError('No paper questions are available to mark');
  const { entries, total } = parseMarks(body, detail.questions);
  return withTransaction(async (db) => {
    await applyMarks(db, evaluationId, entries);
    const { rows } = await db.query(
      `UPDATE evaluations SET total_marks = $1, remarks = $2, updated_at = now()
        WHERE id = $3 RETURNING *`,
      [total, String(body.remarks || '').trim().slice(0, 2000) || null, evaluationId]);
    return rows[0];
  });
}

async function submitEvaluation(evaluationId, facultyId, body, ip) {
  const detail = await getFacultyEvaluation(evaluationId, facultyId);
  if (!['DRAFT', 'REOPENED'].includes(detail.evaluation.status)) {
    throw new ValidationError('This evaluation has already been submitted');
  }
  if (!detail.questions.length) throw new ValidationError('No paper questions are available to mark');
  const { entries, total, missing } = parseMarks(body, detail.questions);
  if (missing) throw new ValidationError('Enter marks for every question before submitting');

  return withTransaction(async (db) => {
    const locked = (await db.query(
      'SELECT * FROM evaluations WHERE id = $1 FOR UPDATE', [evaluationId])).rows[0];
    if (!locked) throw new NotFoundError('Evaluation not found');
    if (!['DRAFT', 'REOPENED'].includes(locked.status)) {
      throw new ValidationError('This evaluation has already been submitted');
    }
    await applyMarks(db, evaluationId, entries);
    const { rows } = await db.query(
      `UPDATE evaluations
          SET status = 'SUBMITTED', total_marks = $1, remarks = $2,
              submitted_at = now(), updated_at = now()
        WHERE id = $3 RETURNING *`,
      [total, String(body.remarks || '').trim().slice(0, 2000) || null, evaluationId]);
    await db.query(
      `UPDATE answer_scripts SET status = 'EVALUATED' WHERE id = $1`, [locked.script_id]);
    await db.query(
      `INSERT INTO marks_submissions(evaluation_id, action, actor_id, total_before, total_after)
       VALUES ($1,'SUBMITTED',$2,$3,$4)`,
      [evaluationId, facultyId, locked.total_marks, total]);
    await logAudit({
      actorId: facultyId, action: 'EVALUATION_SUBMITTED', entityType: 'evaluation',
      entityId: evaluationId, metadata: { total, scriptId: locked.script_id }, ip
    }, db);
    return rows[0];
  });
}

async function verifyEvaluation(evaluationId, verifierId, ip) {
  return withTransaction(async (db) => {
    const evaluation = (await db.query(
      'SELECT * FROM evaluations WHERE id = $1 FOR UPDATE', [evaluationId])).rows[0];
    if (!evaluation) throw new NotFoundError('Evaluation not found');
    if (evaluation.status !== 'SUBMITTED') {
      throw new ValidationError('Only submitted evaluations can be verified');
    }
    const { rows } = await db.query(
      `UPDATE evaluations SET status = 'VERIFIED', updated_at = now()
        WHERE id = $1 RETURNING *`, [evaluationId]);
    await db.query(
      `UPDATE answer_scripts SET status = 'MARKS_SUBMITTED' WHERE id = $1`, [evaluation.script_id]);
    await db.query(
      `INSERT INTO marks_submissions(evaluation_id, action, actor_id, total_before, total_after)
       VALUES ($1,'VERIFIED',$2,$3,$3)`,
      [evaluationId, verifierId, evaluation.total_marks]);
    await logAudit({
      actorId: verifierId, action: 'EVALUATION_VERIFIED', entityType: 'evaluation',
      entityId: evaluationId, metadata: { total: Number(evaluation.total_marks) }, ip
    }, db);
    return rows[0];
  });
}

async function requestCorrection(evaluationId, verifierId, reason, ip) {
  const note = (reason || '').trim();
  if (!note) throw new ValidationError('Give a reason so the evaluator knows what to correct');
  return withTransaction(async (db) => {
    const evaluation = (await db.query(
      'SELECT * FROM evaluations WHERE id = $1 FOR UPDATE', [evaluationId])).rows[0];
    if (!evaluation) throw new NotFoundError('Evaluation not found');
    if (!['SUBMITTED', 'VERIFIED'].includes(evaluation.status)) {
      throw new ValidationError('Only submitted or verified evaluations can be sent back');
    }
    const { rows } = await db.query(
      `UPDATE evaluations SET status = 'REOPENED', updated_at = now()
        WHERE id = $1 RETURNING *`, [evaluationId]);
    await db.query(
      `UPDATE answer_scripts SET status = 'UNDER_EVALUATION' WHERE id = $1`, [evaluation.script_id]);
    await db.query(
      `INSERT INTO marks_submissions(evaluation_id, action, actor_id, reason, total_before, total_after)
       VALUES ($1,'REOPENED',$2,$3,$4,$4)`,
      [evaluationId, verifierId, note, evaluation.total_marks]);
    await logAudit({
      actorId: verifierId, action: 'EVALUATION_REOPENED', entityType: 'evaluation',
      entityId: evaluationId, metadata: { reason: note.slice(0, 500) }, ip
    }, db);
    return rows[0];
  });
}

async function finalizeEvaluation(evaluationId, controllerId, ip) {
  return withTransaction(async (db) => {
    const evaluation = (await db.query(
      'SELECT * FROM evaluations WHERE id = $1 FOR UPDATE', [evaluationId])).rows[0];
    if (!evaluation) throw new NotFoundError('Evaluation not found');
    if (evaluation.status !== 'VERIFIED') {
      throw new ValidationError('Only verified evaluations can be finalized');
    }
    const { rows } = await db.query(
      `UPDATE evaluations SET status = 'FINALIZED', updated_at = now()
        WHERE id = $1 RETURNING *`, [evaluationId]);
    await db.query(
      `INSERT INTO marks_submissions(evaluation_id, action, actor_id, total_before, total_after)
       VALUES ($1,'FINALIZED',$2,$3,$3)`,
      [evaluationId, controllerId, evaluation.total_marks]);
    await logAudit({
      actorId: controllerId, action: 'EVALUATION_FINALIZED', entityType: 'evaluation',
      entityId: evaluationId, metadata: { total: Number(evaluation.total_marks) }, ip
    }, db);
    return rows[0];
  });
}

async function reopenEvaluation(evaluationId, controllerId, reason, ip) {
  const note = (reason || '').trim();
  if (!note) throw new ValidationError('A reason is required when reopening finalized marks');
  return withTransaction(async (db) => {
    const evaluation = (await db.query(
      'SELECT * FROM evaluations WHERE id = $1 FOR UPDATE', [evaluationId])).rows[0];
    if (!evaluation) throw new NotFoundError('Evaluation not found');
    if (!['VERIFIED', 'FINALIZED'].includes(evaluation.status)) {
      throw new ValidationError('Only verified or finalized evaluations can be reopened');
    }
    const { rows } = await db.query(
      `UPDATE evaluations SET status = 'REOPENED', updated_at = now()
        WHERE id = $1 RETURNING *`, [evaluationId]);
    await db.query(
      `UPDATE answer_scripts SET status = 'UNDER_EVALUATION' WHERE id = $1`, [evaluation.script_id]);
    await db.query(
      `INSERT INTO marks_submissions(evaluation_id, action, actor_id, reason, total_before, total_after)
       VALUES ($1,'REOPENED',$2,$3,$4,$4)`,
      [evaluationId, controllerId, note, evaluation.total_marks]);
    await logAudit({
      actorId: controllerId, action: 'EVALUATION_REOPENED', entityType: 'evaluation',
      entityId: evaluationId, metadata: { reason: note.slice(0, 500) }, ip
    }, db);
    return rows[0];
  });
}

module.exports = {
  listFacultyQueue,
  listEvaluations,
  countEvaluationsByStatus,
  examOptions,
  getEvaluationDetail,
  getFacultyEvaluation,
  startEvaluation,
  saveDraft,
  submitEvaluation,
  verifyEvaluation,
  requestCorrection,
  finalizeEvaluation,
  reopenEvaluation
};
