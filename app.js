require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { query, isConfigured } = require('./config/database');
const sessionMiddleware = require('./config/session');
const { csrfToken, csrfProtect } = require('./middleware/csrf.middleware');
const { flash } = require('./middleware/flash.middleware');
const { requestLogger } = require('./middleware/request-logger.middleware');
const { NAV } = require('./config/navigation');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

const isProd = process.env.NODE_ENV === 'production';
app.use(helmet({
  // HSTS / upgrade-insecure-requests only in production (they break plain-HTTP localhost in some browsers).
  hsts: isProd,
  contentSecurityPolicy: {
    directives: {
      upgradeInsecureRequests: isProd ? [] : null,
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:'],
      frameAncestors: ["'self'"]
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));

// Public static assets only. storage/ is NEVER served statically.
app.use(express.static(path.join(__dirname, 'public')));

// Health check: no session, no auth.
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ success: true, data: { status: 'ok', database: 'up', time: new Date().toISOString() } });
  } catch {
    res.status(503).json({ success: false, error: { code: 'DB_DOWN', message: 'Database unavailable' } });
  }
});

// Missing deployment config: show a clear 503 instead of crashing the whole function.
const setupProblems = [
  !isConfigured && 'DATABASE_URL is not set',
  sessionMiddleware.missingSecret && 'SESSION_SECRET is not set (or still the placeholder)'
].filter(Boolean);
if (setupProblems.length) {
  console.error(`App not configured: ${setupProblems.join('; ')}. Add these as environment variables and redeploy.`);
  app.use((req, res) => {
    res.locals.currentUser = null;
    res.locals.nav = [];
    res.locals.currentPath = req.path;
    res.locals.title = 'Setup required';
    res.status(503).render('errors/error', {
      status: 503,
      message: `Server is not configured yet: ${setupProblems.join('; ')}.`
    });
  });
}

app.use(sessionMiddleware);
app.use(requestLogger);
app.use(csrfToken);
app.use(flash);
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.nav = req.session.user ? NAV[req.session.user.role] || [] : [];
  res.locals.currentPath = req.path;
  res.locals.title = 'Examination Management Platform';
  res.locals.unreadNotifications = 0;
  if (req.session && req.session.user) {
    try {
      const { rows } = await query(
        'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL',
        [req.session.user.id]);
      res.locals.unreadNotifications = rows[0].n;
    } catch (e) { /* ignore */ }
  }
  next();
});
app.use(csrfProtect);

// Module route registration -- each module exports an Express router.
app.use('/', require('./modules/auth/auth.routes'));
app.use('/', require('./modules/dashboard.routes'));
app.use('/account', require('./modules/account/account.routes'));
app.use('/admin/users', require('./modules/users/users.routes'));
app.use('/admin/students', require('./modules/students/students.routes'));
app.use('/admin/academics', require('./modules/academics/academics.routes'));
app.use('/admin/audit', require('./modules/audit/audit.routes'));
app.use('/controller/exams', require('./modules/examinations/examinations.routes'));
app.use('/controller/papers', require('./modules/question-papers/controller.routes'));
app.use('/controller/scripts', require('./modules/answer-scripts/answer-scripts.routes'));
app.use('/controller/marks', require('./modules/evaluations/controller.routes'));
app.use('/controller/results', require('./modules/results/results.routes'));
app.use('/faculty/questions', require('./modules/questions/questions.routes'));
app.use('/faculty/papers', require('./modules/question-papers/faculty.routes'));
app.use('/faculty/marksheets', require('./modules/marksheets/marksheets.routes'));
app.use('/faculty/logistics', require('./modules/logistics/logistics.routes'));
app.use('/faculty/evaluations', require('./modules/evaluations/faculty.routes'));
app.use('/reviewer/papers', require('./modules/approvals/approvals.routes'));
app.use('/printing/papers', require('./modules/printing/printing.routes'));
app.use('/verifier/marks', require('./modules/evaluations/verifier.routes'));
app.use('/head', require('./modules/supervision/supervision.routes'));
app.use('/papers', require('./modules/paper-collab/paper-collab.routes'));
app.use('/notifications', require('./modules/notifications/notifications.routes'));
app.use('/student', require('./modules/student-portal/student-portal.routes'));

// 404
app.use((req, res) => res.status(404).render('errors/error', { status: 404, message: 'Page not found' }));

// Central error handler: no stack traces to clients in production.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.name === 'MulterError') {
    err.status = 422;
    err.code = err.code || 'UPLOAD_ERROR';
    err.message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the upload limit' : 'Upload failed';
  }
  const status = err.status || 500;
  const message = status >= 500 ? 'Something went wrong' : err.message;
  if (status >= 500 && process.env.NODE_ENV !== 'test') console.error(err);
  if (req.accepts(['html', 'json']) === 'json' && !req.accepts('html')) {
    return res.status(status).json({ success: false, error: { code: err.code || 'INTERNAL_ERROR', message, details: err.details } });
  }
  return res.status(status).render('errors/error', { status, message });
});

module.exports = app;
