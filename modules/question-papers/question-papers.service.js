const fs = require('fs');
const { query, withTransaction } = require('../../config/database');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const academics = require('../academics/academics.service');
const { generatePaperPdf } = require('./paper-pdf.service');
const { resolveStoragePath } = require('../../config/upload');

const SET_CODES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

async function listExamsForFaculty(facultyId) {
  const ids = await academics.facultyCourseIds(facultyId);
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT e.*, c.code AS course_code, c.title AS course_title,
            coalesce(string_agg(p.set_code, ', ' ORDER BY p.set_code), '') AS set_codes
       FROM examinations e
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN question_papers p ON p.exam_id = e.id
      WHERE e.course_id = ANY($1::bigint[]) AND e.status <> 'CLOSED'
      GROUP BY e.id, c.id
      ORDER BY e.exam_date DESC`, [ids]);
  return rows;
}

async function listPapersForFaculty(facultyId) {
  const ids = await academics.facultyCourseIds(facultyId);
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT p.id, p.set_code, p.created_at,
            e.id AS exam_id, e.name AS exam_name, e.status AS exam_status, e.exam_date, e.max_marks,
            c.code AS course_code, c.title AS course_title,
            v.id AS version_id, v.version_no, v.status AS version_status, v.total_marks,
            v.is_finalized, v.draft_saved_at
       FROM question_papers p
       JOIN examinations e ON e.id = p.exam_id
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN LATERAL (
         SELECT * FROM paper_versions pv WHERE pv.paper_id = p.id ORDER BY pv.version_no DESC LIMIT 1
       ) v ON true
      WHERE e.course_id = ANY($1::bigint[])
      ORDER BY e.exam_date DESC, p.set_code`, [ids]);
  return rows;
}

async function listAllPapers({ examId = '', status = '' } = {}) {
  const { rows } = await query(
    `SELECT p.id, p.set_code, p.created_at,
            e.id AS exam_id, e.name AS exam_name, e.exam_date, e.max_marks, e.status AS exam_status,
            c.code AS course_code, c.title AS course_title,
            v.id AS version_id, v.version_no, v.status AS version_status, v.total_marks,
            v.is_finalized, v.draft_saved_at,
            (SELECT r.released_at FROM paper_releases r WHERE r.version_id=v.id) AS released_at
       FROM question_papers p
       JOIN examinations e ON e.id = p.exam_id
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN LATERAL (
         SELECT * FROM paper_versions pv WHERE pv.paper_id = p.id ORDER BY pv.version_no DESC LIMIT 1
       ) v ON true
      WHERE ($1::bigint IS NULL OR e.id = $1)
        AND ($2 = '' OR v.status = $2)
      ORDER BY e.exam_date DESC, p.set_code`,
    [examId || null, status || '']);
  return rows;
}

async function getPaperDetail(paperId) {
  const paper = await academics.getPaperContext(paperId);
  const versions = await query(
    `SELECT v.*, u.full_name AS created_by_name,
            (SELECT count(*)::int FROM paper_questions q WHERE q.version_id=v.id) AS question_count
       FROM paper_versions v JOIN users u ON u.id=v.created_by
      WHERE v.paper_id=$1 ORDER BY v.version_no DESC`, [paperId]);
  const latest = versions.rows[0] || null;
  let questions = [];
  let approvals = [];
  let headReviews = [];
  let release = null;
  if (latest) {
    questions = (await query('SELECT * FROM paper_questions WHERE version_id=$1 ORDER BY position', [latest.id])).rows;
    approvals = (await query(
      `SELECT a.*, u.full_name AS reviewer_name FROM paper_approvals a
        JOIN users u ON u.id=a.reviewer_id WHERE a.version_id=$1 ORDER BY a.decided_at`, [latest.id])).rows;
    headReviews = (await query(
      `SELECT h.*, u.full_name AS head_name FROM paper_head_reviews h
        JOIN users u ON u.id=h.head_id WHERE h.version_id=$1 ORDER BY h.decided_at`, [latest.id])).rows;
    release = (await query('SELECT * FROM paper_releases WHERE version_id=$1', [latest.id])).rows[0] || null;
  }
  return { paper, versions: versions.rows, latest, questions, approvals, headReviews, release };
}

async function getVersionDetail(versionId) {
  const { rows } = await query(
    `SELECT v.*, p.set_code, p.id AS paper_id, p.exam_id, p.created_by AS paper_owner,
            p.download_password_hash,
            e.name AS exam_name, e.max_marks, e.duration_minutes, e.exam_date, e.instructions,
            e.status AS exam_status, e.course_id,
            c.code AS course_code, c.title AS course_title, c.department_id,
            u.full_name AS created_by_name
       FROM paper_versions v
       JOIN question_papers p ON p.id = v.paper_id
       JOIN examinations e ON e.id = p.exam_id
       JOIN courses c ON c.id = e.course_id
       JOIN users u ON u.id = v.created_by
      WHERE v.id = $1`, [versionId]);
  if (!rows[0]) throw new NotFoundError('Paper version not found');
  const version = rows[0];
  const questions = (await query('SELECT * FROM paper_questions WHERE version_id=$1 ORDER BY position', [versionId])).rows;
  const approvals = (await query(
    `SELECT a.*, u.full_name AS reviewer_name FROM paper_approvals a
      JOIN users u ON u.id=a.reviewer_id WHERE a.version_id=$1 ORDER BY a.decided_at`, [versionId])).rows;
  const headReviews = (await query(
    `SELECT h.*, u.full_name AS head_name FROM paper_head_reviews h
      JOIN users u ON u.id=h.head_id WHERE h.version_id=$1 ORDER BY h.decided_at`, [versionId])).rows;
  const release = (await query('SELECT * FROM paper_releases WHERE version_id=$1', [versionId])).rows[0] || null;
  return { ...version, questions, approvals, headReviews, release };
}

async function assertFacultyVersion(versionId, facultyId) {
  const version = await getVersionDetail(versionId);
  await academics.assertFacultyAssigned(facultyId, version.course_id);
  return version;
}

/** Only the subject teacher who created the paper may change or finalize it. */
async function assertPaperOwner(version, facultyId) {
  if (Number(version.paper_owner) !== Number(facultyId)) {
    let ownerName = 'the subject teacher who created it';
    try {
      const { rows } = await query('SELECT full_name FROM users WHERE id = $1', [version.paper_owner]);
      if (rows[0] && rows[0].full_name) ownerName = rows[0].full_name;
    } catch (e) { /* ignore */ }
    throw new ForbiddenError(
      `Only ${ownerName} can modify or finalize this paper. ` +
      `You are assigned to this course but did not create this paper. ` +
      `Ask ${ownerName} or your administrator if you need access.`);
  }
}

async function createPaper({ examId, setCode }, facultyId, ip) {
  const exam = await academics.getExamContext(examId);
  await academics.assertFacultyAssigned(facultyId, exam.course_id);
  if (exam.status === 'CLOSED') throw new ValidationError('Closed examinations cannot receive new papers');
  const code = String(setCode || '').trim().toUpperCase();
  if (!SET_CODES.includes(code)) throw new ValidationError('Set code must be a single letter A-Z');
  try {
    return await withTransaction(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO question_papers(exam_id, set_code, created_by) VALUES ($1,$2,$3) RETURNING *',
        [examId, code, facultyId]);
      const paper = rows[0];
      const created = await db.query(
        `INSERT INTO paper_versions(paper_id, version_no, status, created_by) VALUES ($1,1,'DRAFT',$2) RETURNING *`,
        [paper.id, facultyId]);
      await logAudit({ actorId: facultyId, action: 'PAPER_CREATED', entityType: 'question_paper',
        entityId: paper.id, metadata: { examId, setCode: code }, ip }, db);
      return { paper, version: created.rows[0] };
    });
  } catch (e) {
    if (e.code === '23505') throw new ValidationError(`Set ${code} already exists for this examination`);
    throw e;
  }
}

async function createRevision(paperId, facultyId, ip) {
  const paper = await academics.getPaperContext(paperId);
  await academics.assertFacultyAssigned(facultyId, paper.course_id);
  return withTransaction(async (db) => {
    const latest = await db.query(
      'SELECT * FROM paper_versions WHERE paper_id=$1 ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [paperId]);
    const current = latest.rows[0];
    if (!current) throw new NotFoundError('Paper has no versions');
    if (current.status === 'DRAFT') throw new ValidationError('A draft version already exists');
    if (current.status !== 'REJECTED') throw new ValidationError('A new version can only be started after a rejection');
    const { rows } = await db.query(
      `INSERT INTO paper_versions(paper_id, version_no, status, created_by)
       VALUES ($1,$2,'DRAFT',$3) RETURNING *`, [paperId, current.version_no + 1, facultyId]);
    const version = rows[0];
    await db.query(
      `INSERT INTO paper_questions(version_id, source_question_id, section_title, display_no, position, question_type, body, marks, options_json)
       SELECT $1, source_question_id, section_title, display_no, position, question_type, body, marks, options_json
         FROM paper_questions WHERE version_id=$2`, [version.id, current.id]);
    await db.query(
      `UPDATE paper_versions SET total_marks = (SELECT coalesce(sum(marks),0) FROM paper_questions WHERE version_id=$1) WHERE id=$1`,
      [version.id]);
    await logAudit({ actorId: facultyId, action: 'PAPER_VERSION_CREATED', entityType: 'paper_version',
      entityId: version.id, metadata: { paperId, versionNo: version.version_no }, ip }, db);
    return version;
  });
}

async function getBuilder(versionId, facultyId) {
  const version = await assertFacultyVersion(versionId, facultyId);
  if (version.status !== 'DRAFT') throw new ValidationError('Only draft versions can be edited');
  await assertPaperOwner(version, facultyId);
  const available = await query(
    `SELECT id, question_type, body, marks, difficulty, unit, topic
       FROM questions WHERE course_id=$1 AND NOT is_archived ORDER BY created_at DESC`, [version.course_id]);
  return { version, availableQuestions: available.rows };
}

async function addQuestion(versionId, { questionId, sectionTitle }, facultyId, ip) {
  return withTransaction(async (db) => {
    const lock = await db.query(
      `SELECT v.*, p.exam_id, p.created_by AS paper_owner FROM paper_versions v JOIN question_papers p ON p.id=v.paper_id
        WHERE v.id=$1 FOR UPDATE`, [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');
    if (version.status !== 'DRAFT') throw new ValidationError('Only draft versions can be edited');
    const exam = await db.query('SELECT course_id, max_marks FROM examinations WHERE id=$1', [version.exam_id]);
    await academics.assertFacultyAssigned(facultyId, exam.rows[0].course_id);
    await assertPaperOwner(version, facultyId);

    const q = await db.query(
      'SELECT * FROM questions WHERE id=$1 AND NOT is_archived', [questionId]);
    const question = q.rows[0];
    if (!question) throw new ValidationError('Question not found');
    if (Number(question.course_id) !== Number(exam.rows[0].course_id)) {
      throw new ValidationError('Question belongs to a different course');
    }
    const count = await db.query(
      'SELECT coalesce(max(position),0)::int AS n FROM paper_questions WHERE version_id=$1', [versionId]);
    const position = count.rows[0].n + 1;
    const options = await db.query(
      'SELECT label, body FROM question_options WHERE question_id=$1 ORDER BY label', [questionId]);
    const optionsJson = options.rows.length ? JSON.stringify(options.rows) : null;
    const section = (sectionTitle || 'Section A').trim().slice(0, 80) || 'Section A';
    await db.query(
      `INSERT INTO paper_questions(version_id, source_question_id, section_title, display_no, position, question_type, body, marks, options_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [versionId, question.id, section, String(position), position, question.question_type,
        question.body, question.marks, optionsJson]);
    await db.query(
      `UPDATE paper_versions SET total_marks=(SELECT coalesce(sum(marks),0) FROM paper_questions WHERE version_id=$1) WHERE id=$1`,
      [versionId]);
    await logAudit({ actorId: facultyId, action: 'PAPER_QUESTION_ADDED', entityType: 'paper_version',
      entityId: versionId, metadata: { questionId }, ip }, db);
  });
}

async function removeQuestion(versionId, paperQuestionId, facultyId, ip) {
  return withTransaction(async (db) => {
    const lock = await db.query(
      `SELECT v.*, p.exam_id, p.created_by AS paper_owner FROM paper_versions v JOIN question_papers p ON p.id=v.paper_id
        WHERE v.id=$1 FOR UPDATE`, [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');
    if (version.status !== 'DRAFT') throw new ValidationError('Only draft versions can be edited');
    const exam = await db.query('SELECT course_id FROM examinations WHERE id=$1', [version.exam_id]);
    await academics.assertFacultyAssigned(facultyId, exam.rows[0].course_id);
    await assertPaperOwner(version, facultyId);
    const removed = await db.query(
      'DELETE FROM paper_questions WHERE id=$1 AND version_id=$2 RETURNING id', [paperQuestionId, versionId]);
    if (!removed.rows[0]) throw new NotFoundError('Question is not part of this version');
    const remaining = await db.query(
      'SELECT id FROM paper_questions WHERE version_id=$1 ORDER BY position', [versionId]);
    for (let i = 0; i < remaining.rows.length; i++) {
      await db.query('UPDATE paper_questions SET position=$1, display_no=$2 WHERE id=$3',
        [i + 1, String(i + 1), remaining.rows[i].id]);
    }
    await db.query(
      `UPDATE paper_versions SET total_marks=(SELECT coalesce(sum(marks),0) FROM paper_questions WHERE version_id=$1) WHERE id=$1`,
      [versionId]);
    await logAudit({ actorId: facultyId, action: 'PAPER_QUESTION_REMOVED', entityType: 'paper_version',
      entityId: versionId, metadata: { paperQuestionId }, ip }, db);
  });
}

async function submitVersion(versionId, facultyId, ip) {
  return withTransaction(async (db) => {
    const lock = await db.query(
      `SELECT v.*, p.set_code, p.exam_id, p.created_by AS paper_owner, e.name AS exam_name, e.max_marks,
              e.duration_minutes, e.exam_date, e.instructions, e.course_id,
              c.code AS course_code, c.title AS course_title, c.department_id
         FROM paper_versions v
         JOIN question_papers p ON p.id=v.paper_id
         JOIN examinations e ON e.id=p.exam_id
         JOIN courses c ON c.id=e.course_id
        WHERE v.id=$1 FOR UPDATE`, [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');
    if (version.status !== 'DRAFT') throw new ValidationError('Only draft versions can be submitted');
    await academics.assertFacultyAssigned(facultyId, version.course_id);
    await assertPaperOwner(version, facultyId);

    const questions = (await db.query(
      'SELECT * FROM paper_questions WHERE version_id=$1 ORDER BY position', [versionId])).rows;
    if (!questions.length) throw new ValidationError('Add at least one question before submitting');
    const total = Number(version.total_marks);
    if (Math.abs(total - Number(version.max_marks)) > 0.005) {
      throw new ValidationError(`Paper total is ${total}, but the examination is out of ${Number(version.max_marks)}`);
    }

    const pdf = await generatePaperPdf({
      paper: { id: version.paper_id, set_code: version.set_code },
      version: { version_no: version.version_no },
      exam: {
        name: version.exam_name, exam_date: version.exam_date, duration_minutes: version.duration_minutes,
        max_marks: version.max_marks, instructions: version.instructions
      },
      course: { code: version.course_code, title: version.course_title },
      questions
    });
    // If the department has an active subject head, the paper waits for their
    // approval/veto before it reaches the reviewer queue.
    const head = await db.query(
      `SELECT 1 FROM users u JOIN roles r ON r.id=u.role_id
        WHERE r.code='SUBJECT_HEAD' AND u.is_active AND u.department_id=$1 LIMIT 1`,
      [version.department_id]);
    const nextStatus = head.rows[0] ? 'SUBMITTED' : 'UNDER_REVIEW';
    const { rows } = await db.query(
      `UPDATE paper_versions SET status=$1, submitted_at=now(), draft_saved_at=now(),
              pdf_path=$2, pdf_sha256=$3
        WHERE id=$4 RETURNING *`, [nextStatus, pdf.relPath, pdf.sha256, versionId]);
    await logAudit({ actorId: facultyId, action: 'PAPER_SUBMITTED', entityType: 'paper_version',
      entityId: versionId, metadata: { total, nextStatus }, ip }, db);
    return rows[0];
  });
}

/** Explicitly persist a draft (teachers can do this repeatedly before submitting). */
async function saveDraft(versionId, facultyId, ip) {
  return withTransaction(async (db) => {
    const lock = await db.query(
      `SELECT v.*, e.course_id, p.created_by AS paper_owner
         FROM paper_versions v
         JOIN question_papers p ON p.id=v.paper_id
         JOIN examinations e ON e.id=p.exam_id
        WHERE v.id=$1 FOR UPDATE`, [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');
    if (version.status !== 'DRAFT') throw new ValidationError('Only draft versions can be saved');
    await academics.assertFacultyAssigned(facultyId, version.course_id);
    await assertPaperOwner(version, facultyId);
    const { rows } = await db.query(
      `UPDATE paper_versions
          SET draft_saved_at=now(),
              total_marks=(SELECT coalesce(sum(marks),0) FROM paper_questions WHERE version_id=$1)
        WHERE id=$1 RETURNING *`, [versionId]);
    await logAudit({ actorId: facultyId, action: 'PAPER_DRAFT_SAVED', entityType: 'paper_version',
      entityId: versionId, metadata: { total: Number(rows[0].total_marks) }, ip }, db);
    return rows[0];
  });
}

/** The teacher signs off an approved paper; the controller cannot release before this. */
async function finalizeVersion(versionId, facultyId, ip) {
  return withTransaction(async (db) => {
    const lock = await db.query(
      `SELECT v.*, e.course_id, p.created_by AS paper_owner
         FROM paper_versions v
         JOIN question_papers p ON p.id=v.paper_id
         JOIN examinations e ON e.id=p.exam_id
        WHERE v.id=$1 FOR UPDATE`, [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');
    if (version.status !== 'APPROVED') {
      throw new ValidationError('Only an approved paper can be finalized');
    }
    if (version.is_finalized) throw new ValidationError('This paper is already finalized');
    await academics.assertFacultyAssigned(facultyId, version.course_id);
    await assertPaperOwner(version, facultyId);
    const { rows } = await db.query(
      `UPDATE paper_versions SET is_finalized=true WHERE id=$1 RETURNING *`, [versionId]);
    await logAudit({ actorId: facultyId, action: 'PAPER_FINALIZED', entityType: 'paper_version',
      entityId: versionId, metadata: { paperId: version.paper_id }, ip }, db);
    return rows[0];
  });
}

async function reviewVersion(versionId, reviewerId, decision, comments, ip) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw new ValidationError('Invalid review decision');
  if (decision === 'REJECTED' && !(comments || '').trim()) {
    throw new ValidationError('Comments are required when rejecting a paper');
  }
  return withTransaction(async (db) => {
    const lock = await db.query('SELECT * FROM paper_versions WHERE id=$1 FOR UPDATE', [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');
    // The subject head must approve a submitted paper before it reaches the
    // reviewer queue, so reviewers only ever act on UNDER_REVIEW versions.
    if (version.status !== 'UNDER_REVIEW') {
      throw new ValidationError('This version is not awaiting reviewer approval');
    }
    if (decision === 'APPROVED') {
      try {
        await db.query(
          `UPDATE paper_versions SET status='APPROVED', approved_at=now() WHERE id=$1`, [versionId]);
      } catch (e) {
        if (e.code === '23505') throw new ValidationError('Another version of this paper is already live');
        throw e;
      }
    } else {
      await db.query(`UPDATE paper_versions SET status='REJECTED' WHERE id=$1`, [versionId]);
    }
    await db.query(
      `INSERT INTO paper_approvals(version_id, reviewer_id, decision, comments) VALUES ($1,$2,$3,$4)`,
      [versionId, reviewerId, decision, (comments || '').trim() || null]);
    await logAudit({ actorId: reviewerId, action: `PAPER_${decision}`, entityType: 'paper_version',
      entityId: versionId, metadata: { comments: (comments || '').slice(0, 500) }, ip }, db);
    return { ...version, status: decision };
  });
}

/**
 * Papers in a department, with the latest head decision, for subject-head and
 * department-head supervision screens.
 */
async function listForHead(departmentId) {
  const { rows } = await query(
    `SELECT p.id AS paper_id, p.set_code, p.created_at,
            e.id AS exam_id, e.name AS exam_name, e.exam_date, e.max_marks, e.status AS exam_status,
            c.code AS course_code, c.title AS course_title, d.name AS department_name,
            v.id AS version_id, v.version_no, v.status AS version_status, v.total_marks,
            v.submitted_at, v.approved_at, v.is_finalized, v.draft_saved_at,
            u.full_name AS teacher_name,
            h.decision AS head_decision, h.comments AS head_comments, h.decided_at AS head_decided_at,
            (SELECT count(*)::int FROM paper_comments pc WHERE pc.paper_id=p.id) AS comment_count
       FROM question_papers p
       JOIN examinations e ON e.id=p.exam_id
       JOIN courses c ON c.id=e.course_id
       JOIN departments d ON d.id=c.department_id
       JOIN users u ON u.id=p.created_by
       LEFT JOIN LATERAL (
         SELECT * FROM paper_versions pv WHERE pv.paper_id=p.id ORDER BY pv.version_no DESC LIMIT 1
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT hr.decision, hr.comments, hr.decided_at
           FROM paper_head_reviews hr WHERE hr.version_id=v.id
          ORDER BY hr.decided_at DESC LIMIT 1
       ) h ON true
      WHERE c.department_id=$1
      ORDER BY e.exam_date DESC, p.set_code`, [departmentId]);
  return rows;
}

/**
 * Subject-head decision. Approval moves the paper into the reviewer queue;
 * a veto sends it back to the teacher and clears any teacher finalization.
 * A head may veto SUBMITTED, UNDER_REVIEW or APPROVED versions.
 */
async function headReviewVersion(versionId, headId, decision, comments, ip) {
  if (!['APPROVED', 'VETOED'].includes(decision)) throw new ValidationError('Invalid head review decision');
  if (decision === 'VETOED' && !(comments || '').trim()) {
    throw new ValidationError('Explain why you are vetoing this paper');
  }
  return withTransaction(async (db) => {
    const lock = await db.query(
      `SELECT v.*, p.id AS paper_id, p.created_by AS paper_owner,
              e.course_id, c.department_id
         FROM paper_versions v
         JOIN question_papers p ON p.id=v.paper_id
         JOIN examinations e ON e.id=p.exam_id
         JOIN courses c ON c.id=e.course_id
        WHERE v.id=$1 FOR UPDATE`, [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');

    const head = await db.query(
      `SELECT u.department_id FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.id=$1 AND u.is_active AND r.code = 'SUBJECT_HEAD'`, [headId]);
    if (!head.rows[0]) throw new ForbiddenError('Only the subject head can approve or veto a paper.');
    if (Number(head.rows[0].department_id) !== Number(version.department_id)) {
      throw new ForbiddenError('This paper belongs to another department. You can only review papers in your department.');
    }
    if (Number(version.paper_owner) === Number(headId)) {
      throw new ForbiddenError('You cannot review your own paper. Ask another head to review it.');
    }

    if (decision === 'APPROVED') {
      if (version.status !== 'SUBMITTED') {
        throw new ValidationError('Only submitted papers can be approved by the head');
      }
    } else if (!['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(version.status)) {
      throw new ValidationError('This paper can no longer be vetoed');
    }

    const nextStatus = decision === 'APPROVED' ? 'UNDER_REVIEW' : 'REJECTED';
    await db.query(
      `UPDATE paper_versions
          SET status=$1,
              is_finalized = CASE WHEN $1 = 'REJECTED' THEN false ELSE is_finalized END
        WHERE id=$2`, [nextStatus, versionId]);
    await db.query(
      `INSERT INTO paper_head_reviews(version_id, head_id, decision, comments)
       VALUES ($1,$2,$3,$4)`,
      [versionId, headId, decision, (comments || '').trim() || null]);
    await logAudit({ actorId: headId, action: decision === 'APPROVED' ? 'PAPER_HEAD_APPROVED' : 'PAPER_HEAD_VETOED',
      entityType: 'paper_version', entityId: versionId,
      metadata: { paperId: version.paper_id, comments: (comments || '').slice(0, 500) }, ip }, db);
    return { ...version, status: nextStatus };
  });
}

async function releaseVersion(versionId, controllerId, note, ip) {
  return withTransaction(async (db) => {
    const lock = await db.query(
      `SELECT v.*, e.status AS exam_status FROM paper_versions v
         JOIN question_papers p ON p.id=v.paper_id JOIN examinations e ON e.id=p.exam_id
        WHERE v.id=$1 FOR UPDATE`, [versionId]);
    const version = lock.rows[0];
    if (!version) throw new NotFoundError('Paper version not found');
    if (version.status !== 'APPROVED') throw new ValidationError('Only approved versions can be released');
    if (!version.is_finalized) {
      throw new ValidationError('The subject teacher must finalize this paper before it can be released');
    }
    if (version.exam_status === 'CLOSED') throw new ValidationError('This examination is closed');
    await db.query(
      `INSERT INTO paper_releases(version_id, released_by, note) VALUES ($1,$2,$3)`,
      [versionId, controllerId, (note || '').trim() || null]);
    await db.query(`UPDATE paper_versions SET status='RELEASED_FOR_PRINTING' WHERE id=$1`, [versionId]);
    await logAudit({ actorId: controllerId, action: 'PAPER_RELEASED', entityType: 'paper_version',
      entityId: versionId, metadata: { paperId: version.paper_id }, ip }, db);
    return { ...version, status: 'RELEASED_FOR_PRINTING' };
  });
}

async function ensureVersionPdf(versionId) {
  const detail = await getVersionDetail(versionId);
  if (detail.pdf_path) {
    try {
      const absPath = resolveStoragePath(detail.pdf_path);
      if (fs.existsSync(absPath)) return { detail, absPath };
    } catch { /* regenerate below */ }
  }
  const pdf = await generatePaperPdf({
    paper: { id: detail.paper_id, set_code: detail.set_code },
    version: { version_no: detail.version_no },
    exam: {
      name: detail.exam_name, exam_date: detail.exam_date, duration_minutes: detail.duration_minutes,
      max_marks: detail.max_marks, instructions: detail.instructions
    },
    course: { code: detail.course_code, title: detail.course_title },
    questions: detail.questions
  });
  await query('UPDATE paper_versions SET pdf_path=$1, pdf_sha256=$2 WHERE id=$3',
    [pdf.relPath, pdf.sha256, versionId]);
  return { detail: { ...detail, pdf_path: pdf.relPath, pdf_sha256: pdf.sha256 }, absPath: pdf.absPath };
}

async function listForReview() {
  const { rows } = await query(
    `SELECT v.id, v.version_no, v.status, v.total_marks, v.submitted_at,
            p.id AS paper_id, p.set_code, e.name AS exam_name, e.exam_date, e.max_marks,
            c.code AS course_code, c.title AS course_title, u.full_name AS submitted_by
       FROM paper_versions v
       JOIN question_papers p ON p.id=v.paper_id
       JOIN examinations e ON e.id=p.exam_id
       JOIN courses c ON c.id=e.course_id
       JOIN users u ON u.id=v.created_by
      WHERE v.status = 'UNDER_REVIEW'
      ORDER BY v.submitted_at ASC NULLS LAST`);
  return rows;
}

async function listReleased() {
  const { rows } = await query(
    `SELECT v.id, v.version_no, v.total_marks, p.set_code,
            e.id AS exam_id, e.name AS exam_name, e.exam_date, e.max_marks, e.status AS exam_status,
            c.code AS course_code, c.title AS course_title,
            r.released_at, r.note, u.full_name AS released_by
       FROM paper_versions v
       JOIN question_papers p ON p.id=v.paper_id
       JOIN examinations e ON e.id=p.exam_id
       JOIN courses c ON c.id=e.course_id
       JOIN paper_releases r ON r.version_id=v.id
       JOIN users u ON u.id=r.released_by
      WHERE v.status='RELEASED_FOR_PRINTING'
      ORDER BY r.released_at DESC`);
  return rows;
}

/** The version a script should be evaluated against: released first, then approved, then latest. */
async function versionForEvaluation(paperId) {
  const { rows } = await query(
    `SELECT * FROM paper_versions WHERE paper_id=$1
      ORDER BY CASE status
        WHEN 'RELEASED_FOR_PRINTING' THEN 0 WHEN 'APPROVED' THEN 1
        WHEN 'SUBMITTED' THEN 2 WHEN 'UNDER_REVIEW' THEN 3 WHEN 'REJECTED' THEN 4 ELSE 5 END,
        version_no DESC LIMIT 1`, [paperId]);
  return rows[0] || null;
}

module.exports = {
  SET_CODES,
  listExamsForFaculty,
  listPapersForFaculty,
  listAllPapers,
  getPaperDetail,
  getVersionDetail,
  assertFacultyVersion,
  createPaper,
  createRevision,
  getBuilder,
  addQuestion,
  removeQuestion,
  submitVersion,
  saveDraft,
  finalizeVersion,
  headReviewVersion,
  listForHead,
  reviewVersion,
  releaseVersion,
  ensureVersionPdf,
  listForReview,
  listReleased,
  versionForEvaluation
};
