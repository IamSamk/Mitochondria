(function () {
  var type = document.getElementById('questionType');
  var block = document.getElementById('mcq-options');
  if (!type || !block) return;
  function sync() { block.style.display = type.value === 'MCQ' ? '' : 'none'; }
  type.addEventListener('change', sync);
  sync();
})();
