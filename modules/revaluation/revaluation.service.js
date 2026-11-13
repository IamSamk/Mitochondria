const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');

async function studentForUser(userId) {
  const { rows } = await query('SELECT id FROM students WHERE user_id=$1', [userId]);
  if (!rows[0]) throw new NotFoundError('No student record linked to this account');
  return rows[0].id;
}

async function openWindowsForStudent(studentId) {
  const { rows } = await query(
    `SELECT w.*, e.name AS exam_name, e.exam_date, e.max_marks
       FROM revaluation_windows w
       JOIN examinations e ON e.id = w.exam_id
       JOIN students s ON s.department_id = (SELECT department_id FROM examinations ex JOIN courses c ON c.id=ex.course_id WHERE ex.id=w.exam_id)
      WHERE s.id = $1
        AND now() BETWEEN w.opens_at AND w.closes_at
      ORDER BY w.closes_at`, [studentId]);
  return rows;
}

async function listRequestsForStudent(studentId) {
  const { rows } = await query(
    `SELECT r.*, e.name AS exam_name, e.exam_date, e.max_marks
       FROM revaluation_requests r
       JOIN examinations e ON e.id = r.exam_id
      WHERE r.student_id = $1
      ORDER BY r.created_at DESC`, [studentId]);
  return rows;
}

async function listRequestsForReview({ examId = '', status = '' } = {}) {
  const params = [];
  const where = [];
  if (examId) { params.push(examId); where.push(`r.exam_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`r.status = $${params.length}`); }
  const { rows } = await query(
    `SELECT r.*, s.student_code, s.full_name AS student_name, e.name AS exam_name, e.max_marks
       FROM revaluation_requests r
       JOIN students s ON s.id = r.student_id
       JOIN examinations e ON e.id = r.exam_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC
      LIMIT 500`, params);
  return rows;
}

async function submitRequest(userId, { examId, reason }, ip) {
  const studentId = await studentForUser(userId);
  const reasonText = String(reason || '').trim();
  if (!reasonText) throw new ValidationError('Provide a reason for revaluation');
  // Must have an open window.
  const { rows: windows } = await query(
    `SELECT * FROM revaluation_windows
      WHERE exam_id=$1 AND now() BETWEEN opens_at AND closes_at`, [examId]);
  if (!windows[0]) throw new ValidationError('No open revaluation window for this exam');
  // Fetch current marks (direct marksheet or evaluation).
  const { rows: marks } = await query(
    `SELECT marks_obtained FROM exam_marks WHERE exam_id=$1 AND student_id=$2`, [examId, studentId]);
  const oldMarks = marks[0] ? Number(marks[0].marks_obtained) : null;
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO revaluation_requests(student_id, exam_id, reason, old_marks, fee_paid)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [studentId, examId, reasonText, oldMarks, false]);
    await logAudit({ actorId: userId, action: 'REVALUATION_SUBMITTED', entityType: 'revaluation_request',
      entityId: rows[0].id, metadata: { examId, oldMarks }, ip }, db);
    return rows[0];
  });
}

async function reviewRequest(id, reviewerId, { status, newMarks, notes }, ip) {
  if (!['UNDER_REVIEW','APPROVED','REJECTED','CLOSED'].includes(status)) {
    throw new ValidationError('Invalid status');
  }
  return withTransaction(async (db) => {
    const lock = await db.query('SELECT * FROM revaluation_requests WHERE id=$1 FOR UPDATE', [id]);
    const req = lock.rows[0];
    if (!req) throw new NotFoundError('Revaluation request not found');
    if (req.status === 'CLOSED') throw new ValidationError('This request is already closed');
    let finalNew = req.new_marks;
    if (status === 'APPROVED') {
      if (newMarks === null || newMarks === undefined || newMarks === '') {
        throw new ValidationError('Enter the revised marks when approving');
      }
      const v = Number(newMarks);
      if (!Number.isFinite(v) || v < 0) throw new ValidationError('Revised marks must be a non-negative number');
      finalNew = v;
      // Update direct marksheet if present.
      await db.query(
        `INSERT INTO exam_marks(exam_id, student_id, marks_obtained, entered_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (exam_id, student_id) DO UPDATE
           SET marks_obtained=EXCLUDED.marks_obtained, updated_at=now()`,
        [req.exam_id, req.student_id, v, reviewerId]);
    }
    const { rows } = await db.query(
      `UPDATE revaluation_requests
          SET status=$1, reviewer_id=$2, resolved_at=CASE WHEN $1 IN ('APPROVED','REJECTED','CLOSED') THEN now() ELSE resolved_at END,
              new_marks=$3, notes=$4
        WHERE id=$5 RETURNING *`,
      [status, reviewerId, finalNew, (notes || '').trim() || null, id]);
    await logAudit({ actorId: reviewerId, action: `REVALUATION_${status}`, entityType: 'revaluation_request',
      entityId: id, metadata: { oldMarks: req.old_marks, newMarks: finalNew }, ip }, db);
    // Notify student if account linked.
    const { rows: stu } = await db.query('SELECT user_id FROM students WHERE id=$1', [req.student_id]);
    if (stu[0] && stu[0].user_id) {
      const notifications = require('../notifications/notifications.service');
      await notifications.notify([stu[0].user_id], {
        type: 'REVALUATION_UPDATE',
        title: `Revaluation ${status.toLowerCase()}: request #${id}`,
        body: status === 'APPROVED' ? `Revised marks: ${finalNew}` : (notes || 'Your request was reviewed.'),
        link: '/student/revaluation'
      });
    }
    return rows[0];
  });
}

async function createWindow({ examId, opensAt, closesAt, feeAmount }, actorId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO revaluation_windows(exam_id, opens_at, closes_at, fee_amount, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [examId, opensAt, closesAt, feeAmount || 0, actorId]);
    await logAudit({ actorId, action: 'REVALUATION_WINDOW_CREATED', entityType: 'revaluation_window',
      entityId: rows[0].id, metadata: { examId }, ip }, db);
    return rows[0];
  });
}

module.exports = {
  studentForUser, openWindowsForStudent, listRequestsForStudent, listRequestsForReview,
  submitRequest, reviewRequest, createWindow
};
