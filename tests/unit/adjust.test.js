import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAdjust,
  applyFilterPreset,
  resetAllAdjust,
  cssFilterString,
  softwareApply,
  ADJUST_RANGES,
} from '../../js/ops/adjust.js';

// Helper: minimal ImageState carrying the fields the adjust ops touch.
function makeImageState() {
  return {
    adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filterPreset: 'none',
    baseDirty: false,
    overlaysDirty: false,
  };
}

// --------------------------------------------------------------------------
// applyAdjust
// --------------------------------------------------------------------------

test('applyAdjust: brightness 50 is stored', () => {
  const img = makeImageState();
  applyAdjust(img, 'brightness', 50);
  assert.equal(img.adjust.brightness, 50);
});

test('applyAdjust: contrast -30 is stored', () => {
  const img = makeImageState();
  applyAdjust(img, 'contrast', -30);
  assert.equal(img.adjust.contrast, -30);
});

test('applyAdjust: saturation 0 is stored (no-op valid value)', () => {
  const img = makeImageState();
  applyAdjust(img, 'saturation', 25);
  applyAdjust(img, 'saturation', 0);
  assert.equal(img.adjust.saturation, 0);
});

test('applyAdjust: blur 10 is stored', () => {
  const img = makeImageState();
  applyAdjust(img, 'blur', 10);
  assert.equal(img.adjust.blur, 10);
});

test('applyAdjust: out-of-range high brightness (200) clamps to 100', () => {
  const img = makeImageState();
  applyAdjust(img, 'brightness', 200);
  assert.equal(img.adjust.brightness, 100);
});

test('applyAdjust: out-of-range low contrast (-500) clamps to -100', () => {
  const img = makeImageState();
  applyAdjust(img, 'contrast', -500);
  assert.equal(img.adjust.contrast, -100);
});

test('applyAdjust: blur clamps to [0, 50] — 80 → 50', () => {
  const img = makeImageState();
  applyAdjust(img, 'blur', 80);
  assert.equal(img.adjust.blur, 50);
});

test('applyAdjust: blur clamps to [0, 50] — negative → 0', () => {
  const img = makeImageState();
  applyAdjust(img, 'blur', -5);
  assert.equal(img.adjust.blur, 0);
});

test('applyAdjust: unknown key is a no-op', () => {
  const img = makeImageState();
  applyAdjust(img, 'bogus', 50);
  assert.deepStrictEqual(img.adjust, { brightness: 0, contrast: 0, saturation: 0, blur: 0 });
});

test('applyAdjust: non-finite value snaps to 0', () => {
  const img = makeImageState();
  applyAdjust(img, 'brightness', 'not-a-number');
  assert.equal(img.adjust.brightness, 0);
  applyAdjust(img, 'contrast', NaN);
  assert.equal(img.adjust.contrast, 0);
});

test('applyAdjust does NOT set baseDirty (CSS-filter preview)', () => {
  const img = makeImageState();
  applyAdjust(img, 'brightness', 50);
  assert.equal(img.baseDirty, false);
});

test('applyAdjust: null imageState is a no-op (defensive)', () => {
  applyAdjust(null, 'brightness', 50);
  assert.ok(true);
});

// --------------------------------------------------------------------------
// applyFilterPreset
// --------------------------------------------------------------------------

test('applyFilterPreset: "grayscale" is accepted', () => {
  const img = makeImageState();
  applyFilterPreset(img, 'grayscale');
  assert.equal(img.filterPreset, 'grayscale');
});

test('applyFilterPreset: "sepia" is accepted', () => {
  const img = makeImageState();
  applyFilterPreset(img, 'sepia');
  assert.equal(img.filterPreset, 'sepia');
});

test('applyFilterPreset: "invert" is accepted', () => {
  const img = makeImageState();
  applyFilterPreset(img, 'invert');
  assert.equal(img.filterPreset, 'invert');
});

test('applyFilterPreset: "none" is accepted', () => {
  const img = makeImageState();
  applyFilterPreset(img, 'grayscale');
  applyFilterPreset(img, 'none');
  assert.equal(img.filterPreset, 'none');
});

test('applyFilterPreset: unknown value falls back to "none"', () => {
  const img = makeImageState();
  applyFilterPreset(img, 'bogus');
  assert.equal(img.filterPreset, 'none');
});

test('applyFilterPreset does NOT set baseDirty (CSS-filter preview)', () => {
  const img = makeImageState();
  applyFilterPreset(img, 'grayscale');
  assert.equal(img.baseDirty, false);
});

test('applyFilterPreset: null imageState is a no-op', () => {
  applyFilterPreset(null, 'sepia');
  assert.ok(true);
});

// --------------------------------------------------------------------------
// resetAllAdjust
// --------------------------------------------------------------------------

test('resetAllAdjust zeroes all four adjust values and clears preset', () => {
  const img = makeImageState();
  img.adjust.brightness = 50;
  img.adjust.contrast = -30;
  img.adjust.saturation = 80;
  img.adjust.blur = 10;
  img.filterPreset = 'sepia';
  resetAllAdjust(img);
  assert.deepStrictEqual(img.adjust, { brightness: 0, contrast: 0, saturation: 0, blur: 0 });
  assert.equal(img.filterPreset, 'none');
});

test('resetAllAdjust: null imageState is a no-op', () => {
  resetAllAdjust(null);
  assert.ok(true);
});

// --------------------------------------------------------------------------
// cssFilterString
// --------------------------------------------------------------------------

test('cssFilterString: empty adjust + "none" preset returns "none"', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
  assert.equal(cssFilterString(adjust, 'none'), 'none');
});

test('cssFilterString: brightness 50 → "brightness(1.5)"', () => {
  const adjust = { brightness: 50, contrast: 0, saturation: 0, blur: 0 };
  assert.equal(cssFilterString(adjust, 'none'), 'brightness(1.5)');
});

test('cssFilterString: negative brightness -50 → "brightness(0.5)"', () => {
  const adjust = { brightness: -50, contrast: 0, saturation: 0, blur: 0 };
  assert.equal(cssFilterString(adjust, 'none'), 'brightness(0.5)');
});

test('cssFilterString: contrast 25 → "contrast(1.25)"', () => {
  const adjust = { brightness: 0, contrast: 25, saturation: 0, blur: 0 };
  assert.equal(cssFilterString(adjust, 'none'), 'contrast(1.25)');
});

test('cssFilterString: saturation -50 → "saturate(0.5)"', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: -50, blur: 0 };
  assert.equal(cssFilterString(adjust, 'none'), 'saturate(0.5)');
});

test('cssFilterString: blur 5 → "blur(5px)"', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 5 };
  assert.equal(cssFilterString(adjust, 'none'), 'blur(5px)');
});

test('cssFilterString: composes preset + adjustments in documented order (preset first)', () => {
  const adjust = { brightness: 10, contrast: 20, saturation: 30, blur: 2 };
  const out = cssFilterString(adjust, 'sepia');
  // sepia(1) brightness(1.1) contrast(1.2) saturate(1.3) blur(2px)
  assert.equal(out, 'sepia(1) brightness(1.1) contrast(1.2) saturate(1.3) blur(2px)');
});

test('cssFilterString: grayscale preset prepended', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
  assert.equal(cssFilterString(adjust, 'grayscale'), 'grayscale(1)');
});

test('cssFilterString: invert preset prepended', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
  assert.equal(cssFilterString(adjust, 'invert'), 'invert(1)');
});

test('cssFilterString: blurPxForCurrentRender override uses override, not adjust.blur', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 20 };
  // Pass 5 as the display-scaled blur; should win over the 20-px source-space value.
  assert.equal(cssFilterString(adjust, 'none', 5), 'blur(5px)');
});

test('cssFilterString: blurPxForCurrentRender = 0 suppresses the blur term (no negative output)', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 20 };
  assert.equal(cssFilterString(adjust, 'none', 0), 'none');
});

test('cssFilterString: undefined override falls back to adjust.blur', () => {
  const adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 10 };
  assert.equal(cssFilterString(adjust, 'none', undefined), 'blur(10px)');
});

// --------------------------------------------------------------------------
// softwareApply
// --------------------------------------------------------------------------

function makeImageData(pixels) {
  // pixels is an array of { r, g, b, a }. Returns a {data, width, height}
  // mock conforming to the subset of ImageData the code touches.
  const data = new Uint8ClampedArray(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    data[i * 4]     = pixels[i].r;
    data[i * 4 + 1] = pixels[i].g;
    data[i * 4 + 2] = pixels[i].b;
    data[i * 4 + 3] = pixels[i].a ?? 255;
  }
  return { data, width: pixels.length, height: 1 };
}

test('softwareApply: brightness +50 on mid-gray (128) pushes value up by ~128', () => {
  const img = makeImageData([{ r: 128, g: 128, b: 128 }]);
  softwareApply(img, { brightness: 50, contrast: 0, saturation: 0, blur: 0 }, 'none');
  // 128 + 0.5 * 255 = 255.5 → clamped to 255.
  assert.equal(img.data[0], 255);
  assert.equal(img.data[1], 255);
  assert.equal(img.data[2], 255);
});

test('softwareApply: brightness -50 on mid-gray darkens by ~128', () => {
  const img = makeImageData([{ r: 128, g: 128, b: 128 }]);
  softwareApply(img, { brightness: -50, contrast: 0, saturation: 0, blur: 0 }, 'none');
  // 128 - 0.5 * 255 = 0.5 → clamped to 0 (Uint8ClampedArray clamps via floor).
  assert.ok(img.data[0] <= 1);
});

test('softwareApply: grayscale on a red pixel produces equal R=G=B', () => {
  const img = makeImageData([{ r: 200, g: 50, b: 50 }]);
  softwareApply(img, { brightness: 0, contrast: 0, saturation: 0, blur: 0 }, 'grayscale');
  assert.equal(img.data[0], img.data[1]);
  assert.equal(img.data[1], img.data[2]);
});

test('softwareApply: invert flips white → black', () => {
  const img = makeImageData([{ r: 255, g: 255, b: 255 }]);
  softwareApply(img, { brightness: 0, contrast: 0, saturation: 0, blur: 0 }, 'invert');
  assert.equal(img.data[0], 0);
  assert.equal(img.data[1], 0);
  assert.equal(img.data[2], 0);
});

test('softwareApply: invert flips black → white', () => {
  const img = makeImageData([{ r: 0, g: 0, b: 0 }]);
  softwareApply(img, { brightness: 0, contrast: 0, saturation: 0, blur: 0 }, 'invert');
  assert.equal(img.data[0], 255);
  assert.equal(img.data[1], 255);
  assert.equal(img.data[2], 255);
});

test('softwareApply: sepia tints toward warm hues (red > green > blue)', () => {
  const img = makeImageData([{ r: 128, g: 128, b: 128 }]);
  softwareApply(img, { brightness: 0, contrast: 0, saturation: 0, blur: 0 }, 'sepia');
  // Classic CSS sepia: nr=0.393*128+0.769*128+0.189*128 ≈ 173 → clamped to 173.
  // ng ≈ 153, nb ≈ 119. So r > g > b.
  assert.ok(img.data[0] > img.data[1]);
  assert.ok(img.data[1] > img.data[2]);
});

test('softwareApply: contrast 100 on mid-gray stays at 128 (pivot point)', () => {
  const img = makeImageData([{ r: 128, g: 128, b: 128 }]);
  softwareApply(img, { brightness: 0, contrast: 100, saturation: 0, blur: 0 }, 'none');
  // (128 - 128) * 2 + 128 = 128. Mid-gray is the pivot.
  assert.equal(img.data[0], 128);
});

test('softwareApply: contrast 100 on bright pixel pushes toward white', () => {
  const img = makeImageData([{ r: 200, g: 200, b: 200 }]);
  softwareApply(img, { brightness: 0, contrast: 100, saturation: 0, blur: 0 }, 'none');
  // (200 - 128) * 2 + 128 = 272 → clamped to 255.
  assert.equal(img.data[0], 255);
});

test('softwareApply: clamps values to [0, 255]', () => {
  const img = makeImageData([{ r: 250, g: 250, b: 250 }]);
  softwareApply(img, { brightness: 100, contrast: 0, saturation: 0, blur: 0 }, 'none');
  for (let i = 0; i < 3; i++) {
    assert.ok(img.data[i] >= 0 && img.data[i] <= 255, `channel ${i} out of range: ${img.data[i]}`);
  }
});

test('softwareApply: saturation -100 on coloured pixel collapses to grayscale (R=G=B)', () => {
  const img = makeImageData([{ r: 200, g: 50, b: 50 }]);
  softwareApply(img, { brightness: 0, contrast: 0, saturation: -100, blur: 0 }, 'none');
  // s = 0 → r = g = b = luma.
  assert.equal(img.data[0], img.data[1]);
  assert.equal(img.data[1], img.data[2]);
});

test('softwareApply: small gradient stays in range on roundtrip', () => {
  // Synthetic 10-px gradient, run through a few effects, verify all channels in range.
  const pixels = [];
  for (let i = 0; i < 10; i++) pixels.push({ r: i * 25, g: 255 - i * 25, b: 128 });
  const img = makeImageData(pixels);
  softwareApply(img, { brightness: 10, contrast: 20, saturation: -30, blur: 0 }, 'sepia');
  for (let i = 0; i < img.data.length; i++) {
    assert.ok(img.data[i] >= 0 && img.data[i] <= 255);
  }
});

// --------------------------------------------------------------------------
// ADJUST_RANGES (re-exported constant)
// --------------------------------------------------------------------------

test('ADJUST_RANGES exposes all four sliders with correct bounds', () => {
  assert.deepStrictEqual(ADJUST_RANGES.brightness, { min: -100, max: 100 });
  assert.deepStrictEqual(ADJUST_RANGES.contrast,   { min: -100, max: 100 });
  assert.deepStrictEqual(ADJUST_RANGES.saturation, { min: -100, max: 100 });
  assert.deepStrictEqual(ADJUST_RANGES.blur,       { min: 0,    max: 50  });
});

test('ADJUST_RANGES is frozen (constant)', () => {
  assert.equal(Object.isFrozen(ADJUST_RANGES), true);
});
