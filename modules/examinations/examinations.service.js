const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');

const STATUSES = ['PLANNED', 'PAPER_PREPARATION', 'CONDUCTED', 'EVALUATION', 'MARKS_FINALIZED', 'CLOSED'];
const NEXT_STATUS = {
  PLANNED: 'PAPER_PREPARATION',
  PAPER_PREPARATION: 'CONDUCTED',
  CONDUCTED: 'EVALUATION',
  EVALUATION: 'MARKS_FINALIZED',
  MARKS_FINALIZED: 'CLOSED'
};

async function listExams({ courseId = '', status = '', q = '' } = {}) {
  const params = [];
  const where = [];
  if (courseId) { params.push(courseId); where.push(`e.course_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(e.name ILIKE $${params.length} OR c.code ILIKE $${params.length})`); }
  const { rows } = await query(
    `SELECT e.*, c.code AS course_code, c.title AS course_title,
            (SELECT count(*)::int FROM question_papers p WHERE p.exam_id = e.id) AS paper_count,
            (SELECT count(*)::int FROM answer_scripts s WHERE s.exam_id = e.id) AS script_count,
            (SELECT count(*)::int FROM answer_scripts s WHERE s.exam_id = e.id
              AND s.status IN ('UPLOADED','PENDING_VERIFICATION','VERIFIED','ALLOCATED','UNDER_EVALUATION','ON_HOLD')) AS open_script_count
       FROM examinations e JOIN courses c ON c.id = e.course_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.exam_date DESC, e.id DESC`, params);
  return rows;
}

async function getExam(id) {
  const { rows } = await query(
    `SELECT e.*, c.code AS course_code, c.title AS course_title, c.id AS course_id,
            u.full_name AS created_by_name
       FROM examinations e
       JOIN courses c ON c.id = e.course_id
       JOIN users u ON u.id = e.created_by
      WHERE e.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Examination not found');
  return rows[0];
}

async function createExam(data, actorId, ip) {
  return withTransaction(async (db) => {
    const course = await db.query('SELECT id FROM courses WHERE id=$1 AND is_active', [data.courseId]);
    if (!course.rows[0]) throw new ValidationError('Select an active course');
    const { rows } = await db.query(
      `INSERT INTO examinations
         (course_id, name, exam_type, exam_date, duration_minutes, max_marks, instructions,
          paper_deadline, evaluation_deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [data.courseId, data.name.trim(), data.examType, data.examDate, data.durationMinutes,
        data.maxMarks, data.instructions || null, data.paperDeadline || null,
        data.evaluationDeadline || null, actorId]);
    await logAudit({ actorId, action: 'EXAM_CREATED', entityType: 'examination', entityId: rows[0].id,
      metadata: { courseId: data.courseId, name: rows[0].name }, ip }, db);
    return rows[0];
  });
}

async function updateExam(id, data, actorId, ip) {
  return withTransaction(async (db) => {
    const current = await db.query('SELECT status FROM examinations WHERE id=$1 FOR UPDATE', [id]);
    if (!current.rows[0]) throw new NotFoundError('Examination not found');
    if (current.rows[0].status === 'CLOSED') throw new ValidationError('Closed examinations cannot be edited');
    const { rows } = await db.query(
      `UPDATE examinations SET course_id=$1, name=$2, exam_type=$3, exam_date=$4,
              duration_minutes=$5, max_marks=$6, instructions=$7, paper_deadline=$8,
              evaluation_deadline=$9, updated_at=now()
        WHERE id=$10 RETURNING *`,
      [data.courseId, data.name.trim(), data.examType, data.examDate, data.durationMinutes,
        data.maxMarks, data.instructions || null, data.paperDeadline || null,
        data.evaluationDeadline || null, id]);
    await logAudit({ actorId, action: 'EXAM_UPDATED', entityType: 'examination', entityId: id,
      metadata: { name: rows[0].name }, ip }, db);
    return rows[0];
  });
}

async function advanceStatus(id, nextStatus, actorId, ip) {
  if (!STATUSES.includes(nextStatus)) throw new ValidationError('Unknown examination status');
  return withTransaction(async (db) => {
    const current = await db.query('SELECT * FROM examinations WHERE id=$1 FOR UPDATE', [id]);
    const exam = current.rows[0];
    if (!exam) throw new NotFoundError('Examination not found');
    if (NEXT_STATUS[exam.status] !== nextStatus) {
      throw new ValidationError(`Cannot move an examination from ${exam.status.replaceAll('_', ' ')} to ${nextStatus.replaceAll('_', ' ')}`);
    }
    if (nextStatus === 'MARKS_FINALIZED') {
      const pending = await db.query(
        `SELECT
           (SELECT count(*)::int FROM answer_scripts WHERE exam_id=$1
             AND status IN ('UPLOADED','PENDING_VERIFICATION','VERIFIED','ALLOCATED','UNDER_EVALUATION','ON_HOLD')) AS scripts,
           (SELECT count(*)::int FROM evaluations ev JOIN answer_scripts s ON s.id=ev.script_id
             WHERE s.exam_id=$1 AND ev.status <> 'FINALIZED') AS evaluations`, [id]);
      if (pending.rows[0].scripts > 0 || pending.rows[0].evaluations > 0) {
        throw new ValidationError('All scripts must be evaluated, verified and finalized before marking marks as finalized');
      }
    }
    const { rows } = await db.query(
      'UPDATE examinations SET status=$1, updated_at=now() WHERE id=$2 RETURNING *', [nextStatus, id]);
    await logAudit({ actorId, action: 'EXAM_STATUS_CHANGED', entityType: 'examination', entityId: id,
      metadata: { from: exam.status, to: nextStatus }, ip }, db);
    return rows[0];
  });
}

async function examDetail(id) {
  const exam = await getExam(id);
  const [papers, scriptStats, evaluationStats] = await Promise.all([
    query(
      `SELECT p.id, p.set_code, p.created_at,
              v.id AS version_id, v.version_no, v.status AS version_status, v.total_marks
         FROM question_papers p
         LEFT JOIN LATERAL (
           SELECT * FROM paper_versions pv WHERE pv.paper_id = p.id
            ORDER BY pv.version_no DESC LIMIT 1
         ) v ON true
        WHERE p.exam_id = $1 ORDER BY p.set_code`, [id]),
    query(
      `SELECT status, count(*)::int AS n FROM answer_scripts WHERE exam_id=$1 GROUP BY status ORDER BY status`, [id]),
    query(
      `SELECT ev.status, count(*)::int AS n
         FROM evaluations ev JOIN answer_scripts s ON s.id=ev.script_id
        WHERE s.exam_id=$1 GROUP BY ev.status ORDER BY ev.status`, [id])
  ]);
  return { exam, papers: papers.rows, scriptStats: scriptStats.rows, evaluationStats: evaluationStats.rows };
}

module.exports = { STATUSES, NEXT_STATUS, listExams, getExam, createExam, updateExam, advanceStatus, examDetail };
