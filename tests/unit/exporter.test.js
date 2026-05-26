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

const { formatBytes, hasTransparency, watermarkCacheKey } = await import('../../js/exporter.js');

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

// --- watermarkCacheKey ---------------------------------------------------
//
// Regression coverage for v1.2.08 cache-key bug: changing watermark state
// MUST produce a different fingerprint so the predict-encode cache misses
// and the next export bakes in the new settings. Before the fix, the cache
// key only included per-image state; toggling the watermark or tweaking
// scale produced a cache HIT and re-served stale bytes.

test('watermarkCacheKey: disabled / null / undefined all hash to "wm:off"', () => {
  assert.equal(watermarkCacheKey(null), 'wm:off');
  assert.equal(watermarkCacheKey(undefined), 'wm:off');
  assert.equal(watermarkCacheKey({}), 'wm:off');
  assert.equal(watermarkCacheKey({ enabled: false }), 'wm:off');
  assert.equal(watermarkCacheKey({ enabled: false, scale: 0.5 }), 'wm:off');
});

test('watermarkCacheKey: enabled → not "wm:off", and starts with "wm:on"', () => {
  const k = watermarkCacheKey({ enabled: true, type: 'text', text: 'A' });
  assert.notEqual(k, 'wm:off');
  assert.ok(k.startsWith('wm:on'), `expected key to start with "wm:on", got ${k}`);
});

test('watermarkCacheKey: toggling enabled flips the fingerprint (Bug fix)', () => {
  const base = {
    type: 'text', text: '© Dan', position: 'bottom-right',
    opacity: 0.6, scale: 0.15, tiledAngle: -30,
    customX: 0.5, customY: 0.5,
    textFont: 'sans-serif', textSize: 0.04, textColor: '#fff',
  };
  const off = watermarkCacheKey({ ...base, enabled: false });
  const on  = watermarkCacheKey({ ...base, enabled: true  });
  assert.notEqual(on, off);
});

test('watermarkCacheKey: changing scale invalidates the key (Bug 1 regression)', () => {
  const base = { enabled: true, type: 'text', text: 'X', position: 'tiled', opacity: 0.6, tiledAngle: -30 };
  const a = watermarkCacheKey({ ...base, scale: 0.28 });
  const b = watermarkCacheKey({ ...base, scale: 0.30 });
  assert.notEqual(a, b);
});

test('watermarkCacheKey: changing position invalidates the key', () => {
  const base = { enabled: true, type: 'text', text: 'X', scale: 0.15, opacity: 0.6 };
  assert.notEqual(
    watermarkCacheKey({ ...base, position: 'bottom-right' }),
    watermarkCacheKey({ ...base, position: 'top-left' }),
  );
});

test('watermarkCacheKey: changing text / color / opacity each invalidates the key', () => {
  const base = {
    enabled: true, type: 'text', text: '© Dan', position: 'bottom-right',
    scale: 0.15, opacity: 0.6, textColor: '#ffffff', textFont: 'sans-serif',
  };
  const ref = watermarkCacheKey(base);
  assert.notEqual(watermarkCacheKey({ ...base, text: '© Other' }), ref);
  assert.notEqual(watermarkCacheKey({ ...base, textColor: '#000000' }), ref);
  assert.notEqual(watermarkCacheKey({ ...base, opacity: 0.4 }), ref);
});

test('watermarkCacheKey: identical inputs produce identical keys (stable)', () => {
  const wm = {
    enabled: true, type: 'image', position: 'tiled',
    opacity: 0.5, scale: 0.2, tiledAngle: -30,
    customX: 0.3, customY: 0.7,
    text: '', textFont: 'sans-serif', textSize: 0.04, textColor: '#fff',
    imageBlobBase64: 'AAAA',
  };
  assert.equal(watermarkCacheKey(wm), watermarkCacheKey({ ...wm }));
});

test('watermarkCacheKey: skips transient imageBlobUrl (regenerates each session)', () => {
  // Two watermarks identical except for imageBlobUrl should hash the same —
  // the URL is a fresh ObjectURL per session, NOT a content-bearing field.
  const base = { enabled: true, type: 'image', scale: 0.15, opacity: 0.6, imageBlobBase64: 'XYZ' };
  assert.equal(
    watermarkCacheKey({ ...base, imageBlobUrl: 'blob:foo' }),
    watermarkCacheKey({ ...base, imageBlobUrl: 'blob:bar' }),
  );
});
