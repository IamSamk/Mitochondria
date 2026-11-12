const { app, request, loginAs } = require('../helpers');
const { NAV } = require('../../config/navigation');
const { pool } = require('../../config/database');

afterAll(() => pool.end());

// The sidebar is a promise to the user: every item must render for that role.
const ACCOUNTS = {
  ADMIN: 'admin@college.test',
  CONTROLLER: 'controller@college.test',
  FACULTY: 'faculty1@college.test',
  REVIEWER: 'reviewer@college.test',
  PRINTING: 'printing@college.test',
  VERIFIER: 'verifier@college.test',
  SUBJECT_HEAD: 'subjecthead@college.test',
  DEPARTMENT_HEAD: 'depthead@college.test',
  STUDENT: 'student1@college.test'
};

for (const [role, email] of Object.entries(ACCOUNTS)) {
  describe(`${role} sidebar`, () => {
    it('renders every navigation item', async () => {
      const { agent, res } = await loginAs(email);
      expect(res.status).toBe(302);
      expect(NAV[role].length).toBeGreaterThan(1);
      for (const [label, path] of NAV[role]) {
        const page = await agent.get(path);
        expect({ label, path, status: page.status }).toEqual({ label, path, status: 200 });
      }
    });
  });
}

describe('cross-role route protection', () => {
  const DENIED = [
    ['faculty1@college.test', '/admin/users'],
    ['faculty1@college.test', '/controller/scripts'],
    ['faculty1@college.test', '/printing/papers'],
    ['reviewer@college.test', '/controller/marks'],
    ['reviewer@college.test', '/faculty/papers'],
    ['printing@college.test', '/reviewer/papers'],
    ['printing@college.test', '/controller/results'],
    ['verifier@college.test', '/admin/audit'],
    ['verifier@college.test', '/faculty/evaluations'],
    ['controller@college.test', '/faculty/questions'],
    ['controller@college.test', '/admin/academics'],
    ['admin@college.test', '/controller/exams'],
    ['faculty1@college.test', '/head/papers'],
    ['subjecthead@college.test', '/faculty/papers'],
    ['depthead@college.test', '/reviewer/papers'],
    ['reviewer@college.test', '/head/logistics']
  ];

  it.each(DENIED)('%s is denied %s with 403', async (email, path) => {
    const { agent } = await loginAs(email);
    const res = await agent.get(path);
    expect(res.status).toBe(403);
  });

  it('redirects anonymous users away from every protected prefix', async () => {
    const prefixes = ['/dashboard', '/admin/users', '/controller/exams', '/faculty/papers',
      '/reviewer/papers', '/printing/papers', '/verifier/marks', '/head/papers'];
    for (const path of prefixes) {
      const res = await request(app).get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
  });
});
