const { PDFDocument } = require('pdf-lib');
const { app, request, loginAs, csrfFor } = require('../helpers');
const { query, pool } = require('../../config/database');

jest.setTimeout(30000);

afterAll(() => pool.end());

async function adminSession() {
  const { agent, res } = await loginAs('admin@college.test');
  expect(res.status).toBe(302);
  const csrf = await csrfFor(agent);
  expect(csrf).toBeTruthy();
  return { agent, csrf };
}

async function firstDepartmentId() {
  return (await query('SELECT id FROM departments ORDER BY id LIMIT 1')).rows[0].id;
}

async function makePdf(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage();
    page.drawText(`Student registry test - page ${i + 1}`, { x: 60, y: 760, size: 12 });
  }
  return Buffer.from(await doc.save());
}

describe('admin student registry', () => {
  it('lists seeded students for an administrator', async () => {
    const { agent } = await adminSession();
    const res = await agent.get('/admin/students');
    expect(res.status).toBe(200);
    expect(res.text).toContain('S2026001');
    expect(res.text).toContain('Add student');
  });

  it('creates a student and rejects a duplicate student code', async () => {
    const { agent, csrf } = await adminSession();
    const code = `T${Date.now().toString().slice(-8)}`;
    const departmentId = await firstDepartmentId();

    const created = await agent.post('/admin/students').type('form').send({
      _csrf: csrf, studentCode: code, fullName: 'Registry Test Student', departmentId
    });
    expect(created.status).toBe(302);

    const row = (await query('SELECT * FROM students WHERE student_code = $1', [code])).rows[0];
    expect(row).toMatchObject({ student_code: code, full_name: 'Registry Test Student', is_active: true });

    const duplicate = await agent.post('/admin/students').type('form').send({
      _csrf: csrf, studentCode: code.toLowerCase(), fullName: 'Duplicate Student', departmentId
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.text).toContain('already exists');
    const count = (await query(
      'SELECT count(*)::int AS n FROM students WHERE upper(student_code) = upper($1)', [code])).rows[0].n;
    expect(count).toBe(1);
  });

  it('edits a student and removes deactivated students from the upload picker', async () => {
    const { agent, csrf } = await adminSession();
    const code = `E${Date.now().toString().slice(-8)}`;
    const departmentId = await firstDepartmentId();

    await agent.post('/admin/students').type('form').send({
      _csrf: csrf, studentCode: code, fullName: 'Before Edit', departmentId
    });
    const student = (await query('SELECT id FROM students WHERE student_code = $1', [code])).rows[0];

    const edited = await agent.post(`/admin/students/${student.id}`).type('form').send({
      _csrf: csrf, studentCode: code, fullName: 'After Edit', departmentId, isActive: 'true'
    });
    expect(edited.status).toBe(302);
    expect((await query('SELECT full_name FROM students WHERE id = $1', [student.id])).rows[0].full_name)
      .toBe('After Edit');

    const toggled = await agent.post(`/admin/students/${student.id}/toggle`).type('form')
      .send({ _csrf: csrf });
    expect(toggled.status).toBe(302);
    expect((await query('SELECT is_active FROM students WHERE id = $1', [student.id])).rows[0].is_active)
      .toBe(false);

    const { agent: controller } = await loginAs('controller@college.test');
    const picker = await controller.get('/controller/scripts/new');
    expect(picker.status).toBe(200);
    expect(picker.text).not.toContain(code);
  });

  it('rejects an inactive student even when an upload request is crafted', async () => {
    const { agent, csrf } = await adminSession();
    const code = `X${Date.now().toString().slice(-8)}`;
    const departmentId = await firstDepartmentId();

    await agent.post('/admin/students').type('form').send({
      _csrf: csrf, studentCode: code, fullName: 'Inactive Upload Student', departmentId
    });
    const student = (await query('SELECT id FROM students WHERE student_code = $1', [code])).rows[0];
    await agent.post(`/admin/students/${student.id}/toggle`).type('form').send({ _csrf: csrf });

    const { agent: controller, res: loginRes } = await loginAs('controller@college.test');
    expect(loginRes.status).toBe(302);
    const controllerCsrf = await csrfFor(controller);
    const course = (await query("SELECT id FROM courses WHERE code = 'CS101'")).rows[0];
    const controllerUser = (await query("SELECT id FROM users WHERE email = 'controller@college.test'")).rows[0];

    const examRes = await controller.post('/controller/exams').type('form').send({
      _csrf: controllerCsrf,
      courseId: course.id,
      name: `Inactive Student Exam ${Date.now()}`,
      examType: 'MIDTERM',
      examDate: '2026-12-15',
      durationMinutes: 60,
      maxMarks: 10
    });
    expect(examRes.status).toBe(302);
    const examId = Number(examRes.headers.location.match(/\/controller\/exams\/(\d+)$/)[1]);

    const paper = (await query(
      `INSERT INTO question_papers(exam_id, set_code, created_by) VALUES ($1, 'A', $2) RETURNING id`,
      [examId, controllerUser.id])).rows[0];

    const upload = await controller.post('/controller/scripts')
      .field('_csrf', controllerCsrf)
      .field('examId', String(examId))
      .field('studentId', String(student.id))
      .field('paperId', String(paper.id))
      .field('expectedPages', '1')
      .attach('script', await makePdf(1), 'inactive-student.pdf');

    expect(upload.status).toBe(302);
    expect(upload.headers.location).toMatch(/^\/controller\/scripts\/new/);
    const stored = (await query(
      'SELECT count(*)::int AS n FROM answer_scripts WHERE exam_id = $1 AND student_id = $2',
      [examId, student.id])).rows[0].n;
    expect(stored).toBe(0);
  });

  it('is restricted to administrators', async () => {
    const { agent } = await loginAs('controller@college.test');
    expect((await agent.get('/admin/students')).status).toBe(403);
    expect((await request(app).get('/admin/students')).status).toBe(302);
  });
});
