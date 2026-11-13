// Lazily refresh the unread-notification badge without a DB query on every page render.
(function () {
  var badge = document.getElementById('notification-count');
  if (!badge) return;
  fetch('/notifications/count', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      var count = data && data.success ? Number(data.data.count) : 0;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.classList.remove('d-none');
      }
    })
    .catch(function () { /* badge is optional */ });
})();
