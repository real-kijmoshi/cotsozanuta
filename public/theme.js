// Album color themes. Loaded in <head> (blocking, tiny) so the saved theme is
// applied before first paint — no flash of the default palette.
//   grind – TTHE GRIND (default): blood red on burnt black
//   riott – RIOTT: clean white promo-card look, black type, CCTV details
(function () {
  var KEY = 'czs_theme';
  var THEMES = {
    grind: { label: 'tthe grind', bg: '#060404', accent: '#e31c12', text: '#f2e9e4', bgRgb: '6,4,4',      accentRgb: '227,28,18', textRgb: '242,233,228' },
    riott: { label: 'riott',      bg: '#ffffff', accent: '#0a0a0a', text: '#0a0a0a', bgRgb: '255,255,255', accentRgb: '10,10,10', textRgb: '10,10,10' },
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
    var btns = document.querySelectorAll('#theme-ctrl button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-val') === name);
  }

  function set(name) {
    try { localStorage.setItem(KEY, name); } catch (e) { /* storage blocked */ }
    apply(name);
  }

  // CCTV-style timestamp in the RIOTT strip: 20.11.2026  21:04:33
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tick() {
    var els = document.querySelectorAll('.riott-hud .rh-time');
    if (!els.length) return;
    var d = new Date();
    var txt = pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() +
      '  ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    for (var i = 0; i < els.length; i++) els[i].textContent = txt;
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
    tick();
    setInterval(function () { if (root.getAttribute('data-theme') === 'riott') tick(); }, 1000);
  });

  // Keep other open tabs in sync.
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(get()); });
})();
