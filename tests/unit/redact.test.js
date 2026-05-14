import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newRedactOverlay,
  drawRedact,
  redactBounds,
  REDACT_MODES,
} from '../../js/ops/redact.js';

// --- mock 2D context ------------------------------------------------------

function makeMockCtx() {
  const calls = [];
  const state = {
    fillStyle:   '',
    strokeStyle: '',
    lineWidth:   0,
    font:        '',
    textBaseline:'',
  };
  return {
    set fillStyle(v)    { state.fillStyle = v;    calls.push(['set:fillStyle', v]); },
    get fillStyle()     { return state.fillStyle; },
    set strokeStyle(v)  { state.strokeStyle = v;  calls.push(['set:strokeStyle', v]); },
    get strokeStyle()   { return state.strokeStyle; },
    set lineWidth(v)    { state.lineWidth = v;    calls.push(['set:lineWidth', v]); },
    get lineWidth()     { return state.lineWidth; },
    set font(v)         { state.font = v;         calls.push(['set:font', v]); },
    get font()          { return state.font; },
    set textBaseline(v) { state.textBaseline = v; calls.push(['set:textBaseline', v]); },
    get textBaseline()  { return state.textBaseline; },
    save:        () => { calls.push(['save']); },
    restore:     () => { calls.push(['restore']); },
    fillRect:    (x, y, w, h) => { calls.push(['fillRect', x, y, w, h]); },
    strokeRect:  (x, y, w, h) => { calls.push(['strokeRect', x, y, w, h]); },
    setLineDash: (d) => { calls.push(['setLineDash', d]); },
    measureText: (s) => ({ width: (s || '').length * 7 }),
    fillText:    (s, x, y) => { calls.push(['fillText', s, x, y]); },
    _calls: calls,
    _state: state,
  };
}

function callsOfType(ctx, name) {
  return ctx._calls.filter(c => c[0] === name);
}

// --- REDACT_MODES ---------------------------------------------------------

test('REDACT_MODES: contains blur, pixelate', () => {
  assert.deepEqual([...REDACT_MODES].sort(), ['blur', 'pixelate']);
});

// --- newRedactOverlay -----------------------------------------------------

test('newRedactOverlay: applies defaults', () => {
  const o = newRedactOverlay(10, 20, 100, 80);
  assert.equal(o.type, 'redact');
  assert.equal(o.x, 10);
  assert.equal(o.y, 20);
  assert.equal(o.w, 100);
  assert.equal(o.h, 80);
  assert.equal(o.mode, 'blur');
  assert.equal(o.strength, 12);
  assert.equal(o.rot, 0);
  assert.equal(typeof o.id, 'string');
  assert.ok(o.id.length > 0);
});

test('newRedactOverlay: applies opts', () => {
  const o = newRedactOverlay(0, 0, 50, 50, { mode: 'pixelate', strength: 24 });
  assert.equal(o.mode, 'pixelate');
  assert.equal(o.strength, 24);
});

test('newRedactOverlay: invalid mode falls back to blur', () => {
  const o = newRedactOverlay(0, 0, 50, 50, { mode: 'bogus' });
  assert.equal(o.mode, 'blur');
});

test('newRedactOverlay: non-finite strength falls back to default', () => {
  const o = newRedactOverlay(0, 0, 50, 50, { strength: NaN });
  assert.equal(o.strength, 12);
});

test('newRedactOverlay: each call has a unique id', () => {
  const a = newRedactOverlay(0, 0, 10, 10);
  const b = newRedactOverlay(0, 0, 10, 10);
  assert.notEqual(a.id, b.id);
});

// --- drawRedact -----------------------------------------------------------

test('drawRedact: fills the region with a translucent rect', () => {
  const ctx = makeMockCtx();
  drawRedact(ctx, newRedactOverlay(10, 20, 100, 80));
  const fills = callsOfType(ctx, 'fillRect');
  // First fillRect = the translucent placeholder; later fillRect = label backdrop.
  assert.ok(fills.length >= 1);
  assert.deepEqual(fills[0], ['fillRect', 10, 20, 100, 80]);
});

test('drawRedact: strokes a dotted border (setLineDash called)', () => {
  const ctx = makeMockCtx();
  drawRedact(ctx, newRedactOverlay(10, 20, 100, 80));
  const dashes = callsOfType(ctx, 'setLineDash');
  assert.ok(dashes.length >= 1);
  // First setLineDash should set a non-empty pattern.
  assert.ok(Array.isArray(dashes[0][1]) && dashes[0][1].length > 0);
  // strokeRect should be called for the border.
  assert.equal(callsOfType(ctx, 'strokeRect').length, 1);
});

test('drawRedact: emits a label fillText with mode + strength', () => {
  const ctx = makeMockCtx();
  drawRedact(ctx, newRedactOverlay(0, 0, 50, 50, { mode: 'blur', strength: 7 }));
  const texts = callsOfType(ctx, 'fillText');
  assert.equal(texts.length, 1);
  assert.match(texts[0][1], /blur\s*7/);
});

test('drawRedact: pixelate label says "pixelate"', () => {
  const ctx = makeMockCtx();
  drawRedact(ctx, newRedactOverlay(0, 0, 50, 50, { mode: 'pixelate', strength: 16 }));
  const texts = callsOfType(ctx, 'fillText');
  assert.equal(texts.length, 1);
  assert.match(texts[0][1], /pixelate\s*16/);
});

test('drawRedact: wraps in save/restore', () => {
  const ctx = makeMockCtx();
  drawRedact(ctx, newRedactOverlay(0, 0, 10, 10));
  assert.equal(callsOfType(ctx, 'save').length, 1);
  assert.equal(callsOfType(ctx, 'restore').length, 1);
});

test('drawRedact: pixelate mode uses different alpha than blur', () => {
  const blurCtx = makeMockCtx();
  drawRedact(blurCtx, newRedactOverlay(0, 0, 10, 10, { mode: 'blur' }));
  const pixCtx = makeMockCtx();
  drawRedact(pixCtx, newRedactOverlay(0, 0, 10, 10, { mode: 'pixelate' }));

  // Find the first fillStyle write that's an rgba(...) color (the placeholder).
  const blurFill = blurCtx._calls.find(c => c[0] === 'set:fillStyle' && /rgba/.test(c[1]));
  const pixFill  = pixCtx._calls.find(c =>  c[0] === 'set:fillStyle' && /rgba/.test(c[1]));
  assert.ok(blurFill && pixFill);
  // The two modes use distinct alpha values so a colorblind user can tell
  // them apart visually without colour.
  assert.notEqual(blurFill[1], pixFill[1]);
});

test('drawRedact: zero-size region is a no-op', () => {
  const ctx = makeMockCtx();
  drawRedact(ctx, newRedactOverlay(10, 20, 0, 0));
  assert.equal(callsOfType(ctx, 'fillRect').length, 0);
  assert.equal(callsOfType(ctx, 'strokeRect').length, 0);
});

test('drawRedact: no-op on missing ctx or overlay', () => {
  drawRedact(null, newRedactOverlay(0, 0, 10, 10));
  drawRedact(makeMockCtx(), null);
  assert.ok(true);
});

// --- redactBounds ---------------------------------------------------------

test('redactBounds: returns x/y/w/h directly', () => {
  const o = newRedactOverlay(10, 20, 100, 80);
  const b = redactBounds(o);
  assert.deepEqual(b, { x: 10, y: 20, w: 100, h: 80 });
});

test('redactBounds: tolerates null', () => {
  assert.deepEqual(redactBounds(null), { x: 0, y: 0, w: 0, h: 0 });
});
