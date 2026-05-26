// tests/unit/formatSmart.test.js — pure helpers for the smart match-source
// default export format. No DOM dependencies, no state, just MIME / extension
// matching + transparency promotion.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getSmartDefaultFormat } = await import('../../js/ops/formatSmart.js');

// --- Source MIME match ---------------------------------------------------

test('getSmartDefaultFormat: PNG source → png', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: 'image/png', name: 'pic.png' } }),
    'png',
  );
});

test('getSmartDefaultFormat: JPEG source → jpeg', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: 'image/jpeg', name: 'pic.jpg' } }),
    'jpeg',
  );
});

test('getSmartDefaultFormat: WebP source → webp', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: 'image/webp', name: 'pic.webp' } }),
    'webp',
  );
});

test('getSmartDefaultFormat: HEIC source MIME → jpeg (HEIC is not a sensible output)', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: 'image/heic', name: 'pic.heic' } }),
    'jpeg',
  );
  assert.equal(
    getSmartDefaultFormat({ source: { type: 'image/heif', name: 'pic.heif' } }),
    'jpeg',
  );
});

test('getSmartDefaultFormat: unknown MIME + .heic extension → jpeg', () => {
  // Some browsers (notably Safari pre-17) hand back an empty type for HEIC.
  // Filename extension is the fallback.
  assert.equal(
    getSmartDefaultFormat({ source: { type: '', name: 'IMG_0042.HEIC' } }),
    'jpeg',
  );
  assert.equal(
    getSmartDefaultFormat({ source: { type: 'application/octet-stream', name: 'shot.heif' } }),
    'jpeg',
  );
});

test('getSmartDefaultFormat: unknown MIME + .png extension → png', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: '', name: 'pic.PNG' } }),
    'png',
  );
});

test('getSmartDefaultFormat: unknown MIME + .jpg/.jpeg → jpeg', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: '', name: 'pic.jpg' } }),
    'jpeg',
  );
  assert.equal(
    getSmartDefaultFormat({ source: { type: '', name: 'pic.JPEG' } }),
    'jpeg',
  );
});

test('getSmartDefaultFormat: unknown MIME + .webp → webp', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: '', name: 'pic.webp' } }),
    'webp',
  );
});

test('getSmartDefaultFormat: totally unknown source → jpeg fallback', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { type: '', name: 'mystery.dat' } }),
    'jpeg',
  );
  assert.equal(
    getSmartDefaultFormat({ source: { type: 'image/tiff', name: 'scan.tif' } }),
    'jpeg',
  );
});

// --- Transparency promotion ---------------------------------------------

test('getSmartDefaultFormat: JPEG source + bgRemoved → webp (promoted, not png)', () => {
  // The smart default for JPEG-with-alpha is WebP because it's smaller than
  // PNG at equivalent quality AND supports transparency.
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/jpeg', name: 'pic.jpg' },
      bgRemoved: true,
    }),
    'webp',
  );
});

test('getSmartDefaultFormat: JPEG source + bgMask → webp (promoted)', () => {
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/jpeg', name: 'pic.jpg' },
      bgMask: new Uint8Array(10),
    }),
    'webp',
  );
});

test('getSmartDefaultFormat: JPEG source + chromakeyMask → webp (promoted)', () => {
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/jpeg', name: 'pic.jpg' },
      chromakeyMask: new Uint8Array(10),
    }),
    'webp',
  );
});

test('getSmartDefaultFormat: PNG source + bgRemoved → png (unchanged, already alpha-capable)', () => {
  // PNG already carries alpha — no promotion needed. The user implicitly
  // asked for PNG-in/PNG-out by importing a PNG.
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/png', name: 'pic.png' },
      bgRemoved: true,
    }),
    'png',
  );
});

test('getSmartDefaultFormat: WebP source + bgRemoved → webp (unchanged)', () => {
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/webp', name: 'pic.webp' },
      bgRemoved: true,
    }),
    'webp',
  );
});

test('getSmartDefaultFormat: HEIC source + bgRemoved → webp (HEIC base is JPEG, then promoted)', () => {
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/heic', name: 'pic.heic' },
      bgRemoved: true,
    }),
    'webp',
  );
});

// --- fromHeic flag (HEIC imports re-encoded to PNG-backed bytes) --------
//
// The HEIC importer in js/importer.js decodes HEIC → ImageData → PNG-backed
// File, then stashes `source.type = 'image/png'` and renames the file to
// '.png'. Without the `fromHeic` flag, getSmartDefaultFormat would pick PNG
// — defeating the whole point (iPhone users want small JPEGs out, not 30 MB
// PNGs). The flag is a high-priority signal that overrides MIME/extension.

test('getSmartDefaultFormat: fromHeic + PNG-backed source → jpeg (overrides PNG MIME)', () => {
  // Mirrors what the HEIC importer actually produces post-decode: type/name
  // both say PNG, but the original input was HEIC. Expect JPEG, not PNG.
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/png', name: 'IMG_0042.png', fromHeic: true },
    }),
    'jpeg',
  );
});

test('getSmartDefaultFormat: fromHeic + bgRemoved → webp (transparency promotion still applies)', () => {
  // JPEG can't carry alpha. If the user bg-removed a HEIC import, promote
  // to WebP — same logic that applies to any JPEG-base + transparency case.
  assert.equal(
    getSmartDefaultFormat({
      source: { type: 'image/png', name: 'IMG_0042.png', fromHeic: true },
      bgRemoved: true,
    }),
    'webp',
  );
});

// --- Defensive paths -----------------------------------------------------

test('getSmartDefaultFormat: null / undefined → jpeg fallback', () => {
  assert.equal(getSmartDefaultFormat(null), 'jpeg');
  assert.equal(getSmartDefaultFormat(undefined), 'jpeg');
});

test('getSmartDefaultFormat: empty object → jpeg fallback', () => {
  assert.equal(getSmartDefaultFormat({}), 'jpeg');
  assert.equal(getSmartDefaultFormat({ source: {} }), 'jpeg');
});

test('getSmartDefaultFormat: missing name + missing type → jpeg fallback', () => {
  assert.equal(
    getSmartDefaultFormat({ source: { width: 100, height: 100 } }),
    'jpeg',
  );
});

test('getSmartDefaultFormat: accepts .mime alias on source (some test stubs use it)', () => {
  // The hasTransparency helper in exporter.js accepts either source.type OR
  // source.mime; we mirror that for consistency.
  assert.equal(
    getSmartDefaultFormat({ source: { mime: 'image/png', name: '' } }),
    'png',
  );
});
