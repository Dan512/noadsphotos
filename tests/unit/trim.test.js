// tests/unit/trim.test.js — v1.1 Feature 3 (auto-crop / trim).
//
// Covers the pure geometry + predicate helpers in js/ops/trim.js. The wiring
// (render → bbox → bake → crop) is covered by the browser specs because it
// requires real ImageBitmap / canvas APIs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findContentBoundingBox,
  predicateTransparent,
  predicateNotColor,
  sampleTopLeftPixel,
} from '../../js/ops/trim.js';

// Build an ImageData-shaped duck. trim.js only reads {data, width, height}
// so we don't need a DOM polyfill.
function makeImageData(width, height, fillRgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fillRgba) {
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      data[i] = fillRgba[0];
      data[i + 1] = fillRgba[1];
      data[i + 2] = fillRgba[2];
      data[i + 3] = fillRgba[3];
    }
  }
  return { width, height, data };
}

// Paint an axis-aligned filled rect inside an ImageData.
function paintRect(imgData, x, y, w, h, rgba) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * imgData.width + xx) * 4;
      imgData.data[i]     = rgba[0];
      imgData.data[i + 1] = rgba[1];
      imgData.data[i + 2] = rgba[2];
      imgData.data[i + 3] = rgba[3];
    }
  }
}

// --------------------------------------------------------------------------
// findContentBoundingBox
// --------------------------------------------------------------------------

test('findContentBoundingBox: fully transparent 16x16 → null', () => {
  const img = makeImageData(16, 16, [0, 0, 0, 0]);
  const bbox = findContentBoundingBox(img, predicateTransparent());
  assert.equal(bbox, null);
});

test('findContentBoundingBox: 4x4 opaque square at (5,5) in 16x16 → exact bbox', () => {
  const img = makeImageData(16, 16, [0, 0, 0, 0]);
  paintRect(img, 5, 5, 4, 4, [255, 0, 0, 255]);
  const bbox = findContentBoundingBox(img, predicateTransparent());
  assert.deepStrictEqual(bbox, { x: 5, y: 5, w: 4, h: 4 });
});

test('findContentBoundingBox: single opaque pixel at (10, 3) → 1x1 bbox', () => {
  const img = makeImageData(16, 16, [0, 0, 0, 0]);
  paintRect(img, 10, 3, 1, 1, [0, 255, 0, 255]);
  const bbox = findContentBoundingBox(img, predicateTransparent());
  assert.deepStrictEqual(bbox, { x: 10, y: 3, w: 1, h: 1 });
});

test('findContentBoundingBox: opaque pixels at the four corners → full image bbox', () => {
  const img = makeImageData(8, 8, [0, 0, 0, 0]);
  paintRect(img, 0, 0, 1, 1, [255, 255, 255, 255]);
  paintRect(img, 7, 0, 1, 1, [255, 255, 255, 255]);
  paintRect(img, 0, 7, 1, 1, [255, 255, 255, 255]);
  paintRect(img, 7, 7, 1, 1, [255, 255, 255, 255]);
  const bbox = findContentBoundingBox(img, predicateTransparent());
  assert.deepStrictEqual(bbox, { x: 0, y: 0, w: 8, h: 8 });
});

test('findContentBoundingBox: white image with a red square → square bbox via predicateNotColor', () => {
  const img = makeImageData(16, 16, [255, 255, 255, 255]);
  paintRect(img, 5, 5, 4, 4, [255, 0, 0, 255]);
  // Background is white; the red square is the content.
  const bbox = findContentBoundingBox(img, predicateNotColor(255, 255, 255, 8));
  assert.deepStrictEqual(bbox, { x: 5, y: 5, w: 4, h: 4 });
});

test('findContentBoundingBox: solid color image with predicateNotColor of same color → null', () => {
  const img = makeImageData(8, 8, [200, 100, 50, 255]);
  const bbox = findContentBoundingBox(img, predicateNotColor(200, 100, 50, 0));
  assert.equal(bbox, null);
});

test('findContentBoundingBox: null/empty input → null', () => {
  assert.equal(findContentBoundingBox(null, predicateTransparent()), null);
  assert.equal(findContentBoundingBox({}, predicateTransparent()), null);
  assert.equal(findContentBoundingBox(makeImageData(0, 0), predicateTransparent()), null);
});

test('findContentBoundingBox: non-function predicate → null', () => {
  const img = makeImageData(4, 4, [255, 0, 0, 255]);
  assert.equal(findContentBoundingBox(img, null), null);
});

// --------------------------------------------------------------------------
// predicateTransparent
// --------------------------------------------------------------------------

test('predicateTransparent: default threshold keeps any non-zero alpha', () => {
  const p = predicateTransparent();
  assert.equal(p(0, 0, 0, 1), true);   // alpha 1 kept
  assert.equal(p(0, 0, 0, 255), true); // opaque kept
  assert.equal(p(0, 0, 0, 0), false);  // fully transparent dropped
});

test('predicateTransparent: explicit threshold filters below it', () => {
  const p = predicateTransparent(10);
  assert.equal(p(0, 0, 0, 10), false); // strictly greater, so 10 is dropped
  assert.equal(p(0, 0, 0, 11), true);
  assert.equal(p(0, 0, 0, 0), false);
});

// --------------------------------------------------------------------------
// predicateNotColor
// --------------------------------------------------------------------------

test('predicateNotColor: exact match dropped, distant pixel kept', () => {
  const p = predicateNotColor(255, 255, 255, 8);
  assert.equal(p(255, 255, 255, 255), false); // exact white → background, drop
  assert.equal(p(0, 0, 0, 255), true);        // black → content, keep
});

test('predicateNotColor: pixels within tolerance are dropped', () => {
  const p = predicateNotColor(100, 100, 100, 10);
  // distance squared = 3*5*5 = 75; tolerance squared = 100. Within → drop.
  assert.equal(p(105, 105, 105, 255), false);
  // distance squared = 3*7*7 = 147 > 100 → keep.
  assert.equal(p(107, 107, 107, 255), true);
});

test('predicateNotColor: fully transparent pixel is treated as background (dropped)', () => {
  const p = predicateNotColor(255, 0, 0, 8);
  // Black opaque is far from red → would normally keep, but a=0 → drop.
  assert.equal(p(0, 0, 0, 0), false);
});

test('predicateNotColor: zero tolerance only drops exact matches', () => {
  const p = predicateNotColor(50, 50, 50, 0);
  assert.equal(p(50, 50, 50, 255), false); // exact
  assert.equal(p(51, 50, 50, 255), true);  // any difference → keep
});

test('predicateNotColor: non-finite tolerance falls back to 0', () => {
  const p = predicateNotColor(50, 50, 50, NaN);
  assert.equal(p(50, 50, 50, 255), false);
  assert.equal(p(51, 50, 50, 255), true);
});

// --------------------------------------------------------------------------
// sampleTopLeftPixel
// --------------------------------------------------------------------------

test('sampleTopLeftPixel: returns the (0,0) RGBA tuple', () => {
  const img = makeImageData(4, 4, [10, 20, 30, 200]);
  assert.deepStrictEqual(sampleTopLeftPixel(img), { r: 10, g: 20, b: 30, a: 200 });
});

test('sampleTopLeftPixel: returns null for empty inputs', () => {
  assert.equal(sampleTopLeftPixel(null), null);
  assert.equal(sampleTopLeftPixel({}), null);
  assert.equal(sampleTopLeftPixel(makeImageData(0, 0)), null);
});

test('sampleTopLeftPixel: independent of other pixels', () => {
  const img = makeImageData(4, 4, [10, 20, 30, 200]);
  paintRect(img, 1, 0, 3, 4, [200, 200, 200, 255]);
  // (0,0) is still the original fill.
  assert.deepStrictEqual(sampleTopLeftPixel(img), { r: 10, g: 20, b: 30, a: 200 });
});

// --------------------------------------------------------------------------
// Integration: predicate-finder pair behaves transitively
// --------------------------------------------------------------------------

test('integration: trim white background then trim transparent edges → same bbox', () => {
  // White background with a 5x3 red rect at (2, 1).
  const whiteWithRed = makeImageData(10, 6, [255, 255, 255, 255]);
  paintRect(whiteWithRed, 2, 1, 5, 3, [255, 0, 0, 255]);
  const colorBBox = findContentBoundingBox(whiteWithRed, predicateNotColor(255, 255, 255, 4));

  // Now build the same shape on a transparent background.
  const transparent = makeImageData(10, 6, [0, 0, 0, 0]);
  paintRect(transparent, 2, 1, 5, 3, [255, 0, 0, 255]);
  const alphaBBox = findContentBoundingBox(transparent, predicateTransparent());

  assert.deepStrictEqual(colorBBox, alphaBBox);
  assert.deepStrictEqual(colorBBox, { x: 2, y: 1, w: 5, h: 3 });
});
