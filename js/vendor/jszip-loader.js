// js/vendor/jszip-loader.js — bridges the vendored JSZip UMD bundle into ES-module land.
//
// JSZip 3.x ships only a UMD/AMD/global build (no native ESM). Rather than
// adopt a build step purely to consume it, we inject a <script> tag on first
// use and resolve once `window.JSZip` is set. The bundle is loaded from our
// own origin (`/js/vendor/jszip.min.js`) — no third-party CDN request at any
// point, which matches the brand stance.
//
// Cost shape:
//   - Initial page load: 0 KB. This module is imported lazily by exporter.js
//     only inside `exportBatch()`, so a user who never clicks "Export queue
//     (ZIP)" never pays the ~97 KB JSZip cost.
//   - Subsequent batch exports: 0 KB. The cached module-level `cached` Promise
//     ensures we only inject the <script> once per page load.
//
// Test note: jsdom-y test environments without a real DOM may want to stub
// this — we expose `_setJSZipForTest(JSZip)` to inject a fake.

let cached = null;
let testJSZip = null;

/**
 * Load JSZip lazily. Returns the JSZip constructor.
 *
 * @returns {Promise<typeof JSZip>}
 */
export function loadJSZip() {
  if (testJSZip) return Promise.resolve(testJSZip);
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    // If something else already loaded JSZip (e.g., a test stub), reuse it.
    if (typeof window !== 'undefined' && window.JSZip) {
      resolve(window.JSZip);
      return;
    }
    const s = document.createElement('script');
    s.src = '/js/vendor/jszip.min.js';
    s.async = true;
    s.onload = () => {
      if (typeof window !== 'undefined' && window.JSZip) {
        resolve(window.JSZip);
      } else {
        reject(new Error('jszip_loaded_but_global_missing'));
      }
    };
    s.onerror = (err) => reject(new Error('jszip_load_failed'));
    document.head.appendChild(s);
  });
  return cached;
}

// Test-only escape hatch so spec files can inject a fake without touching the
// network. Reset to null to fall back to real-script-tag loading.
export function _setJSZipForTest(jszip) {
  testJSZip = jszip || null;
  if (jszip) {
    cached = Promise.resolve(jszip);
  } else {
    cached = null;
  }
}
