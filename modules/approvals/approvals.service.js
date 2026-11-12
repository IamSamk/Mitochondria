const { query } = require('../../config/database');
const papers = require('../question-papers/question-papers.service');

async function listQueue() {
  return papers.listForReview();
}

async function recentDecisions(reviewerId, limit = 15) {
  const { rows } = await query(
    `SELECT a.id, a.decision, a.comments, a.decided_at,
            v.id AS version_id, v.version_no, p.set_code,
            e.name AS exam_name, e.exam_date,
            c.code AS course_code, c.title AS course_title
       FROM paper_approvals a
       JOIN paper_versions v ON v.id = a.version_id
       JOIN question_papers p ON p.id = v.paper_id
       JOIN examinations e ON e.id = p.exam_id
       JOIN courses c ON c.id = e.course_id
      WHERE a.reviewer_id = $1
      ORDER BY a.decided_at DESC
      LIMIT $2`, [reviewerId, limit]);
  return rows;
}

module.exports = { listQueue, recentDecisions };
