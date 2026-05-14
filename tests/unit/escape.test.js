import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, pickFromAllowlist } from '../../js/escape.js';

test('escapeHtml: no-op for safe text', () => {
  assert.equal(escapeHtml('hello'), 'hello');
});

test('escapeHtml: fully escapes a script tag payload', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
});

test('escapeHtml: escapes ampersand', () => {
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml: re-escapes already-escaped text (documented behavior)', () => {
  assert.equal(escapeHtml('a &amp; b'), 'a &amp;amp; b');
});

test('escapeHtml: coerces number to string', () => {
  assert.equal(escapeHtml(42), '42');
});

test('escapeHtml: coerces null via String(null)', () => {
  assert.equal(escapeHtml(null), 'null');
});

test('escapeHtml: coerces undefined via String(undefined)', () => {
  assert.equal(escapeHtml(undefined), 'undefined');
});

test('escapeHtml: handles all five entities in one string', () => {
  assert.equal(escapeHtml("'<>&\""), '&#39;&lt;&gt;&amp;&quot;');
});

test('pickFromAllowlist: returns value when present', () => {
  assert.equal(pickFromAllowlist('en', ['en', 'es', 'fr'], 'en'), 'en');
});

test('pickFromAllowlist: returns fallback when value not present', () => {
  assert.equal(pickFromAllowlist('xx', ['en', 'es', 'fr'], 'en'), 'en');
});

test('pickFromAllowlist: blocks attempted XSS through language code', () => {
  assert.equal(pickFromAllowlist('javascript:alert', ['en', 'es'], 'en'), 'en');
});

test('pickFromAllowlist: returns fallback for null (defensive)', () => {
  assert.equal(pickFromAllowlist(null, ['en'], 'en'), 'en');
});

test('pickFromAllowlist: empty string is valid if explicitly in allowlist', () => {
  assert.equal(pickFromAllowlist('', ['en', 'es', ''], 'en'), '');
});
