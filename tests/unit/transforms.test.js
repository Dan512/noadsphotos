import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCrop,
  applyResize,
  applyRotate,
  applyFlip,
} from '../../js/ops/transforms.js';

// Helper: minimal ImageState with the fields the transform ops touch.
function makeImageState({ w = 100, h = 80 } = {}) {
  return {
    source: { width: w, height: h },
    transforms: { crop: null, rotate: 0, flipH: false, flipV: false, resize: null },
    baseDirty: false,
    overlaysDirty: false,
  };
}

// --------------------------------------------------------------------------
// applyCrop
// --------------------------------------------------------------------------

test('applyCrop: valid rect stored on transforms.crop', () => {
  const img = makeImageState();
  applyCrop(img, { x: 10, y: 5, w: 40, h: 30 });
  assert.deepStrictEqual(img.transforms.crop, { x: 10, y: 5, w: 40, h: 30 });
});

test('applyCrop: out-of-bounds rect is clamped to image bounds', () => {
  const img = makeImageState({ w: 100, h: 80 });
  applyCrop(img, { x: -10, y: -10, w: 200, h: 200 });
  assert.deepStrictEqual(img.transforms.crop, { x: 0, y: 0, w: 100, h: 80 });
});

test('applyCrop: rect extending past right edge shifts left to fit', () => {
  const img = makeImageState({ w: 100, h: 100 });
  applyCrop(img, { x: 90, y: 10, w: 30, h: 30 });
  // clampCropToImage shifts so the right edge sits at 100.
  assert.equal(img.transforms.crop.x, 70);
  assert.equal(img.transforms.crop.w, 30);
});

test('applyCrop(null) clears the crop', () => {
  const img = makeImageState();
  img.transforms.crop = { x: 10, y: 10, w: 20, h: 20 };
  applyCrop(img, null);
  assert.equal(img.transforms.crop, null);
});

test('applyCrop sets baseDirty = true', () => {
  const img = makeImageState();
  assert.equal(img.baseDirty, false);
  applyCrop(img, { x: 0, y: 0, w: 50, h: 50 });
  assert.equal(img.baseDirty, true);
});

test('applyCrop(null) also sets baseDirty', () => {
  const img = makeImageState();
  applyCrop(img, null);
  assert.equal(img.baseDirty, true);
});

test('applyCrop: null imageState is a no-op (defensive)', () => {
  // Just shouldn't throw.
  applyCrop(null, { x: 0, y: 0, w: 10, h: 10 });
  assert.ok(true);
});

// --------------------------------------------------------------------------
// applyResize
// --------------------------------------------------------------------------

test('applyResize: longestSide mode is accepted and stored', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'longestSide', value: 800 });
  assert.deepStrictEqual(img.transforms.resize, { mode: 'longestSide', value: 800 });
});

test('applyResize: shortestSide mode is accepted', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'shortestSide', value: 400 });
  assert.equal(img.transforms.resize.mode, 'shortestSide');
  assert.equal(img.transforms.resize.value, 400);
});

test('applyResize: width mode is accepted', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'width', value: 1024 });
  assert.equal(img.transforms.resize.mode, 'width');
});

test('applyResize: height mode is accepted', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'height', value: 768 });
  assert.equal(img.transforms.resize.mode, 'height');
});

test('applyResize: percent mode is accepted', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'percent', value: 50 });
  assert.equal(img.transforms.resize.mode, 'percent');
  assert.equal(img.transforms.resize.value, 50);
});

test('applyResize: exact mode preserves both width and height', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'exact', value: 320, height: 240 });
  assert.equal(img.transforms.resize.mode, 'exact');
  assert.equal(img.transforms.resize.value, 320);
  assert.equal(img.transforms.resize.height, 240);
});

test('applyResize: unknown mode is a no-op (state untouched)', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'bogus', value: 100 });
  assert.equal(img.transforms.resize, null);
  // Should not even mark dirty since nothing changed.
  assert.equal(img.baseDirty, false);
});

test('applyResize(null) clears resize', () => {
  const img = makeImageState();
  img.transforms.resize = { mode: 'width', value: 500 };
  applyResize(img, null);
  assert.equal(img.transforms.resize, null);
});

test('applyResize sets baseDirty when a valid mode is stored', () => {
  const img = makeImageState();
  applyResize(img, { mode: 'longestSide', value: 800 });
  assert.equal(img.baseDirty, true);
});

test('applyResize(null) sets baseDirty', () => {
  const img = makeImageState();
  applyResize(img, null);
  assert.equal(img.baseDirty, true);
});

test('applyResize: stored resize is a copy (caller mutation does not leak)', () => {
  const img = makeImageState();
  const input = { mode: 'width', value: 100 };
  applyResize(img, input);
  input.value = 999;
  assert.equal(img.transforms.resize.value, 100);
});

test('applyResize: null imageState is a no-op', () => {
  applyResize(null, { mode: 'width', value: 100 });
  assert.ok(true);
});

// --------------------------------------------------------------------------
// applyRotate
// --------------------------------------------------------------------------

test('applyRotate(90) sets rotate to 90', () => {
  const img = makeImageState();
  applyRotate(img, 90);
  assert.equal(img.transforms.rotate, 90);
});

test('applyRotate(370) normalises to 10', () => {
  const img = makeImageState();
  applyRotate(img, 370);
  assert.equal(img.transforms.rotate, 10);
});

test('applyRotate(-90) normalises to 270', () => {
  const img = makeImageState();
  applyRotate(img, -90);
  assert.equal(img.transforms.rotate, 270);
});

test('applyRotate(720) normalises to 0', () => {
  const img = makeImageState();
  applyRotate(img, 720);
  assert.equal(img.transforms.rotate, 0);
});

test('applyRotate(-450) normalises to 270', () => {
  const img = makeImageState();
  applyRotate(img, -450);
  assert.equal(img.transforms.rotate, 270);
});

test('applyRotate sets baseDirty', () => {
  const img = makeImageState();
  applyRotate(img, 90);
  assert.equal(img.baseDirty, true);
});

test('applyRotate with non-finite deg is a no-op', () => {
  const img = makeImageState();
  applyRotate(img, NaN);
  assert.equal(img.transforms.rotate, 0);
  assert.equal(img.baseDirty, false);
});

test('applyRotate: null imageState is a no-op', () => {
  applyRotate(null, 90);
  assert.ok(true);
});

// --------------------------------------------------------------------------
// applyFlip
// --------------------------------------------------------------------------

test('applyFlip("h") toggles flipH false → true', () => {
  const img = makeImageState();
  applyFlip(img, 'h');
  assert.equal(img.transforms.flipH, true);
});

test('applyFlip("h") twice returns flipH to false', () => {
  const img = makeImageState();
  applyFlip(img, 'h');
  applyFlip(img, 'h');
  assert.equal(img.transforms.flipH, false);
});

test('applyFlip("v") toggles flipV false → true', () => {
  const img = makeImageState();
  applyFlip(img, 'v');
  assert.equal(img.transforms.flipV, true);
});

test('applyFlip("v") twice returns flipV to false', () => {
  const img = makeImageState();
  applyFlip(img, 'v');
  applyFlip(img, 'v');
  assert.equal(img.transforms.flipV, false);
});

test('applyFlip("h") does not touch flipV (independent axes)', () => {
  const img = makeImageState();
  applyFlip(img, 'h');
  assert.equal(img.transforms.flipH, true);
  assert.equal(img.transforms.flipV, false);
});

test('applyFlip sets baseDirty', () => {
  const img = makeImageState();
  applyFlip(img, 'h');
  assert.equal(img.baseDirty, true);
});

test('applyFlip("bogus") is a no-op', () => {
  const img = makeImageState();
  applyFlip(img, 'bogus');
  assert.equal(img.transforms.flipH, false);
  assert.equal(img.transforms.flipV, false);
  assert.equal(img.baseDirty, false);
});

test('applyFlip: null imageState is a no-op', () => {
  applyFlip(null, 'h');
  assert.ok(true);
});
