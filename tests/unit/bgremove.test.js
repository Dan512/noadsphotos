// tests/unit/bgremove.test.js — Phase 11. Pure unit tests for js/ops/bgremove.js.
//
// The actual @imgly model never runs under node:test, so we can only cover the
// metadata + the consent-storage helpers here. The full apply-bg-remove flow
// + the editor / batch wiring is tested in tests/browser/bgremove.spec.js
// with a mocked impl via _setImplForTest.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub localStorage on globalThis BEFORE importing the module under test —
// the module reads window.localStorage at runtime, not at import time, but
// we set it up early to be safe across import orders.
function installLocalStorageStub() {
  const store = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
  return store;
}

let _store;
before(() => {
  _store = installLocalStorageStub();
});

beforeEach(() => {
  _store.clear();
});

after(() => {
  // Best-effort cleanup. Other unit tests don't touch localStorage so this
  // isn't strictly necessary, but tidy.
  try { delete globalThis.localStorage; } catch { /* ignore */ }
});

// Dynamic import so the stub is in place before the module's top-level code
// runs. (None of the top-level code touches localStorage today, but defensive.)
const bgremove = await import('../../js/ops/bgremove.js');

// --------------------------------------------------------------------------
// Exported constants
// --------------------------------------------------------------------------

test('exports CONSENT_KEY as a non-empty string', () => {
  assert.equal(typeof bgremove.CONSENT_KEY, 'string');
  assert.ok(bgremove.CONSENT_KEY.length > 0);
  // Namespaced under the site so it doesn't collide with sibling NoAds sites.
  assert.match(bgremove.CONSENT_KEY, /^noadsimages_/);
});

test('exports MODEL_HASH as a non-empty string', () => {
  assert.equal(typeof bgremove.MODEL_HASH, 'string');
  assert.ok(bgremove.MODEL_HASH.length > 0);
});

test('exports MODEL_SIZE_LABEL as a non-empty string', () => {
  assert.equal(typeof bgremove.MODEL_SIZE_LABEL, 'string');
  assert.ok(bgremove.MODEL_SIZE_LABEL.length > 0);
});

test('MODEL_HASH was bumped to a webgpu-aware version', () => {
  // Bumped from imgly-isnet-fp16-v1 when WebGPU support was added so users
  // who consented under the smaller-payload v1 are re-prompted to consent
  // to the larger asset set.
  assert.match(bgremove.MODEL_HASH, /webgpu/);
});

test('MODEL_SIZE_LABEL is at least 100 MB now that WebGPU assets ship too', () => {
  // First-use bandwidth is ~95 MB (CPU) or ~106 MB (WebGPU). The label
  // should be honest about the larger end, since that's what a WebGPU
  // browser will actually fetch on a cold cache.
  const match = bgremove.MODEL_SIZE_LABEL.match(/(\d+)/);
  assert.ok(match, `MODEL_SIZE_LABEL should contain a number, got: ${bgremove.MODEL_SIZE_LABEL}`);
  const mb = parseInt(match[1], 10);
  assert.ok(mb >= 100, `MODEL_SIZE_LABEL ${bgremove.MODEL_SIZE_LABEL} should reflect ~100+ MB`);
});

// --------------------------------------------------------------------------
// hasStoredConsent
// --------------------------------------------------------------------------

test('hasStoredConsent: returns false when localStorage is empty', () => {
  assert.equal(bgremove.hasStoredConsent(), false);
});

test('hasStoredConsent: returns true when stored value matches MODEL_HASH', () => {
  globalThis.localStorage.setItem(bgremove.CONSENT_KEY, bgremove.MODEL_HASH);
  assert.equal(bgremove.hasStoredConsent(), true);
});

test('hasStoredConsent: returns false when stored value does NOT match MODEL_HASH', () => {
  globalThis.localStorage.setItem(bgremove.CONSENT_KEY, 'stale-model-hash-v0');
  assert.equal(bgremove.hasStoredConsent(), false);
});

test('hasStoredConsent: tolerates a throwing localStorage and returns false', () => {
  const orig = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('quota exceeded'); },
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { /* noop */ },
  };
  try {
    assert.equal(bgremove.hasStoredConsent(), false);
  } finally {
    globalThis.localStorage = orig;
  }
});

// --------------------------------------------------------------------------
// ensureBgRemoveConsent
// --------------------------------------------------------------------------

test('ensureBgRemoveConsent: returns true immediately when stored hash matches', async () => {
  globalThis.localStorage.setItem(bgremove.CONSENT_KEY, bgremove.MODEL_HASH);
  // No modal can possibly appear here — there's no document in node.
  const result = await bgremove.ensureBgRemoveConsent();
  assert.equal(result, true);
});

// (The "no stored hash → opens modal" case is covered by the browser spec —
// the modal touches `document` which doesn't exist in node:test.)

// --------------------------------------------------------------------------
// _setImplForTest
// --------------------------------------------------------------------------

test('_setImplForTest: accepts an object and survives a clear', () => {
  const fake = { removeBackground: async () => new Blob() };
  // Should not throw on either call.
  bgremove._setImplForTest(fake);
  bgremove._setImplForTest(null);
  // Re-arming with the fake — also fine.
  bgremove._setImplForTest(fake);
  bgremove._setImplForTest(null);
  // No public getter — we just verify it doesn't throw.
});

test('_resetForTest: clears stored consent for the current hash', () => {
  globalThis.localStorage.setItem(bgremove.CONSENT_KEY, bgremove.MODEL_HASH);
  assert.equal(bgremove.hasStoredConsent(), true);
  bgremove._resetForTest();
  assert.equal(bgremove.hasStoredConsent(), false);
});
