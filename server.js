require('dotenv').config({ quiet: true });
const app = require('./app');
const { pool } = require('./config/database');

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`Examination Management Platform listening on http://localhost:${port} (${process.env.NODE_ENV || 'development'})`);
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason})…`);
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  server.close(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});
