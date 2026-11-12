const { app, request, loginAs, csrfFor } = require('../helpers');
const { query, pool } = require('../../config/database');

jest.setTimeout(30000);

afterAll(() => pool.end());

async function adminSession() {
  const { agent, res } = await loginAs('admin@college.test');
  expect(res.status).toBe(302);
  return { agent, csrf: await csrfFor(agent) };
}

async function createThrowawayUser(password = 'StartPass123') {
  const { agent, csrf } = await adminSession();
  const email = `account-${Date.now()}-${Math.floor(Math.random() * 1000)}@college.test`;
  const role = (await query("SELECT id FROM roles WHERE code = 'FACULTY'")).rows[0];
  const department = (await query('SELECT id FROM departments ORDER BY id LIMIT 1')).rows[0];
  const created = await agent.post('/admin/users').type('form').send({
    _csrf: csrf,
    email,
    fullName: 'Account Test User',
    roleId: role.id,
    departmentId: department.id,
    password
  });
  expect(created.status).toBe(302);
  return { email, password, userId: (await query(
    'SELECT id FROM users WHERE email = $1', [email])).rows[0].id };
}

describe('self-service account settings', () => {
  it('redirects anonymous visitors to the login page', async () => {
    const res = await request(app).get('/account');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('shows the signed-in user their own profile details', async () => {
    const { agent } = await loginAs('faculty2@college.test');
    const res = await agent.get('/account');
    expect(res.status).toBe(200);
    expect(res.text).toContain('faculty2@college.test');
    expect(res.text).toContain('FACULTY');
    expect(res.text).toContain('Change password');
  });

  it('updates the display name and reflects it in the session', async () => {
    const { email, password } = await createThrowawayUser();
    const { agent, res } = await loginAs(email, password);
    expect(res.status).toBe(302);
    const csrf = await csrfFor(agent);

    const update = await agent.post('/account/profile').type('form')
      .send({ _csrf: csrf, fullName: 'Renamed Account User' });
    expect(update.status).toBe(302);

    expect((await query('SELECT full_name FROM users WHERE email = $1', [email])).rows[0].full_name)
      .toBe('Renamed Account User');
    const dashboard = await agent.get('/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain('Renamed Account User');
  });

  it('rejects a wrong current password without changing it', async () => {
    const { email, password } = await createThrowawayUser();
    const { agent, res } = await loginAs(email, password);
    expect(res.status).toBe(302);
    const csrf = await csrfFor(agent);

    const change = await agent.post('/account/password').type('form').send({
      _csrf: csrf,
      currentPassword: 'DefinitelyWrong123',
      newPassword: 'ReplacementPass123',
      confirmPassword: 'ReplacementPass123'
    });
    expect(change.status).toBe(302);
    expect((await agent.get('/account')).text).toContain('Current password is incorrect');

    const stillWorks = await loginAs(email, password);
    expect(stillWorks.res.status).toBe(302);
  });

  it('changes the password, keeps the current session and signs out other sessions', async () => {
    const { email, password, userId } = await createThrowawayUser();
    const first = await loginAs(email, password);
    const second = await loginAs(email, password);
    expect(first.res.status).toBe(302);
    expect(second.res.status).toBe(302);
    const csrf = await csrfFor(first.agent);

    const change = await first.agent.post('/account/password').type('form').send({
      _csrf: csrf,
      currentPassword: password,
      newPassword: 'ReplacementPass123',
      confirmPassword: 'ReplacementPass123'
    });
    expect(change.status).toBe(302);

    expect((await first.agent.get('/account')).status).toBe(200);
    const otherSession = await second.agent.get('/account');
    expect(otherSession.status).toBe(302);
    expect(otherSession.headers.location).toBe('/login');

    expect((await loginAs(email, 'ReplacementPass123')).res.status).toBe(302);
    expect((await loginAs(email, password)).res.status).toBe(401);

    const audit = (await query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'PASSWORD_CHANGED' AND entity_id = $1",
      [userId])).rows[0].n;
    expect(audit).toBe(1);
  });
});
