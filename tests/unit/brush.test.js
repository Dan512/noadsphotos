import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newBrushOverlay,
  appendPoint,
  shiftPoints,
  resampleCatmullRom,
  drawBrush,
  brushBounds,
  BRUSH_STRIDE,
} from '../../js/ops/brush.js';

// --- mock ctx (just enough surface for drawBrush) -------------------------

function makeMockCtx() {
  const calls = [];
  const state = {
    strokeStyle: '',
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
  };
  return {
    set strokeStyle(v) { state.strokeStyle = v; calls.push(['set:strokeStyle', v]); },
    get strokeStyle()  { return state.strokeStyle; },
    set lineCap(v)     { state.lineCap = v;     calls.push(['set:lineCap', v]); },
    get lineCap()      { return state.lineCap; },
    set lineJoin(v)    { state.lineJoin = v;    calls.push(['set:lineJoin', v]); },
    get lineJoin()     { return state.lineJoin; },
    set lineWidth(v)   { state.lineWidth = v;   calls.push(['set:lineWidth', v]); },
    get lineWidth()    { return state.lineWidth; },
    save:      () => { calls.push(['save']); },
    restore:   () => { calls.push(['restore']); },
    beginPath: () => { calls.push(['beginPath']); },
    moveTo:    (x, y) => { calls.push(['moveTo', x, y]); },
    lineTo:    (x, y) => { calls.push(['lineTo', x, y]); },
    stroke:    () => { calls.push(['stroke']); },
    _calls: calls,
    _state: state,
  };
}

function callsOfType(ctx, name) {
  return ctx._calls.filter(c => c[0] === name);
}

// --- newBrushOverlay ------------------------------------------------------

test('newBrushOverlay: applies defaults', () => {
  const o = newBrushOverlay();
  assert.equal(o.type, 'brush');
  assert.equal(o.color, '#000000');
  assert.equal(o.size, 8);
  assert.equal(o.rot, 0);
  assert.ok(o.points instanceof Float32Array);
  assert.equal(o.points.length, 0);
  assert.equal(typeof o.id, 'string');
  assert.ok(o.id.length > 0);
});

test('newBrushOverlay: overrides via opts', () => {
  const o = newBrushOverlay({ color: '#ff00ff', size: 24 });
  assert.equal(o.color, '#ff00ff');
  assert.equal(o.size, 24);
});

test('newBrushOverlay: each call has a unique id', () => {
  const a = newBrushOverlay();
  const b = newBrushOverlay();
  assert.notEqual(a.id, b.id);
});

test('BRUSH_STRIDE: exposed as 3 (x, y, pressure)', () => {
  assert.equal(BRUSH_STRIDE, 3);
});

// --- appendPoint ----------------------------------------------------------

test('appendPoint: adds 3 floats per call', () => {
  // Use Float32-exact values (0.5, 0.25, 0.75) to avoid precision drift
  // when comparing assertions.
  let pts = new Float32Array(0);
  pts = appendPoint(pts, 10, 20, 0.5);
  assert.equal(pts.length, 3);
  assert.equal(pts[0], 10);
  assert.equal(pts[1], 20);
  assert.equal(pts[2], 0.5);

  pts = appendPoint(pts, 30, 40, 0.25);
  assert.equal(pts.length, 6);
  assert.equal(pts[3], 30);
  assert.equal(pts[4], 40);
  assert.equal(pts[5], 0.25);

  pts = appendPoint(pts, 50, 60, 0.75);
  assert.equal(pts.length, 9);
  assert.equal(pts[6], 50);
  assert.equal(pts[8], 0.75);
});

test('appendPoint: defaults pressure to 0.5 when omitted', () => {
  const pts = appendPoint(new Float32Array(0), 10, 20);
  assert.equal(pts.length, 3);
  assert.equal(pts[2], 0.5);
});

test('appendPoint: tolerates null/empty input', () => {
  const pts = appendPoint(null, 1, 2, 0.25);
  assert.equal(pts.length, 3);
  assert.equal(pts[0], 1);
  assert.equal(pts[1], 2);
  assert.equal(pts[2], 0.25);
});

test('appendPoint: returns a NEW array (does not mutate input)', () => {
  const original = new Float32Array([1, 2, 0.5]);
  const next = appendPoint(original, 10, 20, 0.75);
  assert.notEqual(next, original);
  assert.equal(original.length, 3);
  assert.equal(next.length, 6);
});

// --- shiftPoints ----------------------------------------------------------

test('shiftPoints: shifts every (x, y); pressure untouched', () => {
  // Use Float32-exact pressure values to avoid spurious assertion failures.
  const pts = new Float32Array([0, 0, 0.5, 10, 20, 0.25, 30, 40, 0.75]);
  shiftPoints(pts, 5, -3);
  assert.equal(pts[0], 5);
  assert.equal(pts[1], -3);
  assert.equal(pts[2], 0.5);
  assert.equal(pts[3], 15);
  assert.equal(pts[4], 17);
  assert.equal(pts[5], 0.25);
  assert.equal(pts[6], 35);
  assert.equal(pts[7], 37);
  assert.equal(pts[8], 0.75);
});

test('shiftPoints: tolerates empty array', () => {
  const pts = new Float32Array(0);
  shiftPoints(pts, 5, 5);
  assert.equal(pts.length, 0);
});

test('shiftPoints: tolerates null', () => {
  shiftPoints(null, 5, 5);
  assert.ok(true);
});

// --- resampleCatmullRom ---------------------------------------------------

test('resampleCatmullRom: empty input → empty output', () => {
  const out = resampleCatmullRom(new Float32Array(0));
  assert.equal(out.length, 0);
});

test('resampleCatmullRom: single point → single point (no interpolation)', () => {
  const pts = new Float32Array([10, 20, 0.5]);
  const out = resampleCatmullRom(pts);
  assert.equal(out.length, 3);
  assert.equal(out[0], 10);
  assert.equal(out[1], 20);
});

test('resampleCatmullRom: preserves first endpoint exactly', () => {
  const pts = new Float32Array([0, 0, 0.5, 10, 5, 0.5, 20, 10, 0.5]);
  const out = resampleCatmullRom(pts, 4);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
});

test('resampleCatmullRom: preserves last endpoint exactly', () => {
  const pts = new Float32Array([0, 0, 0.5, 10, 5, 0.5, 20, 10, 0.5]);
  const out = resampleCatmullRom(pts, 4);
  const lastIdx = out.length - 3;
  assert.equal(out[lastIdx],     20);
  assert.equal(out[lastIdx + 1], 10);
});

test('resampleCatmullRom: returns more samples than input for multi-point strokes', () => {
  const pts = new Float32Array([0, 0, 0.5, 10, 5, 0.5, 20, 10, 0.5, 30, 15, 0.5]);
  const out = resampleCatmullRom(pts, 8);
  // 3 segments * 8 samples + 1 final point = 25 entries * 3 floats = 75
  assert.equal(out.length, 25 * 3);
  assert.ok(out.length > pts.length);
});

test('resampleCatmullRom: samplesPerSegment=1 produces N output samples for N-1 segments + endpoint', () => {
  const pts = new Float32Array([0, 0, 0.5, 10, 10, 0.5, 20, 20, 0.5]);
  // 2 segments * 1 sample + 1 final = 3 entries
  const out = resampleCatmullRom(pts, 1);
  assert.equal(out.length, 3 * 3);
});

test('resampleCatmullRom: 2-point stroke produces a smooth line', () => {
  const pts = new Float32Array([0, 0, 0.5, 100, 0, 0.5]);
  const out = resampleCatmullRom(pts, 4);
  // 1 segment * 4 samples + 1 final = 5 entries
  assert.equal(out.length, 5 * 3);
  // All samples should be on the line y=0 (within float epsilon).
  for (let i = 0; i < out.length; i += 3) {
    assert.ok(Math.abs(out[i + 1]) < 1e-3, `y=${out[i + 1]} should be ~0`);
  }
  // First and last should hit endpoints exactly.
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 3], 100);
});

test('resampleCatmullRom: samplesPerSegment <= 0 falls back to 1', () => {
  const pts = new Float32Array([0, 0, 0.5, 10, 10, 0.5]);
  const out = resampleCatmullRom(pts, 0);
  assert.ok(out.length > 0);
});

// --- drawBrush ------------------------------------------------------------

test('drawBrush: skips when no points', () => {
  const ctx = makeMockCtx();
  drawBrush(ctx, { points: new Float32Array(0), color: '#000', size: 8 });
  assert.equal(callsOfType(ctx, 'stroke').length, 0);
});

test('drawBrush: sets stroke style + line caps/joins', () => {
  const ctx = makeMockCtx();
  drawBrush(ctx, {
    points: new Float32Array([0, 0, 0.5, 10, 10, 0.5]),
    color: '#ff0000',
    size: 12,
  });
  assert.equal(ctx._state.strokeStyle, '#ff0000');
  assert.equal(ctx._state.lineCap, 'round');
  assert.equal(ctx._state.lineJoin, 'round');
  assert.equal(ctx._state.lineWidth, 12);
});

test('drawBrush: calls beginPath/moveTo/lineTo/stroke', () => {
  const ctx = makeMockCtx();
  drawBrush(ctx, {
    points: new Float32Array([0, 0, 0.5, 10, 10, 0.5, 20, 20, 0.5]),
    color: '#000',
    size: 4,
  });
  assert.ok(callsOfType(ctx, 'beginPath').length >= 1);
  assert.ok(callsOfType(ctx, 'moveTo').length >= 1);
  assert.ok(callsOfType(ctx, 'lineTo').length >= 1);
  assert.ok(callsOfType(ctx, 'stroke').length >= 1);
});

test('drawBrush: wraps in save/restore', () => {
  const ctx = makeMockCtx();
  drawBrush(ctx, {
    points: new Float32Array([0, 0, 0.5, 10, 10, 0.5]),
    color: '#000', size: 4,
  });
  assert.equal(callsOfType(ctx, 'save').length, 1);
  assert.equal(callsOfType(ctx, 'restore').length, 1);
});

test('drawBrush: single-point stroke draws (round-cap dot)', () => {
  const ctx = makeMockCtx();
  drawBrush(ctx, {
    points: new Float32Array([5, 7, 0.5]),
    color: '#000', size: 8,
  });
  assert.equal(callsOfType(ctx, 'stroke').length, 1);
});

test('drawBrush: no-op on missing ctx or brush', () => {
  drawBrush(null, { points: new Float32Array([0, 0, 0.5]) });
  drawBrush(makeMockCtx(), null);
  assert.ok(true);
});

test('drawBrush: smooth=false uses raw points (no Catmull-Rom resampling)', () => {
  // With 3 control points and smooth=false, we expect exactly 1 moveTo +
  // 2 lineTo calls (one per segment). With smooth=true the resampler
  // inserts intermediate samples, producing many more lineTo calls.
  const pts = new Float32Array([0, 0, 0.5, 10, 10, 0.5, 20, 20, 0.5]);
  const smooth = makeMockCtx();
  drawBrush(smooth, { points: pts, color: '#000', size: 4 }, { smooth: true });
  const raw = makeMockCtx();
  drawBrush(raw, { points: pts, color: '#000', size: 4 }, { smooth: false });
  assert.equal(callsOfType(raw, 'moveTo').length, 1);
  assert.equal(callsOfType(raw, 'lineTo').length, 2);
  assert.ok(callsOfType(smooth, 'lineTo').length > callsOfType(raw, 'lineTo').length);
});

test('drawBrush: smooth defaults to true when opts omitted', () => {
  const pts = new Float32Array([0, 0, 0.5, 10, 10, 0.5, 20, 20, 0.5]);
  const a = makeMockCtx();
  const b = makeMockCtx();
  drawBrush(a, { points: pts, color: '#000', size: 4 });
  drawBrush(b, { points: pts, color: '#000', size: 4 }, {});
  assert.equal(callsOfType(a, 'lineTo').length, callsOfType(b, 'lineTo').length);
});

// --- brushBounds ----------------------------------------------------------

test('brushBounds: returns axis-aligned bbox of the control points', () => {
  const o = {
    points: new Float32Array([0, 0, 0.5, 10, 5, 0.5, 5, 20, 0.5, -3, 8, 0.5]),
  };
  const b = brushBounds(o);
  assert.equal(b.x, -3);
  assert.equal(b.y, 0);
  assert.equal(b.w, 13);
  assert.equal(b.h, 20);
});

test('brushBounds: zero-extent on empty/missing points', () => {
  assert.deepEqual(brushBounds(null), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(brushBounds({ points: new Float32Array(0) }), { x: 0, y: 0, w: 0, h: 0 });
});

test('brushBounds: single-point stroke gives zero-extent bbox at that point', () => {
  const b = brushBounds({ points: new Float32Array([10, 20, 0.5]) });
  assert.equal(b.x, 10);
  assert.equal(b.y, 20);
  assert.equal(b.w, 0);
  assert.equal(b.h, 0);
});
