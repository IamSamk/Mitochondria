const { app, request, extractCsrf, loginAs } = require('../helpers');
const { pool } = require('../../config/database');

afterAll(() => pool.end());

describe('health', () => {
  it('reports ok and database up', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.database).toBe('up');
  });
});

describe('authentication', () => {
  it('logs in with valid credentials', async () => {
    const { res } = await loginAs('admin@college.test');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
  });

  it('rejects an invalid password with a generic message', async () => {
    const { res } = await loginAs('admin@college.test', 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.text).toContain('Invalid email or password');
  });

  it('rejects an unknown email with the same generic message', async () => {
    const { res } = await loginAs('nobody@college.test', 'whatever');
    expect(res.status).toBe(401);
    expect(res.text).toContain('Invalid email or password');
  });

  it('rejects POST /login without a CSRF token', async () => {
    const res = await request(app).post('/login').type('form').send({ email: 'admin@college.test', password: 'Demo@12345' });
    expect(res.status).toBe(403);
  });

  it('redirects unauthenticated users to /login', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 JSON for unauthenticated API-style requests', async () => {
    const res = await request(app).get('/dashboard').set('Accept', 'application/json');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('blocks deactivated users immediately', async () => {
    const { agent } = await loginAs('reviewer@college.test');
    await pool.query("UPDATE users SET is_active=false WHERE email='reviewer@college.test'");
    const res = await agent.get('/dashboard');
    await pool.query("UPDATE users SET is_active=true WHERE email='reviewer@college.test'");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('logout invalidates the session', async () => {
    const { agent } = await loginAs('faculty1@college.test');
    const dash = await agent.get('/dashboard');
    expect(dash.status).toBe(200);
    const out = await agent.post('/logout').type('form').send({ _csrf: extractCsrf(dash.text) });
    expect(out.status).toBe(302);
    const after = await agent.get('/dashboard');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/login');
  });

  it('writes login and failed-login audit entries without secrets', async () => {
    const { rows } = await pool.query("SELECT action, metadata FROM audit_logs WHERE action IN ('LOGIN','LOGIN_FAILED')");
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/password/i);
  });
});

describe('role-based access control', () => {
  it('lets ADMIN reach /admin', async () => {
    const { agent } = await loginAs('admin@college.test');
    const res = await agent.get('/admin');
    expect(res.status).toBe(302);
  });

  it('denies FACULTY access to /admin with 403', async () => {
    const { agent } = await loginAs('faculty1@college.test');
    const res = await agent.get('/admin');
    expect(res.status).toBe(403);
  });
});

describe('storage protection', () => {
  it('does not serve the storage directory statically', async () => {
    const res = await request(app).get('/storage/answer-scripts/.gitkeep');
    expect(res.status).toBe(404);
  });
});
