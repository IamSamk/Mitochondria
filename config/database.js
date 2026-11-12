require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const connectionString =
  process.env.NODE_ENV === 'test'
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL (or TEST_DATABASE_URL in test) is not set. Copy .env.example to .env.');
}

// Store/read all timestamps as UTC (set at connection startup, no extra query).
const pool = new Pool({ connectionString, max: 10, options: '-c timezone=UTC' });

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

module.exports = { pool, query, withTransaction };
