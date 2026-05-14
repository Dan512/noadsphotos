import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawText, measureText, newTextOverlay } from '../../js/ops/text.js';

// --- mock 2D context -------------------------------------------------------
//
// node:test can't easily run real canvas, so we mock just enough of the
// CanvasRenderingContext2D surface to verify drawText sets the right
// properties and calls fillText for each line. measureText returns a
// predictable width proportional to the input string length so we can
// assert non-zero bounds without a real font engine.

function makeMockCtx() {
  const calls = [];
  const state = {
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
  };
  return {
    set font(v)         { state.font = v;       calls.push(['set:font', v]); },
    get font()          { return state.font; },
    set fillStyle(v)    { state.fillStyle = v;  calls.push(['set:fillStyle', v]); },
    get fillStyle()     { return state.fillStyle; },
    set textAlign(v)    { state.textAlign = v;  calls.push(['set:textAlign', v]); },
    get textAlign()     { return state.textAlign; },
    set textBaseline(v) { state.textBaseline = v; calls.push(['set:textBaseline', v]); },
    get textBaseline()  { return state.textBaseline; },
    save:      () => { calls.push(['save']); },
    restore:   () => { calls.push(['restore']); },
    translate: (x, y) => { calls.push(['translate', x, y]); },
    rotate:    (r) => { calls.push(['rotate', r]); },
    fillText:  (str, x, y) => { calls.push(['fillText', str, x, y]); },
    measureText: (str) => ({ width: (str || '').length * 8 }),
    _calls: calls,
    _state: state,
  };
}

function callsOfType(ctx, name) {
  return ctx._calls.filter(c => c[0] === name);
}

// --- newTextOverlay --------------------------------------------------------

test('newTextOverlay: applies defaults at the given position', () => {
  const o = newTextOverlay(10, 20);
  assert.equal(o.type, 'text');
  assert.equal(o.x, 10);
  assert.equal(o.y, 20);
  assert.equal(o.rot, 0);
  assert.equal(o.text, 'Text');
  assert.equal(o.size, 32);
  assert.equal(o.weight, 500);
  assert.equal(o.color, '#000000');
  assert.equal(o.align, 'left');
  assert.match(o.font, /Onest/);
  assert.equal(typeof o.id, 'string');
  assert.ok(o.id.length > 0);
});

test('newTextOverlay: overrides via opts', () => {
  const o = newTextOverlay(10, 20, { text: 'hi', size: 64, weight: 700, color: '#ff0000', align: 'center' });
  assert.equal(o.text, 'hi');
  assert.equal(o.size, 64);
  assert.equal(o.weight, 700);
  assert.equal(o.color, '#ff0000');
  assert.equal(o.align, 'center');
});

test('newTextOverlay: each call has a unique id', () => {
  const a = newTextOverlay(0, 0);
  const b = newTextOverlay(0, 0);
  assert.notEqual(a.id, b.id);
});

// --- drawText --------------------------------------------------------------

test('drawText: sets font, fillStyle, textAlign, textBaseline', () => {
  const ctx = makeMockCtx();
  drawText(ctx, newTextOverlay(0, 0, { text: 'A', size: 24, weight: 700, color: '#ff00ff', align: 'right' }));
  assert.equal(ctx._state.fillStyle, '#ff00ff');
  assert.equal(ctx._state.textAlign, 'right');
  assert.equal(ctx._state.textBaseline, 'top');
  assert.match(ctx._state.font, /^700 24px /);
});

test('drawText: calls fillText once for single-line text', () => {
  const ctx = makeMockCtx();
  drawText(ctx, newTextOverlay(100, 50, { text: 'Hello' }));
  const fills = callsOfType(ctx, 'fillText');
  assert.equal(fills.length, 1);
  assert.equal(fills[0][1], 'Hello');
  assert.equal(fills[0][2], 100);
  assert.equal(fills[0][3], 50);
});

test('drawText: calls fillText once per line of multi-line text', () => {
  const ctx = makeMockCtx();
  drawText(ctx, newTextOverlay(10, 20, { text: 'line1\nline2\nline3', size: 40 }));
  const fills = callsOfType(ctx, 'fillText');
  assert.equal(fills.length, 3);
  assert.equal(fills[0][1], 'line1');
  assert.equal(fills[1][1], 'line2');
  assert.equal(fills[2][1], 'line3');
  // y advances by size * 1.2 per line.
  const dy = 40 * 1.2;
  assert.equal(fills[0][3], 20);
  assert.equal(fills[1][3], 20 + dy);
  assert.equal(fills[2][3], 20 + 2 * dy);
});

test('drawText: wraps in save/restore', () => {
  const ctx = makeMockCtx();
  drawText(ctx, newTextOverlay(0, 0, { text: 'A' }));
  assert.equal(callsOfType(ctx, 'save').length, 1);
  assert.equal(callsOfType(ctx, 'restore').length, 1);
});

test('drawText: applies rotation when rot != 0', () => {
  const ctx = makeMockCtx();
  drawText(ctx, { ...newTextOverlay(10, 20, { text: 'A' }), rot: 45 });
  // Two translates (to anchor and back) + one rotate when rotation is non-zero.
  assert.equal(callsOfType(ctx, 'translate').length, 2);
  assert.equal(callsOfType(ctx, 'rotate').length, 1);
});

test('drawText: skips rotation transform when rot is 0', () => {
  const ctx = makeMockCtx();
  drawText(ctx, newTextOverlay(0, 0, { text: 'A' })); // rot defaults to 0
  assert.equal(callsOfType(ctx, 'translate').length, 0);
  assert.equal(callsOfType(ctx, 'rotate').length, 0);
});

test('drawText: tolerates missing text (renders empty line)', () => {
  const ctx = makeMockCtx();
  drawText(ctx, { type: 'text', x: 0, y: 0 });
  // String('') split → [''] → one fillText('') call.
  assert.equal(callsOfType(ctx, 'fillText').length, 1);
});

test('drawText: no-op on missing ctx or overlay', () => {
  // Should not throw.
  drawText(null, newTextOverlay(0, 0));
  drawText(makeMockCtx(), null);
  assert.ok(true);
});

// --- measureText -----------------------------------------------------------

test('measureText: returns non-zero w/h on non-empty text', () => {
  const ctx = makeMockCtx();
  const { w, h } = measureText(ctx, newTextOverlay(0, 0, { text: 'hello', size: 20 }));
  // Mock: width = chars * 8.  height = lines * size * 1.2.
  assert.equal(w, 5 * 8);
  assert.equal(h, 1 * 20 * 1.2);
});

test('measureText: takes the widest line for multi-line text', () => {
  const ctx = makeMockCtx();
  const { w, h } = measureText(ctx, newTextOverlay(0, 0, { text: 'a\nbbbbb\ncc', size: 10 }));
  assert.equal(w, 5 * 8); // 'bbbbb' is the widest
  assert.equal(h, 3 * 10 * 1.2);
});

test('measureText: zero size on empty text', () => {
  const ctx = makeMockCtx();
  const { w, h } = measureText(ctx, newTextOverlay(0, 0, { text: '', size: 30 }));
  assert.equal(w, 0);
  // Empty string still gives one line in String('').split('\n').
  assert.equal(h, 1 * 30 * 1.2);
});

test('measureText: tolerates missing ctx', () => {
  const r = measureText(null, newTextOverlay(0, 0));
  assert.deepEqual(r, { w: 0, h: 0 });
});
