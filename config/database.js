require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const connectionString =
  process.env.NODE_ENV === 'test'
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL || process.env.POSTGRES_URL; // POSTGRES_URL: set by Vercel/Neon integrations

const isConfigured = Boolean(connectionString);
const isServerless = Boolean(process.env.VERCEL);

/** Hosted Postgres (Neon, Supabase, Render...) needs TLS; local dev usually doesn't. */
function sslFor(url) {
  if (!url) return undefined;
  if (/sslmode=disable/.test(url)) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return false;
  return { rejectUnauthorized: false };
}

let pool;
if (isConfigured) {
  pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    // Serverless functions run many short-lived instances: keep each one's pool tiny.
    max: isServerless ? 3 : 10,
    idleTimeoutMillis: isServerless ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    // Store/read all timestamps as UTC (set at connection startup, no extra query).
    options: '-c timezone=UTC'
  });
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
} else {
  // Don't crash at import time (that's what turns into Vercel's FUNCTION_INVOCATION_FAILED).
  // Every query fails with a clear message instead; app.js shows a setup page.
  const notConfigured = () =>
    Promise.reject(new Error('DATABASE_URL (or TEST_DATABASE_URL in test) is not set. Copy .env.example to .env, or add it in Vercel project settings.'));
  pool = { query: notConfigured, connect: notConfigured, end: () => Promise.resolve(), on: () => {} };
}

/** Run a single parameterized query. */
const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction; commits on success, rolls back on error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction, isConfigured };
