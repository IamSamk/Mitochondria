// Runs during `vercel build` (and `pnpm build`): applies pending migrations and seeds roles.
// Demo accounts (known password) are only seeded when SEED_DEMO_DATA=true.
// Skips cleanly when no database is configured so the deploy itself still succeeds.
require('dotenv').config({ quiet: true });
const { pool, isConfigured } = require('../config/database');

async function main() {
  if (!isConfigured) {
    console.warn('[build] DATABASE_URL not set: skipping migrations. Add it in Vercel → Settings → Environment Variables, then redeploy.');
    return;
  }
  const { migrate } = require('./migrate');
  const { seed } = require('./seed');
  const applied = await migrate();
  console.log(applied.length ? `[build] Applied migrations: ${applied.join(', ')}` : '[build] Database schema up to date');
  const demo = process.env.SEED_DEMO_DATA === 'true';
  await seed({ demo });
  console.log(demo ? '[build] Seeded roles + demo data' : '[build] Seeded roles (set SEED_DEMO_DATA=true for demo accounts)');
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(`[build] Database setup failed: ${e.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
