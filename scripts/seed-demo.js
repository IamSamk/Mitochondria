// Seeds a COMPLETE, realistic demo dataset into the database pointed at by
// DATABASE_URL (works for local Postgres and Supabase/Neon hosted Postgres).
//
// Usage:
//   $env:DATABASE_URL="postgres://..."; $env:NODE_ENV="production"; node scripts/seed-demo.js
//
// Or on Vercel: set SEED_DEMO_DATA=true and run `pnpm db:seed:demo` as a build step.
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { pool, isConfigured } = require('../config/database');
const { migrate } = require('./migrate');
const { seed } = require('./seed');

async function q(text, params) { return pool.query(text, params); }

async function main() {
  if (!isConfigured) {
    console.error('DATABASE_URL is not set. Add it to .env or the environment, then re-run.');
    process.exit(1);
  }

  console.log('[demo] applying migrations…');
  const applied = await migrate();
  console.log(applied.length ? `[demo] applied: ${applied.join(', ')}` : '[demo] schema up to date');

  console.log('[demo] seeding roles + base demo data…');
  await seed({ demo: true });

  // Look up seeded ids.
  const dept = (await q("SELECT id FROM departments WHERE code='CSE'")).rows[0].id;
  const course = (await q("SELECT id FROM courses WHERE code='CS101'")).rows[0].id;
  const controller = (await q("SELECT id FROM users WHERE email='controller@college.test'")).rows[0].id;
  const faculty = (await q("SELECT id FROM users WHERE email='faculty1@college.test'")).rows[0].id;
  const subjectHead = (await q("SELECT id FROM users WHERE email='subjecthead@college.test'")).rows[0].id;

  // A realistic, future-dated examination.
  const existingExam = (await q("SELECT id FROM examinations WHERE name='Midterm Examination - Data Structures'")).rows[0];
  const examId = existingExam ? existingExam.id : (await q(
    `INSERT INTO examinations (course_id, name, exam_type, exam_date, duration_minutes, max_marks, instructions, created_by)
     VALUES ($1,$2,'MIDTERM','2027-03-15T09:00:00Z',120,50,$3,$4) RETURNING id`,
    [course, 'Midterm Examination - Data Structures', 'Answer all five questions. Each question carries 10 marks.', controller])).rows[0].id;

  // A handful of realistic questions contributed by faculty.
  const questions = [
    ['DESCRIPTIVE', 'Explain the difference between a stack and a queue, with one real-world example for each.', 10, 'EASY', 'Stack: LIFO (plates). Queue: FIFO (ticket line).'],
    ['DESCRIPTIVE', 'Describe how a binary search tree maintains its ordering invariant and what happens on insertion.', 10, 'MEDIUM', 'Left subtree < node < right subtree; insert by walking down from root.'],
    ['DESCRIPTIVE', 'Compare quicksort and mergesort: time complexity, space complexity, and stability.', 10, 'MEDIUM', 'Quicksort O(n log n) avg, O(n^2) worst, in-place; mergesort O(n log n), O(n) space, stable.'],
    ['SHORT', 'What is the height of a balanced binary tree with n nodes?', 5, 'EASY', 'floor(log2 n).'],
    ['SHORT', 'Define amortized analysis in the context of a dynamic array.', 5, 'HARD', 'Average cost per operation over a sequence, despite occasional expensive resizes.'],
    ['DESCRIPTIVE', 'Design an algorithm to detect a cycle in a linked list and explain its time and space complexity.', 10, 'HARD', 'Floyd tortoise-and-hare: O(n) time, O(1) space.']
  ];
  for (const [type, body, marks, diff, key] of questions) {
    const exists = (await q('SELECT id FROM questions WHERE body=$1', [body])).rows[0];
    if (exists) continue;
    await q(
      `INSERT INTO questions (course_id, question_type, body, marks, difficulty, model_answer, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [course, type, body, marks, diff, key, faculty]);
  }

  // A notification so the student portal is not empty.
  const studentUser = (await q("SELECT id FROM users WHERE email='student1@college.test'")).rows[0];
  if (studentUser) {
    const exists = (await q("SELECT id FROM notifications WHERE user_id=$1 AND type='EXAM_SCHEDULED' AND title LIKE 'New exam scheduled: Midterm%'", [studentUser.id])).rows[0];
    if (!exists) {
      await q(
        `INSERT INTO notifications (user_id, type, title, body, link)
         VALUES ($1,'EXAM_SCHEDULED','New exam scheduled: Midterm Examination - Data Structures',
                 'Midterm Examination - Data Structures on 2027-03-15 (120 min).','/student/exams')`,
        [studentUser.id]);
    }
  }
  const annExists = (await q("SELECT id FROM announcements WHERE title='Welcome to the examination platform'")).rows[0];
  if (!annExists) {
    await q(
      `INSERT INTO announcements (title, body, department_id, created_by)
       VALUES ($1,$2,$3,$4)`,
      ['Welcome to the examination platform',
       'All midterm examinations are scheduled. Check your timetable and seat assignment in the student portal.',
       dept, controller]);
  }

  console.log('[demo] done. Demo password for all accounts: Demo@12345');
  await pool.end();
}

main().catch(async (e) => { console.error('[demo] failed:', e); await pool.end().catch(() => {}); process.exit(1); });
