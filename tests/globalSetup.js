// Runs once before all tests: rebuild the TEST database from migrations + seed.
module.exports = async () => {
  process.env.NODE_ENV = 'test';
  const { migrate } = require('../scripts/migrate');
  const { seed } = require('../scripts/seed');
  const { pool } = require('../config/database');
  await migrate({ reset: true });
  await seed();
  await pool.end();
};
