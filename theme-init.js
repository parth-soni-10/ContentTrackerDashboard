// Anti-flash theme init: apply the saved preference to <html> before the first
// paint, so a dark-mode visitor never sees a white flash.
//
// An external file rather than an inline <script> in index.html, because the
// deployed CSP is script-src 'self' with no 'unsafe-inline' and no hash - an
// inline copy would be blocked, and the only symptom would be the flash coming
// back for dark-mode visitors.
//
// Loaded synchronously: no defer and no async, on purpose. Deferred, it would
// run after the document is parsed, which is after the first paint, which is
// exactly the flash this exists to prevent.
//
// Wrapped in try/catch because localStorage throws outright when storage is
// disabled, and a theme preference is never worth an exception on the critical
// path - the stylesheet's default theme is a perfectly good outcome.
// First, before anything that can fail: mark the document as scripted. The
// stylesheet hides the loading overlay only while <html> carries `no-js`, so
// removing it here is what shows the loader again; if this file never runs (JS
// disabled, or the request failed) the class stays and the static introduction
// in #app is the page, with the overlay out of the way.
document.documentElement.classList.remove('no-js');

try {
  if (localStorage.getItem('ct-theme') === 'dark') {
    document.documentElement.classList.add('dark');
  }
} catch (e) {
  /* storage disabled - fall through to the default theme */
}
