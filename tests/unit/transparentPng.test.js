// tests/unit/transparentPng.test.js — v1.3 Feature 16 (transparent PNG tools).
//
// Covers parseColor + replaceTransparentImageData. padCanvas + replaceTransparent
// touch real canvas APIs (drawImage, getImageData, fillStyle), which Node
// doesn't have. Those paths are exercised by browser specs; here we lean on
// the pure ImageData-shaped duck pattern already used by trim.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseColor,
  replaceTransparentImageData,
} from '../../js/ops/transparentPng.js';

// Build an ImageData-shaped duck.
function makeImageData(width, height, fillRgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fillRgba) {
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      data[i]     = fillRgba[0];
      data[i + 1] = fillRgba[1];
      data[i + 2] = fillRgba[2];
      data[i + 3] = fillRgba[3];
    }
  }
  return { width, height, data };
}

// --------------------------------------------------------------------------
// parseColor
// --------------------------------------------------------------------------

test('parseColor: #rrggbb hex returns r,g,b,a=255', () => {
  assert.deepStrictEqual(parseColor('#ff0000'), { r: 255, g: 0,   b: 0,   a: 255 });
  assert.deepStrictEqual(parseColor('#00ff00'), { r: 0,   g: 255, b: 0,   a: 255 });
  assert.deepStrictEqual(parseColor('#0000ff'), { r: 0,   g: 0,   b: 255, a: 255 });
});

test('parseColor: #rgb shorthand expands correctly', () => {
  assert.deepStrictEqual(parseColor('#f00'), { r: 255, g: 0,   b: 0,   a: 255 });
  assert.deepStrictEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 255 });
});

test('parseColor: #rrggbbaa hex returns r,g,b,a', () => {
  assert.deepStrictEqual(parseColor('#ff000080'), { r: 255, g: 0, b: 0, a: 128 });
});

test('parseColor: rgb() and rgba() are parsed', () => {
  assert.deepStrictEqual(parseColor('rgb(10, 20, 30)'),         { r: 10, g: 20, b: 30, a: 255 });
  assert.deepStrictEqual(parseColor('rgba(10, 20, 30, 0.5)'),   { r: 10, g: 20, b: 30, a: 128 });
  assert.deepStrictEqual(parseColor('rgba(10, 20, 30, 1)'),     { r: 10, g: 20, b: 30, a: 255 });
});

test('parseColor: named colors are recognized', () => {
  assert.deepStrictEqual(parseColor('white'),       { r: 255, g: 255, b: 255, a: 255 });
  assert.deepStrictEqual(parseColor('black'),       { r: 0,   g: 0,   b: 0,   a: 255 });
  assert.deepStrictEqual(parseColor('red'),         { r: 255, g: 0,   b: 0,   a: 255 });
  assert.deepStrictEqual(parseColor('transparent'), { r: 0,   g: 0,   b: 0,   a: 0   });
});

test('parseColor: empty / invalid input throws', () => {
  assert.throws(() => parseColor(''));
  assert.throws(() => parseColor('not a color'));
  assert.throws(() => parseColor('#zzzzzz'));
  assert.throws(() => parseColor(null));
});

// --------------------------------------------------------------------------
// replaceTransparentImageData
// --------------------------------------------------------------------------

test('replaceTransparentImageData: fully-transparent pixels become opaque color', () => {
  const img = makeImageData(4, 4, [0, 0, 0, 0]);
  replaceTransparentImageData(img, { color: '#ff0000', threshold: 0.01 });
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i],     255);
    assert.equal(img.data[i + 1], 0);
    assert.equal(img.data[i + 2], 0);
    assert.equal(img.data[i + 3], 255);
  }
});

test('replaceTransparentImageData: opaque pixels are left alone', () => {
  const img = makeImageData(2, 2, [10, 20, 30, 255]);
  replaceTransparentImageData(img, { color: '#ffffff', threshold: 0.5 });
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i],     10);
    assert.equal(img.data[i + 1], 20);
    assert.equal(img.data[i + 2], 30);
    assert.equal(img.data[i + 3], 255);
  }
});

test('replaceTransparentImageData: threshold gates which pixels get replaced', () => {
  // Half pixels at alpha 50 (≈ 0.196), half at 200 (≈ 0.784).
  const img = makeImageData(2, 1, [128, 128, 128, 0]);
  img.data[3]     = 50;   // pixel 0 → below threshold 0.3 (76.5)
  img.data[7]     = 200;  // pixel 1 → above threshold
  replaceTransparentImageData(img, { color: 'white', threshold: 0.3 });
  // Pixel 0 should now be opaque white.
  assert.equal(img.data[0], 255);
  assert.equal(img.data[3], 255);
  // Pixel 1 should be untouched.
  assert.equal(img.data[4], 128);
  assert.equal(img.data[7], 200);
});

test('replaceTransparentImageData: threshold 0 only touches strictly-zero alpha', () => {
  const img = makeImageData(2, 1, [0, 0, 0, 0]);
  img.data[3] = 0;  // pixel 0: a=0 → 0 < 0 is FALSE; stays
  img.data[7] = 1;  // pixel 1: a=1 → also stays
  replaceTransparentImageData(img, { color: 'red', threshold: 0 });
  // Both pixels untouched at threshold 0 (predicate is strict <).
  assert.equal(img.data[0], 0);
  assert.equal(img.data[3], 0);
  assert.equal(img.data[4], 0);
  assert.equal(img.data[7], 1);
});

test('replaceTransparentImageData: threshold clamped to [0,1]', () => {
  // threshold above 1 is clamped; everything below 255*1 = 255 (i.e. anything
  // not fully opaque) becomes the replacement color.
  const img = makeImageData(2, 1, [0, 0, 0, 254]);
  img.data[7] = 255;  // pixel 1 fully opaque
  replaceTransparentImageData(img, { color: '#00ff00', threshold: 5 });
  // Pixel 0 was 254 → < 255 cutoff → replaced.
  assert.equal(img.data[1], 255);
  assert.equal(img.data[3], 255);
  // Pixel 1 was 255 → NOT < 255 → untouched.
  assert.equal(img.data[4], 0);
  assert.equal(img.data[5], 0);
  assert.equal(img.data[6], 0);
  assert.equal(img.data[7], 255);
});

test('replaceTransparentImageData: missing color throws', () => {
  const img = makeImageData(1, 1, [0, 0, 0, 0]);
  assert.throws(() => replaceTransparentImageData(img, { threshold: 0.5 }));
});

test('replaceTransparentImageData: missing imageData throws', () => {
  assert.throws(() => replaceTransparentImageData(null, { color: '#fff' }));
});
