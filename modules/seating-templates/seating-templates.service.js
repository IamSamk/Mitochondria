const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const academics = require('../academics/academics.service');

const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function optimalPlacement(students, rooms) {
  // students: [{id, group}], rooms: [{number, rows, cols}]
  const groups = {};
  students.forEach((s) => { (groups[s.group] = groups[s.group] || []).push(s.id); });
  const groupKeys = Object.keys(groups);
  const state = rooms.map((r) => ({
    number: r.number, rows: r.rows, cols: r.cols,
    grid: Array.from({ length: r.rows }, () => Array(r.cols).fill(null)),
    occupied: 0, capacity: r.rows * r.cols
  }));
  const placement = [];
  let remaining = students.length;
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    const activeGroups = groupKeys.filter((g) => groups[g].length > 0);
    if (!activeGroups.length) break;
    activeGroups.sort((a, b) => groups[b].length - groups[a].length);
    const gk = activeGroups[0];
    // try to place one student of gk
    let placed = false;
    for (const room of state) {
      if (room.occupied >= room.capacity) continue;
      let best = null; let bestScore = Infinity;
      for (let r = 0; r < room.rows; r++) {
        for (let c = 0; c < room.cols; c++) {
          if (room.grid[r][c]) continue;
          let score = 0;
          for (const [dr, dc] of DIRS) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nc < 0 || nr >= room.rows || nc >= room.cols) continue;
            const v = room.grid[nr][nc];
            if (v && v.group === gk) score += 1;
          }
          if (score < bestScore) { bestScore = score; best = { r, c }; }
        }
      }
      if (best) {
        const sid = groups[gk].shift();
        room.grid[best.r][best.c] = { studentId: sid, group: gk };
        room.occupied += 1;
        placement.push({ studentId: sid, roomNumber: room.number, row: best.r, col: best.c });
        remaining -= 1;
        placed = true;
        progress = true;
        break;
      }
    }
    if (!placed) {
      // fallback: place any remaining student in any free cell
      let anyPlaced = false;
      for (const g of activeGroups) {
        if (!groups[g].length) continue;
        for (const room of state) {
          if (room.occupied >= room.capacity) continue;
          let cell = null;
          outer: for (let r = 0; r < room.rows; r++) {
            for (let c = 0; c < room.cols; c++) {
              if (!room.grid[r][c]) { cell = { r, c }; break outer; }
            }
          }
          if (cell) {
            const sid = groups[g].shift();
            room.grid[cell.r][cell.c] = { studentId: sid, group: g };
            room.occupied += 1;
            placement.push({ studentId: sid, roomNumber: room.number, row: cell.r, col: cell.c });
            remaining -= 1;
            anyPlaced = true;
            progress = true;
            break;
          }
        }
        if (anyPlaced) break;
      }
      if (!anyPlaced) break;
    }
  }
  return { placement, unplaced: remaining };
}

// Templates
async function listTemplates(userId) {
  const { rows } = await query(
    `SELECT * FROM room_templates WHERE created_by=$1 OR is_shared=true ORDER BY name`, [userId]);
  return rows;
}

async function createTemplate({ name, rows, cols }, userId, ip) {
  const r = Number(rows), c = Number(cols);
  if (!name || !name.trim()) throw new ValidationError('Template name is required');
  if (!Number.isInteger(r) || r < 1 || r > 100) throw new ValidationError('Rows must be 1-100');
  if (!Number.isInteger(c) || c < 1 || c > 100) throw new ValidationError('Columns must be 1-100');
  return withTransaction(async (db) => {
    const { rows: out } = await db.query(
      `INSERT INTO room_templates(name, rows, cols, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), r, c, userId]);
    await logAudit({ actorId: userId, action: 'ROOM_TEMPLATE_CREATED', entityType: 'room_template',
      entityId: out[0].id, metadata: { rows: r, cols: c }, ip }, db);
    return out[0];
  });
}

async function deleteTemplate(id, userId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      'DELETE FROM room_templates WHERE id=$1 AND (created_by=$2) RETURNING *', [id, userId]);
    if (!rows[0]) throw new NotFoundError('Template not found or not owned by you');
    await logAudit({ actorId: userId, action: 'ROOM_TEMPLATE_DELETED', entityType: 'room_template',
      entityId: id, ip }, db);
  });
}

async function addRoomInstance(examId, templateId, roomNumber, userId, ip) {
  const exam = await (require('../logistics/logistics.service').examContext)(examId);
  await academics.assertFacultyAssigned(userId, exam.course_id);
  const tmpl = (await query('SELECT * FROM room_templates WHERE id=$1', [templateId])).rows[0];
  if (!tmpl) throw new NotFoundError('Template not found');
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO exam_room_instances(exam_id, template_id, room_number) VALUES ($1,$2,$3) RETURNING *`,
      [examId, templateId, String(roomNumber).trim()]);
    await logAudit({ actorId: userId, action: 'EXAM_ROOM_INSTANCE_ADDED', entityType: 'exam_room_instance',
      entityId: rows[0].id, metadata: { templateId, roomNumber }, ip }, db);
    return rows[0];
  });
}

async function listRoomInstances(examId) {
  const { rows } = await query(
    `SELECT eri.*, rt.name AS template_name, rt.rows, rt.cols
       FROM exam_room_instances eri
       JOIN room_templates rt ON rt.id = eri.template_id
      WHERE eri.exam_id = $1
      ORDER BY eri.display_order, eri.id`, [examId]);
  return rows;
}

async function generateFromTemplates(examId, userId, ip) {
  const exam = await (require('../logistics/logistics.service').examContext)(examId);
  await academics.assertFacultyAssigned(userId, exam.course_id);
  const instances = await listRoomInstances(examId);
  if (!instances.length) throw new ValidationError('Add at least one room instance first');
  const rooms = instances.map((i) => ({ number: i.room_number, rows: i.rows, cols: i.cols }));
  const { rows: students } = await query(
    `SELECT id FROM students WHERE is_active AND department_id=$1 ORDER BY student_code`,
    [exam.department_id]);
  if (!students.length) throw new ValidationError('No active students in this department');
  const tagged = students.map((s) => ({ id: s.id, group: exam.id }));
  const { placement, unplaced } = optimalPlacement(tagged, rooms);
  return withTransaction(async (db) => {
    await db.query('DELETE FROM seating_allocations WHERE exam_id=$1', [examId]);
    for (const p of placement) {
      await db.query(
        `INSERT INTO seating_allocations(exam_id, student_id, room_name, seat_no, row_no, col_no, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [examId, p.studentId, p.roomNumber, p.row * (rooms.find((r) => r.number === p.roomNumber).cols) + p.col + 1,
         p.row + 1, p.col + 1, userId]);
    }
    await logAudit({ actorId: userId, action: 'TEMPLATE_SEATING_GENERATED', entityType: 'examination',
      entityId: examId, metadata: { placed: placement.length, unplaced, rooms: rooms.length }, ip }, db);
    return { placed: placement.length, unplaced, rooms: rooms.length };
  });
}

module.exports = {
  DIRS, optimalPlacement, listTemplates, createTemplate, deleteTemplate,
  addRoomInstance, listRoomInstances, generateFromTemplates
};
