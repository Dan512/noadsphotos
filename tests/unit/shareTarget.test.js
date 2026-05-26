// tests/unit/shareTarget.test.js — Feature #14 PWA share target.
//
// We can't easily unit-test the launchQueue path without elaborate DOM
// mocks (FileSystemFileHandle, importFiles, showToast, t() all live behind
// real module imports). What we CAN cover cheaply and meaningfully:
//
//   1) The pure URL-fallback predicate (shouldShowUnsupportedHint) —
//      ensures we only nag the user when (a) they actually landed via a
//      share intent and (b) the modern API isn't available.
//   2) The three new i18n keys are present in TRANSLATIONS.en so the
//      runtime never falls through to a `[?]key` placeholder.
//
// Import side-effects: shareTarget.js imports importer.js, which pulls in
// queue.js / state.js / a chunk of the DOM stack. We isolate by importing
// only the pure helper via a dynamic import after stubbing the globals the
// transitive imports touch (the same shape used by i18n-coverage.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal globals so importing the i18n + importer transitive chain works
// under Node. Mirror the shape used by tests/unit/i18n-coverage.test.js.
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
} catch { /* already overridden by another test that ran first */ }
if (!globalThis.document) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { documentElement: { lang: '', dir: '' } },
  });
}

const { shouldShowUnsupportedHint } = await import('../../js/shareTarget.js');
const { TRANSLATIONS } = await import('../../js/i18n.js');

test('shouldShowUnsupportedHint returns true when ?share-target is set AND launchQueue is absent', () => {
  assert.equal(shouldShowUnsupportedHint('?share-target', false), true);
  assert.equal(shouldShowUnsupportedHint('?share-target=1&foo=bar', false), true);
});

test('shouldShowUnsupportedHint returns false when launchQueue is available (modern path will handle it)', () => {
  assert.equal(shouldShowUnsupportedHint('?share-target', true), false);
});

test('shouldShowUnsupportedHint returns false for unrelated URLs or missing search', () => {
  assert.equal(shouldShowUnsupportedHint('', false), false);
  assert.equal(shouldShowUnsupportedHint('?foo=bar', false), false);
  assert.equal(shouldShowUnsupportedHint(null, false), false);
  assert.equal(shouldShowUnsupportedHint(undefined, false), false);
});

test('share-target i18n keys exist in TRANSLATIONS.en', () => {
  for (const key of ['shareTargetReceived', 'shareTargetFailed', 'shareTargetUnsupported']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(TRANSLATIONS.en, key),
      `Missing EN i18n key: ${key}`,
    );
    assert.equal(typeof TRANSLATIONS.en[key], 'string');
    assert.ok(TRANSLATIONS.en[key].length > 0, `EN i18n key '${key}' is empty`);
  }
});

test('manifest.webmanifest declares a valid share_target', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const __filename = url.fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const manifestPath = path.resolve(__dirname, '..', '..', 'manifest.webmanifest');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw); // throws if invalid JSON
  assert.ok(manifest.share_target, 'manifest is missing share_target');
  assert.equal(manifest.share_target.method, 'POST');
  assert.equal(manifest.share_target.enctype, 'multipart/form-data');
  assert.ok(Array.isArray(manifest.share_target.params.files));
  assert.equal(manifest.share_target.params.files[0].name, 'image');
  // HEIC/HEIF must be explicit — image/* doesn't always match on Android.
  const accept = manifest.share_target.params.files[0].accept;
  assert.ok(accept.includes('image/*'));
  assert.ok(accept.includes('image/heic'));
  assert.ok(accept.includes('image/heif'));
});
