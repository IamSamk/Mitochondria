const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const { solveTimetable } = require('../algorithms/placement');

// Conflict graph: two exams conflict if they share a student (via answer_scripts or exam_marks).
async function buildConflictGraph(examIds) {
  const conflicts = {};
  examIds.forEach((id) => { conflicts[id] = new Set(); });
  // Shared students via answer scripts
  const { rows } = await query(
    `SELECT a.exam_id AS e1, b.exam_id AS e2
       FROM answer_scripts a
       JOIN answer_scripts b ON b.student_id = a.student_id AND b.exam_id <> a.exam_id
      WHERE a.exam_id = ANY($1::bigint[]) AND b.exam_id = ANY($1::bigint[])`,
    [examIds]);
  rows.forEach((r) => { conflicts[r.e1].add(r.e2); conflicts[r.e2].add(r.e1); });
  // Shared students via direct marks
  const { rows: mrows } = await query(
    `SELECT m1.exam_id AS e1, m2.exam_id AS e2
       FROM exam_marks m1
       JOIN exam_marks m2 ON m2.student_id = m1.student_id AND m2.exam_id <> m1.exam_id
      WHERE m1.exam_id = ANY($1::bigint[]) AND m2.exam_id = ANY($1::bigint[])`,
    [examIds]);
  mrows.forEach((r) => { conflicts[r.e1].add(r.e2); conflicts[r.e2].add(r.e1); });
  return conflicts;
}

async function solveForExams(examIds) {
  const { rows: exams } = await query(
    'SELECT id, name, exam_date FROM examinations WHERE id = ANY($1::bigint[])', [examIds]);
  const conflicts = await buildConflictGraph(examIds);
  const { color, slots } = solveTimetable(exams, conflicts);
  return { exams, conflicts, color, slots };
}

async function listSlots(examId) {
  const { rows } = await query('SELECT * FROM exam_slots WHERE exam_id=$1 ORDER BY slot_start', [examId]);
  return rows;
}

async function createSlot({ examId, slotStart, slotEnd, venue }, userId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO exam_slots(exam_id, slot_start, slot_end, venue, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [examId, slotStart, slotEnd, venue || null, userId]);
    await logAudit({ actorId: userId, action: 'EXAM_SLOT_CREATED', entityType: 'exam_slot', entityId: rows[0].id, ip }, db);
    return rows[0];
  });
}

module.exports = { buildConflictGraph, solveTimetable, solveForExams, listSlots, createSlot };
