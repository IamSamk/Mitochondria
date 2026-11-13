// Demo scenario data: walks synthetic examinations through every workflow state so each
// role has something real to look at and act on. It drives the app's own routes
// in-process (like the integration tests), so audit logs, paper snapshots, totals and
// notifications are produced by the real code, not hand-written rows.
//
// Usage (local Postgres or a hosted DB such as Supabase/Neon):
//   pnpm db:seed:demo
//   $env:DATABASE_URL="postgres://..."; pnpm db:seed:demo      (PowerShell, hosted DB)
// Not run by the Vercel build (too many round trips to a distant DB); run it from a terminal.
// Applies migrations and base seed first, then the scenarios. The scenarios run once per
// database: they are skipped if the marker examination already exists.

// Requests never leave this process. Outside production the session cookie is not
// marked Secure, which the in-process HTTP client needs; nothing is served.
if (require.main === module && process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'development';

require('dotenv').config({ quiet: true });
const { PDFDocument } = require('pdf-lib');
const { query, pool, isConfigured } = require('../config/database');

const MARKER_EXAM = 'CS101 Data Structures - Midterm 2026';
const PASSWORD = 'Demo@12345';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
let request;
let app;
let ipSeq = 10;
const extractCsrf = (html) => (html.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];
const idFrom = (location, re) => {
  const m = String(location || '').match(re);
  if (!m) throw new Error(`Unexpected redirect: ${location}`);
  return Number(m[1]);
};

/** Signed-in session for a demo account. Each gets its own client IP so the login limiter isn't shared. */
async function as(email) {
  const agent = request.agent(app).set('X-Forwarded-For', `10.77.0.${ipSeq++}`);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form')
    .send({ _csrf: extractCsrf(page.text), email, password: PASSWORD });
  if (res.status !== 302 || /\/login/.test(res.headers.location || '')) throw new Error(`Login failed for ${email}`);
  const home = await agent.get('/dashboard').redirects(3);
  const csrf = extractCsrf(home.text);
  if (!csrf) throw new Error(`No CSRF token after login for ${email}`);
  return { email, agent, csrf };
}

/** Fail loudly if the page the action redirected to shows an error flash. */
async function checkRedirect(who, path, res, expectedWarning = null) {
  if (res.status >= 400) throw new Error(`${who.email} POST ${path} -> ${res.status}`);
  if (res.status !== 302) return res;
  const next = await who.agent.get(res.headers.location);
  const err = next.text.match(/class="alert alert-danger"[^>]*>([\s\S]*?)<\/div>/);
  if (err && !(expectedWarning && expectedWarning.test(err[1]))) throw new Error(`${who.email} POST ${path} failed: ${err[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
  return res;
}

async function post(who, path, data = {}, expectedWarning = null) {
  const res = await who.agent.post(path).type('form').send({ _csrf: who.csrf, ...data });
  return checkRedirect(who, path, res, expectedWarning);
}

async function uploadScript(controller, { examId, studentId, paperId, pages, expectedPages, label }) {
  const res = await controller.agent.post('/controller/scripts')
    .field('_csrf', controller.csrf)
    .field('examId', String(examId))
    .field('studentId', String(studentId))
    .field('paperId', String(paperId))
    .field('expectedPages', String(expectedPages))
    .attach('script', await makePdf(pages, label), `${label}.pdf`);
  // An incomplete scan is accepted but flagged with a warning; that is the expected outcome.
  await checkRedirect(controller, '/controller/scripts', res, pages !== expectedPages ? /cannot be verified until corrected/ : null);
  return idFrom(res.headers.location, /\/controller\/scripts\/(\d+)$/);
}

async function makePdf(pages, label) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage();
    page.drawText(`SYNTHETIC ANSWER SCRIPT - ${label}`, { x: 50, y: 780, size: 14 });
    page.drawText(`Page ${i + 1} of ${pages}`, { x: 50, y: 755, size: 11 });
    page.drawText('Demo data only. No real student work.', { x: 50, y: 735, size: 10 });
  }
  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// Data lookups
// ---------------------------------------------------------------------------
const one = async (sql, params) => (await query(sql, params)).rows[0];
const userId = async (email) => Number((await one('SELECT id FROM users WHERE email=$1', [email])).id);
const courseId = async (code) => Number((await one('SELECT id FROM courses WHERE code=$1', [code])).id);
const studentsOf = async (deptCode) => (await query(
  `SELECT s.id, s.student_code FROM students s JOIN departments d ON d.id = s.department_id
    WHERE d.code = $1 AND s.is_active ORDER BY s.student_code`, [deptCode])).rows;
const isoDaysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 16);

// ---------------------------------------------------------------------------
// Question banks. Each bank's first five questions make a 20-mark paper:
// MCQ 2 + MCQ 2 + SHORT 4 + SHORT 4 + DESCRIPTIVE 8.
// ---------------------------------------------------------------------------
const mcq = (body, options, correct, unit, difficulty = 'EASY') =>
  ({ questionType: 'MCQ', body, marks: 2, difficulty, unit, options, correct });
const short = (body, unit, marks = 4, difficulty = 'MEDIUM') =>
  ({ questionType: 'SHORT', body, marks, difficulty, unit, modelAnswer: `Key points expected for: ${body}` });
const desc = (body, unit, marks = 8, difficulty = 'HARD') =>
  ({ questionType: 'DESCRIPTIVE', body, marks, difficulty, unit, modelAnswer: `Marking scheme: definition, worked example, analysis for: ${body}` });

const BANKS = {
  CS101: [
    mcq('Which data structure follows Last-In-First-Out order?', ['Queue', 'Stack', 'Heap', 'Graph'], 1, 'Unit 1'),
    mcq('What is the worst-case time complexity of binary search on a sorted array of n items?', ['O(1)', 'O(n)', 'O(log n)', 'O(n log n)'], 2, 'Unit 1'),
    short('Explain how a circular queue avoids wasted space compared to a linear array queue.', 'Unit 2'),
    short('Write the steps to insert a node at the head of a singly linked list.', 'Unit 2'),
    desc('Compare AVL trees and red-black trees: balancing rules, rotations, and when you would prefer each.', 'Unit 3'),
    mcq('Which traversal of a binary search tree visits keys in sorted order?', ['Pre-order', 'In-order', 'Post-order', 'Level-order'], 1, 'Unit 3', 'MEDIUM'),
    short('What is a hash collision? Describe two strategies to resolve it.', 'Unit 4', 5),
    short('Define the height and depth of a node in a tree with an example.', 'Unit 3', 3, 'EASY'),
    desc('Explain Dijkstra\'s algorithm with a worked example on a five-vertex weighted graph.', 'Unit 5', 10),
    desc('Describe heap sort, prove its O(n log n) bound, and state whether it is stable.', 'Unit 4'),
    // Questions from the earlier showcase seed.
    { questionType: 'DESCRIPTIVE', body: 'Explain the difference between a stack and a queue, with one real-world example for each.', marks: 10, difficulty: 'EASY', modelAnswer: 'Stack: LIFO (plates). Queue: FIFO (ticket line).' },
    { questionType: 'DESCRIPTIVE', body: 'Describe how a binary search tree maintains its ordering invariant and what happens on insertion.', marks: 10, difficulty: 'MEDIUM', modelAnswer: 'Left subtree < node < right subtree; insert by walking down from root.' },
    { questionType: 'DESCRIPTIVE', body: 'Compare quicksort and mergesort: time complexity, space complexity, and stability.', marks: 10, difficulty: 'MEDIUM', modelAnswer: 'Quicksort O(n log n) avg, O(n^2) worst, in-place; mergesort O(n log n), O(n) space, stable.' },
    { questionType: 'SHORT', body: 'What is the height of a balanced binary tree with n nodes?', marks: 5, difficulty: 'EASY', modelAnswer: 'floor(log2 n).' },
    { questionType: 'SHORT', body: 'Define amortized analysis in the context of a dynamic array.', marks: 5, difficulty: 'HARD', modelAnswer: 'Average cost per operation over a sequence, despite occasional expensive resizes.' },
    { questionType: 'DESCRIPTIVE', body: 'Design an algorithm to detect a cycle in a linked list and explain its time and space complexity.', marks: 10, difficulty: 'HARD', modelAnswer: 'Floyd tortoise-and-hare: O(n) time, O(1) space.' }
  ],
  CS102: [
    mcq('Which normal form removes transitive dependencies?', ['1NF', '2NF', '3NF', 'BCNF'], 2, 'Unit 2'),
    mcq('Which SQL clause filters groups after aggregation?', ['WHERE', 'HAVING', 'GROUP BY', 'ORDER BY'], 1, 'Unit 1'),
    short('Explain the difference between a primary key and a candidate key.', 'Unit 1'),
    short('What does the isolation property of ACID guarantee? Give one anomaly it prevents.', 'Unit 4'),
    desc('Normalize the given order-management relation up to BCNF, showing each functional dependency you use.', 'Unit 2'),
    mcq('Which index structure is most common for range queries in relational databases?', ['Hash index', 'B+ tree', 'Bitmap', 'Trie'], 1, 'Unit 3', 'MEDIUM'),
    short('Write an SQL query to list departments with more than five employees.', 'Unit 1', 4, 'EASY'),
    desc('Explain two-phase locking and show how it ensures conflict serializability.', 'Unit 4', 10)
  ],
  CS201: [
    mcq('Which scheduling algorithm can cause starvation of long processes?', ['FCFS', 'Round Robin', 'Shortest Job First', 'FIFO'], 2, 'Unit 2'),
    mcq('Thrashing is primarily caused by:', ['Too few page frames per process', 'A fast disk', 'Large TLB', 'Small page tables'], 0, 'Unit 4'),
    short('List the four necessary conditions for deadlock.', 'Unit 3'),
    short('Differentiate between a process and a thread.', 'Unit 1'),
    desc('Simulate the Banker\'s algorithm for the given allocation matrix and decide whether the state is safe.', 'Unit 3'),
    short('Explain the purpose of a translation lookaside buffer.', 'Unit 4', 4, 'EASY'),
    desc('Compare FIFO, LRU and Optimal page replacement on a reference string of length 12.', 'Unit 4', 10)
  ],
  CS202: [
    mcq('Which layer of the OSI model handles routing?', ['Data link', 'Network', 'Transport', 'Session'], 1, 'Unit 1'),
    mcq('TCP uses which mechanism for flow control?', ['Sliding window', 'Token passing', 'CSMA/CD', 'Checksum'], 0, 'Unit 3'),
    short('Explain the three-way handshake in TCP.', 'Unit 3'),
    short('What is subnetting? Subnet 192.168.10.0/24 into four equal subnets.', 'Unit 2'),
    desc('Compare distance-vector and link-state routing with an example of count-to-infinity.', 'Unit 2')
  ],
  EC101: [
    mcq('A system is causal if its output depends only on:', ['Future inputs', 'Present and past inputs', 'Past inputs only', 'Random inputs'], 1, 'Unit 1'),
    mcq('The Fourier transform of a unit impulse is:', ['Zero', 'A constant', 'An impulse', 'A ramp'], 1, 'Unit 3'),
    short('State and explain the sampling theorem.', 'Unit 4'),
    short('Define linearity and time invariance with one example each.', 'Unit 1'),
    desc('Find the convolution of two rectangular pulses and sketch the result.', 'Unit 2')
  ],
  ME101: [
    mcq('The first law of thermodynamics is a statement of:', ['Conservation of mass', 'Conservation of energy', 'Entropy increase', 'Heat transfer rate'], 1, 'Unit 1'),
    short('Define a thermodynamic system and classify its types.', 'Unit 1')
  ]
};

const BANK_OWNER = {
  CS101: 'faculty1@college.test', CS102: 'faculty2@college.test', CS201: 'faculty3@college.test',
  CS202: 'faculty3@college.test', EC101: 'faculty5@college.test', ME101: 'faculty6@college.test'
};

async function createQuestions(sessions, code) {
  const who = sessions[BANK_OWNER[code]];
  const cid = await courseId(code);
  const ids = [];
  for (const q of BANKS[code]) {
    const data = {
      courseId: cid, questionType: q.questionType, body: q.body, marks: q.marks,
      difficulty: q.difficulty, unit: q.unit || '', modelAnswer: q.modelAnswer || ''
    };
    if (q.options) {
      data.optionLabel = q.options.map((_, i) => String.fromCharCode(65 + i));
      data.optionBody = q.options;
      data.correctOption = String(q.correct);
    }
    await post(who, '/faculty/questions', data);
    ids.push(Number((await one('SELECT id FROM questions WHERE course_id=$1 AND body=$2 ORDER BY id DESC LIMIT 1', [cid, q.body])).id));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Workflow building blocks
// ---------------------------------------------------------------------------
async function createExam(controller, code, name, { examType, examDate, maxMarks, durationMinutes = 120, deadlines = false }) {
  const data = {
    courseId: await courseId(code), name, examType, examDate, durationMinutes, maxMarks,
    instructions: 'Answer all questions. Write your student code on every page. Use of electronic devices is not permitted.'
  };
  if (deadlines) {
    data.paperDeadline = isoDaysFromNow(10);
    data.evaluationDeadline = isoDaysFromNow(40);
  }
  const res = await post(controller, '/controller/exams', data);
  return idFrom(res.headers.location, /\/controller\/exams\/(\d+)$/);
}

async function advanceExam(controller, examId, ...statuses) {
  for (const status of statuses) await post(controller, `/controller/exams/${examId}/status`, { status });
}

/** New paper set with the given questions, optionally saved as a draft. Returns { paperId, versionId }. */
async function buildPaper(faculty, examId, setCode, questionIds, sections = ['Section A', 'Section A', 'Section B', 'Section B', 'Section C']) {
  const res = await post(faculty, '/faculty/papers/new', { examId, setCode });
  const versionId = idFrom(res.headers.location, /\/versions\/(\d+)\/builder$/);
  for (let i = 0; i < questionIds.length; i++) {
    await post(faculty, `/faculty/papers/versions/${versionId}/questions`,
      { questionId: questionIds[i], sectionTitle: sections[i] || 'Section A' });
  }
  const paperId = Number((await one('SELECT paper_id FROM paper_versions WHERE id=$1', [versionId])).paper_id);
  return { paperId, versionId };
}

const submitPaper = (f, v) => post(f, `/faculty/papers/versions/${v}/submit`);
const headReview = (h, v, decision, comments) => post(h, `/head/papers/${v}/head-review`, { decision, comments });
// The page after a rejection permanently shows "was rejected" in red; that is expected there.
const reviewerDecision = (r, v, decision, comments) => post(r, `/reviewer/papers/${v}/decision`, { decision, comments },
  decision === 'REJECTED' ? /was rejected/ : null);
const finalizePaper = (f, v, paperId) => post(f, `/faculty/papers/versions/${v}/finalize`, { paperId });
const releasePaper = (c, v, note) => post(c, `/controller/papers/${v}/release`, { note });

async function markEvaluation(faculty, evaluationId, versionId, fraction, action, remarks) {
  const pqs = (await query('SELECT id, marks FROM paper_questions WHERE version_id=$1 ORDER BY position', [versionId])).rows;
  const data = { remarks };
  pqs.forEach((pq, i) => {
    // Vary marks per question but keep them within the maximum, rounded to 0.5.
    const wobble = [0, 0.15, -0.1, 0.05, -0.2][i % 5];
    const f = Math.min(1, Math.max(0, fraction + wobble));
    data[`mark_${pq.id}`] = String(Math.round(Number(pq.marks) * f * 2) / 2);
    if (i === pqs.length - 1) data[`comment_${pq.id}`] = fraction > 0.7 ? 'Well structured answer.' : 'Analysis is incomplete.';
  });
  await post(faculty, `/faculty/evaluations/${evaluationId}/${action}`, data);
}

async function enterMarksheet(faculty, examId, students, maxMarks, seed) {
  const data = {};
  students.forEach((s, i) => {
    const f = 0.35 + (((i * 37 + seed * 11) % 60) / 100); // 35%-95%, deterministic
    data[`mark_${s.id}`] = String(Math.round(maxMarks * f * 2) / 2);
  });
  await post(faculty, `/faculty/marksheets/${examId}`, data);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function seedDemo({ log = console.log } = {}) {
  if (await one('SELECT id FROM examinations WHERE name=$1', [MARKER_EXAM])) {
    log('[demo] Demo scenarios already present; skipping.');
    return { skipped: true };
  }
  request = require('supertest');
  app = require('../app');

  const emails = [
    'admin@college.test', 'controller@college.test', 'reviewer@college.test', 'printing@college.test',
    'verifier@college.test', 'subjecthead@college.test', 'subjecthead.ece@college.test',
    'faculty1@college.test', 'faculty2@college.test', 'faculty3@college.test', 'faculty4@college.test',
    'faculty5@college.test', 'faculty6@college.test',
    'student1@college.test', 'student2@college.test', 'student3@college.test'
  ];
  const s = {};
  for (const e of emails) s[e] = await as(e);
  const controller = s['controller@college.test'];
  const reviewer = s['reviewer@college.test'];
  const verifier = s['verifier@college.test'];
  const head = s['subjecthead@college.test'];
  const f1 = s['faculty1@college.test'];
  const f2 = s['faculty2@college.test'];
  const f3 = s['faculty3@college.test'];
  const f4 = s['faculty4@college.test'];
  const f5 = s['faculty5@college.test'];
  const f6 = s['faculty6@college.test'];

  log('[demo] Question banks');
  const bank = {};
  for (const code of Object.keys(BANKS)) bank[code] = await createQuestions(s, code);
  const paper20 = (code) => bank[code].slice(0, 5);

  const cse = await studentsOf('CSE');
  const ece = await studentsOf('ECE');

  // A. CS101 Midterm: paper released, scripts in every evaluation state. -----
  log('[demo] A. CS101 Midterm: full valuation pipeline');
  const examA = await createExam(controller, 'CS101', MARKER_EXAM,
    { examType: 'MIDTERM', examDate: '2026-10-20', maxMarks: 20, durationMinutes: 90 });
  await advanceExam(controller, examA, 'PAPER_PREPARATION');
  const pA = await buildPaper(f1, examA, 'A', paper20('CS101'));
  await post(f1, `/faculty/papers/versions/${pA.versionId}/save`);
  await submitPaper(f1, pA.versionId);
  await headReview(head, pA.versionId, 'APPROVED', 'Coverage across units 1-3 is balanced.');
  await reviewerDecision(reviewer, pA.versionId, 'APPROVED', 'Clear wording; marks add up.');
  await finalizePaper(f1, pA.versionId, pA.paperId);
  await releasePaper(controller, pA.versionId, 'Print 60 copies for Hall A and Hall B.');
  await advanceExam(controller, examA, 'CONDUCTED', 'EVALUATION');

  // A teacher from another course tries to download the paper: refused, logged, 15-min freeze.
  await f3.agent.get(`/papers/versions/${pA.versionId}/download`);
  await post(f1, `/papers/${pA.paperId}/lock/clear`, { returnTo: `/faculty/papers/${pA.paperId}` });

  const f1Id = await userId('faculty1@college.test');
  const f4Id = await userId('faculty4@college.test');
  // [target state, evaluator, score fraction]
  const plan = [
    ['FINALIZED', f1, 0.82], ['FINALIZED', f1, 0.64], ['FINALIZED', f1, 0.91], ['FINALIZED', f1, 0.47],
    ['FINALIZED', f4, 0.73], ['FINALIZED', f4, 0.58],
    ['VERIFIED', f1, 0.69], ['VERIFIED', f4, 0.88],
    ['SUBMITTED', f1, 0.55], ['SUBMITTED', f4, 0.77],
    ['REOPENED', f1, 0.61],
    ['DRAFT', f1, 0.5],
    ['ALLOCATED', f4],
    ['REALLOCATED', f4],
    ['VERIFIED_UNALLOCATED'],
    ['UPLOADED'],
    ['ON_HOLD']
  ];
  for (let i = 0; i < plan.length; i++) {
    const [state, evaluator, fraction] = plan[i];
    const st = cse[i];
    const incomplete = state === 'ON_HOLD';
    const scriptId = await uploadScript(controller, {
      examId: examA, studentId: st.id, paperId: pA.paperId,
      pages: incomplete ? 3 : 4, expectedPages: 4, label: `${st.student_code} CS101 Midterm`
    });
    if (state === 'UPLOADED') continue;
    if (incomplete) {
      await post(controller, `/controller/scripts/${scriptId}/hold`, { reason: 'Page 4 missing from scan; rescan requested from exam cell.' },
        /cannot be verified until corrected/);
      continue;
    }
    await post(controller, `/controller/scripts/${scriptId}/verify`);
    if (state === 'VERIFIED_UNALLOCATED') continue;
    if (state === 'REALLOCATED') {
      await post(controller, `/controller/scripts/${scriptId}/allocate`, { facultyId: f1Id });
      await post(controller, `/controller/scripts/${scriptId}/allocate`, { facultyId: f4Id, reason: 'Balancing evaluation load between CS101 teachers.' });
      continue;
    }
    const evaluatorId = evaluator === f1 ? f1Id : f4Id;
    await post(controller, `/controller/scripts/${scriptId}/allocate`, { facultyId: evaluatorId });
    if (state === 'ALLOCATED') continue;

    const start = await post(evaluator, `/faculty/evaluations/scripts/${scriptId}/start`);
    const evId = idFrom(start.headers.location, /\/faculty\/evaluations\/(\d+)$/);
    if (state === 'DRAFT') {
      await markEvaluation(evaluator, evId, pA.versionId, fraction, 'draft', 'Halfway through; Q5 still to mark.');
      continue;
    }
    await markEvaluation(evaluator, evId, pA.versionId, fraction, 'submit', 'Evaluated as per scheme.');
    if (state === 'SUBMITTED') continue;
    if (state === 'REOPENED') {
      await post(verifier, `/verifier/marks/${evId}/reopen`, { reason: 'Q3 marks exceed what the answer supports; please re-check.' });
      continue;
    }
    await post(verifier, `/verifier/marks/${evId}/verify`);
    if (state === 'VERIFIED') continue;
    await post(controller, `/controller/marks/${evId}/finalize`);
  }

  // B. CS102 Midterm: three paper sets at different review stages. -----------
  log('[demo] B. CS102 Midterm: paper review queue');
  const examB = await createExam(controller, 'CS102', 'CS102 Database Systems - Midterm 2026',
    { examType: 'MIDTERM', examDate: '2026-11-28', maxMarks: 20, deadlines: true });
  await advanceExam(controller, examB, 'PAPER_PREPARATION');
  const bA = await buildPaper(f2, examB, 'A', paper20('CS102'));
  await submitPaper(f2, bA.versionId);
  await headReview(head, bA.versionId, 'APPROVED', 'Good spread of SQL and theory.'); // -> reviewer queue
  const bB = await buildPaper(f2, examB, 'B', paper20('CS102'));
  await submitPaper(f2, bB.versionId); // -> subject head queue
  const bC = await buildPaper(f2, examB, 'C', paper20('CS102'));
  await submitPaper(f2, bC.versionId);
  await headReview(head, bC.versionId, 'APPROVED', 'Fine from the department side.');
  await reviewerDecision(reviewer, bC.versionId, 'REJECTED', 'Set C repeats Set A word for word. Replace at least two questions.');
  await post(f2, `/papers/${bC.paperId}/comments`, { body: 'Will swap Q3 and Q5 for new questions in the revision.', returnTo: `/faculty/papers/${bC.paperId}` });
  await post(head, `/papers/${bC.paperId}/comments`, { body: 'Consider the two-phase locking question from the bank for Q5.', returnTo: `/head/papers/${bC.paperId}` });
  const revC = await post(f2, `/faculty/papers/${bC.paperId}/revisions`);
  const bC2 = idFrom(revC.headers.location, /\/versions\/(\d+)\/builder$/);
  await post(f2, `/faculty/papers/versions/${bC2}/save`); // revision left as a draft for the tester

  // C. CS201 End Sem: approved papers waiting on the teacher and the controller.
  log('[demo] C. CS201 End Semester: finalize + release queue');
  const examC = await createExam(controller, 'CS201', 'CS201 Operating Systems - End Semester 2026',
    { examType: 'FINAL', examDate: '2026-12-08', maxMarks: 20, durationMinutes: 180, deadlines: true });
  await advanceExam(controller, examC, 'PAPER_PREPARATION');
  for (const [set, finalize] of [['A', false], ['B', true]]) {
    const p = await buildPaper(f3, examC, set, paper20('CS201'));
    await submitPaper(f3, p.versionId);
    await headReview(head, p.versionId, 'APPROVED', 'Approved for review.');
    await reviewerDecision(reviewer, p.versionId, 'APPROVED', 'Approved.');
    if (finalize) await finalizePaper(f3, p.versionId, p.paperId); // B awaits controller release
  }

  // D. CS202 IA1: direct marksheet, seating, invigilation, revaluation. ------
  log('[demo] D. CS202 Internal Assessment: marksheet + revaluation');
  const examD = await createExam(controller, 'CS202', 'CS202 Computer Networks - Internal Assessment 1',
    { examType: 'INTERNAL', examDate: '2026-11-05', maxMarks: 25, durationMinutes: 60 });
  await post(f3, `/faculty/logistics/${examD}/seating/generate`, { roomName: 'Room 204', capacity: '20' });
  await post(f3, `/faculty/logistics/${examD}/invigilation/generate`);
  await enterMarksheet(f3, examD, cse, 25, 1);
  await advanceExam(controller, examD, 'PAPER_PREPARATION', 'CONDUCTED', 'EVALUATION', 'MARKS_FINALIZED');
  await post(controller, '/revaluation/windows', { examId: examD, opensAt: isoDaysFromNow(-1), closesAt: isoDaysFromNow(14), feeAmount: '500' });
  await post(s['student1@college.test'], '/student/revaluation', { examId: examD, reason: 'I believe question 3 on subnetting was not fully counted.' });
  await post(s['student2@college.test'], '/student/revaluation', { examId: examD, reason: 'Total on the answer sheet does not match the marks uploaded.' });
  await post(s['student3@college.test'], '/student/revaluation', { examId: examD, reason: 'Requesting a recheck of the routing answer.' });
  const reqs = (await query('SELECT r.id, s.student_code FROM revaluation_requests r JOIN students s ON s.id=r.student_id WHERE r.exam_id=$1 ORDER BY s.student_code', [examD])).rows;
  const oldOf = async (code) => Number((await one(
    `SELECT m.marks_obtained FROM exam_marks m JOIN students s ON s.id=m.student_id WHERE m.exam_id=$1 AND s.student_code=$2`, [examD, code])).marks_obtained);
  await post(controller, `/revaluation/${reqs[0].id}/review`, { status: 'APPROVED', newMarks: String(Math.min(25, (await oldOf(reqs[0].student_code)) + 2)), notes: 'Q3 part (b) was missed in totalling. +2.' });
  await post(controller, `/revaluation/${reqs[1].id}/review`, { status: 'UNDER_REVIEW', notes: 'Physical answer sheet requested from the department.' });
  await post(controller, `/revaluation/${reqs[2].id}/review`, { status: 'REJECTED', notes: 'Rechecked; marks were awarded correctly.' });

  // E. CS101 End Sem: upcoming exam with draft paper, seating plan, assembly. -
  log('[demo] E. CS101 End Semester: upcoming exam, templates, assembly');
  const examE = await createExam(controller, 'CS101', 'CS101 Data Structures - End Semester 2026',
    { examType: 'FINAL', examDate: '2026-12-10', maxMarks: 20, durationMinutes: 180, deadlines: true });
  await buildPaper(f1, examE, 'A', bank.CS101.slice(5, 8), ['Section A', 'Section B', 'Section B']); // incomplete draft
  await post(f1, '/faculty/seating-templates/templates', { name: 'Main Hall (8 x 6)', rows: '8', cols: '6', isShared: 'on' });
  await post(f1, '/faculty/seating-templates/templates', { name: 'Lab Block L2 (5 x 6)', rows: '5', cols: '6' });
  const tmpl = (await query(`SELECT id, name FROM room_templates ORDER BY id`)).rows;
  await post(f1, `/faculty/seating-templates/plans/${examE}/rooms`, { templateId: tmpl[0].id, roomNumber: 'MH-1' });
  await post(f1, `/faculty/seating-templates/plans/${examE}/rooms`, { templateId: tmpl[1].id, roomNumber: 'L2-03' });
  await post(f1, `/faculty/seating-templates/plans/${examE}/generate`);
  await post(f1, `/faculty/logistics/${examE}/invigilation/generate`);

  const cid101 = await courseId('CS101');
  const contributions = [
    [f1, 'Explain amortized analysis using a dynamic array that doubles in size.', 'SHORT', 4, 'MEDIUM', 'Analysis'],
    [f1, 'Which structure gives O(1) average lookup by key?', 'MCQ', 2, 'EASY', 'Hashing'],
    [f1, 'Design an LRU cache and justify the data structures you choose.', 'DESCRIPTIVE', 8, 'HARD', 'Design'],
    [f4, 'What is the maximum number of nodes in a binary tree of height h?', 'MCQ', 2, 'EASY', 'Trees'],
    [f4, 'Describe how a trie supports prefix search.', 'SHORT', 4, 'MEDIUM', 'Trees'],
    [f4, 'Compare adjacency matrix and adjacency list representations for sparse graphs.', 'SHORT', 4, 'MEDIUM', 'Graphs'],
    [f4, 'Prove that BFS finds shortest paths in unweighted graphs.', 'DESCRIPTIVE', 8, 'HARD', 'Graphs'],
    [f1, 'Define a data structure.', 'SHORT', 4, 'EASY', 'Basics']
  ];
  for (const [who, body, questionType, marks, difficulty, topic] of contributions) {
    await post(who, '/faculty/assembly/contributions', { courseId: cid101, body, questionType, marks, difficulty, topic, answerKey: 'See marking scheme.' });
  }
  const contribIds = (await query('SELECT id FROM question_contributions WHERE course_id=$1 ORDER BY id', [cid101])).rows.map((r) => r.id);
  for (let i = 0; i < contribIds.length; i++) {
    const good = i !== 7;
    await post(head, `/faculty/assembly/contributions/${contribIds[i]}/review`, {
      clarity: good ? '5' : '2', difficultyAccuracy: good ? '4' : '2', correctness: good ? '5' : '3',
      comments: good ? 'Clear and well pitched.' : 'Too vague for an end-semester paper.'
    });
    if (i < 6) await post(head, `/faculty/assembly/contributions/${contribIds[i]}/status`, { status: 'APPROVED' });
    if (i === 7) await post(head, `/faculty/assembly/contributions/${contribIds[i]}/status`, { status: 'REJECTED' });
    // contribution 6 stays PENDING for the tester to review
  }
  const asm = await post(head, '/faculty/assembly/assemblies', { examId: examE, setCode: 'B' });
  const asmId = idFrom(asm.headers.location, /\/faculty\/assembly\/assemblies\/(\d+)/);
  await post(head, `/faculty/assembly/assemblies/${asmId}/auto`, { totalMarks: '20', easy: '1', medium: '3', hard: '1' });

  // F/G/H. Other departments and upcoming exams. -----------------------------
  log('[demo] F-H. Upcoming exams, ECE marksheet, closed exam, timetable');
  const examF = await createExam(controller, 'CS102', 'CS102 Database Systems - End Semester 2026',
    { examType: 'FINAL', examDate: '2026-12-12', maxMarks: 20, durationMinutes: 180, deadlines: true });
  const examG = await createExam(controller, 'EC101', 'EC101 Signals and Systems - Midterm 2026',
    { examType: 'MIDTERM', examDate: '2026-10-28', maxMarks: 30, durationMinutes: 90 });
  await enterMarksheet(f5, examG, ece, 30, 2);
  await advanceExam(controller, examG, 'PAPER_PREPARATION', 'CONDUCTED', 'EVALUATION', 'MARKS_FINALIZED');
  const examH = await createExam(controller, 'ME101', 'ME101 Engineering Thermodynamics - Quiz 1',
    { examType: 'QUIZ', examDate: '2026-12-05', maxMarks: 10, durationMinutes: 30 });
  // Planned exam from the earlier showcase seed: 5 x 10-mark questions.
  await createExam(controller, 'CS101', 'Midterm Examination - Data Structures',
    { examType: 'MIDTERM', examDate: '2027-03-15', maxMarks: 50 });
  const examI = await createExam(controller, 'CS101', 'CS101 Data Structures - Internal Assessment 1',
    { examType: 'INTERNAL', examDate: '2026-09-15', maxMarks: 25, durationMinutes: 60 });
  await enterMarksheet(f1, examI, cse, 25, 3);
  await advanceExam(controller, examI, 'PAPER_PREPARATION', 'CONDUCTED', 'EVALUATION', 'MARKS_FINALIZED', 'CLOSED');

  for (const [examId, start, end, venue] of [
    [examH, '2026-12-05T10:00', '2026-12-05T10:30', 'MECH Seminar Hall'],
    [examC, '2026-12-08T09:30', '2026-12-08T12:30', 'Main Hall'],
    [examE, '2026-12-10T09:30', '2026-12-10T12:30', 'Main Hall + Lab L2'],
    [examF, '2026-12-12T09:30', '2026-12-12T12:30', 'Main Hall']
  ]) await post(controller, '/timetable/slots', { examId, slotStart: start, slotEnd: end, venue });

  log('[demo] Announcements');
  const eceId = Number((await one(`SELECT id FROM departments WHERE code='ECE'`)).id);
  const cseId = Number((await one(`SELECT id FROM departments WHERE code='CSE'`)).id);
  await post(controller, '/announcements', { title: 'Welcome to the examination platform', body: 'All midterm examinations are scheduled. Check your timetable and seat assignment in the student portal.', departmentId: cseId });
  await post(controller, '/announcements', { title: 'End-semester timetable published', body: 'The December end-semester timetable is now available under Timetable. Report clashes to the exam cell by 20 November.' });
  await post(controller, '/announcements', { title: 'Revaluation open for CS202 Internal Assessment 1', body: 'Students may apply for revaluation from the Revaluation page within the next two weeks. Fee: Rs. 500.', audienceRole: 'STUDENT' });
  await post(s['subjecthead.ece@college.test'], '/announcements', { title: 'ECE: EC101 midterm marks finalized', body: 'EC101 midterm marks are finalized. Contact the department office for queries.', departmentId: eceId });

  // Smoke check: every role's landing page renders with the new data.
  for (const who of Object.values(s)) {
    const res = await who.agent.get('/dashboard').redirects(3);
    if (res.status !== 200) throw new Error(`Dashboard for ${who.email} returned ${res.status}`);
  }

  const counts = await one(`SELECT
    (SELECT count(*) FROM examinations) exams, (SELECT count(*) FROM questions) questions,
    (SELECT count(*) FROM paper_versions) paper_versions, (SELECT count(*) FROM answer_scripts) scripts,
    (SELECT count(*) FROM evaluations) evaluations, (SELECT count(*) FROM exam_marks) marksheet_rows,
    (SELECT count(*) FROM revaluation_requests) revaluations, (SELECT count(*) FROM notifications) notifications`);
  log(`[demo] Done: ${JSON.stringify(counts)}`);
  return counts;
}

module.exports = { seedDemo, MARKER_EXAM };

async function main(log) {
  if (!isConfigured) throw new Error('DATABASE_URL is not set. Add it to .env or the environment, then re-run.');
  const applied = await require('./migrate').migrate();
  log(applied.length ? `[demo] Applied migrations: ${applied.join(', ')}` : '[demo] Schema up to date');
  await require('./seed').seed({ demo: true });
  log('[demo] Roles + base demo data seeded');
  await seedDemo({ log });
  log(`[demo] Demo password for all accounts: ${PASSWORD}`);
}

if (require.main === module) {
  // The app logs one JSON line per request; hide those so the seed output stays readable.
  const original = console.log;
  console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('{"time"'))) original(...args); };
  main(original)
    .then(() => pool.end())
    .catch(async (e) => {
      console.error(`[demo] Failed: ${e.message}`);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
