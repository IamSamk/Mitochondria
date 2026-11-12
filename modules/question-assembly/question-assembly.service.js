const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const academics = require('../academics/academics.service');

// Contributions
async function listContributions({ courseId = '', status = '', topic = '' } = {}) {
  const params = [];
  const where = [];
  if (courseId) { params.push(courseId); where.push(`c.course_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
  if (topic) { params.push(`%${topic}%`); where.push(`c.topic ILIKE $${params.length}`); }
  const { rows } = await query(
    `SELECT c.*, u.full_name AS author_name, co.code AS course_code
       FROM question_contributions c
       JOIN users u ON u.id = c.author_id
       JOIN courses co ON co.id = c.course_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.created_at DESC`, params);
  return rows;
}

async function createContribution(data, userId, ip) {
  const body = String(data.body || '').trim();
  if (!body) throw new ValidationError('Question body is required');
  const marks = Number(data.marks);
  if (!Number.isFinite(marks) || marks <= 0) throw new ValidationError('Marks must be positive');
  if (!['MCQ','SHORT','DESCRIPTIVE'].includes(data.questionType)) throw new ValidationError('Invalid question type');
  if (!['EASY','MEDIUM','HARD'].includes(data.difficulty)) throw new ValidationError('Invalid difficulty');
  await academics.assertFacultyAssigned(userId, data.courseId);
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO question_contributions(course_id, author_id, body, question_type, marks, difficulty, topic, answer_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [data.courseId, userId, body, data.questionType, marks, data.difficulty,
       data.topic ? String(data.topic).trim() : null, data.answerKey ? String(data.answerKey).trim() : null]);
    await logAudit({ actorId: userId, action: 'QUESTION_CONTRIBUTED', entityType: 'question_contribution',
      entityId: rows[0].id, ip }, db);
    return rows[0];
  });
}

async function reviewContribution(contributionId, reviewerId, { clarity, difficultyAccuracy, correctness, comments }, ip) {
  const c = Number(clarity), d = Number(difficultyAccuracy), k = Number(correctness);
  if (![c,d,k].every((n) => Number.isInteger(n) && n >= 1 && n <= 5)) {
    throw new ValidationError('Scores must be integers 1-5');
  }
  return withTransaction(async (db) => {
    const contrib = (await db.query('SELECT * FROM question_contributions WHERE id=$1', [contributionId])).rows[0];
    if (!contrib) throw new NotFoundError('Contribution not found');
    await db.query(
      `INSERT INTO question_reviews(contribution_id, reviewer_id, clarity, difficulty_accuracy, correctness, comments)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (contribution_id, reviewer_id) DO UPDATE
         SET clarity=EXCLUDED.clarity, difficulty_accuracy=EXCLUDED.difficulty_accuracy,
             correctness=EXCLUDED.correctness, comments=EXCLUDED.comments`,
      [contributionId, reviewerId, c, d, k, (comments || '').trim() || null]);
    // Recompute aggregate score.
    const { rows } = await db.query(
      `SELECT avg(clarity + difficulty_accuracy + correctness)::numeric / 3 AS score
         FROM question_reviews WHERE contribution_id=$1`, [contributionId]);
    const score = rows[0].score !== null ? Number(Number(rows[0].score).toFixed(2)) : null;
    await db.query('UPDATE question_contributions SET score=$1, updated_at=now() WHERE id=$2', [score, contributionId]);
    await logAudit({ actorId: reviewerId, action: 'QUESTION_REVIEWED', entityType: 'question_contribution',
      entityId: contributionId, metadata: { score }, ip }, db);
    return { score };
  });
}

async function setContributionStatus(id, status, actorId, ip) {
  if (!['APPROVED','REJECTED','PENDING'].includes(status)) throw new ValidationError('Invalid status');
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE question_contributions SET status=$1, updated_at=now() WHERE id=$2 RETURNING *`,
      [status, id]);
    if (!rows[0]) throw new NotFoundError('Contribution not found');
    await logAudit({ actorId, action: `QUESTION_${status}`, entityType: 'question_contribution',
      entityId: id, ip }, db);
    return rows[0];
  });
}

// Assembly
async function createAssembly({ examId, setCode }, userId, ip) {
  const code = String(setCode || '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(code)) throw new ValidationError('Set code must be a single letter');
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO question_assemblies(exam_id, set_code, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [examId, code, userId]);
    await logAudit({ actorId: userId, action: 'ASSEMBLY_CREATED', entityType: 'question_assembly',
      entityId: rows[0].id, metadata: { examId, setCode: code }, ip }, db);
    return rows[0];
  });
}

async function getAssembly(id) {
  const { rows } = await query('SELECT * FROM question_assemblies WHERE id=$1', [id]);
  if (!rows[0]) throw new NotFoundError('Assembly not found');
  const assembly = rows[0];
  const { rows: items } = await query(
    `SELECT ai.*, qc.body, qc.question_type, qc.difficulty, qc.topic, qc.marks AS contrib_marks, qc.score, qc.status AS contrib_status
       FROM question_assembly_items ai
       JOIN question_contributions qc ON qc.id = ai.contribution_id
      WHERE ai.assembly_id = $1
      ORDER BY ai.position`, [id]);
  return { ...assembly, items };
}

async function autoAssemble(assemblyId, { topics = [], difficultyMix = {}, totalMarks }, userId, ip) {
  const assembly = await getAssembly(assemblyId);
  const exam = (await query('SELECT * FROM examinations WHERE id=$1', [assembly.exam_id])).rows[0];
  if (!exam) throw new NotFoundError('Examination not found');
  const course = (await query('SELECT * FROM courses WHERE id=$1', [exam.course_id])).rows[0];
  // Candidate approved contributions for this course not yet used.
  const params = [course.id];
  const where = [`course_id=$1`, `status='APPROVED'`];
  if (topics.length) {
    params.push(topics);
    where.push(`topic = ANY($${params.length}::text[])`);
  }
  const { rows: candidates } = await query(
    `SELECT * FROM question_contributions WHERE ${where.join(' AND ')} ORDER BY score DESC NULLS LAST, created_at`,
    params);
  // Greedy selection by difficulty mix then score.
  const target = Number(totalMarks || exam.max_marks);
  const selected = [];
  let total = 0;
  const remaining = [...candidates];
  // Prefer difficulty mix if provided.
  const mix = difficultyMix || {};
  const difficulties = ['EASY','MEDIUM','HARD'].filter((d) => mix[d]);
  // First satisfy mix quotas.
  for (const diff of difficulties) {
    const quota = Number(mix[diff]) || 0;
    let count = 0;
    for (let i = 0; i < remaining.length && count < quota; i++) {
      const c = remaining[i];
      if (!c || c.difficulty !== diff) continue;
      if (total + Number(c.marks) > target + 0.005) continue;
      selected.push(c);
      total += Number(c.marks);
      remaining[i] = null;
      count += 1;
    }
  }
  // Fill remaining marks with best-scoring contributions.
  remaining = remaining.filter(Boolean);
  remaining.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  for (const c of remaining) {
    if (total + Number(c.marks) > target + 0.005) continue;
    selected.push(c);
    total += Number(c.marks);
    if (Math.abs(total - target) < 0.005) break;
  }
  if (selected.length === 0) throw new ValidationError('No suitable contributions found');
  // Persist items.
  return withTransaction(async (db) => {
    await db.query('DELETE FROM question_assembly_items WHERE assembly_id=$1', [assemblyId]);
    let pos = 1;
    for (const c of selected) {
      await db.query(
        `INSERT INTO question_assembly_items(assembly_id, contribution_id, position, marks)
         VALUES ($1,$2,$3,$4)`,
        [assemblyId, c.id, pos++, Number(c.marks)]);
    }
    await db.query('UPDATE question_assemblies SET status=$1 WHERE id=$2', ['DRAFT', assemblyId]);
    await logAudit({ actorId: userId, action: 'ASSEMBLY_AUTO', entityType: 'question_assembly',
      entityId: assemblyId, metadata: { selected: selected.length, total }, ip }, db);
    return { selected: selected.length, total };
  });
}

async function materializeToPaper(assemblyId, userId, ip) {
  const assembly = await getAssembly(assemblyId);
  const exam = (await query('SELECT * FROM examinations WHERE id=$1', [assembly.exam_id])).rows[0];
  if (!exam) throw new NotFoundError('Examination not found');
  const course = (await query('SELECT * FROM courses WHERE id=$1', [exam.course_id])).rows[0];
  return withTransaction(async (db) => {
    // Create questions from contributions (if not already).
    const questionIds = [];
    for (const item of assembly.items) {
      const contrib = (await db.query('SELECT * FROM question_contributions WHERE id=$1', [item.contribution_id])).rows[0];
      const existing = (await db.query('SELECT id FROM questions WHERE source_contribution_id=$1', [contrib.id])).rows[0];
      let qid = existing ? existing.id : null;
      if (!qid) {
        const { rows } = await db.query(
          `INSERT INTO questions(course_id, question_type, body, marks, difficulty, answer_key, created_by, source_contribution_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [course.id, contrib.question_type, contrib.body, contrib.marks, contrib.difficulty,
           contrib.answer_key, userId, contrib.id]);
        qid = rows[0].id;
      }
      questionIds.push({ qid, item });
    }
    // Create paper.
    const { rows: paperRows } = await db.query(
      `INSERT INTO question_papers(exam_id, set_code, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [exam.id, assembly.set_code, userId]);
    const paper = paperRows[0];
    // Create version.
    const { rows: verRows } = await db.query(
      `INSERT INTO paper_versions(paper_id, version_no, status, created_by) VALUES ($1,1,'DRAFT',$2) RETURNING *`,
      [paper.id, userId]);
    const version = verRows[0];
    // Add questions.
    let pos = 1;
    for (const { qid, item } of questionIds) {
      await db.query(
        `INSERT INTO paper_questions(version_id, question_id, position, section_title, marks)
         VALUES ($1,$2,$3,$4,$5)`,
        [version.id, qid, pos++, item.section_title || 'Section A', item.marks]);
    }
    await db.query(
      `UPDATE paper_versions SET total_marks=(SELECT coalesce(sum(marks),0) FROM paper_questions WHERE version_id=$1) WHERE id=$1`,
      [version.id]);
    await db.query('UPDATE question_assemblies SET status=$1 WHERE id=$2', ['FINALIZED', assemblyId]);
    await logAudit({ actorId: userId, action: 'ASSEMBLY_MATERIALIZED', entityType: 'question_assembly',
      entityId: assemblyId, metadata: { paperId: paper.id, versionId: version.id }, ip }, db);
    return { paperId: paper.id, versionId: version.id };
  });
}

// Timetable conflict solver (greedy graph coloring)
function solveTimetable(exams, conflicts) {
  // exams: [{id}], conflicts: Map examId -> Set of conflicting examIds
  // Returns {slot: Map examId->slotNumber, slots: number}
  const adj = {};
  exams.forEach((e) => { adj[e.id] = new Set(conflicts[e.id] || []); });
  // order by degree desc
  const order = exams.map((e) => e.id).sort((a, b) => adj[b].size - adj[a].size);
  const color = {};
  let maxColor = 0;
  for (const id of order) {
    const used = new Set();
    for (const nb of adj[id]) if (color[nb] !== undefined) used.add(color[nb]);
    let c = 0;
    while (used.has(c)) c += 1;
    color[id] = c;
    if (c + 1 > maxColor) maxColor = c + 1;
  }
  return { color, slots: maxColor };
}

async function listExamSlots(examId) {
  const { rows } = await query('SELECT * FROM exam_slots WHERE exam_id=$1 ORDER BY slot_start', [examId]);
  return rows;
}

async function createExamSlot({ examId, slotStart, slotEnd, venue }, userId, ip) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO exam_slots(exam_id, slot_start, slot_end, venue, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [examId, slotStart, slotEnd, venue || null, userId]);
    await logAudit({ actorId: userId, action: 'EXAM_SLOT_CREATED', entityType: 'exam_slot',
      entityId: rows[0].id, ip }, db);
    return rows[0];
  });
}

module.exports = {
  listContributions, createContribution, reviewContribution, setContributionStatus,
  createAssembly, getAssembly, autoAssemble, materializeToPaper,
  solveTimetable, listExamSlots, createExamSlot
};
