// Seating arrangements and invigilation schedules generated from the active
// student registry and department faculty, then editable row by row.
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

async function assertAccess(exam, { facultyId = null, departmentId = null }) {
  if (facultyId) await academics.assertFacultyAssigned(facultyId, exam.course_id);
  if (departmentId && Number(departmentId) !== Number(exam.department_id)) {
    throw new ForbiddenError('This examination belongs to another department. You can only manage logistics for your own department.');
  }
}

async function listExamsForFaculty(facultyId) {
  const ids = await academics.facultyCourseIds(facultyId);
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT e.id, e.name, e.exam_type, e.exam_date, e.duration_minutes, e.max_marks, e.status,
            c.code AS course_code, c.title AS course_title,
            (SELECT count(*)::int FROM seating_allocations s WHERE s.exam_id=e.id) AS seat_count,
            (SELECT count(DISTINCT s.room_name)::int FROM seating_allocations s WHERE s.exam_id=e.id) AS room_count,
            (SELECT count(*)::int FROM invigilations i WHERE i.exam_id=e.id) AS invigilation_count
       FROM examinations e
       JOIN courses c ON c.id=e.course_id
      WHERE e.course_id = ANY($1::bigint[])
      ORDER BY e.exam_date DESC, e.id DESC`, [ids]);
  return rows;
}

async function listExamsForDepartment(departmentId) {
  const { rows } = await query(
    `SELECT e.id, e.name, e.exam_type, e.exam_date, e.duration_minutes, e.max_marks, e.status,
            c.code AS course_code, c.title AS course_title,
            (SELECT count(*)::int FROM seating_allocations s WHERE s.exam_id=e.id) AS seat_count,
            (SELECT count(DISTINCT s.room_name)::int FROM seating_allocations s WHERE s.exam_id=e.id) AS room_count,
            (SELECT count(*)::int FROM invigilations i WHERE i.exam_id=e.id) AS invigilation_count
       FROM examinations e
       JOIN courses c ON c.id=e.course_id
      WHERE c.department_id=$1
      ORDER BY e.exam_date DESC, e.id DESC`, [departmentId]);
  return rows;
}

async function getPlan(examId, { facultyId = null, departmentId = null } = {}) {
  const exam = await examContext(examId);
  await assertAccess(exam, { facultyId, departmentId });
  const [seating, invigilations, faculty] = await Promise.all([
    query(
      `SELECT s.*, st.student_code, st.full_name AS student_name
         FROM seating_allocations s
         JOIN students st ON st.id=s.student_id
        WHERE s.exam_id=$1
        ORDER BY s.room_name, s.seat_no`, [examId]),
    query(
      `SELECT i.*, u.full_name AS invigilator_name
         FROM invigilations i
         JOIN users u ON u.id=i.invigilator_id
        WHERE i.exam_id=$1
        ORDER BY i.room_name, u.full_name`, [examId]),
    query(
      `SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id=u.role_id
        WHERE r.code='FACULTY' AND u.is_active AND u.department_id=$1
        ORDER BY u.full_name`, [exam.department_id])
  ]);
  const rooms = [...new Set([
    ...seating.rows.map((s) => s.room_name),
    ...invigilations.rows.map((i) => i.room_name)
  ])].sort();
  return {
    exam,
    seating: seating.rows,
    invigilations: invigilations.rows,
    faculty: faculty.rows,
    rooms
  };
}

/** Replace the seating chart for an exam with a fresh generation. */
async function generateSeating(examId, { roomName = 'Room 1', capacity = 30 }, actor, ip) {
  const exam = await examContext(examId);
  await assertAccess(exam, { facultyId: actor.id });
  const room = String(roomName || 'Room 1').trim().slice(0, 80) || 'Room 1';
  const size = Number(capacity);
  if (!Number.isInteger(size) || size < 1 || size > 500) {
    throw new ValidationError('Room capacity must be between 1 and 500');
  }
  const { rows: students } = await query(
    `SELECT id FROM students WHERE is_active AND department_id=$1 ORDER BY student_code`,
    [exam.department_id]);
  if (!students.length) throw new ValidationError('No active students in this department to seat');

  return withTransaction(async (db) => {
    await db.query('DELETE FROM invigilations WHERE exam_id=$1', [examId]);
    await db.query('DELETE FROM seating_allocations WHERE exam_id=$1', [examId]);
    let roomNo = 1;
    let seat = 0;
    for (let i = 0; i < students.length; i += 1) {
      if (seat >= size) { roomNo += 1; seat = 0; }
      seat += 1;
      const name = roomNo === 1 ? room : `${room.replace(/\s*\d+$/, '')} ${roomNo}`;
      await db.query(
        `INSERT INTO seating_allocations(exam_id, student_id, room_name, seat_no, created_by)
         VALUES ($1,$2,$3,$4,$5)`, [examId, students[i].id, name, seat, actor.id]);
    }
    await logAudit({ actorId: actor.id, action: 'SEATING_GENERATED', entityType: 'examination',
      entityId: examId, metadata: { students: students.length, rooms: roomNo, capacity: size }, ip }, db);
    return { students: students.length, rooms: roomNo };
  });
}

/**
 * Assign department faculty across the rooms that already hold seating.
 * Two invigilators per room when there are enough people.
 */
async function generateInvigilation(examId, actor, ip) {
  const exam = await examContext(examId);
  await assertAccess(exam, { facultyId: actor.id });
  const [rooms, faculty] = await Promise.all([
    query(
      `SELECT room_name, count(*)::int AS students FROM seating_allocations
        WHERE exam_id=$1 GROUP BY room_name ORDER BY room_name`, [examId]),
    query(
      `SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
        WHERE r.code='FACULTY' AND u.is_active AND u.department_id=$1 ORDER BY u.id`,
      [exam.department_id])
  ]);
  if (!rooms.rows.length) throw new ValidationError('Generate the seating arrangement first');
  if (!faculty.rows.length) throw new ValidationError('No active faculty in this department to invigilate');
  const date = new Date(exam.exam_date);
  const day = date.toISOString().slice(0, 10);
  const startsAt = `${day}T09:00:00Z`;
  const endsAt = new Date(new Date(startsAt).getTime() + Number(exam.duration_minutes) * 60000).toISOString();
  const perRoom = faculty.rows.length >= rooms.rows.length * 2 ? 2 : 1;

  return withTransaction(async (db) => {
    await db.query('DELETE FROM invigilations WHERE exam_id=$1', [examId]);
    let n = 0;
    for (const [index, room] of rooms.rows.entries()) {
      for (let slot = 0; slot < perRoom; slot += 1) {
        const person = faculty.rows[(index * perRoom + slot) % faculty.rows.length];
        await db.query(
          `INSERT INTO invigilations(exam_id, room_name, invigilator_id, starts_at, ends_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (exam_id, room_name, invigilator_id) DO NOTHING`,
          [examId, room.room_name, person.id, startsAt, endsAt, actor.id]);
        n += 1;
      }
    }
    await logAudit({ actorId: actor.id, action: 'INVIGILATION_GENERATED', entityType: 'examination',
      entityId: examId, metadata: { rooms: rooms.rows.length, assignments: n, perRoom }, ip }, db);
    return { rooms: rooms.rows.length, assignments: n };
  });
}

async function updateSeating(examId, allocationId, { roomName, seatNo }, actor, ip) {
  const exam = await examContext(examId);
  await assertAccess(exam, { facultyId: actor.id });
  const room = String(roomName || '').trim().slice(0, 80);
  const seat = Number(seatNo);
  if (!room) throw new ValidationError('Room name is required');
  if (!Number.isInteger(seat) || seat < 1) throw new ValidationError('Seat number must be a positive integer');
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE seating_allocations SET room_name=$1, seat_no=$2
          WHERE id=$3 AND exam_id=$4 RETURNING *`, [room, seat, allocationId, examId]);
      if (!rows[0]) throw new NotFoundError('Seating row not found');
      await logAudit({ actorId: actor.id, action: 'SEATING_EDITED', entityType: 'seating_allocation',
        entityId: allocationId, metadata: { room, seat }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('Another student already occupies that room and seat');
    throw e;
  }
}

async function deleteSeating(examId, allocationId, actor, ip) {
  const exam = await examContext(examId);
  await assertAccess(exam, { facultyId: actor.id });
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      'DELETE FROM seating_allocations WHERE id=$1 AND exam_id=$2 RETURNING *', [allocationId, examId]);
    if (!rows[0]) throw new NotFoundError('Seating row not found');
    await logAudit({ actorId: actor.id, action: 'SEATING_DELETED', entityType: 'seating_allocation',
      entityId: allocationId, ip }, db);
  });
}

async function updateInvigilation(examId, id, { roomName, invigilatorId, startsAt, endsAt }, actor, ip) {
  const exam = await examContext(examId);
  await assertAccess(exam, { facultyId: actor.id });
  const room = String(roomName || '').trim().slice(0, 80);
  if (!room) throw new ValidationError('Room name is required');
  const person = Number(invigilatorId);
  if (!person) throw new ValidationError('Select an invigilator');
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE invigilations
            SET room_name=$1, invigilator_id=$2, starts_at=$3, ends_at=$4
          WHERE id=$5 AND exam_id=$6 RETURNING *`,
        [room, person, startsAt || null, endsAt || null, id, examId]);
      if (!rows[0]) throw new NotFoundError('Invigilation row not found');
      await logAudit({ actorId: actor.id, action: 'INVIGILATION_EDITED', entityType: 'invigilation',
        entityId: id, metadata: { room, invigilatorId: person }, ip }, db);
      return rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError('That invigilator is already assigned to this room');
    throw e;
  }
}

async function deleteInvigilation(examId, id, actor, ip) {
  const exam = await examContext(examId);
  await assertAccess(exam, { facultyId: actor.id });
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      'DELETE FROM invigilations WHERE id=$1 AND exam_id=$2 RETURNING *', [id, examId]);
    if (!rows[0]) throw new NotFoundError('Invigilation row not found');
    await logAudit({ actorId: actor.id, action: 'INVIGILATION_DELETED', entityType: 'invigilation',
      entityId: id, ip }, db);
  });
}

module.exports = {
  examContext,
  listExamsForFaculty,
  listExamsForDepartment,
  getPlan,
  generateSeating,
  generateInvigilation,
  updateSeating,
  deleteSeating,
  updateInvigilation,
  deleteInvigilation
};
