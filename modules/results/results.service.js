const { query } = require('../../config/database');

const RESULT_SELECT = `
  SELECT ev.id AS evaluation_id, ev.total_marks, ev.submitted_at, ev.updated_at,
         s.id AS script_id, s.status AS script_status,
         st.student_code, st.full_name AS student_name,
         e.id AS exam_id, e.name AS exam_name, e.exam_date, e.max_marks, e.status AS exam_status,
         c.code AS course_code, c.title AS course_title,
         p.set_code, u.full_name AS evaluator_name
    FROM evaluations ev
    JOIN answer_scripts s ON s.id = ev.script_id
    JOIN students st ON st.id = s.student_id
    JOIN examinations e ON e.id = s.exam_id
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN question_papers p ON p.id = s.paper_id
    JOIN users u ON u.id = ev.evaluator_id
   WHERE ev.status = 'FINALIZED'`;

async function listResults({ examId = '', courseId = '', q = '' } = {}) {
  const params = [];
  const where = [];
  if (examId) { params.push(examId); where.push(`e.id = $${params.length}`); }
  if (courseId) { params.push(courseId); where.push(`e.course_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(st.student_code ILIKE $${params.length} OR st.full_name ILIKE $${params.length}
      OR e.name ILIKE $${params.length})`);
  }
  const { rows } = await query(
    `${RESULT_SELECT}${where.length ? ` AND ${where.join(' AND ')}` : ''}
      ORDER BY e.exam_date DESC, e.name, st.student_code`, params);
  return rows;
}

async function resultFilters() {
  const [exams, courses] = await Promise.all([
    query(`SELECT id, name, exam_date FROM examinations ORDER BY exam_date DESC, id DESC`),
    query(`SELECT id, code, title FROM courses ORDER BY code`)
  ]);
  return { exams: exams.rows, courses: courses.rows };
}

function summarize(rows) {
  const marks = rows.map((r) => Number(r.total_marks));
  const max = rows.length ? Number(rows[0].max_marks) : 0;
  const sum = marks.reduce((a, b) => a + b, 0);
  return {
    attempts: rows.length,
    average: rows.length ? (sum / rows.length).toFixed(2) : '0.00',
    highest: rows.length ? Math.max(...marks).toFixed(2) : '0.00',
    lowest: rows.length ? Math.min(...marks).toFixed(2) : '0.00',
    maxMarks: max
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function resultsCsv(rows) {
  const header = ['student_code', 'student_name', 'exam', 'course', 'set',
    'marks', 'max_marks', 'percentage', 'evaluator', 'submitted_at'];
  const lines = rows.map((r) => {
    const marks = Number(r.total_marks);
    const max = Number(r.max_marks);
    return [
      r.student_code, r.student_name, r.exam_name, `${r.course_code} — ${r.course_title}`,
      r.set_code || '', marks.toFixed(2), max.toFixed(2),
      max ? ((marks / max) * 100).toFixed(2) : '0.00',
      r.evaluator_name,
      r.submitted_at ? new Date(r.submitted_at).toISOString() : ''
    ].map(csvEscape).join(',');
  });
  return [header.join(','), ...lines].join('\r\n');
}

module.exports = { listResults, resultFilters, summarize, resultsCsv };
