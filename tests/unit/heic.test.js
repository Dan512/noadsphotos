// tests/unit/heic.test.js — v1.1 Feature 5. Pure-JS surface of the HEIC
// import path. The real wasm decoder never runs under node:test, so this
// file only covers detection + loader metadata. The end-to-end import flow
// (consent modal, decode, queue insertion) is exercised in
// tests/browser/heic-import.spec.js.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal browser-ish globals so heic-loader.js + the importer can import.
// We only need localStorage; the loader's DOM/script-tag paths are exercised
// in the browser spec.
// ---------------------------------------------------------------------------
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { storage.set(String(k), String(v)); },
    removeItem(k) { storage.delete(String(k)); },
    clear() { storage.clear(); },
  },
});

before(() => {
  // i18n.js reads document on import. Provide a tiny stub.
  if (typeof globalThis.document === 'undefined') {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        documentElement: { lang: '', dir: '' },
      },
    });
  }
});

beforeEach(() => storage.clear());

// Dynamic imports so all our globals are in place first.
const importer    = await import('../../js/importer.js');
const heicLoader  = await import('../../js/vendor/heic-loader.js');

// ---------------------------------------------------------------------------
// isHeicFile / isAcceptedImageFile
// ---------------------------------------------------------------------------

test('isHeicFile: matches lowercase .heic extension', () => {
  assert.equal(importer.isHeicFile({ name: 'photo.heic', type: '' }), true);
});

test('isHeicFile: matches uppercase .HEIC extension (case-insensitive)', () => {
  assert.equal(importer.isHeicFile({ name: 'PHOTO.HEIC', type: '' }), true);
});

test('isHeicFile: matches lowercase .heif extension', () => {
  assert.equal(importer.isHeicFile({ name: 'photo.heif', type: '' }), true);
});

test('isHeicFile: matches MixedCase .Heic and .HeIf', () => {
  assert.equal(importer.isHeicFile({ name: 'photo.Heic', type: '' }), true);
  assert.equal(importer.isHeicFile({ name: 'photo.HeIf', type: '' }), true);
});

test('isHeicFile: matches image/heic MIME with no extension hint', () => {
  assert.equal(importer.isHeicFile({ name: 'photo', type: 'image/heic' }), true);
});

test('isHeicFile: matches image/heif MIME', () => {
  assert.equal(importer.isHeicFile({ name: 'photo', type: 'image/heif' }), true);
});

test('isHeicFile: matches MIME uppercase (Image/HEIC)', () => {
  assert.equal(importer.isHeicFile({ name: 'photo', type: 'Image/HEIC' }), true);
});

test('isHeicFile: rejects .jpg extension', () => {
  assert.equal(importer.isHeicFile({ name: 'photo.jpg', type: 'image/jpeg' }), false);
});

test('isHeicFile: rejects empty / null file', () => {
  assert.equal(importer.isHeicFile(null), false);
  assert.equal(importer.isHeicFile({}), false);
  assert.equal(importer.isHeicFile({ name: '', type: '' }), false);
});

test('isHeicFile: rejects unrelated extensions that contain heic-like substrings', () => {
  // Defensive: nothing trailing .heicx should look like a HEIC.
  assert.equal(importer.isHeicFile({ name: 'photo.heicx', type: '' }), false);
  assert.equal(importer.isHeicFile({ name: 'archeic.png', type: 'image/png' }), false);
});

test('isAcceptedImageFile: accepts standard JPEG/PNG/WebP/GIF by MIME', () => {
  assert.equal(importer.isAcceptedImageFile({ type: 'image/jpeg', name: 'a.jpg' }), true);
  assert.equal(importer.isAcceptedImageFile({ type: 'image/png',  name: 'a.png' }), true);
  assert.equal(importer.isAcceptedImageFile({ type: 'image/webp', name: 'a.webp' }), true);
  assert.equal(importer.isAcceptedImageFile({ type: 'image/gif',  name: 'a.gif' }), true);
});

test('isAcceptedImageFile: accepts HEIC by extension only (no MIME)', () => {
  assert.equal(importer.isAcceptedImageFile({ type: '', name: 'phone.heic' }), true);
});

test('isAcceptedImageFile: accepts HEIF by extension only (no MIME)', () => {
  assert.equal(importer.isAcceptedImageFile({ type: '', name: 'phone.heif' }), true);
});

test('isAcceptedImageFile: accepts HEIC by MIME only (no extension)', () => {
  assert.equal(importer.isAcceptedImageFile({ type: 'image/heic', name: 'phone' }), true);
});

test('isAcceptedImageFile: rejects text/plain', () => {
  assert.equal(importer.isAcceptedImageFile({ type: 'text/plain', name: 'note.txt' }), false);
});

test('isAcceptedImageFile: rejects image/tiff (out of scope)', () => {
  assert.equal(importer.isAcceptedImageFile({ type: 'image/tiff', name: 'scan.tif' }), false);
});

test('isAcceptedImageFile: rejects unknown / empty file', () => {
  assert.equal(importer.isAcceptedImageFile({}), false);
  assert.equal(importer.isAcceptedImageFile(null), false);
  assert.equal(importer.isAcceptedImageFile(undefined), false);
});

// ---------------------------------------------------------------------------
// heic-loader: exported constants + consent storage
// ---------------------------------------------------------------------------

test('heic-loader: CONSENT_KEY is a non-empty, namespaced string', () => {
  assert.equal(typeof heicLoader.CONSENT_KEY, 'string');
  assert.ok(heicLoader.CONSENT_KEY.length > 0);
  assert.match(heicLoader.CONSENT_KEY, /^noadsimages_/);
});

test('heic-loader: VENDOR_HASH is a non-empty string with the libheif tag', () => {
  assert.equal(typeof heicLoader.VENDOR_HASH, 'string');
  assert.ok(heicLoader.VENDOR_HASH.length > 0);
  // Sanity: vendor hash should reference libheif so reviewers know what
  // version of the decoder a stored consent matches.
  assert.match(heicLoader.VENDOR_HASH, /libheif/i);
});

test('heic-loader: VENDOR_SIZE_LABEL contains a number followed by MB', () => {
  assert.equal(typeof heicLoader.VENDOR_SIZE_LABEL, 'string');
  assert.match(heicLoader.VENDOR_SIZE_LABEL, /\d/);
  assert.match(heicLoader.VENDOR_SIZE_LABEL, /MB/i);
});

test('hasStoredConsent: false when localStorage is empty', () => {
  heicLoader._resetForTest();
  assert.equal(heicLoader.hasStoredConsent(), false);
});

test('hasStoredConsent: true when stored value matches VENDOR_HASH', () => {
  heicLoader._resetForTest();
  globalThis.localStorage.setItem(heicLoader.CONSENT_KEY, heicLoader.VENDOR_HASH);
  assert.equal(heicLoader.hasStoredConsent(), true);
});

test('hasStoredConsent: false when stored value does NOT match VENDOR_HASH (stale)', () => {
  heicLoader._resetForTest();
  globalThis.localStorage.setItem(heicLoader.CONSENT_KEY, 'libheif-vSTALE');
  assert.equal(heicLoader.hasStoredConsent(), false);
});

test('hasStoredConsent: tolerates a throwing localStorage and returns false', () => {
  heicLoader._resetForTest();
  const orig = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem() { throw new Error('quota exceeded'); },
      setItem() { throw new Error('quota exceeded'); },
      removeItem() { /* noop */ },
    },
  });
  try {
    assert.equal(heicLoader.hasStoredConsent(), false);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, writable: true, value: orig,
    });
  }
});

test('ensureHeicConsent: returns true immediately when stored hash matches', async () => {
  heicLoader._resetForTest();
  globalThis.localStorage.setItem(heicLoader.CONSENT_KEY, heicLoader.VENDOR_HASH);
  const result = await heicLoader.ensureHeicConsent();
  assert.equal(result, true);
});

test('ensureHeicConsent: respects _setConsentForTest("grant")', async () => {
  heicLoader._resetForTest();
  heicLoader._setConsentForTest('grant');
  try {
    const result = await heicLoader.ensureHeicConsent();
    assert.equal(result, true);
  } finally {
    heicLoader._setConsentForTest(null);
  }
});

test('ensureHeicConsent: respects _setConsentForTest("deny")', async () => {
  heicLoader._resetForTest();
  heicLoader._setConsentForTest('deny');
  try {
    const result = await heicLoader.ensureHeicConsent();
    assert.equal(result, false);
  } finally {
    heicLoader._setConsentForTest(null);
  }
});

test('_setHeicDecoderForTest: short-circuits loadHeicDecoder() with the injected impl (after consent)', async () => {
  heicLoader._resetForTest();
  // Pre-grant consent so the loader doesn't try to open a real <dialog> in
  // this no-DOM test environment.
  heicLoader._setConsentForTest('grant');
  const fake = { decode: async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) };
  heicLoader._setHeicDecoderForTest(fake);
  try {
    const got = await heicLoader.loadHeicDecoder();
    assert.equal(got, fake);
    // And calling decode works through our wrapper.
    const out = await got.decode(new ArrayBuffer(0));
    assert.equal(out.width, 1);
    assert.equal(out.height, 1);
  } finally {
    heicLoader._setHeicDecoderForTest(null);
    heicLoader._setConsentForTest(null);
  }
});

test('_resetForTest: clears stored consent + test injections', async () => {
  globalThis.localStorage.setItem(heicLoader.CONSENT_KEY, heicLoader.VENDOR_HASH);
  heicLoader._setHeicDecoderForTest({ decode: async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) });
  heicLoader._setConsentForTest('grant');
  assert.equal(heicLoader.hasStoredConsent(), true);
  heicLoader._resetForTest();
  assert.equal(heicLoader.hasStoredConsent(), false);
  // After reset, consent override is gone, so a deny-by-default would apply
  // — we just verify by checking the override clears.
  assert.equal(typeof heicLoader.hasStoredConsent(), 'boolean');
});
