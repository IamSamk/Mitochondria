// Applies versioned SQL files in database/migrations in filename order.
// Usage: node scripts/migrate.js [--reset]   (--reset drops everything first; dev/test only)
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function migrate({ reset = false } = {}) {
  if (reset) {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset in production');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, '..', 'database', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const done = new Set(rows.map((r) => r.filename));
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

module.exports = { migrate };

if (require.main === module) {
  migrate({ reset: process.argv.includes('--reset') })
    .then((a) => { console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database up to date'); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
