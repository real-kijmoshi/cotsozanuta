// Shared browser utilities — loaded by all HTML pages via <script src="/utils.js">
/* eslint-disable no-unused-vars */

/** XSS-escape HTML entities in user-supplied strings. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Debounce: delays calling `fn` until `wait` ms after the last invocation. */
function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}
