require('dotenv').config({ quiet: true });
const app = require('./app');
const { pool } = require('./config/database');

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`Examination Management Platform listening on http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
}
