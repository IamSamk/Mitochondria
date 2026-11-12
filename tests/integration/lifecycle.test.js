const { PDFDocument } = require('pdf-lib');
const { app, request, extractCsrf, loginAs } = require('../helpers');
const { query, pool } = require('../../config/database');

jest.setTimeout(30000);

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

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage();
    page.drawText(`Final integration answer script - page ${i + 1}`, { x: 60, y: 760, size: 12 });
  }
  return Buffer.from(await doc.save());
}

function expectPdf(res) {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/application\/pdf/);
  expect(res.body.slice(0, 4).toString()).toBe('%PDF');
}

async function expectStatus(table, id, status) {
  const { rows } = await query(`SELECT status FROM ${table} WHERE id = $1`, [id]);
  expect(rows[0].status).toBe(status);
}

describe('full examination lifecycle through the UI routes', () => {
  it('runs exam → paper → release → script → marks → results, with revisions and corrections', async () => {
    const stamp = Date.now();
    const examName = `Integration Lifecycle ${stamp}`;
    const questionBody = `Describe transaction isolation levels ${stamp}`;
    const controller = await signedIn('controller@college.test');
    const faculty = await signedIn('faculty1@college.test');
    const reviewer = await signedIn('reviewer@college.test');
    const subjectHead = await signedIn('subjecthead@college.test');
    const printing = await signedIn('printing@college.test');
    const verifier = await signedIn('verifier@college.test');

    const course = (await query(`SELECT id FROM courses WHERE code = 'CS101'`)).rows[0];
    const student = (await query(`SELECT id, student_code FROM students WHERE student_code = 'S2026001'`)).rows[0];
    const facultyUser = (await query(`SELECT id FROM users WHERE email = 'faculty1@college.test'`)).rows[0];
    expect(course && student && facultyUser).toBeTruthy();

    // --- Controller plans the examination ------------------------------
    const examRes = await controller.agent.post('/controller/exams').type('form').send({
      _csrf: controller.csrf,
      courseId: course.id,
      name: examName,
      examType: 'MIDTERM',
      examDate: '2026-12-01',
      durationMinutes: 120,
      maxMarks: 5,
      instructions: 'Answer all questions.'
    });
    expect(examRes.status).toBe(302);
    const examId = Number(examRes.headers.location.match(/\/controller\/exams\/(\d+)$/)[1]);
    expect((await controller.agent.get(`/controller/exams/${examId}`)).status).toBe(200);

    // --- Faculty writes the question bank and a paper set --------------
    const questionRes = await faculty.agent.post('/faculty/questions').type('form').send({
      _csrf: faculty.csrf,
      courseId: course.id,
      questionType: 'SHORT',
      body: questionBody,
      marks: 5,
      difficulty: 'MEDIUM',
      unit: 'Unit 1',
      modelAnswer: 'Synthetic model answer that must never appear in the paper PDF.'
    });
    expect(questionRes.status).toBe(302);
    const question = (await query('SELECT id FROM questions WHERE body = $1', [questionBody])).rows[0];

    const paperRes = await faculty.agent.post('/faculty/papers/new').type('form')
      .send({ _csrf: faculty.csrf, examId, setCode: 'A' });
    expect(paperRes.status).toBe(302);
    const versionId = Number(paperRes.headers.location.match(/\/versions\/(\d+)\/builder$/)[1]);
    const paperId = (await query('SELECT paper_id FROM paper_versions WHERE id = $1', [versionId])).rows[0].paper_id;

    const addRes = await faculty.agent.post(`/faculty/papers/versions/${versionId}/questions`).type('form')
      .send({ _csrf: faculty.csrf, questionId: question.id, sectionTitle: 'Section A' });
    expect(addRes.status).toBe(302);
    const builder = await faculty.agent.get(`/faculty/papers/versions/${versionId}/builder`);
    expect(builder.status).toBe(200);
    expect(builder.text).toContain('5 / 5 marks');

    const submitPaper = await faculty.agent.post(`/faculty/papers/versions/${versionId}/submit`).type('form')
      .send({ _csrf: faculty.csrf });
    expect(submitPaper.status).toBe(302);
    await expectStatus('paper_versions', versionId, 'SUBMITTED');
    expect((await query('SELECT pdf_path FROM paper_versions WHERE id = $1', [versionId])).rows[0].pdf_path).toBeTruthy();

    expectPdf(await faculty.agent.get(`/faculty/papers/versions/${versionId}/download`)
      .buffer(true).parse(binaryParser));

    // --- Subject head approves before the reviewer sees it ---------------
    expect((await subjectHead.agent.get('/head/papers')).text).toContain(examName);
    const headApprove = await subjectHead.agent.post(`/head/papers/${versionId}/head-review`).type('form')
      .send({ _csrf: subjectHead.csrf, decision: 'APPROVED', comments: 'Head approval in integration test.' });
    expect(headApprove.status).toBe(302);
    await expectStatus('paper_versions', versionId, 'UNDER_REVIEW');

    // --- Reviewer approves, teacher finalizes, controller releases ------
    expect((await reviewer.agent.get('/reviewer/papers')).text).toContain(examName);
    expectPdf(await reviewer.agent.get(`/reviewer/papers/${versionId}/download`)
      .buffer(true).parse(binaryParser));
    const approve = await reviewer.agent.post(`/reviewer/papers/${versionId}/decision`).type('form')
      .send({ _csrf: reviewer.csrf, decision: 'APPROVED', comments: 'Approved in integration test.' });
    expect(approve.status).toBe(302);
    await expectStatus('paper_versions', versionId, 'APPROVED');

    // Releasing before the teacher finalizes must be refused.
    const earlyRelease = await controller.agent.post(`/controller/papers/${versionId}/release`).type('form')
      .send({ _csrf: controller.csrf, note: 'Too early' });
    expect(earlyRelease.status).toBe(302);
    await expectStatus('paper_versions', versionId, 'APPROVED');

    const finalizePaper = await faculty.agent.post(`/faculty/papers/versions/${versionId}/finalize`).type('form')
      .send({ _csrf: faculty.csrf, paperId });
    expect(finalizePaper.status).toBe(302);
    expect((await query('SELECT is_finalized FROM paper_versions WHERE id = $1', [versionId])).rows[0].is_finalized).toBe(true);

    const release = await controller.agent.post(`/controller/papers/${versionId}/release`).type('form')
      .send({ _csrf: controller.csrf, note: 'Integration release' });
    expect(release.status).toBe(302);
    await expectStatus('paper_versions', versionId, 'RELEASED_FOR_PRINTING');
    expect((await printing.agent.get('/printing/papers')).text).toContain(examName);
    expectPdf(await printing.agent.get(`/printing/papers/${versionId}/download`)
      .buffer(true).parse(binaryParser));

    // --- Controller uploads, verifies and allocates a script -----------
    const paper = (await query(
      'SELECT id FROM question_papers WHERE exam_id = $1 AND set_code = $2', [examId, 'A'])).rows[0];
    const upload = await controller.agent.post('/controller/scripts')
      .field('_csrf', controller.csrf)
      .field('examId', String(examId))
      .field('studentId', String(student.id))
      .field('paperId', String(paper.id))
      .field('expectedPages', '2')
      .attach('script', await makePdf(2), 'answer-script.pdf');
    expect(upload.status).toBe(302);
    const scriptId = Number(upload.headers.location.match(/\/controller\/scripts\/(\d+)$/)[1]);
    const script = (await query('SELECT status, page_count, is_complete FROM answer_scripts WHERE id = $1', [scriptId])).rows[0];
    expect(script).toMatchObject({ page_count: 2, is_complete: true });

    const hold = await controller.agent.post(`/controller/scripts/${scriptId}/hold`).type('form')
      .send({ _csrf: controller.csrf, reason: 'Integration hold check' });
    expect(hold.status).toBe(302);
    await expectStatus('answer_scripts', scriptId, 'ON_HOLD');
    const releaseHold = await controller.agent.post(`/controller/scripts/${scriptId}/release-hold`).type('form')
      .send({ _csrf: controller.csrf });
    expect(releaseHold.status).toBe(302);
    await expectStatus('answer_scripts', scriptId, 'VERIFIED');

    const allocate = await controller.agent.post(`/controller/scripts/${scriptId}/allocate`).type('form')
      .send({ _csrf: controller.csrf, facultyId: String(facultyUser.id) });
    expect(allocate.status).toBe(302);
    await expectStatus('answer_scripts', scriptId, 'ALLOCATED');
    expectPdf(await controller.agent.get(`/controller/scripts/${scriptId}/download`)
      .buffer(true).parse(binaryParser));

    // --- Faculty evaluates ---------------------------------------------
    expect((await faculty.agent.get('/faculty/evaluations')).text).toContain(student.student_code);
    const start = await faculty.agent.post(`/faculty/evaluations/scripts/${scriptId}/start`).type('form')
      .send({ _csrf: faculty.csrf });
    expect(start.status).toBe(302);
    const evaluationId = Number(start.headers.location.match(/\/faculty\/evaluations\/(\d+)$/)[1]);
    const paperQuestion = (await query(
      'SELECT id FROM paper_questions WHERE version_id = $1 AND source_question_id = $2',
      [versionId, question.id])).rows[0];
    const marks = {
      _csrf: faculty.csrf,
      remarks: 'Integration evaluation.',
      [`mark_${paperQuestion.id}`]: '4',
      [`comment_${paperQuestion.id}`]: 'Mostly correct.'
    };
    const draft = await faculty.agent.post(`/faculty/evaluations/${evaluationId}/draft`).type('form').send(marks);
    expect(draft.status).toBe(302);
    expect(Number((await query('SELECT total_marks FROM evaluations WHERE id = $1', [evaluationId])).rows[0].total_marks)).toBe(4);
    expectPdf(await faculty.agent.get(`/faculty/evaluations/${evaluationId}/script`)
      .buffer(true).parse(binaryParser));

    const submitMarks = await faculty.agent.post(`/faculty/evaluations/${evaluationId}/submit`).type('form').send(marks);
    expect(submitMarks.status).toBe(302);
    await expectStatus('evaluations', evaluationId, 'SUBMITTED');

    // --- Verifier sends back once, then verifies -----------------------
    const reopen = await verifier.agent.post(`/verifier/marks/${evaluationId}/reopen`).type('form')
      .send({ _csrf: verifier.csrf, reason: 'Double-check the last part.' });
    expect(reopen.status).toBe(302);
    await expectStatus('evaluations', evaluationId, 'REOPENED');
    expect((await faculty.agent.get(`/faculty/evaluations/${evaluationId}`)).text).toContain('sent back for correction');
    const resubmit = await faculty.agent.post(`/faculty/evaluations/${evaluationId}/submit`).type('form').send({
      ...marks,
      [`mark_${paperQuestion.id}`]: '5'
    });
    expect(resubmit.status).toBe(302);
    await expectStatus('evaluations', evaluationId, 'SUBMITTED');

    expect((await verifier.agent.get('/verifier/marks?status=SUBMITTED')).text).toContain(student.student_code);
    const verify = await verifier.agent.post(`/verifier/marks/${evaluationId}/verify`).type('form')
      .send({ _csrf: verifier.csrf });
    expect(verify.status).toBe(302);
    await expectStatus('evaluations', evaluationId, 'VERIFIED');

    // --- Controller finalizes, reopens once, finalizes again -----------
    const finalize = await controller.agent.post(`/controller/marks/${evaluationId}/finalize`).type('form')
      .send({ _csrf: controller.csrf });
    expect(finalize.status).toBe(302);
    await expectStatus('evaluations', evaluationId, 'FINALIZED');

    const controllerReopen = await controller.agent.post(`/controller/marks/${evaluationId}/reopen`).type('form')
      .send({ _csrf: controller.csrf, reason: 'Result audit requires a correction.' });
    expect(controllerReopen.status).toBe(302);
    await expectStatus('evaluations', evaluationId, 'REOPENED');
    expect((await faculty.agent.post(`/faculty/evaluations/${evaluationId}/submit`).type('form').send(marks)).status).toBe(302);
    expect((await verifier.agent.post(`/verifier/marks/${evaluationId}/verify`).type('form')
      .send({ _csrf: verifier.csrf })).status).toBe(302);
    expect((await controller.agent.post(`/controller/marks/${evaluationId}/finalize`).type('form')
      .send({ _csrf: controller.csrf })).status).toBe(302);
    await expectStatus('evaluations', evaluationId, 'FINALIZED');

    // Filtering by status must not collapse the summary cards: the exam filter
    // is visible and the cards still count every status for that exam.
    const filteredMarks = await controller.agent.get(`/controller/marks?examId=${examId}&status=VERIFIED`);
    expect(filteredMarks.status).toBe(200);
    expect(filteredMarks.text).toContain('All examinations');
    expect(filteredMarks.text).toContain('Finalized</div><div class="display-6">1</div>');

    // --- Results page and CSV contain the finalized script -------------
    const results = await controller.agent.get(`/controller/results?examId=${examId}`);
    expect(results.status).toBe(200);
    expect(results.text).toContain(student.student_code);
    const csv = await controller.agent.get(`/controller/results/export.csv?examId=${examId}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('student_code,student_name');
    expect(csv.text).toContain(student.student_code);
    const verifierResults = await verifier.agent.get(`/controller/results?examId=${examId}`);
    expect(verifierResults.status).toBe(200);
    expect(verifierResults.text).toContain(`/verifier/marks/${evaluationId}`);

    // --- Rejection → revision → resubmission path ----------------------
    const paperB = await faculty.agent.post('/faculty/papers/new').type('form')
      .send({ _csrf: faculty.csrf, examId, setCode: 'B' });
    expect(paperB.status).toBe(302);
    const versionB1 = Number(paperB.headers.location.match(/\/versions\/(\d+)\/builder$/)[1]);
    expect((await faculty.agent.post(`/faculty/papers/versions/${versionB1}/questions`).type('form')
      .send({ _csrf: faculty.csrf, questionId: question.id, sectionTitle: 'Section A' })).status).toBe(302);
    expect((await faculty.agent.post(`/faculty/papers/versions/${versionB1}/submit`).type('form')
      .send({ _csrf: faculty.csrf })).status).toBe(302);
    await expectStatus('paper_versions', versionB1, 'SUBMITTED');
    expect((await subjectHead.agent.post(`/head/papers/${versionB1}/head-review`).type('form')
      .send({ _csrf: subjectHead.csrf, decision: 'APPROVED', comments: 'Head approved set B.' })).status).toBe(302);

    const reject = await reviewer.agent.post(`/reviewer/papers/${versionB1}/decision`).type('form')
      .send({ _csrf: reviewer.csrf, decision: 'REJECTED', comments: 'Tighten the wording.' });
    expect(reject.status).toBe(302);
    await expectStatus('paper_versions', versionB1, 'REJECTED');

    const paperBRow = (await query('SELECT paper_id FROM paper_versions WHERE id = $1', [versionB1])).rows[0];
    const paperBPage = await faculty.agent.get(`/faculty/papers/${paperBRow.paper_id}`);
    expect(paperBPage.status).toBe(200);
    expect(paperBPage.text).toContain('Start new version');

    const revision = await faculty.agent.post(`/faculty/papers/${paperBRow.paper_id}/revisions`).type('form')
      .send({ _csrf: faculty.csrf });
    expect(revision.status).toBe(302);
    const versionB2 = Number(revision.headers.location.match(/\/versions\/(\d+)\/builder$/)[1]);
    expect((await faculty.agent.get(`/faculty/papers/versions/${versionB2}/builder`)).text)
      .toContain(questionBody);
    expect((await faculty.agent.post(`/faculty/papers/versions/${versionB2}/submit`).type('form')
      .send({ _csrf: faculty.csrf })).status).toBe(302);
    expect((await subjectHead.agent.post(`/head/papers/${versionB2}/head-review`).type('form')
      .send({ _csrf: subjectHead.csrf, decision: 'APPROVED', comments: 'Revision approved by head.' })).status).toBe(302);
    expect((await reviewer.agent.post(`/reviewer/papers/${versionB2}/decision`).type('form')
      .send({ _csrf: reviewer.csrf, decision: 'APPROVED', comments: 'Revision accepted.' })).status).toBe(302);
    expect((await faculty.agent.post(`/faculty/papers/versions/${versionB2}/finalize`).type('form')
      .send({ _csrf: faculty.csrf, paperId: paperBRow.paper_id })).status).toBe(302);
    expect((await controller.agent.post(`/controller/papers/${versionB2}/release`).type('form')
      .send({ _csrf: controller.csrf, note: 'Release revision' })).status).toBe(302);
    expect((await printing.agent.get('/printing/papers')).text).toContain(examName);
  });
});
