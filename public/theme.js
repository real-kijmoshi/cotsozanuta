// Album color themes. Loaded in <head> (blocking, tiny) so the saved theme is
// applied before first paint — no flash of the default palette.
//   grind – TTHE GRIND (default): blood red on burnt black
//   riott – RIOTT: redesign after the album's promo cards and clips —
//            serif stepped-letter logo, tracklist mode menu, CCTV-feed game
//            screen, white sheet with black type
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

  // RIOTT swaps a few bits of markup (logo lettering, camera overlay). The
  // HTML below is static and defined here, never user input. The original
  // markup is kept on the element so switching back restores it exactly.
  var LOGO = 'COTSOZANU<span class="rl-d1">T</span><span class="rl-d2">A</span>';
  var CAM = '<div class="cam-hud" aria-hidden="true">' +
    '<div class="cam-row"><span class="rh-time"></span><span>Area 32_Cam 22</span></div>' +
    '<div class="cam-row"><span class="cam-brand"><span class="tt-mark">T<span>T</span></span>CCTV Systems</span><span class="cam-rec"><i></i>REC</span></div>' +
    '</div>';

  function swap(el, html) {
    if (!el) return;
    if (!el.hasAttribute('data-orig-html')) el.setAttribute('data-orig-html', el.innerHTML);
    el.innerHTML = html == null ? el.getAttribute('data-orig-html') : html;
  }

  function decorate(name) {
    var riott = name === 'riott';
    var marks = document.querySelectorAll('.wordmark');
    for (var i = 0; i < marks.length; i++) swap(marks[i], riott ? '<span class="rl-logo">' + LOGO + '</span>' : null);
    swap(document.querySelector('#splash h1'), riott ? '<span class="rl-logo">' + LOGO + '</span>' : null);
    var feeds = document.querySelectorAll('#lyric-block, #audio-block');
    for (var j = 0; j < feeds.length; j++) {
      if (!feeds[j].querySelector('.cam-hud')) feeds[j].insertAdjacentHTML('afterbegin', CAM);
    }
    tick();
  }

  function apply(name) {
    if (!THEMES[name]) name = 'grind';
    if (name === 'grind') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEMES[name].bg);
    var btns = document.querySelectorAll('#theme-ctrl button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-val') === name);
    if (document.readyState !== 'loading') decorate(name);
  }

  function set(name) {
    try { localStorage.setItem(KEY, name); } catch (e) { /* storage blocked */ }
    apply(name);
  }

  // CCTV-style timestamp in the RIOTT strip: 20.11.2026  21:04:33
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function tick() {
    var els = document.querySelectorAll('.rh-time');
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
