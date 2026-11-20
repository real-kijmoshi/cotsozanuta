// Album color themes. Loaded in <head> (blocking, tiny) so the saved theme is
// applied before first paint — no flash of the default palette.
//   grind – TTHE GRIND (default): blood red on burnt black
//   riott – RIOTT: siren blue on cold concrete
(function () {
  var KEY = 'czs_theme';
  var THEMES = {
    grind: { label: 'tthe grind', bg: '#060404', accent: '#e31c12', text: '#f2e9e4', bgRgb: '6,4,4',  accentRgb: '227,28,18', textRgb: '242,233,228', tag: null },
    riott: { label: 'riott',      bg: '#05070b', accent: '#2f6bff', text: '#e6ecf3', bgRgb: '5,7,11', accentRgb: '47,107,255', textRgb: '230,236,243', tag: 'RIOTT' },
  };
  var root = document.documentElement;

  function get() {
    var t;
    try { t = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    return THEMES[t] ? t : 'grind';
  }

  function apply(name) {
    if (!THEMES[name]) name = 'grind';
    if (name === 'grind') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES[name].bg);
    var tag = document.getElementById('bg-tag');
    if (tag) {
      if (!tag.hasAttribute('data-orig')) tag.setAttribute('data-orig', tag.textContent);
      tag.textContent = THEMES[name].tag || tag.getAttribute('data-orig');
    }
    var btns = document.querySelectorAll('#theme-ctrl button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-val') === name);
  }

  function set(name) {
    try { localStorage.setItem(KEY, name); } catch (e) { /* storage blocked */ }
    apply(name);
  }

  window.czsTheme = {
    get: get,
    set: set,
    palette: function () { return THEMES[get()]; },
  };

  apply(get());

  document.addEventListener('DOMContentLoaded', function () {
    apply(get());
    var btns = document.querySelectorAll('#theme-ctrl button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { set(this.getAttribute('data-val')); });
    }
  });

  // Keep other open tabs in sync.
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(get()); });
})();
