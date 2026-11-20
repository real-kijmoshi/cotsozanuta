// Album color themes. Loaded in <head> (blocking, tiny) so the saved theme is
// applied before first paint — no flash of the default palette.
//   grind – TTHE GRIND (default): blood red on burnt black
//   riott – RIOTT: photocopied zine, black ink on off-white paper
(function () {
  var KEY = 'czs_theme';
  var THEMES = {
    grind: { label: 'tthe grind', bg: '#060404', accent: '#e31c12', text: '#f2e9e4', bgRgb: '6,4,4',  accentRgb: '227,28,18', textRgb: '242,233,228', tag: null },
    riott: { label: 'riott',      bg: '#eceae4', accent: '#111111', text: '#111111', bgRgb: '236,234,228', accentRgb: '17,17,17', textRgb: '17,17,17', tag: 'RIO<span class="riott-drop">T</span><span class="riott-drop" style="transform:translateY(.84em)">T</span>', year: '2026 2020' },
  };
  var root = document.documentElement;

  function get() {
    var t;
    try { t = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    return THEMES[t] ? t : 'grind';
  }

  // Theme-specific decorative text. Values are static strings from THEMES
  // above (never user input), so innerHTML is safe here.
  function swapText(id, html) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!el.hasAttribute('data-orig')) el.setAttribute('data-orig', el.textContent);
    if (html) el.innerHTML = html;
    else el.textContent = el.getAttribute('data-orig');
  }

  function apply(name) {
    if (!THEMES[name]) name = 'grind';
    if (name === 'grind') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES[name].bg);
    swapText('bg-tag', THEMES[name].tag);
    swapText('bg-year', THEMES[name].year);
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
