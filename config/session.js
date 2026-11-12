const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { pool } = require('./database');

const isProd = process.env.NODE_ENV === 'production';

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.startsWith('change-me'))) {
  throw new Error('Set a strong SESSION_SECRET in production');
}

module.exports = session({
  store: new PgStore({ pool, tableName: 'user_sessions' }),
  name: 'emp.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
});
