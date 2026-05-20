import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChromakey,
  setChromakeyMask,
  buildChromakeyMask,
  normalizeHex,
  pixelToHex,
} from '../../js/ops/chromakey.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeImageState() {
  return {
    source: { width: 0, height: 0 },
    chromakey: null,
    chromakeyMask: null,
    baseDirty: false,
    overlaysDirty: false,
  };
}

// Build an ImageData-shaped duck (width, height, Uint8ClampedArray data).
// buildChromakeyMask only reads these three properties, so this is sufficient
// without needing a DOM ImageData polyfill in Node.
function makeImageDataLike(pixels) {
  // pixels is an array of [r, g, b, a] tuples, one per pixel.
  const data = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    data[i * 4]     = pixels[i][0];
    data[i * 4 + 1] = pixels[i][1];
    data[i * 4 + 2] = pixels[i][2];
    data[i * 4 + 3] = pixels[i][3] ?? 255;
  }
  return { width: pixels.length, height: 1, data };
}

// --------------------------------------------------------------------------
// normalizeHex
// --------------------------------------------------------------------------

test('normalizeHex: short form "#abc" → "#AABBCC"', () => {
  assert.equal(normalizeHex('#abc'), '#AABBCC');
});

test('normalizeHex: full form without hash "FFFFFF" → "#FFFFFF"', () => {
  assert.equal(normalizeHex('FFFFFF'), '#FFFFFF');
});

test('normalizeHex: invalid input "garbage" → "#000000" (fallback)', () => {
  assert.equal(normalizeHex('garbage'), '#000000');
});

test('normalizeHex: trims surrounding whitespace', () => {
  assert.equal(normalizeHex('  #00ff00  '), '#00FF00');
});

test('normalizeHex: null → "#000000"', () => {
  assert.equal(normalizeHex(null), '#000000');
});

test('normalizeHex: empty string → "#000000"', () => {
  assert.equal(normalizeHex(''), '#000000');
});

test('normalizeHex: mixed case "#aB12cD" → "#AB12CD"', () => {
  assert.equal(normalizeHex('#aB12cD'), '#AB12CD');
});

test('normalizeHex: short form with invalid hex digit "#xyz" → "#000000"', () => {
  assert.equal(normalizeHex('#xyz'), '#000000');
});

test('normalizeHex: too-short input "#ab" → "#000000"', () => {
  assert.equal(normalizeHex('#ab'), '#000000');
});

// --------------------------------------------------------------------------
// pixelToHex
// --------------------------------------------------------------------------

test('pixelToHex(255, 0, 0) → "#FF0000"', () => {
  assert.equal(pixelToHex(255, 0, 0), '#FF0000');
});

test('pixelToHex(0, 0, 0) → "#000000"', () => {
  assert.equal(pixelToHex(0, 0, 0), '#000000');
});

test('pixelToHex(255, 255, 255) → "#FFFFFF"', () => {
  assert.equal(pixelToHex(255, 255, 255), '#FFFFFF');
});

test('pixelToHex rounds floats', () => {
  assert.equal(pixelToHex(127.6, 127.4, 0), '#807F00');
});

test('pixelToHex clamps out-of-range values', () => {
  assert.equal(pixelToHex(-1, 999, 256), '#00FFFF');
});

// --------------------------------------------------------------------------
// applyChromakey
// --------------------------------------------------------------------------

test('applyChromakey(state, null) clears chromakey + mask, sets baseDirty', () => {
  const img = makeImageState();
  img.chromakey = { hex: '#FF0000', tolerance: 25 };
  img.chromakeyMask = new Uint8Array([0, 0, 255, 255]);
  applyChromakey(img, null);
  assert.equal(img.chromakey, null);
  assert.equal(img.chromakeyMask, null);
  assert.equal(img.baseDirty, true);
});

test('applyChromakey stores normalized hex and clamped tolerance, sets baseDirty', () => {
  const img = makeImageState();
  applyChromakey(img, { hex: '#000', tolerance: 25 });
  assert.deepStrictEqual(img.chromakey, { hex: '#000000', tolerance: 25 });
  assert.equal(img.baseDirty, true);
});

test('applyChromakey: bad hex falls back to "#000000"', () => {
  // 'xyz' is 3 chars but x/y/z aren't hex digits → fall back.
  const img = makeImageState();
  applyChromakey(img, { hex: 'xyz', tolerance: 50 });
  assert.equal(img.chromakey.hex, '#000000');
  assert.equal(img.chromakey.tolerance, 50);
});

test('applyChromakey: tolerance > 100 clamps to 100', () => {
  const img = makeImageState();
  applyChromakey(img, { hex: '#000', tolerance: 150 });
  assert.equal(img.chromakey.tolerance, 100);
});

test('applyChromakey: tolerance < 0 clamps to 0', () => {
  const img = makeImageState();
  applyChromakey(img, { hex: '#000', tolerance: -20 });
  assert.equal(img.chromakey.tolerance, 0);
});

test('applyChromakey: non-finite tolerance becomes 0', () => {
  const img = makeImageState();
  applyChromakey(img, { hex: '#000', tolerance: NaN });
  assert.equal(img.chromakey.tolerance, 0);
});

test('applyChromakey: null imageState is a no-op (defensive)', () => {
  applyChromakey(null, { hex: '#000', tolerance: 25 });
  assert.ok(true);
});

test('applyChromakey: setting params does not pre-populate chromakeyMask', () => {
  // Mask is built separately by buildChromakeyMask + setChromakeyMask. So
  // applyChromakey alone leaves chromakeyMask null.
  const img = makeImageState();
  applyChromakey(img, { hex: '#000', tolerance: 25 });
  assert.equal(img.chromakeyMask, null);
});

// --------------------------------------------------------------------------
// setChromakeyMask
// --------------------------------------------------------------------------

test('setChromakeyMask stores the Uint8Array and sets baseDirty', () => {
  const img = makeImageState();
  const mask = new Uint8Array([0, 128, 255]);
  setChromakeyMask(img, mask);
  assert.strictEqual(img.chromakeyMask, mask);
  assert.equal(img.baseDirty, true);
});

test('setChromakeyMask(null) clears the mask and sets baseDirty', () => {
  const img = makeImageState();
  img.chromakeyMask = new Uint8Array([0, 0, 0]);
  setChromakeyMask(img, null);
  assert.equal(img.chromakeyMask, null);
  assert.equal(img.baseDirty, true);
});

test('setChromakeyMask: null imageState is a no-op', () => {
  setChromakeyMask(null, new Uint8Array([0]));
  assert.ok(true);
});

// --------------------------------------------------------------------------
// buildChromakeyMask: 4-pixel strip [black, dark-gray, red, white], target #000
// dist(black)=0, dist(dark-gray)≈51.96, dist(red)=255, dist(white)≈441
// --------------------------------------------------------------------------

const STRIP = [
  [0, 0, 0],       // black: dist 0
  [30, 30, 30],    // dark-gray: dist ~52
  [255, 0, 0],     // red: dist 255
  [255, 255, 255], // white: dist 441
];

// NOTE: tolerance scale is slider 0..100 → rawTol 0..160 (1.6× multiplier).
// dist(dark-gray (30,30,30) from black) ≈ 51.96, so boundaries are picked
// to land just below or just above that distance under the new scale.

test('buildChromakeyMask: 4-pixel strip, target #000, tol=10 → only black is transparent', () => {
  // rawTol=16, softness=4 → upper band 20. dist(dark-gray)≈52 > 20 → 255.
  const id = makeImageDataLike(STRIP);
  const mask = buildChromakeyMask(id, '#000000', 10);
  assert.equal(mask[0], 0);   // black
  assert.equal(mask[1], 255); // dark-gray
  assert.equal(mask[2], 255); // red
  assert.equal(mask[3], 255); // white
});

test('buildChromakeyMask: 4-pixel strip, tol=20 — dark-gray still out of band', () => {
  // rawTol=32, softness=8 → upper band 40. dist(dark-gray)≈52 > 40 → 255.
  const id = makeImageDataLike(STRIP);
  const mask = buildChromakeyMask(id, '#000000', 20);
  assert.equal(mask[0], 0);
  assert.equal(mask[1], 255);
  assert.equal(mask[2], 255);
  assert.equal(mask[3], 255);
});

test('buildChromakeyMask: 4-pixel strip, tol=25 — dark-gray still out of band', () => {
  // rawTol=40, softness=10 → upper band 50. dist(dark-gray)≈51.96 > 50 → 255.
  const id = makeImageDataLike(STRIP);
  const mask = buildChromakeyMask(id, '#000000', 25);
  assert.equal(mask[0], 0);
  assert.equal(mask[1], 255);
  assert.equal(mask[2], 255);
  assert.equal(mask[3], 255);
});

test('buildChromakeyMask: 4-pixel strip, tol=35 — dark-gray inside core (transparent)', () => {
  // rawTol=56, softness=14. dist(dark-gray)≈51.96 < 56 → 0.
  const id = makeImageDataLike(STRIP);
  const mask = buildChromakeyMask(id, '#000000', 35);
  assert.equal(mask[0], 0);
  assert.equal(mask[1], 0);   // dark-gray now matches
  assert.equal(mask[2], 255); // red still kept
  assert.equal(mask[3], 255); // white still kept
});

test('buildChromakeyMask: tol=0 — only exact target color matches', () => {
  // rawTol=0, softness=0. Only the exact match (dist=0) → 0; everything else → 255.
  const pixels = [
    [0, 0, 0],   // exact match
    [1, 0, 0],   // dist 1
    [10, 0, 0],  // dist 10
  ];
  const id = makeImageDataLike(pixels);
  const mask = buildChromakeyMask(id, '#000000', 0);
  assert.equal(mask[0], 0);
  assert.equal(mask[1], 255);
  assert.equal(mask[2], 255);
});

// --------------------------------------------------------------------------
// Soft-edge band: at tol=100 we have rawTol=160, softness=40 (max band: 200).
// Sample distances 160 / 180 / 200 should give 0 / ~128 / 255.
// --------------------------------------------------------------------------

test('buildChromakeyMask: soft band — pixel exactly at rawTol → 0 (matches)', () => {
  // tol=100, target #000. Pixel (160, 0, 0) has dist 160 == rawTol → mask 0.
  const id = makeImageDataLike([[160, 0, 0]]);
  const mask = buildChromakeyMask(id, '#000000', 100);
  assert.equal(mask[0], 0);
});

test('buildChromakeyMask: soft band — pixel at rawTol+softness/2 → ~128', () => {
  // tol=100, target #000. Pixel (180, 0, 0) has dist 180 → ramp midpoint → 128.
  const id = makeImageDataLike([[180, 0, 0]]);
  const mask = buildChromakeyMask(id, '#000000', 100);
  assert.ok(Math.abs(mask[0] - 128) <= 1, `expected ~128, got ${mask[0]}`);
});

test('buildChromakeyMask: soft band — pixel at rawTol+softness → 255 (kept)', () => {
  // tol=100, target #000. Pixel (200, 0, 0) has dist 200 == rawTol+softness → 255.
  const id = makeImageDataLike([[200, 0, 0]]);
  const mask = buildChromakeyMask(id, '#000000', 100);
  assert.equal(mask[0], 255);
});

// --------------------------------------------------------------------------
// Edge cases on buildChromakeyMask
// --------------------------------------------------------------------------

test('buildChromakeyMask: mask length equals width*height', () => {
  const pixels = Array.from({ length: 12 }, () => [0, 0, 0]);
  const id = { width: 4, height: 3, data: new Uint8ClampedArray(48) };
  for (let i = 0; i < 12; i++) {
    id.data[i * 4]     = pixels[i][0];
    id.data[i * 4 + 1] = pixels[i][1];
    id.data[i * 4 + 2] = pixels[i][2];
    id.data[i * 4 + 3] = 255;
  }
  const mask = buildChromakeyMask(id, '#000000', 25);
  assert.equal(mask.length, 12);
});

test('buildChromakeyMask: returns Uint8Array (not regular array)', () => {
  const id = makeImageDataLike([[0, 0, 0]]);
  const mask = buildChromakeyMask(id, '#000000', 25);
  assert.ok(mask instanceof Uint8Array);
});

test('buildChromakeyMask: hex normalization applied to the target color', () => {
  // '#fff' should match white pixels.
  const id = makeImageDataLike([[255, 255, 255], [0, 0, 0]]);
  const mask = buildChromakeyMask(id, '#fff', 10);
  assert.equal(mask[0], 0);   // white matches
  assert.equal(mask[1], 255); // black does not
});

test('buildChromakeyMask: invalid hex defaults to "#000000" target', () => {
  const id = makeImageDataLike([[0, 0, 0], [255, 255, 255]]);
  const mask = buildChromakeyMask(id, 'garbage', 10);
  assert.equal(mask[0], 0);   // black matches (because fallback is #000000)
  assert.equal(mask[1], 255); // white doesn't
});

test('buildChromakeyMask: tolerance clamped — negative behaves like 0', () => {
  const id = makeImageDataLike([[0, 0, 0], [5, 0, 0]]);
  const mask = buildChromakeyMask(id, '#000000', -50);
  assert.equal(mask[0], 0);   // exact only
  assert.equal(mask[1], 255);
});
