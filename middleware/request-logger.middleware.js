/** Minimal structured request log (skipped in tests). */
function requestLogger(req, res, next) {
  if (process.env.NODE_ENV === 'test') return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const user = req.session && req.session.user ? req.session.user.id : '-';
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Math.round(ms),
      user
    }));
  });
  next();
}

module.exports = { requestLogger };
