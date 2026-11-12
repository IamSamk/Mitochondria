const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const academics = require('../academics/academics.service');
const { storageRoot, sha256File, removeFileQuietly } = require('../../config/upload');

const STATUSES = [
  'UPLOADED', 'PENDING_VERIFICATION', 'VERIFIED', 'ALLOCATED',
  'UNDER_EVALUATION', 'EVALUATED', 'MARKS_SUBMITTED', 'ON_HOLD'
];

const SCRIPT_SELECT = `
  SELECT s.*, st.student_code, st.full_name AS student_name,
         e.name AS exam_name, e.exam_date, e.max_marks, e.status AS exam_status, e.course_id,
         c.code AS course_code, c.title AS course_title,
         p.set_code,
         up.full_name AS uploaded_by_name,
         vf.full_name AS verified_by_name,
         fa.full_name AS faculty_name, sa.faculty_id,
         ev.id AS evaluation_id, ev.status AS evaluation_status,
         ev.total_marks AS evaluation_marks, ev.submitted_at AS evaluation_submitted_at
    FROM answer_scripts s
    JOIN students st ON st.id = s.student_id
    JOIN examinations e ON e.id = s.exam_id
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN question_papers p ON p.id = s.paper_id
    LEFT JOIN users up ON up.id = s.uploaded_by
    LEFT JOIN users vf ON vf.id = s.verified_by
    LEFT JOIN script_allocations sa ON sa.script_id = s.id AND sa.is_current
    LEFT JOIN users fa ON fa.id = sa.faculty_id
    LEFT JOIN evaluations ev ON ev.script_id = s.id`;

async function listScripts({ examId = '', status = '', q = '' } = {}) {
  const params = [];
  const where = [];
  if (examId) { params.push(examId); where.push(`s.exam_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(st.student_code ILIKE $${params.length} OR st.full_name ILIKE $${params.length} OR e.name ILIKE $${params.length})`);
  }
  const { rows } = await query(
    `${SCRIPT_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.exam_date DESC, st.student_code`, params);
  return rows;
}

async function getScript(id) {
  const { rows } = await query(`${SCRIPT_SELECT} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Answer script not found');
  return rows[0];
}

async function getScriptDetail(id) {
  const script = await getScript(id);
  const history = (await query(
    `SELECT sa.*, u.full_name AS faculty_name, ab.full_name AS allocated_by_name
       FROM script_allocations sa
       JOIN users u ON u.id = sa.faculty_id
       JOIN users ab ON ab.id = sa.allocated_by
      WHERE sa.script_id = $1
      ORDER BY sa.allocated_at DESC`, [id])).rows;
  return { script, history };
}

async function listOpenExams() {
  const { rows } = await query(
    `SELECT e.id, e.name, e.exam_date, e.status, e.course_id, c.code AS course_code, c.title AS course_title
       FROM examinations e JOIN courses c ON c.id = e.course_id
      WHERE e.status <> 'CLOSED'
      ORDER BY e.exam_date DESC, e.id DESC`);
  return rows;
}

async function listStudents() {
  const { rows } = await query(
    'SELECT id, student_code, full_name FROM students WHERE is_active ORDER BY student_code');
  return rows;
}

async function listPapersForUpload() {
  const { rows } = await query(
    `SELECT p.id, p.set_code, p.exam_id, e.name AS exam_name, c.code AS course_code
       FROM question_papers p
       JOIN examinations e ON e.id = p.exam_id
       JOIN courses c ON c.id = e.course_id
      WHERE e.status <> 'CLOSED'
      ORDER BY e.exam_date DESC, p.set_code`);
  return rows;
}

async function listFacultyForCourse(courseId) {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.email
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN faculty_courses fc ON fc.faculty_id = u.id
      WHERE r.code = 'FACULTY' AND u.is_active AND fc.course_id = $1
      ORDER BY u.full_name`, [courseId]);
  return rows;
}

async function pageCountOf(filePath) {
  try {
    const bytes = await fs.promises.readFile(filePath);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

async function uploadScript({ examId, studentId, paperId, expectedPages }, file, actorId, ip) {
  if (!file) throw new ValidationError('Choose a PDF file to upload');
  const cleanup = () => removeFileQuietly(file.path);
  try {
    const exam = (await query(
      `SELECT e.id, e.status, e.course_id, e.name FROM examinations e WHERE e.id = $1`, [examId])).rows[0];
    if (!exam) throw new ValidationError('Select a valid examination');
    if (exam.status === 'CLOSED') throw new ValidationError('Closed examinations cannot receive scripts');

    const student = (await query(
      'SELECT id FROM students WHERE id = $1 AND is_active', [studentId])).rows[0];
    if (!student) throw new ValidationError('Select a valid active student');

    if (paperId) {
      const paper = (await query(
        'SELECT id FROM question_papers WHERE id = $1 AND exam_id = $2', [paperId, examId])).rows[0];
      if (!paper) throw new ValidationError('The selected paper set does not belong to this examination');
    } else {
      throw new ValidationError('Select the paper set the student wrote');
    }

    const expected = expectedPages ? Number(expectedPages) : null;
    if (expectedPages && !(Number.isInteger(expected) && expected > 0)) {
      throw new ValidationError('Expected pages must be a positive number');
    }

    const duplicate = (await query(
      'SELECT id FROM answer_scripts WHERE exam_id = $1 AND student_id = $2', [examId, studentId])).rows[0];
    if (duplicate) throw new ValidationError('A script for this student already exists for this examination');

    const pages = await pageCountOf(file.path);
    if (!pages) throw new ValidationError('The uploaded file is not a readable PDF');
    const complete = expected ? pages === expected : true;
    const relPath = path.relative(storageRoot, file.path).split(path.sep).join('/');
    const sha256 = await sha256File(file.path);

    const script = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO answer_scripts
           (exam_id, paper_id, student_id, file_path, file_sha256, original_name, page_count,
            expected_pages, is_complete, status, hold_reason, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'UPLOADED',$10,$11) RETURNING *`,
        [examId, paperId, studentId, relPath, sha256, file.originalname || null, pages,
          expected, complete, complete ? null : `Uploaded ${pages} page(s); expected ${expected}`, actorId]);
      await logAudit({
        actorId, action: 'SCRIPT_UPLOADED', entityType: 'answer_script', entityId: rows[0].id,
        metadata: { examId, studentId, paperId, pages, complete }, ip
      }, db);
      return rows[0];
    });
    return script;
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function verifyScript(id, actorId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM answer_scripts WHERE id = $1 FOR UPDATE', [id]);
    const script = rows[0];
    if (!script) throw new NotFoundError('Answer script not found');
    if (['EVALUATED', 'MARKS_SUBMITTED'].includes(script.status)) {
      throw new ValidationError('This script has already been evaluated');
    }
    if (!script.is_complete) {
      throw new ValidationError('This script is flagged incomplete. Keep it on hold or upload a complete copy.');
    }
    const updated = await db.query(
      `UPDATE answer_scripts
          SET status = 'VERIFIED', verified_by = $1, verified_at = now(), hold_reason = NULL
        WHERE id = $2 RETURNING *`, [actorId, id]);
    await logAudit({
      actorId, action: 'SCRIPT_VERIFIED', entityType: 'answer_script', entityId: id,
      metadata: { pages: script.page_count }, ip
    }, db);
    return updated.rows[0];
  });
}

async function holdScript(id, reason, actorId, ip) {
  const note = (reason || '').trim();
  if (!note) throw new ValidationError('A reason is required when putting a script on hold');
  return withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM answer_scripts WHERE id = $1 FOR UPDATE', [id]);
    const script = rows[0];
    if (!script) throw new NotFoundError('Answer script not found');
    if (['EVALUATED', 'MARKS_SUBMITTED'].includes(script.status)) {
      throw new ValidationError('Evaluated scripts cannot be put on hold');
    }
    const updated = await db.query(
      `UPDATE answer_scripts SET status = 'ON_HOLD', hold_reason = $1 WHERE id = $2 RETURNING *`,
      [note, id]);
    await logAudit({
      actorId, action: 'SCRIPT_ON_HOLD', entityType: 'answer_script', entityId: id,
      metadata: { reason: note.slice(0, 500) }, ip
    }, db);
    return updated.rows[0];
  });
}

async function releaseHold(id, actorId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM answer_scripts WHERE id = $1 FOR UPDATE', [id]);
    const script = rows[0];
    if (!script) throw new NotFoundError('Answer script not found');
    if (script.status !== 'ON_HOLD') throw new ValidationError('This script is not on hold');
    if (!script.is_complete) {
      throw new ValidationError('This script is still flagged incomplete; correct the page count before releasing it');
    }
    const updated = await db.query(
      `UPDATE answer_scripts
          SET status = 'VERIFIED', verified_by = $1, verified_at = now(), hold_reason = NULL
        WHERE id = $2 RETURNING *`, [actorId, id]);
    await logAudit({ actorId, action: 'SCRIPT_HOLD_RELEASED', entityType: 'answer_script', entityId: id, ip }, db);
    return updated.rows[0];
  });
}

async function allocateScript(id, facultyId, reason, actorId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT s.*, e.course_id, e.status AS exam_status
         FROM answer_scripts s JOIN examinations e ON e.id = s.exam_id
        WHERE s.id = $1 FOR UPDATE`, [id]);
    const script = rows[0];
    if (!script) throw new NotFoundError('Answer script not found');
    if (script.exam_status === 'CLOSED') throw new ValidationError('This examination is closed');
    if (['EVALUATED', 'MARKS_SUBMITTED'].includes(script.status)) {
      throw new ValidationError('Marks have already been submitted for this script');
    }

    const faculty = (await db.query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND r.code = 'FACULTY' AND u.is_active`, [facultyId])).rows[0];
    if (!faculty) throw new ValidationError('Select an active faculty account');
    await academics.assertFacultyAssigned(facultyId, script.course_id);

    const current = (await db.query(
      'SELECT * FROM script_allocations WHERE script_id = $1 AND is_current FOR UPDATE', [id])).rows[0];
    if (!current && script.status !== 'VERIFIED') {
      throw new ValidationError('Only verified scripts can be allocated');
    }
    const note = (reason || '').trim();
    if (current && !note) throw new ValidationError('A reason is required when reallocating a script');

    const evaluation = (await db.query(
      'SELECT * FROM evaluations WHERE script_id = $1 FOR UPDATE', [id])).rows[0];
    if (evaluation && !['DRAFT', 'REOPENED'].includes(evaluation.status)) {
      throw new ValidationError('Marks for this script have already been submitted; reopen them before reallocating');
    }

    if (current) {
      await db.query('UPDATE script_allocations SET is_current = false WHERE id = $1', [current.id]);
    }
    await db.query(
      `INSERT INTO script_allocations(script_id, faculty_id, allocated_by, reason)
       VALUES ($1,$2,$3,$4)`, [id, facultyId, actorId, note || null]);

    let nextStatus = 'ALLOCATED';
    if (evaluation) {
      await db.query('UPDATE evaluations SET evaluator_id = $1, updated_at = now() WHERE id = $2',
        [facultyId, evaluation.id]);
      nextStatus = 'UNDER_EVALUATION';
    }
    const updated = await db.query(
      'UPDATE answer_scripts SET status = $1 WHERE id = $2 RETURNING *', [nextStatus, id]);
    await logAudit({
      actorId, action: current ? 'SCRIPT_REALLOCATED' : 'SCRIPT_ALLOCATED', entityType: 'answer_script',
      entityId: id, metadata: { facultyId, reason: note ? note.slice(0, 500) : null }, ip
    }, db);
    return updated.rows[0];
  });
}

/** Script visibility for faculty/verifier read-only access. */
async function scriptForUser(scriptId, user) {
  const script = await getScript(scriptId);
  if (user.role === 'CONTROLLER' || user.role === 'VERIFIER') return script;
  if (user.role === 'FACULTY') {
    const allocation = (await query(
      `SELECT 1 FROM script_allocations
        WHERE script_id = $1 AND faculty_id = $2 AND is_current`, [scriptId, user.id])).rows[0];
    if (allocation) return script;
  }
  throw new NotFoundError('Answer script not found');
}

module.exports = {
  STATUSES,
  listScripts,
  getScript,
  getScriptDetail,
  listOpenExams,
  listStudents,
  listPapersForUpload,
  listFacultyForCourse,
  uploadScript,
  verifyScript,
  holdScript,
  releaseHold,
  allocateScript,
  scriptForUser
};
