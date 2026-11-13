// Read-side supervision for subject heads and department heads.
const { query } = require('../../config/database');
const { ForbiddenError, NotFoundError } = require('../../config/errors');
const papers = require('../question-papers/question-papers.service');
const paperCollab = require('../paper-collab/paper-collab.service');
const marksheets = require('../marksheets/marksheets.service');
const logistics = require('../logistics/logistics.service');

async function userDepartmentId(userId) {
  const { rows } = await query(
    `SELECT u.department_id, u.full_name, r.code AS role
       FROM users u JOIN roles r ON r.id=u.role_id
      WHERE u.id=$1`, [userId]);
  if (!rows[0]) throw new NotFoundError('User not found');
  return rows[0].department_id;
}

async function assertPaperInDepartment(paperId, departmentId) {
  const paper = await paperCollab.getPaper(paperId);
  if (Number(paper.department_id) !== Number(departmentId)) {
    throw new ForbiddenError('This paper belongs to another department. Head access is limited to your department.');
  }
  return paper;
}

async function paperDetail(paperId, departmentId) {
  const paper = await assertPaperInDepartment(paperId, departmentId);
  const [detail, comments, access] = await Promise.all([
    papers.getPaperDetail(paperId),
    paperCollab.listComments(paperId),
    paperCollab.accessSummary(paperId)
  ]);
  return { paper, ...detail, comments, ...access };
}

async function overview(departmentId) {
  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM question_papers p JOIN examinations e ON e.id=p.exam_id
          JOIN courses c ON c.id=e.course_id WHERE c.department_id=$1) AS paper_count,
       (SELECT count(*)::int FROM paper_versions v JOIN question_papers p ON p.id=v.paper_id
          JOIN examinations e ON e.id=p.exam_id JOIN courses c ON c.id=e.course_id
         WHERE c.department_id=$1 AND v.status='SUBMITTED') AS awaiting_head,
       (SELECT count(*)::int FROM paper_versions v JOIN question_papers p ON p.id=v.paper_id
          JOIN examinations e ON e.id=p.exam_id JOIN courses c ON c.id=e.course_id
         WHERE c.department_id=$1 AND v.status='APPROVED') AS approved_papers,
       (SELECT count(*)::int FROM paper_versions v JOIN question_papers p ON p.id=v.paper_id
          JOIN examinations e ON e.id=p.exam_id JOIN courses c ON c.id=e.course_id
         WHERE c.department_id=$1 AND v.status='REJECTED') AS rejected_papers,
       (SELECT count(*)::int FROM examinations e JOIN courses c ON c.id=e.course_id
         WHERE c.department_id=$1) AS exam_count,
       (SELECT count(*)::int FROM exam_marks m JOIN examinations e ON e.id=m.exam_id
          JOIN courses c ON c.id=e.course_id WHERE c.department_id=$1) AS mark_rows,
       (SELECT count(*)::int FROM seating_allocations s JOIN examinations e ON e.id=s.exam_id
          JOIN courses c ON c.id=e.course_id WHERE c.department_id=$1) AS seat_rows,
       (SELECT count(*)::int FROM invigilations i JOIN examinations e ON e.id=i.exam_id
          JOIN courses c ON c.id=e.course_id WHERE c.department_id=$1) AS invigilation_rows,
       (SELECT count(*)::int FROM users u JOIN roles r ON r.id=u.role_id
         WHERE r.code='FACULTY' AND u.is_active AND u.department_id=$1) AS faculty_count,
       (SELECT count(*)::int FROM students s WHERE s.is_active AND s.department_id=$1) AS student_count`,
    [departmentId]);
  const counts = rows[0];
  const [headPapers, comments] = await Promise.all([
    papers.listForHead(departmentId),
    query(
      `SELECT pc.body, pc.created_at, u.full_name AS author_name, r.code AS author_role,
              p.set_code, e.name AS exam_name, p.id AS paper_id
         FROM paper_comments pc
         JOIN users u ON u.id=pc.author_id
         JOIN roles r ON r.id=u.role_id
         JOIN question_papers p ON p.id=pc.paper_id
         JOIN examinations e ON e.id=p.exam_id
         JOIN courses c ON c.id=e.course_id
        WHERE c.department_id=$1
        ORDER BY pc.created_at DESC LIMIT 8`, [departmentId])
  ]);
  return {
    counts,
    headPapers,
    comments: comments.rows
  };
}

async function listMarksheets(departmentId) {
  return marksheets.listExamsForDepartment(departmentId);
}

async function getMarksheet(examId, departmentId) {
  return marksheets.getSheet(examId, { departmentId });
}

async function listLogistics(departmentId) {
  return logistics.listExamsForDepartment(departmentId);
}

async function getLogistics(examId, departmentId) {
  return logistics.getPlan(examId, { departmentId });
}

module.exports = {
  userDepartmentId,
  assertPaperInDepartment,
  paperDetail,
  overview,
  listMarksheets,
  getMarksheet,
  listLogistics,
  getLogistics
};
