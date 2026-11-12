const request = require('supertest');
const app = require('../app');

const extractCsrf = (html) => (html.match(/name="_csrf" value="([a-f0-9]+)"/) || [])[1];

/** Returns a supertest agent logged in as the given demo user. */
async function loginAs(email, password = 'Demo@12345') {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), email, password });
  return { agent, res };
}

module.exports = { app, request, extractCsrf, loginAs };
