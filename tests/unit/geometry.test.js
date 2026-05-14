import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distance,
  lerp,
  pointInRect,
  pointInRotatedRect,
  makeTransform,
  worldToScreen,
  screenToWorld,
  rectFromHandles,
  clampCropToImage,
  aspectLockResize,
  rotateRect,
  effectiveImageSize,
} from '../../js/geometry.js';

// Floating-point comparison helper. Geometry tests use simple integer
// fixtures where possible; this is for cases that have legitimate fp output.
const EPS = 1e-9;
function near(a, b, eps = EPS) {
  return Math.abs(a - b) < eps;
}
function pointNear(p, q, eps = EPS) {
  return near(p.x, q.x, eps) && near(p.y, q.y, eps);
}

// --------------------------------------------------------------------------
// distance
// --------------------------------------------------------------------------

test('distance: between same point is zero', () => {
  assert.equal(distance({ x: 5, y: 5 }, { x: 5, y: 5 }), 0);
});

test('distance: horizontal segment', () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 0 }), 3);
});

test('distance: classic 3-4-5 triangle', () => {
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});

test('distance: handles negative coordinates', () => {
  assert.equal(distance({ x: -3, y: -4 }, { x: 0, y: 0 }), 5);
});

// --------------------------------------------------------------------------
// lerp
// --------------------------------------------------------------------------

test('lerp: t=0 returns first point', () => {
  assert.deepStrictEqual(lerp({ x: 1, y: 2 }, { x: 5, y: 9 }, 0), { x: 1, y: 2 });
});

test('lerp: t=1 returns second point', () => {
  assert.deepStrictEqual(lerp({ x: 1, y: 2 }, { x: 5, y: 9 }, 1), { x: 5, y: 9 });
});

test('lerp: t=0.5 returns midpoint', () => {
  assert.deepStrictEqual(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
});

test('lerp: t outside [0,1] extrapolates linearly', () => {
  assert.deepStrictEqual(lerp({ x: 0, y: 0 }, { x: 10, y: 0 }, 2), { x: 20, y: 0 });
  assert.deepStrictEqual(lerp({ x: 0, y: 0 }, { x: 10, y: 0 }, -1), { x: -10, y: 0 });
});

// --------------------------------------------------------------------------
// pointInRect
// --------------------------------------------------------------------------

test('pointInRect: interior point counted as inside', () => {
  assert.equal(pointInRect({ x: 5, y: 5 }, { x: 0, y: 0, w: 10, h: 10 }), true);
});

test('pointInRect: outside point counted as outside', () => {
  assert.equal(pointInRect({ x: 15, y: 5 }, { x: 0, y: 0, w: 10, h: 10 }), false);
});

test('pointInRect: point exactly on left edge is inside', () => {
  assert.equal(pointInRect({ x: 0, y: 5 }, { x: 0, y: 0, w: 10, h: 10 }), true);
});

test('pointInRect: point exactly on top edge is inside', () => {
  assert.equal(pointInRect({ x: 5, y: 0 }, { x: 0, y: 0, w: 10, h: 10 }), true);
});

test('pointInRect: point on bottom-right corner is inside', () => {
  assert.equal(pointInRect({ x: 10, y: 10 }, { x: 0, y: 0, w: 10, h: 10 }), true);
});

test('pointInRect: negative coordinates handled correctly', () => {
  assert.equal(pointInRect({ x: -5, y: -5 }, { x: -10, y: -10, w: 20, h: 20 }), true);
  assert.equal(pointInRect({ x: 11, y: 0 }, { x: -10, y: -10, w: 20, h: 20 }), false);
});

test('pointInRect: zero-area rect contains only its origin', () => {
  assert.equal(pointInRect({ x: 5, y: 5 }, { x: 5, y: 5, w: 0, h: 0 }), true);
  assert.equal(pointInRect({ x: 5.0001, y: 5 }, { x: 5, y: 5, w: 0, h: 0 }), false);
});

// --------------------------------------------------------------------------
// pointInRotatedRect
// --------------------------------------------------------------------------

test('pointInRotatedRect: 0° rotation matches pointInRect', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  for (const p of [{ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 11, y: 5 }, { x: -1, y: 5 }]) {
    assert.equal(pointInRotatedRect(p, rect, 0), pointInRect(p, rect),
      `mismatch at point ${JSON.stringify(p)}`);
  }
});

test('pointInRotatedRect: 90° rotation around center keeps center inside', () => {
  const rect = { x: 0, y: 0, w: 10, h: 20 };
  // Center always stays inside under rotation.
  assert.equal(pointInRotatedRect({ x: 5, y: 10 }, rect, 90), true);
});

test('pointInRotatedRect: 90° rotation swaps width/height extents', () => {
  // A tall rect rotated 90° at its center becomes wide.
  // Tall rect 10x20 → rotated 90° forms a region 20x10 around the same center (5,10).
  // A point at (12, 10) was outside the original (x range 0..10) but inside the
  // rotated rect (rotated x-extent is 5 ± 10 = [-5, 15]).
  const rect = { x: 0, y: 0, w: 10, h: 20 };
  assert.equal(pointInRect({ x: 12, y: 10 }, rect), false);
  assert.equal(pointInRotatedRect({ x: 12, y: 10 }, rect, 90), true);
});

test('pointInRotatedRect: corner of a 45°-rotated square', () => {
  // Square 0,0,10,10 rotated 45° has rotated corners at center ± diag.
  // The point (5, 5 - 5*sqrt(2)) is exactly on the top rotated corner.
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  const apex = { x: 5, y: 5 - 5 * Math.sqrt(2) + 0.0001 };
  assert.equal(pointInRotatedRect(apex, rect, 45), true);
  const beyondApex = { x: 5, y: 5 - 5 * Math.sqrt(2) - 0.1 };
  assert.equal(pointInRotatedRect(beyondApex, rect, 45), false);
});

test('pointInRotatedRect: rotation has no effect on center point', () => {
  const rect = { x: 10, y: 20, w: 30, h: 40 };
  const center = { x: 25, y: 40 };
  for (const deg of [0, 30, 90, 137, 180, 270, 359]) {
    assert.equal(pointInRotatedRect(center, rect, deg), true, `failed at ${deg}°`);
  }
});

// --------------------------------------------------------------------------
// makeTransform / worldToScreen / screenToWorld
// --------------------------------------------------------------------------

test('makeTransform: identity transform (no args) yields input == output', () => {
  const t = makeTransform();
  const p = { x: 7, y: 13 };
  assert.deepStrictEqual(worldToScreen(p, t), p);
  assert.deepStrictEqual(screenToWorld(p, t), p);
});

test('makeTransform: defaults match identity', () => {
  const t = makeTransform({ scale: 1, panX: 0, panY: 0, rotation: 0 });
  assert.equal(t.scale, 1);
  assert.equal(t.panX, 0);
  assert.equal(t.panY, 0);
  assert.equal(t.rotation, 0);
  assert.equal(t.flipH, false);
  assert.equal(t.flipV, false);
});

test('worldToScreen: pure pan adds the pan offset', () => {
  const t = makeTransform({ panX: 50, panY: 30 });
  assert.deepStrictEqual(worldToScreen({ x: 10, y: 20 }, t), { x: 60, y: 50 });
});

test('screenToWorld: pure pan subtracts the pan offset', () => {
  const t = makeTransform({ panX: 50, panY: 50 });
  assert.deepStrictEqual(screenToWorld({ x: 100, y: 100 }, t), { x: 50, y: 50 });
});

test('worldToScreen: pure scale multiplies coordinates', () => {
  const t = makeTransform({ scale: 2 });
  assert.deepStrictEqual(worldToScreen({ x: 10, y: 20 }, t), { x: 20, y: 40 });
});

test('screenToWorld: pure scale divides coordinates', () => {
  const t = makeTransform({ scale: 2 });
  assert.deepStrictEqual(screenToWorld({ x: 20, y: 40 }, t), { x: 10, y: 20 });
});

test('worldToScreen: 90° rotation around origin maps (1,0) → (0,1)', () => {
  const t = makeTransform({ rotation: 90 });
  const out = worldToScreen({ x: 1, y: 0 }, t);
  assert.ok(near(out.x, 0));
  assert.ok(near(out.y, 1));
});

test('worldToScreen: 180° rotation around origin negates the point', () => {
  const t = makeTransform({ rotation: 180 });
  const out = worldToScreen({ x: 3, y: 4 }, t);
  assert.ok(near(out.x, -3));
  assert.ok(near(out.y, -4));
});

test('worldToScreen: flipH negates x but not y', () => {
  const t = makeTransform({ flipH: true });
  assert.deepStrictEqual(worldToScreen({ x: 7, y: 13 }, t), { x: -7, y: 13 });
});

test('worldToScreen: flipV negates y but not x', () => {
  const t = makeTransform({ flipV: true });
  assert.deepStrictEqual(worldToScreen({ x: 7, y: 13 }, t), { x: 7, y: -13 });
});

test('roundtrip: worldToScreen → screenToWorld returns the original (identity)', () => {
  const t = makeTransform();
  const p = { x: 42, y: -17 };
  assert.deepStrictEqual(screenToWorld(worldToScreen(p, t), t), p);
});

test('roundtrip: complex transform (scale + pan + rotation) survives roundtrip', () => {
  const t = makeTransform({ scale: 2.5, panX: 100, panY: 50, rotation: 37 });
  const p = { x: 13, y: -9 };
  const out = screenToWorld(worldToScreen(p, t), t);
  assert.ok(pointNear(out, p, 1e-9), `expected ${JSON.stringify(p)} got ${JSON.stringify(out)}`);
});

test('roundtrip: transform with flipH stays consistent', () => {
  const t = makeTransform({ scale: 3, panX: 5, panY: 8, flipH: true });
  const p = { x: 10, y: 4 };
  const out = screenToWorld(worldToScreen(p, t), t);
  assert.ok(pointNear(out, p, 1e-9));
});

test('roundtrip: transform with flipV + rotation stays consistent', () => {
  const t = makeTransform({ scale: 1.5, rotation: 90, flipV: true, panX: 20 });
  const p = { x: -7, y: 11 };
  const out = screenToWorld(worldToScreen(p, t), t);
  assert.ok(pointNear(out, p, 1e-9));
});

// --------------------------------------------------------------------------
// rectFromHandles
// --------------------------------------------------------------------------

test('rectFromHandles: top-left to bottom-right normalizes ordered handles', () => {
  assert.deepStrictEqual(rectFromHandles({ x: 5, y: 5 }, { x: 10, y: 10 }), { x: 5, y: 5, w: 5, h: 5 });
});

test('rectFromHandles: bottom-right to top-left inverted handles still normalizes', () => {
  assert.deepStrictEqual(rectFromHandles({ x: 10, y: 10 }, { x: 5, y: 5 }), { x: 5, y: 5, w: 5, h: 5 });
});

test('rectFromHandles: bottom-left to top-right diagonally inverted', () => {
  assert.deepStrictEqual(rectFromHandles({ x: 5, y: 10 }, { x: 10, y: 5 }), { x: 5, y: 5, w: 5, h: 5 });
});

test('rectFromHandles: identical handles produce a zero-area rect', () => {
  assert.deepStrictEqual(rectFromHandles({ x: 7, y: 7 }, { x: 7, y: 7 }), { x: 7, y: 7, w: 0, h: 0 });
});

test('rectFromHandles: negative coordinates handled', () => {
  assert.deepStrictEqual(rectFromHandles({ x: -10, y: 5 }, { x: 5, y: -10 }), { x: -10, y: -10, w: 15, h: 15 });
});

// --------------------------------------------------------------------------
// clampCropToImage
// --------------------------------------------------------------------------

test('clampCropToImage: rect entirely inside is unchanged', () => {
  const rect = { x: 10, y: 10, w: 50, h: 30 };
  assert.deepStrictEqual(clampCropToImage(rect, { w: 100, h: 100 }), rect);
});

test('clampCropToImage: negative x clamps to 0 (preserving width)', () => {
  const out = clampCropToImage({ x: -5, y: 10, w: 30, h: 30 }, { w: 100, h: 100 });
  assert.equal(out.x, 0);
  assert.equal(out.y, 10);
  assert.equal(out.w, 30);
  assert.equal(out.h, 30);
});

test('clampCropToImage: negative y clamps to 0', () => {
  const out = clampCropToImage({ x: 10, y: -5, w: 30, h: 30 }, { w: 100, h: 100 });
  assert.equal(out.x, 10);
  assert.equal(out.y, 0);
});

test('clampCropToImage: extending past right edge shifts left to fit', () => {
  // Image 100x100, rect extends past x=100 → shift x left so right edge sits at 100.
  const out = clampCropToImage({ x: 90, y: 10, w: 30, h: 30 }, { w: 100, h: 100 });
  assert.equal(out.x, 70);
  assert.equal(out.w, 30);
});

test('clampCropToImage: extending past bottom edge shifts up to fit', () => {
  const out = clampCropToImage({ x: 10, y: 90, w: 30, h: 30 }, { w: 100, h: 100 });
  assert.equal(out.y, 70);
  assert.equal(out.h, 30);
});

test('clampCropToImage: rect larger than image clamped to image bounds', () => {
  const out = clampCropToImage({ x: -10, y: -10, w: 200, h: 200 }, { w: 100, h: 80 });
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
  assert.equal(out.w, 100);
  assert.equal(out.h, 80);
});

test('clampCropToImage: rect at the exact image boundary unchanged', () => {
  const out = clampCropToImage({ x: 0, y: 0, w: 100, h: 100 }, { w: 100, h: 100 });
  assert.deepStrictEqual(out, { x: 0, y: 0, w: 100, h: 100 });
});

test('clampCropToImage: negative w/h clamped to 0', () => {
  const out = clampCropToImage({ x: 10, y: 10, w: -5, h: -5 }, { w: 100, h: 100 });
  assert.equal(out.w, 0);
  assert.equal(out.h, 0);
});

// --------------------------------------------------------------------------
// aspectLockResize
// --------------------------------------------------------------------------

test('aspectLockResize: br corner drag with 1:1 keeps width == height', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  const out = aspectLockResize(rect, 'br', { x: 25, y: 30 }, 1);
  // br anchor stays at (0,0). User cursor at (25,30) — locked square fills
  // the larger dimension (30) to stay covering the cursor.
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
  assert.equal(out.w, 30);
  assert.equal(out.h, 30);
});

test('aspectLockResize: tl corner drag preserves bottom-right anchor', () => {
  const rect = { x: 10, y: 10, w: 20, h: 20 };
  // br anchor of the rect is (30, 30); user drags top-left to (5, 5).
  const out = aspectLockResize(rect, 'tl', { x: 5, y: 5 }, 1);
  // br stays at (30,30); new w/h reach left/up from there. Distance from
  // br to target is 25 on both axes → aspect 1:1, w=h=25, x = 30-25 = 5.
  assert.equal(out.x, 5);
  assert.equal(out.y, 5);
  assert.equal(out.w, 25);
  assert.equal(out.h, 25);
});

test('aspectLockResize: bl corner drag (anchor top-right)', () => {
  const rect = { x: 10, y: 10, w: 20, h: 20 };
  // Anchor for 'bl' is top-right (30, 10).
  const out = aspectLockResize(rect, 'bl', { x: 5, y: 35 }, 1);
  // Distances from anchor: dx=25, dy=25 → w=h=25; x = 30-25 = 5, y=10.
  assert.equal(out.x, 5);
  assert.equal(out.y, 10);
  assert.equal(out.w, 25);
  assert.equal(out.h, 25);
});

test('aspectLockResize: 16:9 aspect picks dominant axis', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  const out = aspectLockResize(rect, 'br', { x: 160, y: 90 }, 16 / 9);
  // 160 vs 90 * (16/9) = 160 → exactly the aspect, w=160, h=90.
  assert.ok(near(out.w, 160));
  assert.ok(near(out.h, 90));
});

test('aspectLockResize: 16:9 aspect, height-dominant target expands width', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  // Target (50, 90): w=50 vs h*aspect = 160 → height dominates → w grows.
  const out = aspectLockResize(rect, 'br', { x: 50, y: 90 }, 16 / 9);
  assert.ok(near(out.h, 90));
  assert.ok(near(out.w, 160));
});

test('aspectLockResize: edge drag (bottom) with aspect grows width symmetrically', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  // Drag bottom edge to y=30 → new h=30, with aspect=1 → w=30, centered on x=5.
  const out = aspectLockResize(rect, 'b', { x: 999, y: 30 }, 1);
  assert.ok(near(out.w, 30));
  assert.ok(near(out.h, 30));
  assert.ok(near(out.x, -10)); // centered on original cx=5 → x = 5 - 15
  assert.ok(near(out.y, 0));
});

test('aspectLockResize: edge drag (right) with 2:1 aspect derives height', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  const out = aspectLockResize(rect, 'r', { x: 40, y: 999 }, 2);
  assert.ok(near(out.w, 40));
  assert.ok(near(out.h, 20));
  assert.ok(near(out.x, 0));
  assert.ok(near(out.y, -5)); // centered on cy=5
});

test('aspectLockResize: no aspect lock (invalid aspect) keeps width on edge drag', () => {
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  const out = aspectLockResize(rect, 'b', { x: 999, y: 30 }, 0);
  assert.equal(out.w, 10); // width unchanged
  assert.equal(out.h, 30);
});

test('aspectLockResize: corner drag without lock just uses target distances', () => {
  const rect = { x: 10, y: 10, w: 20, h: 20 };
  const out = aspectLockResize(rect, 'br', { x: 50, y: 100 }, NaN);
  // No aspect → w=40, h=90, anchor (10,10), corner type 'br' means x/y stay.
  assert.equal(out.x, 10);
  assert.equal(out.y, 10);
  assert.equal(out.w, 40);
  assert.equal(out.h, 90);
});

// --------------------------------------------------------------------------
// rotateRect
// --------------------------------------------------------------------------

test('rotateRect: 0° leaves rect unchanged', () => {
  assert.deepStrictEqual(rotateRect({ x: 1, y: 2, w: 3, h: 4 }, 0), { x: 1, y: 2, w: 3, h: 4 });
});

test('rotateRect: 180° leaves dimensions unchanged but is still the same bounding box', () => {
  const out = rotateRect({ x: 1, y: 2, w: 3, h: 4 }, 180);
  assert.equal(out.w, 3);
  assert.equal(out.h, 4);
});

test('rotateRect: 90° swaps w/h and keeps center fixed', () => {
  const out = rotateRect({ x: 0, y: 0, w: 10, h: 20 }, 90);
  assert.equal(out.w, 20);
  assert.equal(out.h, 10);
  // Center should be at (5, 10) in both.
  assert.equal(out.x + out.w / 2, 5);
  assert.equal(out.y + out.h / 2, 10);
});

test('rotateRect: 270° also swaps w/h', () => {
  const out = rotateRect({ x: 0, y: 0, w: 10, h: 20 }, 270);
  assert.equal(out.w, 20);
  assert.equal(out.h, 10);
});

test('rotateRect: 45° produces a larger bounding box', () => {
  const out = rotateRect({ x: 0, y: 0, w: 10, h: 10 }, 45);
  // Both axes should be 10*sqrt(2) ≈ 14.142.
  assert.ok(near(out.w, 10 * Math.sqrt(2)));
  assert.ok(near(out.h, 10 * Math.sqrt(2)));
});

test('rotateRect: 30° produces a wider/taller bounding box than original', () => {
  const out = rotateRect({ x: 0, y: 0, w: 10, h: 20 }, 30);
  assert.ok(out.w > 10);
  assert.ok(out.h > 20);
});

test('rotateRect: negative rotation works the same as positive equivalent', () => {
  const a = rotateRect({ x: 0, y: 0, w: 10, h: 20 }, -90);
  const b = rotateRect({ x: 0, y: 0, w: 10, h: 20 }, 270);
  assert.deepStrictEqual(a, b);
});

// --------------------------------------------------------------------------
// effectiveImageSize
// --------------------------------------------------------------------------

// Helper to construct a minimal imageState with the fields effectiveImageSize cares about.
function makeImageState({ w = 100, h = 50, crop = null, rotate = 0, resize = null } = {}) {
  return {
    source: { width: w, height: h },
    transforms: { crop, rotate, flipH: false, flipV: false, resize },
  };
}

test('effectiveImageSize: source dims with no transforms returned verbatim', () => {
  const out = effectiveImageSize(makeImageState({ w: 100, h: 50 }));
  assert.deepStrictEqual(out, { w: 100, h: 50 });
});

test('effectiveImageSize: missing imageState returns 0×0', () => {
  assert.deepStrictEqual(effectiveImageSize(null), { w: 0, h: 0 });
  assert.deepStrictEqual(effectiveImageSize({}), { w: 0, h: 0 });
});

test('effectiveImageSize: rotate 90° swaps source dims', () => {
  const out = effectiveImageSize(makeImageState({ w: 100, h: 50, rotate: 90 }));
  assert.deepStrictEqual(out, { w: 50, h: 100 });
});

test('effectiveImageSize: rotate 270° swaps source dims', () => {
  const out = effectiveImageSize(makeImageState({ w: 100, h: 50, rotate: 270 }));
  assert.deepStrictEqual(out, { w: 50, h: 100 });
});

test('effectiveImageSize: rotate 180° preserves dims', () => {
  const out = effectiveImageSize(makeImageState({ w: 100, h: 50, rotate: 180 }));
  assert.deepStrictEqual(out, { w: 100, h: 50 });
});

test('effectiveImageSize: crop overrides source dims', () => {
  const out = effectiveImageSize(makeImageState({
    w: 100, h: 50,
    crop: { x: 10, y: 5, w: 40, h: 30 },
  }));
  assert.deepStrictEqual(out, { w: 40, h: 30 });
});

test('effectiveImageSize: crop then rotate 90° swaps cropped dims', () => {
  const out = effectiveImageSize(makeImageState({
    w: 100, h: 50,
    crop: { x: 10, y: 5, w: 40, h: 30 },
    rotate: 90,
  }));
  assert.deepStrictEqual(out, { w: 30, h: 40 });
});

test('effectiveImageSize: resize longestSide on 100×50 yields 200×100', () => {
  const out = effectiveImageSize(makeImageState({
    w: 100, h: 50,
    resize: { mode: 'longestSide', value: 200 },
  }));
  assert.deepStrictEqual(out, { w: 200, h: 100 });
});

test('effectiveImageSize: resize longestSide on portrait image preserves aspect', () => {
  const out = effectiveImageSize(makeImageState({
    w: 50, h: 200,
    resize: { mode: 'longestSide', value: 100 },
  }));
  assert.ok(near(out.w, 25));
  assert.ok(near(out.h, 100));
});

test('effectiveImageSize: resize shortestSide', () => {
  const out = effectiveImageSize(makeImageState({
    w: 200, h: 100,
    resize: { mode: 'shortestSide', value: 50 },
  }));
  assert.ok(near(out.w, 100));
  assert.ok(near(out.h, 50));
});

test('effectiveImageSize: resize width preserves aspect', () => {
  const out = effectiveImageSize(makeImageState({
    w: 200, h: 100,
    resize: { mode: 'width', value: 100 },
  }));
  assert.ok(near(out.w, 100));
  assert.ok(near(out.h, 50));
});

test('effectiveImageSize: resize height preserves aspect', () => {
  const out = effectiveImageSize(makeImageState({
    w: 200, h: 100,
    resize: { mode: 'height', value: 50 },
  }));
  assert.ok(near(out.w, 100));
  assert.ok(near(out.h, 50));
});

test('effectiveImageSize: resize exact with separate height', () => {
  const out = effectiveImageSize(makeImageState({
    w: 200, h: 100,
    resize: { mode: 'exact', value: 320, height: 240 },
  }));
  assert.deepStrictEqual(out, { w: 320, h: 240 });
});

test('effectiveImageSize: resize exact without height uses value for both', () => {
  const out = effectiveImageSize(makeImageState({
    w: 200, h: 100,
    resize: { mode: 'exact', value: 64 },
  }));
  assert.deepStrictEqual(out, { w: 64, h: 64 });
});

test('effectiveImageSize: resize percent scales both axes uniformly', () => {
  // 10% of 1024×1024 — matches the user-reported regression scenario.
  const out = effectiveImageSize(makeImageState({
    w: 1024, h: 1024,
    resize: { mode: 'percent', value: 10 },
  }));
  assert.ok(near(out.w, 102.4));
  assert.ok(near(out.h, 102.4));
});

test('effectiveImageSize: resize percent at 200% doubles dims', () => {
  const out = effectiveImageSize(makeImageState({
    w: 100, h: 50,
    resize: { mode: 'percent', value: 200 },
  }));
  assert.deepStrictEqual(out, { w: 200, h: 100 });
});

test('effectiveImageSize: resize percent preserves aspect ratio', () => {
  const out = effectiveImageSize(makeImageState({
    w: 800, h: 600,
    resize: { mode: 'percent', value: 50 },
  }));
  assert.deepStrictEqual(out, { w: 400, h: 300 });
});

test('effectiveImageSize: chained crop → rotate → resize', () => {
  const out = effectiveImageSize(makeImageState({
    w: 200, h: 100,
    crop: { x: 0, y: 0, w: 100, h: 50 },
    rotate: 90,                                    // now 50x100
    resize: { mode: 'longestSide', value: 200 },   // 50:100 → 100:200
  }));
  assert.ok(near(out.w, 100));
  assert.ok(near(out.h, 200));
});

test('effectiveImageSize: resize with invalid value (<=0) leaves dims alone', () => {
  const out = effectiveImageSize(makeImageState({
    w: 100, h: 50,
    resize: { mode: 'longestSide', value: 0 },
  }));
  assert.deepStrictEqual(out, { w: 100, h: 50 });
});

test('effectiveImageSize: unknown resize mode leaves dims alone', () => {
  const out = effectiveImageSize(makeImageState({
    w: 100, h: 50,
    resize: { mode: 'banana', value: 50 },
  }));
  assert.deepStrictEqual(out, { w: 100, h: 50 });
});
