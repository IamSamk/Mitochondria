const { query } = require('../../config/database');
const { NotFoundError, ForbiddenError } = require('../../config/errors');

async function studentForUser(userId) {
  const { rows } = await query(
    `SELECT s.*, d.code AS department_code, d.name AS department_name, u.full_name
       FROM students s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN departments d ON d.id = s.department_id
      WHERE s.user_id = $1`, [userId]);
  if (!rows[0]) throw new NotFoundError('No student record is linked to this account');
  return rows[0];
}

async function upcomingExams(userId) {
  const student = await studentForUser(userId);
  const { rows } = await query(
    `SELECT e.id, e.name, e.exam_type, e.exam_date, e.duration_minutes, e.max_marks, e.status,
            c.code AS course_code, c.title AS course_title
       FROM examinations e
       JOIN courses c ON c.id = e.course_id
      WHERE c.department_id = $1
        AND e.exam_date >= now() - interval '1 day'
      ORDER BY e.exam_date ASC`, [student.department_id]);
  return { student, exams: rows };
}

async function results(userId) {
  const student = await studentForUser(userId);
  const { rows } = await query(
    `SELECT e.id AS exam_id, e.name AS exam_name, e.exam_date, e.max_marks,
            c.code AS course_code, m.marks_obtained, 'marksheet' AS source
       FROM exam_marks m
       JOIN examinations e ON e.id = m.exam_id
       JOIN courses c ON c.id = e.course_id
      WHERE m.student_id = $1
     UNION ALL
     SELECT e.id AS exam_id, e.name AS exam_name, e.exam_date, e.max_marks,
            c.code AS course_code, ev.total_marks AS marks_obtained, 'evaluation' AS source
       FROM evaluations ev
       JOIN answer_scripts s ON s.id = ev.script_id
       JOIN examinations e ON e.id = s.exam_id
       JOIN courses c ON c.id = e.course_id
      WHERE s.student_id = $1 AND ev.status = 'FINALIZED'
     ORDER BY exam_date DESC`, [student.id]);
  return { student, results: rows };
}

async function seats(userId) {
  const student = await studentForUser(userId);
  const { rows } = await query(
    `SELECT sa.*, e.name AS exam_name, e.exam_date
       FROM seating_allocations sa
       JOIN examinations e ON e.id = sa.exam_id
      WHERE sa.student_id = $1
      ORDER BY e.exam_date ASC`, [student.id]);
  return { student, seats: rows };
}

async function notifications(userId, limit = 30) {
  const { rows } = await query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]);
  return rows;
}

module.exports = { studentForUser, upcomingExams, results, seats, notifications };
