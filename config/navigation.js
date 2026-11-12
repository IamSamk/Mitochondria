// Sidebar items per role. Menu visibility is cosmetic; every route enforces RBAC server-side.
const NAV = {
  ADMIN: [['Dashboard', '/dashboard'], ['Users', '/admin/users'], ['Students', '/admin/students'], ['Departments & Courses', '/admin/academics'], ['Audit Log', '/admin/audit']],
  CONTROLLER: [['Dashboard', '/dashboard'], ['Examinations', '/controller/exams'], ['Paper Releases', '/controller/papers'], ['Answer Scripts', '/controller/scripts'], ['Marks', '/controller/marks'], ['Results', '/controller/results'], ['Revaluation', '/revaluation']],
  FACULTY: [['Dashboard', '/dashboard'], ['Question Bank', '/faculty/questions'], ['Question Pool', '/faculty/assembly/contributions'], ['Question Papers', '/faculty/papers'], ['Marksheets', '/faculty/marksheets'], ['Seating & Invigilation', '/faculty/logistics'], ['Seating Templates', '/faculty/seating-templates/templates'], ['My Evaluations', '/faculty/evaluations']],
  REVIEWER: [['Dashboard', '/dashboard'], ['Papers to Review', '/reviewer/papers']],
  PRINTING: [['Dashboard', '/dashboard'], ['Released Papers', '/printing/papers']],
  VERIFIER: [['Dashboard', '/dashboard'], ['Marks to Verify', '/verifier/marks'], ['Results', '/controller/results']],
  SUBJECT_HEAD: [['Dashboard', '/dashboard'], ['Department Papers', '/head/papers'], ['Marksheets', '/head/marksheets'], ['Seating & Invigilation', '/head/logistics']],
  DEPARTMENT_HEAD: [['Dashboard', '/dashboard'], ['Department Papers', '/head/papers'], ['Marksheets', '/head/marksheets'], ['Seating & Invigilation', '/head/logistics']],
  STUDENT: [['Dashboard', '/dashboard'], ['My Exams', '/student/exams'], ['My Results', '/student/results'], ['My Seat', '/student/seat'], ['Revaluation', '/student/revaluation'], ['Notifications', '/student/notifications'], ['Announcements', '/announcements']]
};
module.exports = { NAV };

