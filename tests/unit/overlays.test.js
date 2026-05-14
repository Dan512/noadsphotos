import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addOverlay,
  removeOverlay,
  getOverlay,
  moveOverlay,
  updateOverlay,
  reorderOverlays,
  createOverlayId,
  drawOverlaySync,
  getOverlayBounds,
} from '../../js/overlays.js';

function makeImageState() {
  return {
    overlays: [],
    baseDirty: false,
    overlaysDirty: false,
  };
}

function makeTextOverlay(id = 'a', extras = {}) {
  return {
    id,
    type: 'text',
    x: 10, y: 20, rot: 0,
    text: 'Hello',
    font: 'system-ui',
    size: 32,
    weight: 500,
    color: '#000000',
    align: 'left',
    ...extras,
  };
}

// --- addOverlay ------------------------------------------------------------

test('addOverlay: pushes overlay onto list and returns its id', () => {
  const img = makeImageState();
  const o = makeTextOverlay('a');
  const id = addOverlay(img, o);
  assert.equal(id, 'a');
  assert.equal(img.overlays.length, 1);
  assert.equal(img.overlays[0], o);
});

test('addOverlay: marks overlaysDirty (OVERLAY invalidation)', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  assert.equal(img.overlaysDirty, true);
  assert.equal(img.baseDirty, false);
});

test('addOverlay: throws on missing id', () => {
  const img = makeImageState();
  assert.throws(
    () => addOverlay(img, { type: 'text', x: 0, y: 0 }),
    /id/,
  );
});

test('addOverlay: throws on empty id', () => {
  const img = makeImageState();
  assert.throws(
    () => addOverlay(img, { id: '', type: 'text' }),
    /id/,
  );
});

test('addOverlay: throws on unknown type', () => {
  const img = makeImageState();
  assert.throws(
    () => addOverlay(img, { id: 'a', type: 'gizmo' }),
    /unknown overlay type/i,
  );
});

test('addOverlay: throws when overlay is not an object', () => {
  const img = makeImageState();
  assert.throws(() => addOverlay(img, null), /object/);
  assert.throws(() => addOverlay(img, 'nope'), /object/);
});

test('addOverlay: accepts all four known types (shape/brush/redact skeletons)', () => {
  const img = makeImageState();
  addOverlay(img, { id: 't', type: 'text', x: 0, y: 0 });
  addOverlay(img, { id: 'b', type: 'brush', points: new Float32Array(0) });
  addOverlay(img, { id: 's', type: 'shape', x: 0, y: 0, w: 1, h: 1 });
  addOverlay(img, { id: 'r', type: 'redact', x: 0, y: 0, w: 1, h: 1 });
  assert.equal(img.overlays.length, 4);
});

// --- removeOverlay ---------------------------------------------------------

test('removeOverlay: removes the matching overlay', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  addOverlay(img, makeTextOverlay('b'));
  img.overlaysDirty = false;
  removeOverlay(img, 'a');
  assert.equal(img.overlays.length, 1);
  assert.equal(img.overlays[0].id, 'b');
  assert.equal(img.overlaysDirty, true);
});

test('removeOverlay: no-op on missing id', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  img.overlaysDirty = false;
  removeOverlay(img, 'missing');
  assert.equal(img.overlays.length, 1);
  assert.equal(img.overlaysDirty, false);
});

test('removeOverlay: tolerates a null imageState', () => {
  removeOverlay(null, 'x');
  assert.ok(true);
});

// --- getOverlay ------------------------------------------------------------

test('getOverlay: returns the overlay object', () => {
  const img = makeImageState();
  const o = makeTextOverlay('a');
  addOverlay(img, o);
  assert.equal(getOverlay(img, 'a'), o);
});

test('getOverlay: returns null for unknown id', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  assert.equal(getOverlay(img, 'nope'), null);
});

test('getOverlay: tolerates a null imageState', () => {
  assert.equal(getOverlay(null, 'x'), null);
});

// --- moveOverlay -----------------------------------------------------------

test('moveOverlay: updates a text overlay\'s x/y by dx/dy', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a', { x: 10, y: 20 }));
  img.overlaysDirty = false;
  moveOverlay(img, 'a', 5, -3);
  const o = getOverlay(img, 'a');
  assert.equal(o.x, 15);
  assert.equal(o.y, 17);
  assert.equal(img.overlaysDirty, true);
});

test('moveOverlay: no-op on unknown id', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a', { x: 10, y: 20 }));
  img.overlaysDirty = false;
  moveOverlay(img, 'missing', 5, 5);
  const o = getOverlay(img, 'a');
  assert.equal(o.x, 10);
  assert.equal(o.y, 20);
  assert.equal(img.overlaysDirty, false);
});

test('moveOverlay: shifts all points of a brush overlay (stride 3 — pressure untouched)', () => {
  const img = makeImageState();
  // Points are stride 3: [x, y, pressure, x, y, pressure, ...].
  // Pressure values use Float32-exact fractions (0.5, 0.25, 0.75) so
  // the assertions don't trip on float-precision drift.
  addOverlay(img, {
    id: 'b', type: 'brush',
    points: new Float32Array([0, 0, 0.5, 10, 5, 0.25, 20, 10, 0.75]),
    color: '#000', size: 4, rot: 0,
  });
  moveOverlay(img, 'b', 2, 3);
  const o = getOverlay(img, 'b');
  // x/y shifted; pressure untouched.
  assert.equal(o.points[0], 2);
  assert.equal(o.points[1], 3);
  assert.equal(o.points[2], 0.5);
  assert.equal(o.points[3], 12);
  assert.equal(o.points[4], 8);
  assert.equal(o.points[5], 0.25);
  assert.equal(o.points[6], 22);
  assert.equal(o.points[7], 13);
  assert.equal(o.points[8], 0.75);
});

test('moveOverlay: shifts all four corners of a shape overlay', () => {
  const img = makeImageState();
  addOverlay(img, {
    id: 's', type: 'shape', kind: 'rect',
    x1: 10, y1: 20, x2: 60, y2: 80,
    stroke: '#000', strokeWidth: 2, fill: null,
  });
  moveOverlay(img, 's', 5, -3);
  const o = getOverlay(img, 's');
  assert.equal(o.x1, 15);
  assert.equal(o.y1, 17);
  assert.equal(o.x2, 65);
  assert.equal(o.y2, 77);
});

test('moveOverlay: shifts x/y of a redact overlay (w/h unchanged)', () => {
  const img = makeImageState();
  addOverlay(img, {
    id: 'r', type: 'redact',
    x: 10, y: 20, w: 100, h: 80,
    mode: 'blur', strength: 12, rot: 0,
  });
  moveOverlay(img, 'r', 5, -3);
  const o = getOverlay(img, 'r');
  assert.equal(o.x, 15);
  assert.equal(o.y, 17);
  assert.equal(o.w, 100);
  assert.equal(o.h, 80);
});

// --- updateOverlay ---------------------------------------------------------

test('updateOverlay: shallow-merges a patch', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a', { text: 'old', size: 32 }));
  img.overlaysDirty = false;
  updateOverlay(img, 'a', { text: 'new', size: 48 });
  const o = getOverlay(img, 'a');
  assert.equal(o.text, 'new');
  assert.equal(o.size, 48);
  // Untouched fields preserved.
  assert.equal(o.color, '#000000');
  assert.equal(img.overlaysDirty, true);
});

test('updateOverlay: no-op on unknown id', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  img.overlaysDirty = false;
  updateOverlay(img, 'missing', { text: 'x' });
  assert.equal(img.overlaysDirty, false);
});

test('updateOverlay: tolerates non-object patches', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  img.overlaysDirty = false;
  updateOverlay(img, 'a', null);
  updateOverlay(img, 'a', 'bogus');
  assert.equal(img.overlaysDirty, false);
});

// --- reorderOverlays -------------------------------------------------------

test('reorderOverlays: moves an overlay to a new index', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  addOverlay(img, makeTextOverlay('b'));
  addOverlay(img, makeTextOverlay('c'));
  img.overlaysDirty = false;
  reorderOverlays(img, 0, 2);
  assert.deepEqual(img.overlays.map(o => o.id), ['b', 'c', 'a']);
  assert.equal(img.overlaysDirty, true);
});

test('reorderOverlays: moving to same index is a no-op', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  addOverlay(img, makeTextOverlay('b'));
  img.overlaysDirty = false;
  reorderOverlays(img, 1, 1);
  assert.deepEqual(img.overlays.map(o => o.id), ['a', 'b']);
  assert.equal(img.overlaysDirty, false);
});

test('reorderOverlays: throws RangeError on negative fromIndex', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  assert.throws(() => reorderOverlays(img, -1, 0), RangeError);
});

test('reorderOverlays: throws RangeError on out-of-range toIndex', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  addOverlay(img, makeTextOverlay('b'));
  assert.throws(() => reorderOverlays(img, 0, 5), RangeError);
});

test('reorderOverlays: throws RangeError on non-integer indices', () => {
  const img = makeImageState();
  addOverlay(img, makeTextOverlay('a'));
  addOverlay(img, makeTextOverlay('b'));
  assert.throws(() => reorderOverlays(img, 0.5, 1), RangeError);
});

// --- createOverlayId -------------------------------------------------------

test('createOverlayId: returns distinct non-empty strings', () => {
  const a = createOverlayId();
  const b = createOverlayId();
  assert.equal(typeof a, 'string');
  assert.equal(typeof b, 'string');
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

// --- drawOverlaySync -------------------------------------------------------

test('drawOverlaySync: dispatches to the registered drawer for that type', () => {
  let calledWith = null;
  const drawers = {
    text: (ctx, o) => { calledWith = { ctx, o }; return 'ok'; },
  };
  const ctx = {};
  const overlay = { id: 'a', type: 'text', x: 0, y: 0 };
  const result = drawOverlaySync(ctx, overlay, drawers);
  assert.equal(result, 'ok');
  assert.equal(calledWith.ctx, ctx);
  assert.equal(calledWith.o, overlay);
});

test('drawOverlaySync: throws if no drawer is registered for the type', () => {
  const drawers = { text: () => {} };
  assert.throws(
    () => drawOverlaySync({}, { id: 'a', type: 'brush' }, drawers),
    /No drawer registered/,
  );
});

test('drawOverlaySync: throws on missing drawers map', () => {
  assert.throws(
    () => drawOverlaySync({}, { id: 'a', type: 'text' }, null),
    /drawers/,
  );
});

test('drawOverlaySync: throws on non-object overlay', () => {
  assert.throws(
    () => drawOverlaySync({}, null, { text: () => {} }),
    /overlay/,
  );
});

// --- getOverlayBounds ------------------------------------------------------

test('getOverlayBounds: text — uses ctx.measureText when ctx provided', () => {
  const ctx = {
    font: '',
    measureText: (s) => ({ width: (s || '').length * 8 }),
  };
  const b = getOverlayBounds(
    { type: 'text', x: 10, y: 20, text: 'hello', size: 30 },
    ctx,
  );
  assert.equal(b.x, 10);
  assert.equal(b.y, 20);
  assert.equal(b.w, 5 * 8);
  assert.equal(b.h, 1 * 30 * 1.2);
});

test('getOverlayBounds: text — uses estimate when no ctx', () => {
  const b = getOverlayBounds(
    { type: 'text', x: 10, y: 20, text: 'hello', size: 30 },
    null,
  );
  assert.equal(b.x, 10);
  assert.equal(b.y, 20);
  // Estimate: chars * size * 0.55 ≈ non-zero.
  assert.ok(b.w > 0);
  assert.equal(b.h, 1 * 30 * 1.2);
});

test('getOverlayBounds: brush — bbox of points', () => {
  const b = getOverlayBounds({
    type: 'brush',
    points: new Float32Array([0, 0, 0.5, 10, 5, 0.5, 5, 20, 0.5]),
  });
  assert.equal(b.x, 0);
  assert.equal(b.y, 0);
  assert.equal(b.w, 10);
  assert.equal(b.h, 20);
});

test('getOverlayBounds: shape — normalised bbox of x1/y1/x2/y2', () => {
  const b = getOverlayBounds({
    type: 'shape', kind: 'rect',
    x1: 100, y1: 80, x2: 10, y2: 20,
  });
  assert.deepEqual(b, { x: 10, y: 20, w: 90, h: 60 });
});

test('getOverlayBounds: redact — x/y/w/h passthrough', () => {
  const b = getOverlayBounds({
    type: 'redact', x: 10, y: 20, w: 100, h: 80,
  });
  assert.deepEqual(b, { x: 10, y: 20, w: 100, h: 80 });
});

test('getOverlayBounds: unknown type returns zero bbox', () => {
  assert.deepEqual(getOverlayBounds({ type: 'mystery' }), { x: 0, y: 0, w: 0, h: 0 });
});

test('getOverlayBounds: tolerates null', () => {
  assert.deepEqual(getOverlayBounds(null), { x: 0, y: 0, w: 0, h: 0 });
});
