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
const DEMO_COURSE_CREDITS = 4;
const DEMO_STUDENT_LINK_CODE = 'S2026001';
const LINKED_STUDENT_EMAIL = 'student1@college.test';

async function seed({ demo = true } = {}) {
  for (const [id, code, name, description] of ROLES) {
    await pool.query(
      `INSERT INTO roles(id, code, name, description) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, name=EXCLUDED.name, description=EXCLUDED.description`,
      [id, code, name, description]);
  }
  if (!demo) return;

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const deptIds = {};
  for (const [code, name] of DEPARTMENTS) {
    deptIds[code] = (await pool.query(
      `INSERT INTO departments(code, name) VALUES ($1,$2)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [code, name])).rows[0].id;
  }

  const ids = {};
  for (const [email, name, role, dept, active = true] of DEMO_USER_SEEDS) {
    ids[email] = (await pool.query(
      `INSERT INTO users(email, full_name, password_hash, role_id, department_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name RETURNING id`,
      [email, name, hash, role, deptIds[dept], active])).rows[0].id;
  }

  const courseIds = {};
  for (const [code, title, dept, credits] of DEMO_COURSES) {
    courseIds[code] = (await pool.query(
      `INSERT INTO courses(department_id, code, title, credits) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title RETURNING id`,
      [deptIds[dept], code, title, credits])).rows[0].id;
  }
  for (const [email, code] of FACULTY_COURSES) {
    await pool.query(`INSERT INTO faculty_courses(faculty_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [ids[email], courseIds[code]]);
  }

  for (const s of studentRoster()) {
    await pool.query(
      `INSERT INTO students(student_code, full_name, department_id, is_active) VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_code) DO NOTHING`,
      [s.code, s.name, deptIds[s.dept], s.active]);
  }
  for (const [email, code] of STUDENT_LOGINS) {
    await pool.query(`UPDATE students SET user_id=$1, email=$2 WHERE student_code=$3`, [ids[email], email, code]);
  }
}

// --- Synthetic reference data ---------------------------------------------
// Everything below is invented. Names are random first/last-name pairings.

const DEPARTMENTS = [
  ['CSE', 'Computer Science and Engineering'],
  ['ECE', 'Electronics and Communication Engineering'],
  ['MECH', 'Mechanical Engineering']
];

// [email, full name, role id, department code, active?]
const DEMO_USER_SEEDS = [
  ['admin@college.test', 'Demo Admin', 1, 'CSE'],
  ['controller@college.test', 'Demo Controller', 2, 'CSE'],
  ['faculty1@college.test', 'Demo Faculty One', 3, 'CSE'],
  ['faculty2@college.test', 'Demo Faculty Two', 3, 'CSE'],
  ['reviewer@college.test', 'Demo Reviewer', 4, 'CSE'],
  ['printing@college.test', 'Demo Printing Coordinator', 5, 'CSE'],
  ['verifier@college.test', 'Demo Marks Verifier', 6, 'CSE'],
  ['subjecthead@college.test', 'Demo Subject Head', 7, 'CSE'],
  ['depthead@college.test', 'Demo Department Head', 8, 'CSE'],
  [LINKED_STUDENT_EMAIL, 'Demo Student One', 9, 'CSE'],
  // Extra staff so allocation, re-allocation and cross-department scoping can be tested.
  ['faculty3@college.test', 'Demo Faculty Three', 3, 'CSE'],
  ['faculty4@college.test', 'Demo Faculty Four', 3, 'CSE'],
  ['faculty5@college.test', 'Demo Faculty Five (ECE)', 3, 'ECE'],
  ['faculty6@college.test', 'Demo Faculty Six (MECH)', 3, 'MECH'],
  ['subjecthead.ece@college.test', 'Demo Subject Head (ECE)', 7, 'ECE'],
  ['depthead.ece@college.test', 'Demo Department Head (ECE)', 8, 'ECE'],
  ['former.faculty@college.test', 'Demo Former Faculty (deactivated)', 3, 'CSE', false],
  ['student2@college.test', 'Demo Student Two', 9, 'CSE'],
  ['student3@college.test', 'Demo Student Three', 9, 'CSE'],
  ['student4@college.test', 'Demo Student Four', 9, 'CSE'],
  ['student5@college.test', 'Demo Student Five', 9, 'CSE'],
  ['student.ece@college.test', 'Demo ECE Student', 9, 'ECE']
];

// [code, title, department code, credits]
const DEMO_COURSES = [
  ['CS101', 'Data Structures', 'CSE', DEMO_COURSE_CREDITS],
  ['CS102', 'Database Systems', 'CSE', DEMO_COURSE_CREDITS],
  ['CS201', 'Operating Systems', 'CSE', DEMO_COURSE_CREDITS],
  ['CS202', 'Computer Networks', 'CSE', 3],
  ['EC101', 'Signals and Systems', 'ECE', 4],
  ['EC102', 'Digital Electronics', 'ECE', 3],
  ['ME101', 'Engineering Thermodynamics', 'MECH', 4]
];

const FACULTY_COURSES = [
  ['faculty1@college.test', 'CS101'],
  ['faculty4@college.test', 'CS101'], // second CS101 teacher: script re-allocation, peer review
  ['faculty2@college.test', 'CS102'],
  ['faculty3@college.test', 'CS201'],
  ['faculty3@college.test', 'CS202'],
  ['faculty5@college.test', 'EC101'],
  ['faculty5@college.test', 'EC102'],
  ['faculty6@college.test', 'ME101']
];

const STUDENT_LOGINS = [
  [LINKED_STUDENT_EMAIL, DEMO_STUDENT_LINK_CODE],
  ['student2@college.test', 'S2026002'],
  ['student3@college.test', 'S2026003'],
  ['student4@college.test', 'S2026004'],
  ['student5@college.test', 'S2026005'],
  ['student.ece@college.test', 'E2026001']
];

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Ishaan', 'Kavya', 'Arjun', 'Nisha',
  'Vihaan', 'Pooja', 'Aditya', 'Sneha', 'Rahul', 'Tara', 'Nikhil', 'Riya', 'Karthik', 'Lakshmi'];
const LAST = ['Sharma', 'Rao', 'Iyer', 'Patel', 'Nair', 'Gupta', 'Reddy', 'Menon', 'Das', 'Kulkarni',
  'Joshi', 'Shetty', 'Verma', 'Pillai', 'Hegde'];

/** CSE S2026001-040 (040 inactive), ECE E2026001-015, MECH M2026001-010. Deterministic. */
function studentRoster() {
  const out = [];
  const add = (prefix, dept, count, inactive = []) => {
    for (let i = 1; i <= count; i++) {
      const n = out.length;
      out.push({
        code: `${prefix}2026${String(i).padStart(3, '0')}`,
        name: `${FIRST[(n * 7) % FIRST.length]} ${LAST[(n * 11 + 3) % LAST.length]}`,
        dept,
        active: !inactive.includes(i)
      });
    }
  };
  add('S', 'CSE', 40, [40]);
  add('E', 'ECE', 15);
  add('M', 'MECH', 10);
  return out;
}

module.exports = { seed, ROLES, DEMO_PASSWORD };

if (require.main === module) {
  seed()
    .then(() => { console.log(`Seeded. Demo password for all demo accounts: ${DEMO_PASSWORD}`); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
