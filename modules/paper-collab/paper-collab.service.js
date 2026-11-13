// Cross-role paper collaboration: comments, download access control,
// 15-minute freeze after unauthorised attempts, and optional download password.
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../../config/database');
const { AppError, ForbiddenError, NotFoundError, ValidationError } = require('../../config/errors');
const { logAudit } = require('../audit/audit.service');
const papers = require('../question-papers/question-papers.service');

const LOCK_MINUTES = 15;

async function userContext(userId) {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.department_id, r.code AS role
       FROM users u JOIN roles r ON r.id=u.role_id
      WHERE u.id=$1`, [userId]);
  return rows[0] || null;
}

async function getPaper(paperId) {
  const { rows } = await query(
    `SELECT p.id, p.exam_id, p.set_code, p.created_by, p.download_password_hash,
            e.name AS exam_name, e.status AS exam_status, e.course_id,
            c.code AS course_code, c.title AS course_title, c.department_id,
            d.name AS department_name, u.full_name AS teacher_name
       FROM question_papers p
       JOIN examinations e ON e.id=p.exam_id
       JOIN courses c ON c.id=e.course_id
       JOIN departments d ON d.id=c.department_id
       JOIN users u ON u.id=p.created_by
      WHERE p.id=$1`, [paperId]);
  if (!rows[0]) throw new NotFoundError('Question paper not found');
  return rows[0];
}

async function activeLock(paperId) {
  const { rows } = await query(
    `SELECT l.*, u.full_name AS locked_by_name
       FROM paper_download_locks l
       LEFT JOIN users u ON u.id=l.locked_by
      WHERE l.paper_id=$1 AND l.locked_until > now()`, [paperId]);
  return rows[0] || null;
}

async function recordAttempt(paperId, userId, ip, outcome) {
  await query(
    `INSERT INTO paper_download_attempts(paper_id, user_id, ip_address, outcome)
     VALUES ($1,$2,$3,$4)`, [paperId, userId || null, ip || null, outcome]);
}

async function lockPaper(paperId, userId, reason) {
  await query(
    `INSERT INTO paper_download_locks(paper_id, locked_until, locked_by, reason)
     VALUES ($1, now() + ($2 || ' minutes')::interval, $3, $4)
     ON CONFLICT (paper_id) DO UPDATE
       SET locked_until=EXCLUDED.locked_until, locked_by=EXCLUDED.locked_by,
           reason=EXCLUDED.reason, created_at=now()`,
    [paperId, LOCK_MINUTES, userId || null, reason]);
}

/** Owner/admin can lift a freeze after reviewing the recorded attempts. */
async function clearLock(paperId, user, ip) {
  const paper = await getPaper(paperId);
  const ctx = await userContext(user.id);
  const canClear = ctx.role === 'ADMIN' || Number(paper.created_by) === Number(user.id);
  if (!canClear) throw new ForbiddenError('Only the paper owner or an administrator can clear a download freeze. Ask the paper owner to clear it.');
  await withTransaction(async (db) => {
    await db.query('DELETE FROM paper_download_locks WHERE paper_id=$1', [paperId]);
    await logAudit({ actorId: user.id, action: 'PAPER_DOWNLOAD_LOCK_CLEARED', entityType: 'question_paper',
      entityId: paperId, ip }, db);
  });
}

async function listDownloadAttempts(paperId, limit = 30) {
  const { rows } = await query(
    `SELECT a.*, u.full_name AS user_name, u.email AS user_email, r.code AS user_role
       FROM paper_download_attempts a
       LEFT JOIN users u ON u.id=a.user_id
       LEFT JOIN roles r ON r.id=u.role_id
      WHERE a.paper_id=$1
      ORDER BY a.created_at DESC
      LIMIT $2`, [paperId, limit]);
  return rows;
}

async function setDownloadPassword(paperId, user, password, ip) {
  const paper = await getPaper(paperId);
  const ctx = await userContext(user.id);
  const canSet = ctx.role === 'ADMIN' || Number(paper.created_by) === Number(user.id);
  if (!canSet) throw new ForbiddenError('Only the paper owner or an administrator can set a download password.');
  const clean = String(password || '').trim();
  if (clean && clean.length < 6) throw new ValidationError('The download password must be at least 6 characters');
  const hash = clean ? await bcrypt.hash(clean, 10) : null;
  await withTransaction(async (db) => {
    await db.query('UPDATE question_papers SET download_password_hash=$1 WHERE id=$2', [hash, paperId]);
    await logAudit({ actorId: user.id, action: clean ? 'PAPER_DOWNLOAD_PASSWORD_SET' : 'PAPER_DOWNLOAD_PASSWORD_CLEARED',
      entityType: 'question_paper', entityId: paperId, ip }, db);
  });
}

function roleMayDownload(role, status, sameDepartment) {
  if (role === 'ADMIN') return true;
  if (role === 'REVIEWER') {
    return ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'RELEASED_FOR_PRINTING'].includes(status);
  }
  if (role === 'CONTROLLER') return ['APPROVED', 'RELEASED_FOR_PRINTING'].includes(status);
  if (role === 'PRINTING') return status === 'RELEASED_FOR_PRINTING';
  if (role === 'SUBJECT_HEAD' || role === 'DEPARTMENT_HEAD') {
    // Heads supervise papers once they leave the teacher's draft.
    return sameDepartment && status !== 'DRAFT';
  }
  return false;
}

/**
 * Central download gate used by every role's route. Returns the generated PDF
 * for authorised users. Unauthorised attempts are recorded and freeze the
 * paper for 15 minutes; if the owner set a password the caller gets a
 * PASSWORD_REQUIRED error first so the UI can prompt without penalising anyone.
 */
async function requestDownload(versionId, user, { password = '' } = {}, ip = null) {
  const version = await papers.getVersionDetail(versionId);
  const paperId = version.paper_id;
  const ctx = await userContext(user.id);
  const role = (ctx && ctx.role) || user.role;
  const isOwner = Number(version.paper_owner) === Number(user.id);
  const isAdmin = role === 'ADMIN';

  const lock = await activeLock(paperId);
  if (lock && !isAdmin) {
    await recordAttempt(paperId, user.id, ip, 'LOCKED');
    const until = new Date(lock.locked_until).toISOString().slice(0, 16).replace('T', ' ');
    throw new ForbiddenError(
      `Downloads for this paper are frozen until ${until} UTC after an unauthorised access attempt.`);
  }

  const sameDepartment = Boolean(ctx && ctx.department_id &&
    String(ctx.department_id) === String(version.department_id));
  let allowed = isAdmin || isOwner || roleMayDownload(role, version.status, sameDepartment);

  if (!allowed) {
    if (!version.download_password_hash) {
      await recordAttempt(paperId, user.id, ip, 'DENIED');
      await lockPaper(paperId, user.id, 'Unauthorised download attempt');
      throw new ForbiddenError(
        'You are not authorised to download this paper. The attempt was recorded and downloads are frozen for 15 minutes.');
    }
    if (!password) {
      // No penalty for simply opening the prompt; a wrong password is the signal.
      throw new AppError(401, 'PASSWORD_REQUIRED', 'This paper is password protected');
    }
    const ok = await bcrypt.compare(String(password), version.download_password_hash);
    if (!ok) {
      await recordAttempt(paperId, user.id, ip, 'BAD_PASSWORD');
      await lockPaper(paperId, user.id, 'Incorrect paper download password');
      throw new ForbiddenError(
        'Incorrect download password. The attempt was recorded and downloads are frozen for 15 minutes.');
    }
    allowed = true;
  }

  if (!allowed) throw new ForbiddenError('You do not have access to this paper. Ask the subject teacher for access.');
  const { detail, absPath } = await papers.ensureVersionPdf(versionId);
  return { detail, absPath };
}

async function assertCommentAccess(paperId, user) {
  const paper = await getPaper(paperId);
  const ctx = await userContext(user.id);
  const role = ctx && ctx.role;
  const owner = Number(paper.created_by) === Number(user.id);
  const sameDepartment = Boolean(ctx && ctx.department_id &&
    String(ctx.department_id) === String(paper.department_id));
  const allowed = role === 'ADMIN' || owner ||
    ((role === 'SUBJECT_HEAD' || role === 'DEPARTMENT_HEAD') && sameDepartment) ||
    role === 'REVIEWER' || role === 'CONTROLLER';
  if (!allowed) throw new ForbiddenError('You cannot comment on this paper. Only staff involved with this paper can comment.');
  return paper;
}

async function listComments(paperId) {
  const { rows } = await query(
    `SELECT c.*, u.full_name AS author_name, r.code AS author_role,
            pq.display_no AS question_no
       FROM paper_comments c
       JOIN users u ON u.id=c.author_id
       JOIN roles r ON r.id=u.role_id
       LEFT JOIN paper_questions pq ON pq.id=c.paper_question_id
      WHERE c.paper_id=$1
      ORDER BY c.created_at ASC, c.id ASC`, [paperId]);
  return rows;
}

async function addComment({ paperId, versionId = null, paperQuestionId = null, body }, user, ip) {
  const text = String(body || '').trim();
  if (!text) throw new ValidationError('Write a comment before posting');
  if (text.length > 5000) throw new ValidationError('Comments are limited to 5,000 characters');
  const paper = await assertCommentAccess(paperId, user);

  let version = null;
  if (versionId) {
    const { rows } = await query('SELECT * FROM paper_versions WHERE id=$1 AND paper_id=$2', [versionId, paperId]);
    version = rows[0] || null;
    if (!version) throw new ValidationError('That version does not belong to this paper');
  }
  if (paperQuestionId) {
    const { rows } = await query(
      `SELECT q.id, q.version_id FROM paper_questions q
         JOIN paper_versions v ON v.id=q.version_id
        WHERE q.id=$1 AND v.paper_id=$2`, [paperQuestionId, paperId]);
    if (!rows[0]) throw new ValidationError('That question does not belong to this paper');
    versionId = rows[0].version_id;
  }

  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO paper_comments(paper_id, version_id, paper_question_id, author_id, body)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [paperId, versionId || null, paperQuestionId || null, user.id, text]);
    await logAudit({ actorId: user.id, action: 'PAPER_COMMENT_ADDED', entityType: 'question_paper',
      entityId: paperId, metadata: { versionId: versionId || null, paperQuestionId: paperQuestionId || null,
        excerpt: text.slice(0, 200) }, ip }, db);
    return rows[0];
  });
}

/** Everything the paper detail page needs to explain access state. */
async function accessSummary(paperId) {
  const [lock, attempts] = await Promise.all([
    activeLock(paperId),
    listDownloadAttempts(paperId, 15)
  ]);
  return { downloadLock: lock, downloadAttempts: attempts };
}

module.exports = {
  LOCK_MINUTES,
  getPaper,
  activeLock,
  clearLock,
  listDownloadAttempts,
  setDownloadPassword,
  requestDownload,
  listComments,
  addComment,
  accessSummary
};
