// Manual role-by-role POV smoke test against the development database.
// Usage: $env:NODE_ENV='development'; node scripts/role-pov.js
// Covers admin, controller, faculty, reviewer, printing, verifier,
// subject head, department head, and student flows end to end.
const { loginAs, csrfFor } = require('../tests/helpers');
const { query, pool } = require('../config/database');

const results = [];
let currentRole = '';
function ok(name) { results.push(['PASS', currentRole, name]); }
function fail(name, e) { results.push(['FAIL', currentRole, name, e && e.message ? e.message : String(e)]); }
async function check(name, fn) {
  try { await fn(); ok(name); } catch (e) { fail(name, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function status(res, expected) {
  assert(res.status === expected, `expected ${expected}, got ${res.status}`);
  return res;
}
async function as(email) {
  const { agent, res } = await loginAs(email);
  assert(res.status === 302, `login failed for ${email}: ${res.status}`);
  return { agent, csrf: await csrfFor(agent) };
}
async function post(agent, csrf, path, body = {}) {
  return agent.post(path).type('form').send({ _csrf: csrf, ...body });
}
function redirectsTo(res, re) {
  assert(res.status === 302, `expected redirect, got ${res.status}`);
  assert(re.test(res.headers.location || ''), `unexpected redirect: ${res.headers.location}`);
}

(async () => {
  const stamp = Date.now();
  const examName = `Role POV ${stamp}`;

  // ---------- ADMIN ----------
  currentRole = 'ADMIN';
  const admin = await as('admin@college.test');
  await check('dashboard renders', async () => status(await admin.agent.get('/dashboard'), 200));
  await check('users page', async () => status(await admin.agent.get('/admin/users'), 200));
  await check('students page', async () => status(await admin.agent.get('/admin/students'), 200));
  await check('academics page', async () => status(await admin.agent.get('/admin/academics'), 200));
  await check('audit page', async () => status(await admin.agent.get('/admin/audit'), 200));
  await check('denied faculty papers', async () => status(await admin.agent.get('/faculty/papers'), 403));
  await check('denied student portal', async () => status(await admin.agent.get('/student/exams'), 403));

  // ---------- CONTROLLER ----------
  currentRole = 'CONTROLLER';
  const controller = await as('controller@college.test');
  await check('dashboard renders', async () => status(await controller.agent.get('/dashboard'), 200));
  await check('exams page', async () => status(await controller.agent.get('/controller/exams'), 200));
  const course = (await query("SELECT id, department_id FROM courses WHERE code='CS101'")).rows[0];
  const student = (await query("SELECT id, student_code FROM students WHERE student_code='S2026001'")).rows[0];
  const examRes = await post(controller.agent, controller.csrf, '/controller/exams', {
    courseId: course.id, name: examName, examType: 'MIDTERM', examDate: '2027-03-10',
    durationMinutes: 90, maxMarks: 10, instructions: 'Answer all questions.'
  });
  let examId;
  await check('creates an exam', async () => { redirectsTo(examRes, /\/controller\/exams\/\d+$/); examId = Number(examRes.headers.location.split('/').pop()); });
  await check('papers page', async () => status(await controller.agent.get('/controller/papers'), 200));
  await check('scripts page', async () => status(await controller.agent.get('/controller/scripts'), 200));
  await check('marks page', async () => status(await controller.agent.get('/controller/marks'), 200));
  await check('results page', async () => status(await controller.agent.get('/controller/results'), 200));
  await check('revaluation page', async () => status(await controller.agent.get('/revaluation'), 200));
  await check('timetable page', async () => status(await controller.agent.get('/timetable'), 200));
  await check('denied admin', async () => status(await controller.agent.get('/admin/users'), 403));
  await check('denied student portal', async () => status(await controller.agent.get('/student/exams'), 403));

  // ---------- FACULTY ----------
  currentRole = 'FACULTY';
  const faculty = await as('faculty1@college.test');
  await check('dashboard renders', async () => status(await faculty.agent.get('/dashboard'), 200));
  await check('question bank', async () => status(await faculty.agent.get('/faculty/questions'), 200));
  await check('papers page', async () => status(await faculty.agent.get('/faculty/papers'), 200));
  await check('marksheets page', async () => status(await faculty.agent.get('/faculty/marksheets'), 200));
  await check('logistics page', async () => status(await faculty.agent.get('/faculty/logistics'), 200));
  await check('seating templates page', async () => status(await faculty.agent.get('/faculty/seating-templates/templates'), 200));
  await check('question pool page', async () => status(await faculty.agent.get('/faculty/assembly/contributions'), 200));
  await check('evaluations page', async () => status(await faculty.agent.get('/faculty/evaluations'), 200));
  let questionId;
  await check('creates a question', async () => {
    const body = `Explain isolation levels ${stamp}`;
    const r = await post(faculty.agent, faculty.csrf, '/faculty/questions', {
      courseId: course.id, questionType: 'DESCRIPTIVE', body, marks: 10, difficulty: 'MEDIUM'
    });
    redirectsTo(r, /\/faculty\/questions$/);
    questionId = (await query('SELECT id FROM questions WHERE body=$1', [body])).rows[0].id;
  });
  let paperId, versionId;
  await check('creates a paper', async () => {
    const r = await post(faculty.agent, faculty.csrf, '/faculty/papers/new', { examId, setCode: 'D' });
    redirectsTo(r, /\/versions\/\d+\/builder$/);
    versionId = Number(r.headers.location.match(/versions\/(\d+)/)[1]);
    paperId = (await query('SELECT paper_id FROM paper_versions WHERE id=$1', [versionId])).rows[0].paper_id;
  });
  await check('adds a question to the paper', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, `/faculty/papers/versions/${versionId}/questions`, {
      questionId, sectionTitle: 'Section A'
    }), /builder$/);
  });
  await check('saves a draft', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, `/faculty/papers/versions/${versionId}/save`), /builder$/);
  });
  await check('submits the paper', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, `/faculty/papers/versions/${versionId}/submit`), new RegExp(`/faculty/papers/${paperId}$`));
    const row = (await query('SELECT status FROM paper_versions WHERE id=$1', [versionId])).rows[0];
    assert(row.status === 'SUBMITTED', `status ${row.status}`);
  });
  await check('denied admin', async () => status(await faculty.agent.get('/admin/users'), 403));
  await check('denied head', async () => status(await faculty.agent.get('/head/papers'), 403));
  await check('denied student portal', async () => status(await faculty.agent.get('/student/exams'), 403));

  // ---------- DEPARTMENT HEAD (read-only) ----------
  currentRole = 'DEPARTMENT_HEAD';
  const deptHead = await as('depthead@college.test');
  const headPaperUrl = `/head/papers/${paperId}`;
  await check('department papers page', async () => status(await deptHead.agent.get('/head/papers'), 200));
  await check('paper detail page', async () => status(await deptHead.agent.get(headPaperUrl), 200));
  await check('read-only notice on paper', async () => assert((await deptHead.agent.get(headPaperUrl)).text.includes('read-only'), 'missing read-only notice'));
  await check('cannot approve or veto', async () => {
    const r = await post(deptHead.agent, deptHead.csrf, `/head/papers/${versionId}/head-review`, { decision: 'APPROVED', comments: 'Dept head attempt' });
    assert(r.status === 302, `status ${r.status}`);
    const row = (await query('SELECT status FROM paper_versions WHERE id=$1', [versionId])).rows[0];
    assert(row.status === 'SUBMITTED', `status changed to ${row.status}`);
  });
  await check('marksheets page', async () => status(await deptHead.agent.get('/head/marksheets'), 200));
  await check('logistics page', async () => status(await deptHead.agent.get('/head/logistics'), 200));
  await check('denied admin', async () => status(await deptHead.agent.get('/admin/users'), 403));

  // ---------- SUBJECT HEAD ----------
  currentRole = 'SUBJECT_HEAD';
  const subjectHead = await as('subjecthead@college.test');
  await check('department papers page', async () => status(await subjectHead.agent.get('/head/papers'), 200));
  await check('paper detail page', async () => status(await subjectHead.agent.get(headPaperUrl), 200));
  await check('approves the paper', async () => {
    redirectsTo(await post(subjectHead.agent, subjectHead.csrf, `/head/papers/${versionId}/head-review`, {
      decision: 'APPROVED', comments: 'POV head approval'
    }), /\/head\/papers\/\d+$/);
    const row = (await query('SELECT status FROM paper_versions WHERE id=$1', [versionId])).rows[0];
    assert(row.status === 'UNDER_REVIEW', `status ${row.status}`);
  });
  await check('posts a comment', async () => {
    redirectsTo(await post(subjectHead.agent, subjectHead.csrf, `/papers/${paperId}/comments`, {
      body: 'POV comment on the paper', returnTo: headPaperUrl
    }), /\/head\/papers\/\d+$/);
    const row = (await query('SELECT count(*)::int AS n FROM paper_comments WHERE paper_id=$1', [paperId])).rows[0];
    assert(row.n >= 1, 'comment not stored');
  });
  await check('marksheets page', async () => status(await subjectHead.agent.get('/head/marksheets'), 200));
  await check('logistics page', async () => status(await subjectHead.agent.get('/head/logistics'), 200));

  // ---------- REVIEWER ----------
  currentRole = 'REVIEWER';
  const reviewer = await as('reviewer@college.test');
  await check('queue page', async () => status(await reviewer.agent.get('/reviewer/papers'), 200));
  await check('paper detail page', async () => status(await reviewer.agent.get(`/reviewer/papers/${versionId}`), 200));
  await check('approves the paper', async () => {
    const r = await post(reviewer.agent, reviewer.csrf, `/reviewer/papers/${versionId}/decision`, {
      decision: 'APPROVED', comments: 'POV reviewer approval'
    });
    assert(r.status === 302, `status ${r.status}`);
    assert(new RegExp(`/reviewer/papers/${versionId}$`).test(r.headers.location || ''), `unexpected redirect: ${r.headers.location}`);
    const row = (await query('SELECT status FROM paper_versions WHERE id=$1', [versionId])).rows[0];
    assert(row.status === 'APPROVED', `status ${row.status}`);
  });
  await check('denied admin', async () => status(await reviewer.agent.get('/admin/users'), 403));

  // ---------- TEACHER FINALIZE + CONTROLLER RELEASE ----------
  currentRole = 'FACULTY';
  await check('teacher finalizes approved paper', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, `/faculty/papers/versions/${versionId}/finalize`, { paperId }), new RegExp(`/faculty/papers/${paperId}$`));
    const row = (await query('SELECT is_finalized FROM paper_versions WHERE id=$1', [versionId])).rows[0];
    assert(row.is_finalized === true, 'not finalized');
  });
  currentRole = 'CONTROLLER';
  await check('controller releases the paper', async () => {
    redirectsTo(await post(controller.agent, controller.csrf, `/controller/papers/${versionId}/release`, { note: 'POV release' }), /\/controller\/papers$/);
    const row = (await query('SELECT status FROM paper_versions WHERE id=$1', [versionId])).rows[0];
    assert(row.status === 'RELEASED_FOR_PRINTING', `status ${row.status}`);
  });

  // ---------- PRINTING ----------
  currentRole = 'PRINTING';
  const printing = await as('printing@college.test');
  await check('released papers page', async () => {
    const r = status(await printing.agent.get('/printing/papers'), 200);
    assert(r.text.includes(examName), 'released exam not listed');
  });
  await check('downloads released PDF', async () => {
    const r = await printing.agent.get(`/printing/papers/${versionId}/download`);
    assert(r.status === 200, `status ${r.status}`);
    assert(/application\/pdf/.test(r.headers['content-type'] || ''), 'not a PDF');
  });
  await check('denied controller', async () => status(await printing.agent.get('/controller/exams'), 403));

  // ---------- VERIFIER ----------
  currentRole = 'VERIFIER';
  const verifier = await as('verifier@college.test');
  await check('marks queue', async () => status(await verifier.agent.get('/verifier/marks'), 200));
  await check('results page', async () => status(await verifier.agent.get('/controller/results'), 200));
  await check('denied admin', async () => status(await verifier.agent.get('/admin/users'), 403));

  // ---------- STUDENT ----------
  currentRole = 'STUDENT';
  const studentUser = await as('student1@college.test');
  await check('dashboard renders', async () => {
    const r = status(await studentUser.agent.get('/student/dashboard'), 200);
    assert(r.text.includes('Student Dashboard'), 'missing dashboard');
  });
  await check('sees the new exam', async () => {
    const r = status(await studentUser.agent.get('/student/exams'), 200);
    assert(r.text.includes(examName), 'exam not visible');
  });
  await check('results page', async () => status(await studentUser.agent.get('/student/results'), 200));
  await check('seat page', async () => status(await studentUser.agent.get('/student/seat'), 200));
  await check('revaluation page', async () => status(await studentUser.agent.get('/student/revaluation'), 200));
  await check('notifications page', async () => status(await studentUser.agent.get('/student/notifications'), 200));
  await check('announcements page', async () => status(await studentUser.agent.get('/announcements'), 200));
  await check('notification count endpoint', async () => {
    const r = await studentUser.agent.get('/notifications/count').set('Accept', 'application/json');
    assert(r.status === 200 && typeof r.body.data.count === 'number', 'bad count response');
  });
  await check('denied admin', async () => status(await studentUser.agent.get('/admin/users'), 403));
  await check('denied head', async () => status(await studentUser.agent.get('/head/papers'), 403));
  await check('denied faculty', async () => status(await studentUser.agent.get('/faculty/papers'), 403));

  // ---------- MARKSHEET + HEAD READ ----------
  currentRole = 'FACULTY';
  await check('saves marksheet', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, `/faculty/marksheets/${examId}`, { [`mark_${student.id}`]: '8' }), new RegExp(`/faculty/marksheets/${examId}$`));
    const row = (await query('SELECT marks_obtained FROM exam_marks WHERE exam_id=$1 AND student_id=$2', [examId, student.id])).rows[0];
    assert(Number(row.marks_obtained) === 8, `marks ${row.marks_obtained}`);
  });
  currentRole = 'SUBJECT_HEAD';
  await check('head sees marksheet', async () => {
    const r = status(await subjectHead.agent.get(`/head/marksheets/${examId}`), 200);
    assert(r.text.includes(student.student_code), 'student not visible');
  });
  currentRole = 'STUDENT';
  await check('student sees result marks', async () => {
    const r = status(await studentUser.agent.get('/student/results'), 200);
    assert(r.text.includes('8'), 'marks not visible');
  });

  // ---------- REVALUATION FLOW ----------
  currentRole = 'CONTROLLER';
  await check('opens revaluation window', async () => {
    redirectsTo(await post(controller.agent, controller.csrf, '/revaluation/windows', {
      examId, opensAt: '2026-01-01T00:00', closesAt: '2027-12-31T23:59', feeAmount: '0'
    }), /\/revaluation$/);
  });
  currentRole = 'STUDENT';
  await check('applies for revaluation', async () => {
    redirectsTo(await post(studentUser.agent, studentUser.csrf, '/student/revaluation', {
      examId, reason: 'Please recheck question 4'
    }), /\/student\/revaluation$/);
    const row = (await query('SELECT count(*)::int AS n FROM revaluation_requests WHERE exam_id=$1 AND student_id=$2', [examId, student.id])).rows[0];
    assert(row.n === 1, `requests ${row.n}`);
  });
  currentRole = 'CONTROLLER';
  let revalId;
  await check('reviews revaluation request', async () => {
    revalId = (await query('SELECT id FROM revaluation_requests WHERE exam_id=$1 AND student_id=$2', [examId, student.id])).rows[0].id;
    redirectsTo(await post(controller.agent, controller.csrf, `/revaluation/${revalId}/review`, {
      status: 'APPROVED', newMarks: '9', notes: 'Rechecked'
    }), /\/revaluation$/);
    const row = (await query('SELECT status, new_marks FROM revaluation_requests WHERE id=$1', [revalId])).rows[0];
    assert(row.status === 'APPROVED', `status ${row.status}`);
    assert(Number(row.new_marks) === 9, `new marks ${row.new_marks}`);
  });

  // ---------- SEATING TEMPLATES + STUDENT SEAT ----------
  currentRole = 'FACULTY';
  let templateId;
  await check('creates a seating template', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, '/faculty/seating-templates/templates', {
      name: `POV Template ${stamp}`, rows: '4', cols: '5'
    }), /\/faculty\/seating-templates\/templates$/);
    templateId = (await query("SELECT id FROM room_templates WHERE name=$1", [`POV Template ${stamp}`])).rows[0].id;
  });
  await check('adds a room instance', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, `/faculty/seating-templates/plans/${examId}/rooms`, {
      templateId, roomNumber: 'POV-Hall'
    }), new RegExp(`/faculty/seating-templates/plans/${examId}$`));
  });
  await check('generates template seating', async () => {
    redirectsTo(await post(faculty.agent, faculty.csrf, `/faculty/seating-templates/plans/${examId}/generate`), new RegExp(`/faculty/seating-templates/plans/${examId}$`));
    const row = (await query('SELECT count(*)::int AS n FROM seating_allocations WHERE exam_id=$1', [examId])).rows[0];
    assert(row.n > 0, 'no seats generated');
  });
  currentRole = 'STUDENT';
  await check('student sees assigned seat', async () => {
    const r = status(await studentUser.agent.get('/student/seat'), 200);
    assert(r.text.includes('POV-Hall'), 'seat room not visible');
  });

  // ---------- QUESTION ASSEMBLY + TIMETABLE ----------
  currentRole = 'FACULTY';
  let contributionId;
  await check('contributes to the question pool', async () => {
    const body = `Pool question ${stamp}`;
    redirectsTo(await post(faculty.agent, faculty.csrf, '/faculty/assembly/contributions', {
      courseId: course.id, body, marks: '5', questionType: 'SHORT', difficulty: 'EASY', topic: 'POV'
    }), /\/faculty\/assembly\/contributions$/);
    contributionId = (await query('SELECT id FROM question_contributions WHERE body=$1', [body])).rows[0].id;
  });
  currentRole = 'SUBJECT_HEAD';
  await check('reviews a contribution', async () => {
    redirectsTo(await post(subjectHead.agent, subjectHead.csrf, `/faculty/assembly/contributions/${contributionId}/review`, {
      clarity: '5', difficultyAccuracy: '4', correctness: '5', comments: 'Good'
    }), /\/faculty\/assembly\/contributions$/);
    const row = (await query('SELECT score FROM question_contributions WHERE id=$1', [contributionId])).rows[0];
    assert(row.score !== null, 'score missing');
  });
  await check('approves a contribution', async () => {
    redirectsTo(await post(subjectHead.agent, subjectHead.csrf, `/faculty/assembly/contributions/${contributionId}/status`, { status: 'APPROVED' }), /\/faculty\/assembly\/contributions$/);
    const row = (await query('SELECT status FROM question_contributions WHERE id=$1', [contributionId])).rows[0];
    assert(row.status === 'APPROVED', `status ${row.status}`);
  });
  currentRole = 'CONTROLLER';
  let assemblyId;
  await check('creates an assembly', async () => {
    const r = await post(controller.agent, controller.csrf, '/faculty/assembly/assemblies', { examId, setCode: 'E' });
    redirectsTo(r, /\/faculty\/assembly\/assemblies\/\d+$/);
    assemblyId = Number(r.headers.location.split('/').pop());
  });
  await check('auto-assembles approved questions', async () => {
    redirectsTo(await post(controller.agent, controller.csrf, `/faculty/assembly/assemblies/${assemblyId}/auto`, { totalMarks: '5' }), new RegExp(`/faculty/assembly/assemblies/${assemblyId}$`));
    const row = (await query('SELECT count(*)::int AS n FROM question_assembly_items WHERE assembly_id=$1', [assemblyId])).rows[0];
    assert(row.n >= 1, 'no items selected');
  });
  await check('materializes assembly to a paper', async () => {
    const r = await post(controller.agent, controller.csrf, `/faculty/assembly/assemblies/${assemblyId}/materialize`, {});
    redirectsTo(r, /\/faculty\/papers\/versions\/\d+\/builder$/);
  });
  await check('solves the timetable', async () => {
    const r = await post(controller.agent, controller.csrf, '/timetable/solve', { examIds: String(examId) });
    status(r, 200);
    assert(r.text.includes('Minimum slots required'), 'missing solution');
  });

  // ---------- REPORT ----------
  const passed = results.filter((r) => r[0] === 'PASS').length;
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`\nROLE POV RESULTS: ${passed} passed, ${failed.length} failed, ${results.length} total\n`);
  for (const r of results) {
    if (r[0] === 'FAIL') console.log(`FAIL [${r[1]}] ${r[2]} - ${r[3]}`);
  }
  console.log('');
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  try { await pool.end(); } catch {}
  process.exit(1);
});

