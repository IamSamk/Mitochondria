// Direct student marksheets entered/uploaded by the subject teacher.
// These are independent of answer-script evaluations.
const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const academics = require('../academics/academics.service');

async function examContext(examId) {
  const { rows } = await query(
    `SELECT e.*, c.code AS course_code, c.title AS course_title, c.department_id,
            d.name AS department_name
       FROM examinations e
       JOIN courses c ON c.id=e.course_id
       JOIN departments d ON d.id=c.department_id
      WHERE e.id=$1`, [examId]);
  if (!rows[0]) throw new NotFoundError('Examination not found');
  return rows[0];
}

async function listExamsForFaculty(facultyId) {
  const ids = await academics.facultyCourseIds(facultyId);
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT e.id, e.name, e.exam_type, e.exam_date, e.max_marks, e.status,
            c.code AS course_code, c.title AS course_title, c.department_id,
            (SELECT count(*)::int FROM students s WHERE s.is_active AND s.department_id=c.department_id) AS student_count,
            (SELECT count(*)::int FROM exam_marks m WHERE m.exam_id=e.id) AS marks_count,
            (SELECT count(*)::int FROM exam_marks m WHERE m.exam_id=e.id AND m.marks_obtained >= e.max_marks * 0.4) AS pass_count
       FROM examinations e
       JOIN courses c ON c.id=e.course_id
      WHERE e.course_id = ANY($1::bigint[])
      ORDER BY e.exam_date DESC, e.id DESC`, [ids]);
  return rows;
}

async function listExamsForDepartment(departmentId) {
  const { rows } = await query(
    `SELECT e.id, e.name, e.exam_type, e.exam_date, e.max_marks, e.status,
            c.code AS course_code, c.title AS course_title,
            (SELECT count(*)::int FROM students s WHERE s.is_active AND s.department_id=c.department_id) AS student_count,
            (SELECT count(*)::int FROM exam_marks m WHERE m.exam_id=e.id) AS marks_count,
            (SELECT count(*)::int FROM exam_marks m WHERE m.exam_id=e.id AND m.marks_obtained >= e.max_marks * 0.4) AS pass_count
       FROM examinations e
       JOIN courses c ON c.id=e.course_id
      WHERE c.department_id=$1
      ORDER BY e.exam_date DESC, e.id DESC`, [departmentId]);
  return rows;
}

async function getSheet(examId, { facultyId = null, departmentId = null } = {}) {
  const exam = await examContext(examId);
  if (facultyId) await academics.assertFacultyAssigned(facultyId, exam.course_id);
  if (departmentId && Number(departmentId) !== Number(exam.department_id)) {
    throw new ForbiddenError('This examination belongs to another department. You can only view marksheets for your own department.');
  }
  const { rows: students } = await query(
    `SELECT s.id, s.student_code, s.full_name, s.is_active,
            m.marks_obtained, m.updated_at, u.full_name AS updated_by_name
       FROM students s
       LEFT JOIN exam_marks m ON m.exam_id=$1 AND m.student_id=s.id
       LEFT JOIN users u ON u.id=m.entered_by
      WHERE s.department_id=$2
      ORDER BY s.is_active DESC, s.student_code`,
    [examId, exam.department_id]);
  const entered = students.filter((s) => s.marks_obtained !== null && s.marks_obtained !== undefined);
  const total = entered.reduce((sum, s) => sum + Number(s.marks_obtained), 0);
  return {
    exam,
    students,
    counts: {
      students: students.filter((s) => s.is_active).length,
      entered: entered.length,
      pending: students.filter((s) => s.is_active && (s.marks_obtained === null || s.marks_obtained === undefined)).length,
      average: entered.length ? Math.round((total / entered.length) * 100) / 100 : 0
    }
  };
}

async function persistMarks(db, exam, entries, actorId, ip) {
  let saved = 0;
  let cleared = 0;
  for (const entry of entries) {
    const studentId = Number(entry.studentId);
    if (!studentId) continue;
    const belongs = await db.query(
      `SELECT id FROM students WHERE id=$1 AND department_id=$2`, [studentId, exam.department_id]);
    if (!belongs.rows[0]) throw new ValidationError('A selected student does not belong to this department');

    const raw = entry.marks === null || entry.marks === undefined ? '' : String(entry.marks).trim();
    if (raw === '') {
      const removed = await db.query(
        'DELETE FROM exam_marks WHERE exam_id=$1 AND student_id=$2 RETURNING id', [exam.id, studentId]);
      if (removed.rows[0]) cleared += 1;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > Number(exam.max_marks)) {
      throw new ValidationError(`Marks must be between 0 and ${Number(exam.max_marks)} for every student`);
    }
    await db.query(
      `INSERT INTO exam_marks(exam_id, student_id, marks_obtained, entered_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (exam_id, student_id) DO UPDATE
         SET marks_obtained=EXCLUDED.marks_obtained, entered_by=EXCLUDED.entered_by, updated_at=now()`,
      [exam.id, studentId, value, actorId]);
    saved += 1;
  }
  await logAudit({ actorId, action: 'EXAM_MARKS_SAVED', entityType: 'examination', entityId: exam.id,
    metadata: { saved, cleared }, ip }, db);
  return { saved, cleared };
}

/** Manual save; can be repeated and edits overwrite previous values. */
async function saveMarks(examId, entries, actor, ip) {
  const exam = await examContext(examId);
  await academics.assertFacultyAssigned(actor.id, exam.course_id);
  return withTransaction(async (db) => persistMarks(db, exam, entries, actor.id, ip));
}

/**
 * CSV import. Accepts `student_code,marks` with an optional header row.
 * Valid rows are saved; the caller receives per-line errors for the rest.
 */
async function importMarks(examId, csvText, actor, ip) {
  const exam = await examContext(examId);
  await academics.assertFacultyAssigned(actor.id, exam.course_id);
  const lines = String(csvText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new ValidationError('Paste or upload a CSV with student_code,marks rows');

  const { rows: students } = await query(
    `SELECT id, student_code FROM students WHERE department_id=$1`, [exam.department_id]);
  const byCode = new Map(students.map((s) => [String(s.student_code).toLowerCase(), s.id]));

  const entries = [];
  const errors = [];
  let start = 0;
  const first = lines[0].split(/[,;\t]/).map((v) => v.trim().replace(/^"|"$/g, ''));
  if (first.length >= 2 && Number.isNaN(Number(first[1]))) start = 1; // header row

  for (let i = start; i < lines.length; i += 1) {
    const cells = lines[i].split(/[,;\t]/).map((v) => v.trim().replace(/^"|"$/g, ''));
    if (cells.length < 2) { errors.push(`Line ${i + 1}: expected student_code,marks`); continue; }
    const code = cells[0];
    const marks = cells[1];
    const studentId = byCode.get(code.toLowerCase());
    if (!studentId) { errors.push(`Line ${i + 1}: unknown student code ${code}`); continue; }
    const value = Number(marks);
    if (!Number.isFinite(value) || value < 0 || value > Number(exam.max_marks)) {
      errors.push(`Line ${i + 1}: marks must be between 0 and ${Number(exam.max_marks)}`);
      continue;
    }
    entries.push({ studentId, marks: value });
  }
  if (!entries.length) {
    throw new ValidationError(errors.length ? errors[0] : 'No valid marks rows found');
  }
  const result = await withTransaction(async (db) => persistMarks(db, exam, entries, actor.id, ip));
  return { ...result, errors };
}

module.exports = {
  examContext,
  listExamsForFaculty,
  listExamsForDepartment,
  getSheet,
  saveMarks,
  importMarks
};
