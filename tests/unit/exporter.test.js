// tests/unit/exporter.test.js — pure helpers exported from js/exporter.js.
//
// The exporter has plenty of DOM-dependent code (showToast, triggerDownload,
// renderForExport, progress modals); we cover those in the browser specs.
// Here we focus on the side-effect-free helpers introduced by the v1.1
// compression-UI work: formatBytes() and hasTransparency().
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal globals so importing js/exporter.js (which transitively imports
// js/i18n.js) doesn't blow up under Node.
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

const { formatBytes, hasTransparency } = await import('../../js/exporter.js');

// --- formatBytes ---------------------------------------------------------

test('formatBytes: 0 → "0 B"', () => {
  assert.equal(formatBytes(0), '0 B');
});

test('formatBytes: tiny byte counts use the B suffix', () => {
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
});

test('formatBytes: KB range starts at 1024', () => {
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(2048), '2 KB');
  // 245 KB → matches the example readout in the spec.
  assert.equal(formatBytes(245 * 1024), '245 KB');
});

test('formatBytes: KB range rounds to nearest integer KB', () => {
  // 1024 * 1.4 = 1433.6 bytes → Math.round(1.4) = 1 KB
  assert.equal(formatBytes(Math.round(1024 * 1.4)), '1 KB');
  // 1024 * 1.6 = 1638.4 bytes → Math.round(1.6) = 2 KB
  assert.equal(formatBytes(Math.round(1024 * 1.6)), '2 KB');
});

test('formatBytes: MB range starts at 1 MB and uses one decimal', () => {
  assert.equal(formatBytes(1024 * 1024),        '1.0 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024),  '1.5 MB');
  assert.equal(formatBytes(4.8 * 1024 * 1024),  '4.8 MB');
});

test('formatBytes: very large values still render', () => {
  assert.equal(formatBytes(1024 * 1024 * 1024), '1024.0 MB');
});

test('formatBytes: negative or non-finite values fall back to "0 B"', () => {
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
  assert.equal(formatBytes(Infinity), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
});

// --- hasTransparency -----------------------------------------------------

test('hasTransparency: null state → false', () => {
  assert.equal(hasTransparency(null), false);
  assert.equal(hasTransparency(undefined), false);
});

test('hasTransparency: empty source → false', () => {
  assert.equal(hasTransparency({ source: {} }), false);
});

test('hasTransparency: source PNG → true (conservative default)', () => {
  // PNGs often carry alpha; without decoding pixels we play it safe.
  assert.equal(hasTransparency({ source: { type: 'image/png' } }), true);
});

test('hasTransparency: source JPEG → false (no alpha channel)', () => {
  assert.equal(hasTransparency({ source: { type: 'image/jpeg' } }), false);
});

test('hasTransparency: bgMask present → true', () => {
  assert.equal(
    hasTransparency({ source: { type: 'image/jpeg' }, bgMask: new Uint8Array(10) }),
    true,
  );
});

test('hasTransparency: chromakeyMask present → true', () => {
  assert.equal(
    hasTransparency({ source: { type: 'image/jpeg' }, chromakeyMask: new Uint8Array(10) }),
    true,
  );
});

test('hasTransparency: chromakey config with hex → true', () => {
  assert.equal(
    hasTransparency({ source: { type: 'image/jpeg' }, chromakey: { hex: '#ffffff', tolerance: 25 } }),
    true,
  );
});

test('hasTransparency: chromakey config with tolerance but no hex → true (configured at all means alpha possible)', () => {
  assert.equal(
    hasTransparency({ source: { type: 'image/jpeg' }, chromakey: { tolerance: 25 } }),
    true,
  );
});
