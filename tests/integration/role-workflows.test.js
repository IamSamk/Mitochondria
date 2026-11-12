const { app, request, extractCsrf, loginAs } = require('../helpers');
const { query, pool } = require('../../config/database');

jest.setTimeout(60000);

afterAll(() => pool.end());

const binaryParser = (res, cb) => {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => cb(null, Buffer.from(data, 'binary')));
};

async function signedIn(email) {
  const { agent, res } = await loginAs(email);
  expect(res.status).toBe(302);
  const dashboard = await agent.get('/dashboard');
  const csrf = extractCsrf(dashboard.text);
  expect(csrf).toBeTruthy();
  return { agent, csrf };
}

function expectPdf(res) {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/pdf/);
  expect(res.body.slice(0, 4).toString()).toBe('%PDF');
}

describe('role workflows: head veto, comments, paper locks, marksheets and logistics', () => {
  it('runs the full subject-head and teacher workflow', async () => {
    const stamp = Date.now();
    const examName = `Advanced Workflow ${stamp}`;
    const questionBody = `Explain two-phase commit ${stamp}`;
    const controller = await signedIn('controller@college.test');
    const faculty = await signedIn('faculty1@college.test');
    const faculty2 = await signedIn('faculty2@college.test');
    const reviewer = await signedIn('reviewer@college.test');
    const head = await signedIn('subjecthead@college.test');
    const deptHead = await signedIn('depthead@college.test');

    const course = (await query(`SELECT id, department_id FROM courses WHERE code = 'CS101'`)).rows[0];
    const facultyUser = (await query(`SELECT id FROM users WHERE email = 'faculty1@college.test'`)).rows[0];
    const faculty2User = (await query(`SELECT id FROM users WHERE email = 'faculty2@college.test'`)).rows[0];
    const students = (await query(
      `SELECT id, student_code FROM students WHERE department_id = $1 AND is_active ORDER BY student_code`,
      [course.department_id])).rows;
    expect(students.length).toBeGreaterThanOrEqual(3);

    // Controller plans the exam.
    const examRes = await controller.agent.post('/controller/exams').type('form').send({
      _csrf: controller.csrf,
      courseId: course.id,
      name: examName,
      examType: 'MIDTERM',
      examDate: '2027-01-15',
      durationMinutes: 90,
      maxMarks: 10,
      instructions: 'Answer all questions.'
    });
    expect(examRes.status).toBe(302);
    const examId = Number(examRes.headers.location.match(/\/controller\/exams\/(\d+)$/)[1]);

    // Faculty writes a question and submits a paper.
    expect((await faculty.agent.post('/faculty/questions').type('form').send({
      _csrf: faculty.csrf,
      courseId: course.id,
      questionType: 'DESCRIPTIVE',
      body: questionBody,
      marks: 10,
      difficulty: 'HARD'
    })).status).toBe(302);
    const question = (await query('SELECT id FROM questions WHERE body = $1', [questionBody])).rows[0];

    const paperRes = await faculty.agent.post('/faculty/papers/new').type('form')
      .send({ _csrf: faculty.csrf, examId, setCode: 'C' });
    expect(paperRes.status).toBe(302);
    const version1 = Number(paperRes.headers.location.match(/\/versions\/(\d+)\/builder$/)[1]);
    const paperId = (await query('SELECT paper_id FROM paper_versions WHERE id=$1', [version1])).rows[0].paper_id;
    expect((await faculty.agent.post(`/faculty/papers/versions/${version1}/questions`).type('form')
      .send({ _csrf: faculty.csrf, questionId: question.id, sectionTitle: 'Section A' })).status).toBe(302);

    // Save the draft twice, then submit.
    expect((await faculty.agent.post(`/faculty/papers/versions/${version1}/save`).type('form')
      .send({ _csrf: faculty.csrf })).status).toBe(302);
    expect((await faculty.agent.post(`/faculty/papers/versions/${version1}/save`).type('form')
      .send({ _csrf: faculty.csrf })).status).toBe(302);
    expect((await faculty.agent.post(`/faculty/papers/versions/${version1}/submit`).type('form')
      .send({ _csrf: faculty.csrf })).status).toBe(302);
    expect((await query('SELECT status FROM paper_versions WHERE id=$1', [version1])).rows[0].status).toBe('SUBMITTED');

    // Head approves → reviewer approves → teacher finalizes.
    expect((await head.agent.post(`/head/papers/${version1}/head-review`).type('form')
      .send({ _csrf: head.csrf, decision: 'APPROVED', comments: 'Head approved first version.' })).status).toBe(302);
    expect((await query('SELECT status FROM paper_versions WHERE id=$1', [version1])).rows[0].status).toBe('UNDER_REVIEW');
    expect((await reviewer.agent.post(`/reviewer/papers/${version1}/decision`).type('form')
      .send({ _csrf: reviewer.csrf, decision: 'APPROVED', comments: 'Reviewer approved.' })).status).toBe(302);
    expect((await faculty.agent.post(`/faculty/papers/versions/${version1}/finalize`).type('form')
      .send({ _csrf: faculty.csrf, paperId })).status).toBe(302);
    expect((await query('SELECT is_finalized FROM paper_versions WHERE id=$1', [version1])).rows[0].is_finalized).toBe(true);

    // The head can still veto an approved + finalized paper, clearing finalization.
    const veto = await head.agent.post(`/head/papers/${version1}/head-review`).type('form')
      .send({ _csrf: head.csrf, decision: 'VETOED', comments: 'Question is too broad. Split it into two parts.' });
    expect(veto.status).toBe(302);
    const vetoed = (await query('SELECT status, is_finalized FROM paper_versions WHERE id=$1', [version1])).rows[0];
    expect(vetoed).toEqual({ status: 'REJECTED', is_finalized: false });
    expect((await head.agent.get(`/head/papers/${paperId}`)).text).toContain('Split it into two parts');

    // Comments can target the paper or a specific question.
    expect((await faculty.agent.post(`/papers/${paperId}/comments`).type('form').send({
      _csrf: faculty.csrf, body: 'I will split the question and resubmit.', returnTo: `/faculty/papers/${paperId}`
    })).status).toBe(302);
    const paperQuestion = (await query('SELECT id FROM paper_questions WHERE version_id=$1', [version1])).rows[0];
    expect((await head.agent.post(`/papers/${paperId}/comments`).type('form').send({
      _csrf: head.csrf, body: 'Focus the first part on prepare, the second on commit.',
      paperQuestionId: paperQuestion.id, returnTo: `/head/papers/${paperId}`
    })).status).toBe(302);
    const comments = (await query(
      'SELECT paper_question_id, body FROM paper_comments WHERE paper_id=$1 ORDER BY id', [paperId])).rows;
    expect(comments).toHaveLength(2);
    expect(comments[1].paper_question_id).toBe(String(paperQuestion.id));

    // Teacher revises, head approves, reviewer approves, teacher finalizes,
    // controller releases.
    const revision = await faculty.agent.post(`/faculty/papers/${paperId}/revisions`).type('form')
      .send({ _csrf: faculty.csrf });
    expect(revision.status).toBe(302);
    const version2 = Number(revision.headers.location.match(/\/versions\/(\d+)\/builder$/)[1]);
    expect((await faculty.agent.post(`/faculty/papers/versions/${version2}/submit`).type('form')
      .send({ _csrf: faculty.csrf })).status).toBe(302);
    expect((await head.agent.post(`/head/papers/${version2}/head-review`).type('form')
      .send({ _csrf: head.csrf, decision: 'APPROVED', comments: 'Revision approved.' })).status).toBe(302);
    expect((await reviewer.agent.post(`/reviewer/papers/${version2}/decision`).type('form')
      .send({ _csrf: reviewer.csrf, decision: 'APPROVED', comments: 'Revision accepted.' })).status).toBe(302);
    expect((await faculty.agent.post(`/faculty/papers/versions/${version2}/finalize`).type('form')
      .send({ _csrf: faculty.csrf, paperId })).status).toBe(302);
    expect((await controller.agent.post(`/controller/papers/${version2}/release`).type('form')
      .send({ _csrf: controller.csrf, note: 'Advanced workflow release' })).status).toBe(302);

    // A different teacher cannot download the paper: attempt is recorded and
    // downloads freeze for 15 minutes.
    const denied = await faculty2.agent.get(`/papers/versions/${version2}/download`);
    expect(denied.status).toBe(403);
    const lock = (await query('SELECT * FROM paper_download_locks WHERE paper_id=$1', [paperId])).rows[0];
    expect(lock).toBeTruthy();
    expect(new Date(lock.locked_until).getTime() - Date.now()).toBeGreaterThan(10 * 60 * 1000);
    const attempt = (await query(
      'SELECT user_id, outcome FROM paper_download_attempts WHERE paper_id=$1 ORDER BY id DESC LIMIT 1', [paperId])).rows[0];
    expect(attempt).toMatchObject({ outcome: 'DENIED' });
    expect(Number(attempt.user_id)).toBe(Number(faculty2User.id));
    expect((await faculty.agent.get(`/faculty/papers/${paperId}`)).text).toContain('Demo Faculty Two');

    // Owner reviews the attempt, clears the freeze, and sets a password.
    expect((await faculty.agent.post(`/papers/${paperId}/lock/clear`).type('form')
      .send({ _csrf: faculty.csrf, returnTo: `/faculty/papers/${paperId}` })).status).toBe(302);
    expect((await query('SELECT * FROM paper_download_locks WHERE paper_id=$1', [paperId])).rows).toHaveLength(0);
    expect((await faculty.agent.post(`/papers/${paperId}/password`).type('form')
      .send({ _csrf: faculty.csrf, password: 'Secret123', returnTo: `/faculty/papers/${paperId}` })).status).toBe(302);
    expect((await query('SELECT download_password_hash FROM question_papers WHERE id=$1', [paperId])).rows[0].download_password_hash).toBeTruthy();

    // Password prompt → wrong password freezes again → clear → correct password downloads.
    expect((await faculty2.agent.get(`/papers/versions/${version2}/download`)).status).toBe(401);
    const wrong = await faculty2.agent.post(`/papers/versions/${version2}/download`).type('form')
      .send({ _csrf: faculty2.csrf, password: 'wrong-password' });
    expect(wrong.status).toBe(403);
    expect((await query('SELECT * FROM paper_download_attempts WHERE paper_id=$1 ORDER BY id DESC LIMIT 1', [paperId])).rows[0].outcome)
      .toBe('BAD_PASSWORD');
    expect((await faculty.agent.post(`/papers/${paperId}/lock/clear`).type('form')
      .send({ _csrf: faculty.csrf, returnTo: `/faculty/papers/${paperId}` })).status).toBe(302);
    expectPdf(await faculty2.agent.get(`/papers/versions/${version2}/download?password=Secret123`)
      .buffer(true).parse(binaryParser));

    // Marksheet: manual save, later edit, and CSV import.
    expect((await faculty.agent.get(`/faculty/marksheets/${examId}`)).status).toBe(200);
    const marksPayload = { _csrf: faculty.csrf };
    marksPayload[`mark_${students[0].id}`] = '8';
    marksPayload[`mark_${students[1].id}`] = '6';
    expect((await faculty.agent.post(`/faculty/marksheets/${examId}`).type('form').send(marksPayload)).status).toBe(302);
    expect(Number((await query('SELECT marks_obtained FROM exam_marks WHERE exam_id=$1 AND student_id=$2',
      [examId, students[0].id])).rows[0].marks_obtained)).toBe(8);

    const editPayload = { _csrf: faculty.csrf };
    editPayload[`mark_${students[0].id}`] = '9';
    editPayload[`mark_${students[1].id}`] = '6';
    expect((await faculty.agent.post(`/faculty/marksheets/${examId}`).type('form').send(editPayload)).status).toBe(302);
    expect(Number((await query('SELECT marks_obtained FROM exam_marks WHERE exam_id=$1 AND student_id=$2',
      [examId, students[0].id])).rows[0].marks_obtained)).toBe(9);

    const imported = await faculty.agent.post(`/faculty/marksheets/${examId}/import`)
      .field('_csrf', faculty.csrf)
      .field('csv', `student_code,marks\n${students[0].student_code},9.5\n${students[2].student_code},7\nUNKNOWN,4`);
    expect(imported.status).toBe(302);
    expect(Number((await query('SELECT marks_obtained FROM exam_marks WHERE exam_id=$1 AND student_id=$2',
      [examId, students[0].id])).rows[0].marks_obtained)).toBe(9.5);
    expect((await query('SELECT * FROM exam_marks WHERE exam_id=$1 AND student_id=$2', [examId, students[2].id])).rows)
      .toHaveLength(1);

    const headMarks = await head.agent.get(`/head/marksheets/${examId}`);
    expect(headMarks.status).toBe(200);
    expect(headMarks.text).toContain(students[0].student_code);
    expect((await deptHead.agent.get(`/head/marksheets/${examId}`)).status).toBe(200);

    // Seating + invigilation generation, edits, and head supervision.
    expect((await faculty.agent.post(`/faculty/logistics/${examId}/seating/generate`).type('form')
      .send({ _csrf: faculty.csrf, roomName: 'Hall A', capacity: '4' })).status).toBe(302);
    const seats = (await query('SELECT * FROM seating_allocations WHERE exam_id=$1 ORDER BY room_name, seat_no', [examId])).rows;
    expect(seats).toHaveLength(students.length);
    expect(new Set(seats.map((s) => s.room_name)).size).toBe(Math.ceil(students.length / 4));

    const seat = seats[0];
    expect((await faculty.agent.post(`/faculty/logistics/${examId}/seating/${seat.id}`).type('form')
      .send({ _csrf: faculty.csrf, roomName: 'Hall A', seatNo: '99' })).status).toBe(302);
    expect(Number((await query('SELECT seat_no FROM seating_allocations WHERE id=$1', [seat.id])).rows[0].seat_no)).toBe(99);

    expect((await faculty.agent.post(`/faculty/logistics/${examId}/invigilation/generate`).type('form')
      .send({ _csrf: faculty.csrf })).status).toBe(302);
    const invigilations = (await query('SELECT * FROM invigilations WHERE exam_id=$1 ORDER BY id', [examId])).rows;
    expect(invigilations.length).toBeGreaterThan(0);

    expect((await faculty.agent.post(`/faculty/logistics/${examId}/invigilation/${invigilations[0].id}`).type('form')
      .send({
        _csrf: faculty.csrf,
        roomName: invigilations[0].room_name,
        invigilatorId: String(facultyUser.id),
        startsAt: '2027-01-15T09:00',
        endsAt: '2027-01-15T10:30'
      })).status).toBe(302);
    expect(Number((await query('SELECT invigilator_id FROM invigilations WHERE id=$1', [invigilations[0].id])).rows[0].invigilator_id))
      .toBe(Number(facultyUser.id));

    const headLogistics = await head.agent.get(`/head/logistics/${examId}`);
    expect(headLogistics.status).toBe(200);
    expect(headLogistics.text).toContain('Hall A');
    expect((await deptHead.agent.get('/head/papers')).status).toBe(200);
    expect((await deptHead.agent.get('/dashboard')).status).toBe(200);
  });
});
