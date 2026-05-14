import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newShapeOverlay,
  drawShape,
  shapeBounds,
  SHAPE_KINDS,
} from '../../js/ops/shape.js';

// --- mock 2D context ------------------------------------------------------

function makeMockCtx() {
  const calls = [];
  const state = {
    strokeStyle: '',
    fillStyle:   '',
    lineWidth:   0,
    lineCap:     '',
    lineJoin:    '',
  };
  return {
    set strokeStyle(v) { state.strokeStyle = v; calls.push(['set:strokeStyle', v]); },
    get strokeStyle()  { return state.strokeStyle; },
    set fillStyle(v)   { state.fillStyle = v;   calls.push(['set:fillStyle', v]); },
    get fillStyle()    { return state.fillStyle; },
    set lineWidth(v)   { state.lineWidth = v;   calls.push(['set:lineWidth', v]); },
    get lineWidth()    { return state.lineWidth; },
    set lineCap(v)     { state.lineCap = v;     calls.push(['set:lineCap', v]); },
    get lineCap()      { return state.lineCap; },
    set lineJoin(v)    { state.lineJoin = v;    calls.push(['set:lineJoin', v]); },
    get lineJoin()     { return state.lineJoin; },
    save:        () => { calls.push(['save']); },
    restore:     () => { calls.push(['restore']); },
    beginPath:   () => { calls.push(['beginPath']); },
    closePath:   () => { calls.push(['closePath']); },
    moveTo:      (x, y) => { calls.push(['moveTo', x, y]); },
    lineTo:      (x, y) => { calls.push(['lineTo', x, y]); },
    stroke:      () => { calls.push(['stroke']); },
    fill:        () => { calls.push(['fill']); },
    fillRect:    (x, y, w, h) => { calls.push(['fillRect', x, y, w, h]); },
    strokeRect:  (x, y, w, h) => { calls.push(['strokeRect', x, y, w, h]); },
    ellipse:     (cx, cy, rx, ry, rot, sa, ea) => {
      calls.push(['ellipse', cx, cy, rx, ry, rot, sa, ea]);
    },
    _calls: calls,
    _state: state,
  };
}

function callsOfType(ctx, name) {
  return ctx._calls.filter(c => c[0] === name);
}

// --- SHAPE_KINDS ----------------------------------------------------------

test('SHAPE_KINDS: contains line, rect, arrow, circle', () => {
  assert.deepEqual([...SHAPE_KINDS].sort(), ['arrow', 'circle', 'line', 'rect']);
});

// --- newShapeOverlay ------------------------------------------------------

test('newShapeOverlay: rect with explicit endpoints', () => {
  const o = newShapeOverlay('rect', 10, 20, 100, 80);
  assert.equal(o.type, 'shape');
  assert.equal(o.kind, 'rect');
  assert.equal(o.x1, 10);
  assert.equal(o.y1, 20);
  assert.equal(o.x2, 100);
  assert.equal(o.y2, 80);
  assert.equal(o.stroke, '#000000');
  assert.equal(o.fill, null);
  assert.equal(o.strokeWidth, 2);
  assert.equal(typeof o.id, 'string');
  assert.ok(o.id.length > 0);
});

test('newShapeOverlay: applies opts', () => {
  const o = newShapeOverlay('line', 0, 0, 50, 50, {
    stroke: '#ff0000',
    fill: '#00ff00',
    strokeWidth: 5,
  });
  assert.equal(o.stroke, '#ff0000');
  assert.equal(o.fill, '#00ff00');
  assert.equal(o.strokeWidth, 5);
});

test('newShapeOverlay: throws on unknown kind', () => {
  assert.throws(() => newShapeOverlay('triangle', 0, 0, 10, 10), /unknown kind/);
});

test('newShapeOverlay: each call has a unique id', () => {
  const a = newShapeOverlay('rect', 0, 0, 10, 10);
  const b = newShapeOverlay('rect', 0, 0, 10, 10);
  assert.notEqual(a.id, b.id);
});

test('newShapeOverlay: fill: null is preserved (explicit no-fill)', () => {
  const o = newShapeOverlay('rect', 0, 0, 10, 10, { fill: null });
  assert.equal(o.fill, null);
});

// --- drawShape: line ------------------------------------------------------

test('drawShape: line uses moveTo + lineTo + stroke (no fill)', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('line', 10, 20, 30, 40, { stroke: '#000', strokeWidth: 2 }));
  assert.equal(callsOfType(ctx, 'moveTo').length, 1);
  assert.equal(callsOfType(ctx, 'lineTo').length, 1);
  assert.equal(callsOfType(ctx, 'stroke').length, 1);
  assert.equal(callsOfType(ctx, 'fillRect').length, 0);
  assert.equal(callsOfType(ctx, 'strokeRect').length, 0);
});

// --- drawShape: rect ------------------------------------------------------

test('drawShape: rect strokes the rectangle', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('rect', 10, 20, 110, 80, { stroke: '#000', strokeWidth: 2 }));
  const sr = callsOfType(ctx, 'strokeRect');
  assert.equal(sr.length, 1);
  assert.deepEqual(sr[0], ['strokeRect', 10, 20, 100, 60]);
  assert.equal(callsOfType(ctx, 'fillRect').length, 0); // no fill set
});

test('drawShape: rect with fill calls fillRect + strokeRect', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('rect', 0, 0, 50, 50, { fill: '#ff0000', stroke: '#000' }));
  assert.equal(callsOfType(ctx, 'fillRect').length, 1);
  assert.equal(callsOfType(ctx, 'strokeRect').length, 1);
});

test('drawShape: rect normalises negative-extent bounds', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('rect', 100, 80, 10, 20));
  const sr = callsOfType(ctx, 'strokeRect')[0];
  assert.equal(sr[1], 10);
  assert.equal(sr[2], 20);
  assert.equal(sr[3], 90);
  assert.equal(sr[4], 60);
});

// --- drawShape: arrow -----------------------------------------------------

test('drawShape: arrow draws shaft + triangle head', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('arrow', 0, 0, 100, 0, { strokeWidth: 2 }));
  // Shaft: 1 moveTo + 1 lineTo + 1 stroke.
  // Head: 1 moveTo + 2 lineTo + closePath + fill + stroke.
  assert.ok(callsOfType(ctx, 'moveTo').length >= 2);
  assert.ok(callsOfType(ctx, 'lineTo').length >= 3);
  assert.ok(callsOfType(ctx, 'stroke').length >= 1);
  assert.ok(callsOfType(ctx, 'fill').length >= 1);
  assert.ok(callsOfType(ctx, 'closePath').length >= 1);
});

test('drawShape: arrow with zero length does not draw', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('arrow', 50, 50, 50, 50));
  // Implementation early-returns from drawArrow on zero length; no
  // shaft/head paths emitted.
  assert.equal(callsOfType(ctx, 'lineTo').length, 0);
});

// --- drawShape: circle ----------------------------------------------------

test('drawShape: circle calls ellipse with bbox center + radii', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('circle', 0, 0, 100, 60));
  const calls = callsOfType(ctx, 'ellipse');
  assert.equal(calls.length, 1);
  // cx, cy, rx, ry
  assert.equal(calls[0][1], 50);
  assert.equal(calls[0][2], 30);
  assert.equal(calls[0][3], 50);
  assert.equal(calls[0][4], 30);
  assert.equal(callsOfType(ctx, 'stroke').length, 1);
  assert.equal(callsOfType(ctx, 'fill').length, 0); // no fill
});

test('drawShape: circle with fill calls both fill + stroke', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('circle', 0, 0, 50, 50, { fill: '#00ff00' }));
  assert.equal(callsOfType(ctx, 'fill').length, 1);
  assert.equal(callsOfType(ctx, 'stroke').length, 1);
});

// --- drawShape: cross-cutting ---------------------------------------------

test('drawShape: wraps in save/restore', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('rect', 0, 0, 10, 10));
  assert.equal(callsOfType(ctx, 'save').length, 1);
  assert.equal(callsOfType(ctx, 'restore').length, 1);
});

test('drawShape: sets stroke style + width + line cap/join', () => {
  const ctx = makeMockCtx();
  drawShape(ctx, newShapeOverlay('line', 0, 0, 10, 10, { stroke: '#ff00ff', strokeWidth: 5 }));
  assert.equal(ctx._state.strokeStyle, '#ff00ff');
  assert.equal(ctx._state.lineWidth, 5);
  assert.equal(ctx._state.lineCap, 'round');
  assert.equal(ctx._state.lineJoin, 'round');
});

test('drawShape: no-op on missing ctx or shape', () => {
  drawShape(null, newShapeOverlay('rect', 0, 0, 10, 10));
  drawShape(makeMockCtx(), null);
  assert.ok(true);
});

// --- shapeBounds ----------------------------------------------------------

test('shapeBounds: returns normalised bbox for rect-style endpoints', () => {
  const o = newShapeOverlay('rect', 10, 20, 100, 80);
  const b = shapeBounds(o);
  assert.deepEqual(b, { x: 10, y: 20, w: 90, h: 60 });
});

test('shapeBounds: tolerates negative-extent endpoints', () => {
  const o = newShapeOverlay('line', 100, 80, 10, 20);
  const b = shapeBounds(o);
  assert.deepEqual(b, { x: 10, y: 20, w: 90, h: 60 });
});

test('shapeBounds: zero-size shape', () => {
  const o = newShapeOverlay('rect', 10, 20, 10, 20);
  const b = shapeBounds(o);
  assert.deepEqual(b, { x: 10, y: 20, w: 0, h: 0 });
});

test('shapeBounds: tolerates null', () => {
  assert.deepEqual(shapeBounds(null), { x: 0, y: 0, w: 0, h: 0 });
});
