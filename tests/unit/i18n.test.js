// tests/unit/i18n.test.js — i18n core: t(), setLanguage(), detectLanguage().
//
// The DOM-dependent surface (applyDomTranslations) is covered by the browser
// specs. This file focuses on the pure-JS lookup + interpolation + fallback
// behavior, which we can stub with minimal globals.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub the minimal browser globals i18n.js reads before importing it.
// `localStorage` and `document.documentElement` get used by setLanguage();
// `navigator.language` gets used by detectLanguage(). Node 24 has a
// built-in `navigator` global with a non-configurable getter — we
// override with defineProperty to avoid TypeError on direct assignment.
const storage = new Map();
const localStorageStub = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageStub, configurable: true, writable: true,
});
let mockLanguage = 'en-US';
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get() { return { language: mockLanguage }; },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  writable: true,
  value: {
    documentElement: { lang: '', dir: '' },
    // applyDomTranslations early-returns if querySelectorAll is missing
    // on document — we leave it undefined so we don't need a real DOM.
  },
});

const i18n = await import('../../js/i18n.js');
const { LANGS, TRANSLATIONS, t, setLanguage, getLanguage, detectLanguage } = i18n;

beforeEach(() => {
  storage.clear();
  setLanguage('en');
});

test('LANGS has exactly 15 entries', () => {
  assert.equal(LANGS.length, 15);
});

test('t("brandName") returns the EN string when active is "en"', () => {
  assert.equal(t('brandName'), 'NoAdsPhotos');
});

test('t() falls back to EN when active is a language with empty dict', () => {
  setLanguage('es');
  // Spanish dict is intentionally empty for v1 — should fall back to en.
  assert.equal(t('brandName'), 'NoAdsPhotos');
});

test('t("nonExistentKey") returns "[?]key" so missing keys are visible', () => {
  assert.equal(t('nonExistentKey'), '[?]nonExistentKey');
});

test('t() interpolates variables', () => {
  // resizeOutput has {w} and {h}.
  assert.equal(t('resizeOutput', { w: 100, h: 200 }), 'Output: 100 × 200 px');
});

test('t() HTML-escapes interpolated variables (XSS defense)', () => {
  // The exportSuccessWithSize key is `Exported {filename} ({size})` — pass a hostile name.
  const out = t('exportSuccessWithSize', { filename: '<script>alert(1)</script>', size: '1 KB' });
  assert.ok(out.includes('&lt;script&gt;'), `expected HTML-escaped, got: ${out}`);
  assert.ok(!out.includes('<script>'), `unescaped <script> present: ${out}`);
});

test('t() interpolates count and message together', () => {
  const msg = t('batchToastResizeApplied', { count: 5 });
  assert.equal(msg, 'Resize applied to 5 images.');
});

test('t() ignores missing variables (substitutes empty string)', () => {
  const msg = t('resizeOutput', { w: 100 }); // no h
  assert.equal(msg, 'Output: 100 ×  px');
});

test('detectLanguage maps "en-US" → "en"', () => {
  mockLanguage = 'en-US';
  assert.equal(detectLanguage(), 'en');
});

test('detectLanguage maps "zh-Hant" → "zh-CN" (single zh bucket for v1)', () => {
  mockLanguage = 'zh-Hant';
  assert.equal(detectLanguage(), 'zh-CN');
});

test('detectLanguage maps "zh-CN" → "zh-CN"', () => {
  mockLanguage = 'zh-CN';
  assert.equal(detectLanguage(), 'zh-CN');
});

test('detectLanguage maps "fr-CA" → "fr"', () => {
  mockLanguage = 'fr-CA';
  assert.equal(detectLanguage(), 'fr');
});

test('detectLanguage maps "ar-SA" → "ar"', () => {
  mockLanguage = 'ar-SA';
  assert.equal(detectLanguage(), 'ar');
});

test('detectLanguage returns "en" for unknown locales', () => {
  mockLanguage = 'xx-YY';
  assert.equal(detectLanguage(), 'en');
});

test('setLanguage("javascript:alert(1)") falls back to "en" via allowlist', () => {
  setLanguage('javascript:alert(1)');
  assert.equal(getLanguage(), 'en');
});

test('setLanguage("ar") flips <html dir> to rtl', () => {
  setLanguage('ar');
  assert.equal(globalThis.document.documentElement.dir, 'rtl');
  assert.equal(globalThis.document.documentElement.lang, 'ar');
});

test('setLanguage("en") sets dir back to ltr', () => {
  setLanguage('ar');
  setLanguage('en');
  assert.equal(globalThis.document.documentElement.dir, 'ltr');
});

test('setLanguage persists active code to localStorage', () => {
  setLanguage('de');
  assert.equal(storage.get('noadsimages_lang'), 'de');
});

test('setLanguage with null returns "en" via allowlist', () => {
  setLanguage(null);
  assert.equal(getLanguage(), 'en');
});

test('every language code in LANGS has a TRANSLATIONS entry', () => {
  for (const code of LANGS) {
    assert.ok(
      TRANSLATIONS[code] !== undefined,
      `TRANSLATIONS missing entry for "${code}"`,
    );
  }
});
