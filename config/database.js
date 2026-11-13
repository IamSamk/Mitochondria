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
    max: isServerless ? 3 : Number(process.env.DB_POOL_MAX || 20),
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

/** Run a single parameterized query, logging slow/failed queries without params (which may hold PII). */
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS || 250);
const query = async (text, params) => {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    const ms = Date.now() - started;
    if (ms >= SLOW_QUERY_MS && process.env.NODE_ENV !== 'test') {
      console.warn(`Slow query (${ms}ms): ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return result;
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.error(`Query failed after ${Date.now() - started}ms: ${String(text).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    throw err;
  }
};

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
