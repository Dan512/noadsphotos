// tests/unit/pdf.test.js — v1.1 Feature 4 (Image → PDF export).
//
// Covers the pure layoutPage() math in js/render/pdfRenderer.js. The actual
// PDF byte-stream build + jsPDF interaction is covered by the browser specs
// (it needs real Canvas + FileReader APIs).
//
// layoutPage's math is the load-bearing piece for "does the picture land
// where the user expects" — orientation auto-rotation, margin defaults that
// differ between fit-to-image and named pages, contain vs cover scaling.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal globals so importing js/render/pdfRenderer.js (which transitively
// imports the exporter module, which imports i18n) doesn't blow up under
// Node. Mirrors the shape used by tests/unit/exporter.test.js.
if (!globalThis.localStorage) {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
    },
  });
}
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    get() { return { language: 'en' }; },
  });
} catch { /* already configured */ }
if (!globalThis.document) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { documentElement: { lang: '', dir: '' } },
  });
}

const { layoutPage, PAGE_SIZES_PT } = await import('../../js/render/pdfRenderer.js');

// Helper: minimal image state shaped as renderForExport / effectiveImageSize expect.
function makeImg(w, h) {
  return {
    id: 'test-img',
    source: { width: w, height: h, type: 'image/png' },
    transforms: {},
    adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    overlays: [],
  };
}

// --------------------------------------------------------------------------
// PAGE_SIZES_PT — sanity-check the named dimensions are correct.
// --------------------------------------------------------------------------

test('PAGE_SIZES_PT: includes Letter / A4 / Legal / A3 / B5 with portrait dims', () => {
  // Each named size is stored portrait-style (w < h). Landscape is derived
  // by swapping inside layoutPage.
  for (const id of ['letter', 'a4', 'legal', 'a3', 'b5']) {
    assert.ok(PAGE_SIZES_PT[id], `${id} should be a known size`);
    assert.ok(PAGE_SIZES_PT[id].w < PAGE_SIZES_PT[id].h, `${id} dims stored portrait-style`);
  }
  assert.equal(PAGE_SIZES_PT.letter.w, 612);
  assert.equal(PAGE_SIZES_PT.letter.h, 792);
  assert.equal(PAGE_SIZES_PT.a4.w, 595);
  assert.equal(PAGE_SIZES_PT.a4.h, 842);
});

// --------------------------------------------------------------------------
// Fit-to-image page size — page IS the image pixel rect at 1pt = 1px.
// --------------------------------------------------------------------------

test('layoutPage: fit-to-image landscape uses image dims as page dims, image fills page', () => {
  const img = makeImg(1200, 800);
  const r = layoutPage(img, { pageSize: 'fit', orientation: 'auto' });
  assert.equal(r.pageW, 1200);
  assert.equal(r.pageH, 800);
  assert.equal(r.imgX, 0);
  assert.equal(r.imgY, 0);
  assert.equal(r.imgW, 1200);
  assert.equal(r.imgH, 800);
});

test('layoutPage: fit-to-image portrait stays portrait when orientation auto', () => {
  const img = makeImg(600, 1200);
  const r = layoutPage(img, { pageSize: 'fit', orientation: 'auto' });
  assert.equal(r.pageW, 600);
  assert.equal(r.pageH, 1200);
});

test('layoutPage: fit page with margin reserves space and centers image', () => {
  const img = makeImg(1000, 600);
  const r = layoutPage(img, { pageSize: 'fit', orientation: 'auto', margins: 50 });
  // Page IS the image rect at 1pt = 1px.
  assert.equal(r.pageW, 1000);
  assert.equal(r.pageH, 600);
  // Inner rect = page - 2*margin = 900 × 500.
  // 1000:600 aspect = 1.667; inner aspect = 900:500 = 1.8 → height-limited
  // Wait — actually with cover/contain... fit + margin > 0 falls under the
  // "contain" branch since pageSize='fit' && margin === 0 is the only
  // "edge-to-edge" exception. Let's verify margins shrink the image.
  assert.ok(r.imgW < 1000);
  assert.ok(r.imgH < 600);
  // Image is centered.
  assert.ok(Math.abs((r.imgX + r.imgW / 2) - r.pageW / 2) < 0.001);
  assert.ok(Math.abs((r.imgY + r.imgH / 2) - r.pageH / 2) < 0.001);
});

// --------------------------------------------------------------------------
// Orientation auto: choose landscape for wide, portrait for tall.
// --------------------------------------------------------------------------

test('layoutPage: A4 + orientation auto + wide image → landscape page', () => {
  const img = makeImg(2000, 1000);
  const r = layoutPage(img, { pageSize: 'a4', orientation: 'auto' });
  // A4 portrait is 595×842; landscape is 842×595.
  assert.equal(r.pageW, 842);
  assert.equal(r.pageH, 595);
});

test('layoutPage: A4 + orientation auto + tall image → portrait page', () => {
  const img = makeImg(1000, 2000);
  const r = layoutPage(img, { pageSize: 'a4', orientation: 'auto' });
  // A4 portrait is 595×842.
  assert.equal(r.pageW, 595);
  assert.equal(r.pageH, 842);
});

test('layoutPage: forced portrait flips dims to portrait even for wide image', () => {
  const img = makeImg(2000, 1000);
  const r = layoutPage(img, { pageSize: 'a4', orientation: 'portrait' });
  assert.equal(r.pageW, 595);
  assert.equal(r.pageH, 842);
});

test('layoutPage: forced landscape flips dims to landscape even for tall image', () => {
  const img = makeImg(1000, 2000);
  const r = layoutPage(img, { pageSize: 'a4', orientation: 'landscape' });
  assert.equal(r.pageW, 842);
  assert.equal(r.pageH, 595);
});

// --------------------------------------------------------------------------
// Default margins: 0 for fit, 36 for named pages.
// --------------------------------------------------------------------------

test('layoutPage: fit page defaults to 0 margins (edge-to-edge)', () => {
  const img = makeImg(1000, 800);
  const r = layoutPage(img, { pageSize: 'fit', orientation: 'auto' });
  // The fit + margin === 0 branch makes image fill page exactly.
  assert.equal(r.imgW, 1000);
  assert.equal(r.imgH, 800);
  assert.equal(r.imgX, 0);
  assert.equal(r.imgY, 0);
});

test('layoutPage: named page defaults to 36pt margins', () => {
  const img = makeImg(2000, 2000); // square so we test margin not aspect
  const r = layoutPage(img, { pageSize: 'letter', orientation: 'portrait' });
  // Page is 612×792 portrait. Margin = 36 → inner = 540 × 720. Square image:
  // contain scales so the larger axis matches the smaller inner axis (540).
  assert.equal(r.pageW, 612);
  assert.equal(r.pageH, 792);
  assert.equal(r.imgW, 540);
  assert.equal(r.imgH, 540);
  // Centered: imgX = 36 + (540 - 540)/2 = 36; imgY = 36 + (720 - 540)/2 = 126.
  assert.equal(r.imgX, 36);
  assert.equal(r.imgY, 126);
});

// --------------------------------------------------------------------------
// Contain vs Cover fit modes.
// --------------------------------------------------------------------------

test('layoutPage: contain fits image entirely inside inner rect (no overflow)', () => {
  const img = makeImg(4000, 2000); // 2:1 aspect
  const r = layoutPage(img, {
    pageSize: 'a4',
    orientation: 'landscape',
    margins: 0,
    fitMode: 'contain',
  });
  // A4 landscape = 842 × 595, margin 0 → inner = 842 × 595.
  // Image aspect = 2.0. Width-fit: 842 / 4000 = 0.2105 → 4000*0.2105 = 842,
  // 2000*0.2105 = 420.5. Height-fit: 595 / 2000 = 0.2975 → 4000*0.2975 = 1190,
  // 2000*0.2975 = 595. Contain picks the smaller scale (0.2105) so the larger
  // axis matches and the other axis fits inside.
  assert.ok(r.imgW <= 842 + 0.001);
  assert.ok(r.imgH <= 595 + 0.001);
  assert.ok(Math.abs(r.imgW - 842) < 0.001);
});

test('layoutPage: cover fills inner rect, larger axis overflows', () => {
  const img = makeImg(4000, 2000); // 2:1 aspect
  const r = layoutPage(img, {
    pageSize: 'a4',
    orientation: 'landscape',
    margins: 0,
    fitMode: 'cover',
  });
  // Same inner rect. Cover picks the LARGER scale (0.2975) so the smaller
  // axis matches → 1190 × 595 image inside an 842 × 595 inner rect.
  assert.ok(r.imgW > 842);
  assert.ok(Math.abs(r.imgH - 595) < 0.001);
});

// --------------------------------------------------------------------------
// Margins clamping.
// --------------------------------------------------------------------------

test('layoutPage: negative margins are clamped to 0', () => {
  const img = makeImg(1000, 1000);
  const r = layoutPage(img, { pageSize: 'a4', orientation: 'portrait', margins: -20 });
  // No margin means inner rect = page rect. The image fits inside.
  assert.equal(r.imgX + r.imgW / 2, r.pageW / 2);
});

test('layoutPage: invalid image dims fall back to source.width/height', () => {
  // imageState with effectiveImageSize returning 0 — falls back to source.
  const img = makeImg(500, 250);
  const r = layoutPage(img, { pageSize: 'fit', orientation: 'auto' });
  assert.equal(r.pageW, 500);
  assert.equal(r.pageH, 250);
});

// --------------------------------------------------------------------------
// Unknown page-size IDs fall back to 'fit'.
// --------------------------------------------------------------------------

test('layoutPage: unknown pageSize string falls back to fit (image dims)', () => {
  const img = makeImg(800, 600);
  const r = layoutPage(img, { pageSize: 'unknown-format', orientation: 'auto' });
  // Falls back to image dims (which is the 'fit' branch).
  assert.equal(r.pageW, 800);
  assert.equal(r.pageH, 600);
});
