const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { extractCsrf, loginAs } = require('../helpers');
const { query, pool } = require('../../config/database');
const { resolveStoragePath } = require('../../config/upload');

jest.setTimeout(30000);
afterAll(() => pool.end());

const binaryParser = (res, cb) => {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => cb(null, Buffer.from(data, 'binary')));
};

async function signedIn(email) {
  const { agent } = await loginAs(email);
  const csrf = extractCsrf((await agent.get('/dashboard')).text);
  return { agent, csrf };
}

describe('answer-script files survive losing the local disk (serverless cold start)', () => {
  it('restores a deleted script file from the database copy on download', async () => {
    const controller = await signedIn('controller@college.test');
    const faculty = await signedIn('faculty1@college.test');
    const course = (await query(`SELECT id FROM courses WHERE code = 'CS101'`)).rows[0];
    const student = (await query(`SELECT id FROM students WHERE student_code = 'S2026002'`)).rows[0];

    const examRes = await controller.agent.post('/controller/exams').type('form').send({
      _csrf: controller.csrf, courseId: course.id, name: `Script file restore ${Date.now()}`,
      examType: 'QUIZ', examDate: '2026-12-01', durationMinutes: 30, maxMarks: 10
    });
    const examId = Number(examRes.headers.location.match(/\/controller\/exams\/(\d+)$/)[1]);
    await faculty.agent.post('/faculty/papers/new').type('form').send({ _csrf: faculty.csrf, examId, setCode: 'A' });
    const paper = (await query('SELECT id FROM question_papers WHERE exam_id = $1', [examId])).rows[0];

    const doc = await PDFDocument.create();
    doc.addPage().drawText('restore me', { x: 50, y: 750 });
    const pdf = Buffer.from(await doc.save());
    const upload = await controller.agent.post('/controller/scripts')
      .field('_csrf', controller.csrf).field('examId', String(examId))
      .field('studentId', String(student.id)).field('paperId', String(paper.id))
      .attach('script', pdf, 'restore.pdf');
    const scriptId = Number(upload.headers.location.match(/\/controller\/scripts\/(\d+)$/)[1]);

    const stored = (await query('SELECT content FROM answer_script_files WHERE script_id = $1', [scriptId])).rows[0];
    expect(Buffer.compare(stored.content, pdf)).toBe(0);

    const { file_path: filePath } = (await query('SELECT file_path FROM answer_scripts WHERE id = $1', [scriptId])).rows[0];
    fs.unlinkSync(resolveStoragePath(filePath));

    const res = await controller.agent.get(`/controller/scripts/${scriptId}/download`).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, pdf)).toBe(0);
    expect(fs.existsSync(resolveStoragePath(filePath))).toBe(true);
  });
});
