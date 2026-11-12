const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');

const STUDENT_SELECT = `
  SELECT s.*, d.code AS department_code, d.name AS department_name,
         (SELECT count(*)::int FROM answer_scripts a WHERE a.student_id = s.id) AS script_count
    FROM students s
    LEFT JOIN departments d ON d.id = s.department_id`;

function codeOf(value) {
  return String(value || '').trim().toUpperCase();
}

async function listStudents({ q = '', departmentId = '', active = '' } = {}) {
  const params = [];
  const where = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(s.student_code ILIKE $${params.length} OR s.full_name ILIKE $${params.length})`);
  }
  if (departmentId) { params.push(departmentId); where.push(`s.department_id = $${params.length}`); }
  if (active === 'true' || active === 'false') {
    params.push(active === 'true');
    where.push(`s.is_active = $${params.length}`);
  }
  const { rows } = await query(
    `${STUDENT_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY s.student_code`, params);
  return rows;
}

async function getStudent(id) {
  const { rows } = await query(`${STUDENT_SELECT} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Student not found');
  return rows[0];
}

async function assertDepartment(departmentId, db) {
  if (!departmentId) return;
  const { rows } = await db.query('SELECT id FROM departments WHERE id = $1', [departmentId]);
  if (!rows[0]) throw new ValidationError('Select a valid department');
}

async function createStudent({ studentCode, fullName, departmentId }, actorId, ip) {
  try {
    return await withTransaction(async (db) => {
      await assertDepartment(departmentId, db);
      const { rows } = await db.query(
        `INSERT INTO students(student_code, full_name, department_id)
         VALUES ($1,$2,$3) RETURNING *`,
        [codeOf(studentCode), fullName.trim(), departmentId || null]);
      await logAudit({
        actorId, action: 'STUDENT_CREATED', entityType: 'student', entityId: rows[0].id,
        metadata: { studentCode: rows[0].student_code, departmentId: departmentId || null }, ip
      }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A student with this code already exists');
    if (e.code === '23503') throw new ValidationError('Selected department does not exist');
    throw e;
  }
}

async function updateStudent(id, { studentCode, fullName, departmentId, isActive }, actorId, ip) {
  try {
    return await withTransaction(async (db) => {
      const current = await db.query('SELECT * FROM students WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows[0]) throw new NotFoundError('Student not found');
      await assertDepartment(departmentId, db);

      const { rows } = await db.query(
        `UPDATE students
            SET student_code = $1, full_name = $2, department_id = $3,
                is_active = $4, updated_at = now()
          WHERE id = $5 RETURNING *`,
        [codeOf(studentCode), fullName.trim(), departmentId || null, isActive, id]);
      const becameInactive = current.rows[0].is_active && !isActive;
      const becameActive = !current.rows[0].is_active && isActive;
      await logAudit({
        actorId,
        action: becameInactive ? 'STUDENT_DEACTIVATED' : becameActive ? 'STUDENT_ACTIVATED' : 'STUDENT_UPDATED',
        entityType: 'student', entityId: id,
        metadata: { studentCode: rows[0].student_code, isActive, departmentId: departmentId || null }, ip
      }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('A student with this code already exists');
    if (e.code === '23503') throw new ValidationError('Selected department does not exist');
    throw e;
  }
}

async function setActive(id, isActive, actorId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE students SET is_active = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [isActive, id]);
    if (!rows[0]) throw new NotFoundError('Student not found');
    await logAudit({
      actorId, action: isActive ? 'STUDENT_ACTIVATED' : 'STUDENT_DEACTIVATED',
      entityType: 'student', entityId: id, metadata: { studentCode: rows[0].student_code }, ip
    }, db);
    return rows[0];
  });
}

module.exports = { listStudents, getStudent, createStudent, updateStudent, setActive };
