// Sidebar items per role. Menu visibility is cosmetic; every route enforces RBAC server-side.
const NAV = {
  ADMIN: [['Dashboard', '/dashboard'], ['Users', '/admin/users'], ['Departments & Courses', '/admin/academics'], ['Audit Log', '/admin/audit']],
  CONTROLLER: [['Dashboard', '/dashboard'], ['Examinations', '/controller/exams'], ['Paper Releases', '/controller/papers'], ['Answer Scripts', '/controller/scripts'], ['Marks', '/controller/marks'], ['Results', '/controller/results']],
  FACULTY: [['Dashboard', '/dashboard'], ['Question Bank', '/faculty/questions'], ['Question Papers', '/faculty/papers'], ['My Evaluations', '/faculty/evaluations']],
  REVIEWER: [['Dashboard', '/dashboard'], ['Papers to Review', '/reviewer/papers']],
  PRINTING: [['Dashboard', '/dashboard'], ['Released Papers', '/printing/papers']],
  VERIFIER: [['Dashboard', '/dashboard'], ['Marks to Verify', '/verifier/marks'], ['Results', '/controller/results']]
};
module.exports = { NAV };
