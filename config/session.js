const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { pool, isConfigured } = require('./database');

const isProd = process.env.NODE_ENV === 'production';

/** True when production is missing a real session secret (app.js shows a setup page instead of crashing). */
const missingSecret = isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.startsWith('change-me'));

const middleware = session({
  // Without a database there is nowhere to store sessions; app.js short-circuits before this runs.
  store: isConfigured ? new PgStore({ pool, tableName: 'user_sessions' }) : undefined,
  name: 'emp.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
});

module.exports = middleware;
module.exports.missingSecret = missingSecret;
