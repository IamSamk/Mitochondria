const express = require('express');
const { requireAuth } = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { asyncHandler } = require('../../middleware/async.middleware');
const results = require('./results.service');

const router = express.Router();
router.use(requireAuth, requireRole('CONTROLLER', 'VERIFIER'));

function filtersOf(req) {
  return {
    examId: req.query.examId || '',
    courseId: req.query.courseId || '',
    q: (req.query.q || '').trim()
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const filters = filtersOf(req);
  const [rows, options] = await Promise.all([
    results.listResults(filters),
    results.resultFilters()
  ]);
  res.render('results/results', {
    rows, options, filters, summary: results.summarize(rows),
    title: 'Results'
  });
}));

router.get('/export.csv', asyncHandler(async (req, res) => {
  const rows = await results.listResults(filtersOf(req));
  res.type('text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
  res.send(results.resultsCsv(rows));
}));

module.exports = router;
