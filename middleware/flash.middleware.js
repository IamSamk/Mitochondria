/**
 * One-shot flash messages stored in the session and exposed to every view
 * as `flash = { type, message }`.
 */
function flash(req, res, next) {
  res.locals.flash = req.session && req.session.flash ? req.session.flash : null;
  if (req.session) delete req.session.flash;
  next();
}

function setFlash(req, type, message) {
  if (req.session) req.session.flash = { type, message };
}

module.exports = { flash, setFlash };
