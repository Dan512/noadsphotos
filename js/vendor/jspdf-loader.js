// js/vendor/jspdf-loader.js — bridges the vendored jsPDF UMD bundle into ES-module land.
//
// We vendor jsPDF's UMD build (not the ESM build) because the ESM bundle has
// bare imports (`fflate`, `fast-png`, `@babel/runtime/*`) that would require
// vendoring each dependency or wiring four import-map entries. The UMD bundle
// inlines those deps and matches the loading pattern we already use for
// JSZip — a `<script>` injection that resolves once `globalThis.jspdf.jsPDF`
// is set. No third-party CDN; the bundle is served from this origin.
//
// Cost shape:
//   - Initial page load: 0 KB. This module is only imported by the PDF
//     renderer, which is itself only imported when the user actually clicks
//     "Download" with PDF selected as the format. A user who never exports
//     a PDF pays zero bandwidth and zero CPU for it.
//   - Subsequent PDF exports: 0 KB. The module-level `cached` Promise
//     ensures the `<script>` injects exactly once per page load.
//
// Test note: a `_setJsPdfForTest(ctor)` escape hatch lets specs swap in a
// fake constructor without touching the network.

let cached = null;
let testCtor = null;

/**
 * Load jsPDF lazily. Returns the jsPDF constructor.
 *
 * @returns {Promise<typeof jsPDF>}
 */
export function loadJsPdf() {
  if (testCtor) return Promise.resolve(testCtor);
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    // If something else already loaded jsPDF (e.g., a test stub), reuse it.
    if (typeof window !== 'undefined' && window.jspdf && window.jspdf.jsPDF) {
      resolve(window.jspdf.jsPDF);
      return;
    }
    const s = document.createElement('script');
    s.src = '/js/vendor/jspdf/jspdf.umd.min.js';
    s.async = true;
    s.onload = () => {
      if (typeof window !== 'undefined' && window.jspdf && window.jspdf.jsPDF) {
        resolve(window.jspdf.jsPDF);
      } else {
        reject(new Error('jspdf_loaded_but_global_missing'));
      }
    };
    s.onerror = () => reject(new Error('jspdf_load_failed'));
    document.head.appendChild(s);
  });
  return cached;
}

// Test-only escape hatch so spec files can inject a fake without touching the
// network. Reset to null to fall back to real-script-tag loading.
export function _setJsPdfForTest(ctor) {
  testCtor = ctor || null;
  if (ctor) {
    cached = Promise.resolve(ctor);
  } else {
    cached = null;
  }
}
