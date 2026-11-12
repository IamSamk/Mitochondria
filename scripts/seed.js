// Seeds roles plus SYNTHETIC demo data. Safe to re-run (idempotent).
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');

const ROLES = [
  [1, 'ADMIN', 'System Administrator', 'Manages users, roles, departments, courses'],
  [2, 'CONTROLLER', 'Examination Controller', 'Manages exams, releases papers, uploads/allocates scripts, monitors progress'],
  [3, 'FACULTY', 'Faculty', 'Creates questions and papers, evaluates allocated scripts'],
  [4, 'REVIEWER', 'Question Paper Reviewer', 'Approves or rejects submitted papers'],
  [5, 'PRINTING', 'Printing Coordinator', 'Accesses only released approved papers'],
  [6, 'VERIFIER', 'Marks Verifier', 'Verifies and finalizes marks'],
  [7, 'SUBJECT_HEAD', 'Subject Head', 'Supervises papers and marks, approves or vetoes paper finalization'],
  [8, 'DEPARTMENT_HEAD', 'Department Head', 'Read-only supervision of the whole department'],
  [9, 'STUDENT', 'Student', 'Views exams, results, seat assignment; applies for revaluation']
];

const DEMO_PASSWORD = 'Demo@12345'; // synthetic demo accounts only

async function seed({ demo = true } = {}) {
  for (const [id, code, name, description] of ROLES) {
    await pool.query(
      `INSERT INTO roles(id, code, name, description) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, name=EXCLUDED.name, description=EXCLUDED.description`,
      [id, code, name, description]);
  }
  if (!demo) return;

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const dept = (await pool.query(
    `INSERT INTO departments(code, name) VALUES ('CSE','Computer Science and Engineering')
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;

  const users = [
    ['admin@college.test', 'Demo Admin', 1],
    ['controller@college.test', 'Demo Controller', 2],
    ['faculty1@college.test', 'Demo Faculty One', 3],
    ['faculty2@college.test', 'Demo Faculty Two', 3],
    ['reviewer@college.test', 'Demo Reviewer', 4],
    ['printing@college.test', 'Demo Printing Coordinator', 5],
    ['verifier@college.test', 'Demo Marks Verifier', 6],
    ['subjecthead@college.test', 'Demo Subject Head', 7],
    ['depthead@college.test', 'Demo Department Head', 8],
    ['student1@college.test', 'Demo Student One', 9]
  ];
  const ids = {};
  for (const [email, name, role] of users) {
    ids[email] = (await pool.query(
      `INSERT INTO users(email, full_name, password_hash, role_id, department_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`,
      [email, name, hash, role, dept])).rows[0].id;
  }

  const courses = [['CS101', 'Data Structures'], ['CS102', 'Database Systems']];
  const courseIds = [];
  for (const [code, title] of courses) {
    courseIds.push((await pool.query(
      `INSERT INTO courses(department_id, code, title, credits) VALUES ($1,$2,$3,4)
       ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title RETURNING id`, [dept, code, title])).rows[0].id);
  }
  await pool.query(`INSERT INTO faculty_courses(faculty_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [ids['faculty1@college.test'], courseIds[0]]);
  await pool.query(`INSERT INTO faculty_courses(faculty_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [ids['faculty2@college.test'], courseIds[1]]);

  for (let i = 1; i <= 10; i++) {
    await pool.query(
      `INSERT INTO students(student_code, full_name, department_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [`S2026${String(i).padStart(3, '0')}`, `Synthetic Student ${i}`, dept]);
  }
  await pool.query(
    `UPDATE students SET user_id=$1, email=$2 WHERE student_code='S2026001'`,
    [ids['student1@college.test'], 'student1@college.test']);
}

module.exports = { seed, ROLES, DEMO_PASSWORD };

if (require.main === module) {
  seed()
    .then(() => { console.log(`Seeded. Demo password for all demo accounts: ${DEMO_PASSWORD}`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
