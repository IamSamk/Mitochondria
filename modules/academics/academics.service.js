const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');

async function listDepartments({ includeInactive = false } = {}) {
  const { rows } = await query(
    `SELECT d.*, (SELECT count(*)::int FROM courses c WHERE c.department_id = d.id) AS course_count
       FROM departments d
      ${includeInactive ? '' : 'WHERE d.is_active'}
      ORDER BY d.name`);
  return rows;
}

async function listCourses({ includeInactive = false, departmentId = null } = {}) {
  const params = [];
  const where = [];
  if (!includeInactive) where.push('c.is_active');
  if (departmentId) { params.push(departmentId); where.push(`c.department_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT c.*, d.name AS department_name,
            (SELECT count(*)::int FROM faculty_courses fc WHERE fc.course_id = c.id) AS faculty_count
       FROM courses c JOIN departments d ON d.id = c.department_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.code`, params);
  return rows;
}

async function createDepartment({ code, name }, actorId, ip) {
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO departments(code, name) VALUES ($1,$2) RETURNING *',
        [code.trim().toUpperCase(), name.trim()]);
      await logAudit({ actorId, action: 'DEPARTMENT_CREATED', entityType: 'department', entityId: rows[0].id, metadata: { code: rows[0].code }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A department with this code already exists');
    throw e;
  }
}

async function updateDepartment(id, { code, name, isActive }, actorId, ip) {
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE departments SET code=$1, name=$2, is_active=$3 WHERE id=$4 RETURNING *`,
        [code.trim().toUpperCase(), name.trim(), isActive, id]);
      if (!rows[0]) throw new NotFoundError('Department not found');
      await logAudit({ actorId, action: 'DEPARTMENT_UPDATED', entityType: 'department', entityId: id, metadata: { code: rows[0].code, isActive }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A department with this code already exists');
    throw e;
  }
}

async function createCourse({ departmentId, code, title, credits }, actorId, ip) {
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO courses(department_id, code, title, credits) VALUES ($1,$2,$3,$4) RETURNING *`,
        [departmentId, code.trim().toUpperCase(), title.trim(), credits || null]);
      await logAudit({ actorId, action: 'COURSE_CREATED', entityType: 'course', entityId: rows[0].id, metadata: { code: rows[0].code }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A course with this code already exists');
    if (e.code === '23503') throw new ValidationError('Department not found');
    throw e;
  }
}

async function updateCourse(id, { departmentId, code, title, credits, isActive }, actorId, ip) {
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE courses SET department_id=$1, code=$2, title=$3, credits=$4, is_active=$5
          WHERE id=$6 RETURNING *`,
        [departmentId, code.trim().toUpperCase(), title.trim(), credits || null, isActive, id]);
      if (!rows[0]) throw new NotFoundError('Course not found');
      await logAudit({ actorId, action: 'COURSE_UPDATED', entityType: 'course', entityId: id, metadata: { code: rows[0].code, isActive }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A course with this code already exists');
    throw e;
  }
}

async function listAssignments() {
  const { rows } = await query(
    `SELECT fc.id, fc.assigned_at,
            u.id AS faculty_id, u.full_name, u.email,
            c.id AS course_id, c.code AS course_code, c.title AS course_title
       FROM faculty_courses fc
       JOIN users u ON u.id = fc.faculty_id
       JOIN courses c ON c.id = fc.course_id
      ORDER BY u.full_name, c.code`);
  return rows;
}

async function assignFaculty(facultyId, courseId, actorId, ip) {
  const { rows: faculty } = await query(
    `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 AND r.code='FACULTY' AND u.is_active`, [facultyId]);
  if (!faculty[0]) throw new ValidationError('Select an active faculty account');
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO faculty_courses(faculty_id, course_id) VALUES ($1,$2) RETURNING *`,
        [facultyId, courseId]);
      await logAudit({ actorId, action: 'FACULTY_ASSIGNED', entityType: 'course', entityId: courseId, metadata: { facultyId }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('Faculty is already assigned to this course');
    if (e.code === '23503') throw new ValidationError('Faculty or course not found');
    throw e;
  }
}

async function removeAssignment(id, actorId, ip) {
  await withTransaction(async (db) => {
    const { rows } = await db.query('DELETE FROM faculty_courses WHERE id=$1 RETURNING faculty_id, course_id', [id]);
    if (!rows[0]) throw new NotFoundError('Assignment not found');
    await logAudit({ actorId, action: 'FACULTY_UNASSIGNED', entityType: 'course', entityId: rows[0].course_id, metadata: { facultyId: rows[0].faculty_id }, ip }, db);
  });
}

async function facultyCourseIds(facultyId) {
  const { rows } = await query('SELECT course_id FROM faculty_courses WHERE faculty_id=$1', [facultyId]);
  return rows.map((r) => Number(r.course_id));
}

async function isFacultyAssigned(facultyId, courseId) {
  const { rows } = await query(
    'SELECT 1 FROM faculty_courses WHERE faculty_id=$1 AND course_id=$2', [facultyId, courseId]);
  return Boolean(rows[0]);
}

async function assertFacultyAssigned(facultyId, courseId) {
  if (!(await isFacultyAssigned(facultyId, courseId))) {
    throw new ForbiddenError('You are not assigned to this course. Ask your administrator to assign you, then try again.');
  }
}

async function getExamContext(examId) {
  const { rows } = await query(
    `SELECT e.*, c.code AS course_code, c.title AS course_title, c.department_id,
            d.name AS department_name
       FROM examinations e
       JOIN courses c ON c.id = e.course_id
       JOIN departments d ON d.id = c.department_id
      WHERE e.id = $1`, [examId]);
  if (!rows[0]) throw new NotFoundError('Examination not found');
  return rows[0];
}

async function getPaperContext(paperId) {
  const { rows } = await query(
    `SELECT p.*, e.name AS exam_name, e.course_id, e.max_marks, e.duration_minutes,
            e.exam_date, e.instructions, e.status AS exam_status,
            c.code AS course_code, c.title AS course_title, c.department_id
       FROM question_papers p
       JOIN examinations e ON e.id = p.exam_id
       JOIN courses c ON c.id = e.course_id
      WHERE p.id = $1`, [paperId]);
  if (!rows[0]) throw new NotFoundError('Question paper not found');
  return rows[0];
}

module.exports = {
  listDepartments,
  listCourses,
  createDepartment,
  updateDepartment,
  createCourse,
  updateCourse,
  listAssignments,
  assignFaculty,
  removeAssignment,
  facultyCourseIds,
  isFacultyAssigned,
  assertFacultyAssigned,
  getExamContext,
  getPaperContext
};
