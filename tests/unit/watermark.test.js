// tests/unit/watermark.test.js — pure-math tests for Feature #12 (Watermark).
//
// Covers positionToFractions + computeWatermarkRect. applyWatermark touches
// real canvas APIs (drawImage, fillText, rotate); that path is exercised by
// smoke tests in the browser. Here we lean on the same posture as
// transparentPng.test.js — pure functions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  positionToFractions,
  computeWatermarkRect,
  POSITION_PRESETS,
  applyWatermark,
} from '../../js/ops/watermark.js';

// --------------------------------------------------------------------------
// positionToFractions
// --------------------------------------------------------------------------

test('positionToFractions: returns correct anchors for all 9 preset positions', () => {
  assert.deepStrictEqual(positionToFractions('top-left'),     { fx: 0,   fy: 0   });
  assert.deepStrictEqual(positionToFractions('top'),          { fx: 0.5, fy: 0   });
  assert.deepStrictEqual(positionToFractions('top-right'),    { fx: 1,   fy: 0   });
  assert.deepStrictEqual(positionToFractions('left'),         { fx: 0,   fy: 0.5 });
  assert.deepStrictEqual(positionToFractions('center'),       { fx: 0.5, fy: 0.5 });
  assert.deepStrictEqual(positionToFractions('right'),        { fx: 1,   fy: 0.5 });
  assert.deepStrictEqual(positionToFractions('bottom-left'),  { fx: 0,   fy: 1   });
  assert.deepStrictEqual(positionToFractions('bottom'),       { fx: 0.5, fy: 1   });
  assert.deepStrictEqual(positionToFractions('bottom-right'), { fx: 1,   fy: 1   });
});

test('positionToFractions: returns null for tiled / custom / unknown values', () => {
  assert.strictEqual(positionToFractions('tiled'), null);
  assert.strictEqual(positionToFractions('custom'), null);
  assert.strictEqual(positionToFractions('something-else'), null);
  assert.strictEqual(positionToFractions(''), null);
  assert.strictEqual(positionToFractions(null), null);
});

test('POSITION_PRESETS: exposes the 9 grid positions plus tiled', () => {
  assert.equal(POSITION_PRESETS.length, 10);
  assert.ok(POSITION_PRESETS.includes('top-left'));
  assert.ok(POSITION_PRESETS.includes('center'));
  assert.ok(POSITION_PRESETS.includes('bottom-right'));
  assert.ok(POSITION_PRESETS.includes('tiled'));
});

// --------------------------------------------------------------------------
// computeWatermarkRect — text type
// --------------------------------------------------------------------------

test('computeWatermarkRect (text): scale × long edge produces expected font size', () => {
  // 1000-wide, scale 0.05 → 50px font height.
  const rect = computeWatermarkRect({
    canvasWidth: 1000,
    canvasHeight: 800,
    watermark: {
      enabled: true, type: 'text', text: 'A',
      position: 'top-left', scale: 0.05, opacity: 1,
    },
    measureWidth: (_text, fontSize) => fontSize * 0.5, // mock single-char
  });
  assert.equal(rect.height, 50);
  assert.equal(rect.width, 25); // 50 × 0.5
});

test('computeWatermarkRect (text): tall canvas uses height as long edge', () => {
  // 400×1000 → long edge 1000, scale 0.10 → 100px.
  const rect = computeWatermarkRect({
    canvasWidth: 400,
    canvasHeight: 1000,
    watermark: { enabled: true, type: 'text', text: 'X', position: 'center', scale: 0.10 },
    measureWidth: (_t, fs) => fs * 0.5,
  });
  assert.equal(rect.height, 100);
});

// --------------------------------------------------------------------------
// computeWatermarkRect — image type
// --------------------------------------------------------------------------

test('computeWatermarkRect (image): respects landscape aspect ratio', () => {
  // 1000 × 800 canvas; scale 0.20 → long edge 200; aspect 2 (wide) → 200×100.
  const rect = computeWatermarkRect({
    canvasWidth: 1000,
    canvasHeight: 800,
    watermark: { enabled: true, type: 'image', position: 'top-left', scale: 0.20 },
    imageAspect: 2,
  });
  assert.equal(rect.width, 200);
  assert.equal(rect.height, 100);
});

test('computeWatermarkRect (image): respects portrait aspect ratio', () => {
  // 1000 × 800 canvas; scale 0.20 → long edge 200; aspect 0.5 (tall) → 100×200.
  const rect = computeWatermarkRect({
    canvasWidth: 1000,
    canvasHeight: 800,
    watermark: { enabled: true, type: 'image', position: 'top-left', scale: 0.20 },
    imageAspect: 0.5,
  });
  assert.equal(rect.width, 100);
  assert.equal(rect.height, 200);
});

test('computeWatermarkRect (image): missing aspect falls back to a square', () => {
  const rect = computeWatermarkRect({
    canvasWidth: 1000,
    canvasHeight: 800,
    watermark: { enabled: true, type: 'image', position: 'top-left', scale: 0.20 },
    // no imageAspect
  });
  assert.equal(rect.width, rect.height);
  assert.equal(rect.width, 200);
});

// --------------------------------------------------------------------------
// computeWatermarkRect — position presets (image type for simple aspect math)
// --------------------------------------------------------------------------

const POS_FIXTURE = {
  canvasWidth: 1000,
  canvasHeight: 800,
  watermark: { enabled: true, type: 'image', scale: 0.10 }, // 100×50 wm
  imageAspect: 2,
};
// 1000 × 800 canvas; long edge 1000; scale 0.10 → wm long edge 100; aspect 2 → 100×50.
// Margin = 0.02 × 1000 = 20px.

test('computeWatermarkRect: top-left places wm at margin/margin', () => {
  const r = computeWatermarkRect({ ...POS_FIXTURE, watermark: { ...POS_FIXTURE.watermark, position: 'top-left' } });
  assert.equal(r.x, 20);
  assert.equal(r.y, 20);
  assert.equal(r.width, 100);
  assert.equal(r.height, 50);
});

test('computeWatermarkRect: top-right places wm flush-right with margin', () => {
  const r = computeWatermarkRect({ ...POS_FIXTURE, watermark: { ...POS_FIXTURE.watermark, position: 'top-right' } });
  // x = canvasW - width - margin = 1000 - 100 - 20 = 880
  assert.equal(r.x, 880);
  assert.equal(r.y, 20);
});

test('computeWatermarkRect: bottom-left places wm flush-bottom with margin', () => {
  const r = computeWatermarkRect({ ...POS_FIXTURE, watermark: { ...POS_FIXTURE.watermark, position: 'bottom-left' } });
  assert.equal(r.x, 20);
  // y = canvasH - height - margin = 800 - 50 - 20 = 730
  assert.equal(r.y, 730);
});

test('computeWatermarkRect: bottom-right places wm at far corner with margin', () => {
  const r = computeWatermarkRect({ ...POS_FIXTURE, watermark: { ...POS_FIXTURE.watermark, position: 'bottom-right' } });
  assert.equal(r.x, 880);
  assert.equal(r.y, 730);
});

test('computeWatermarkRect: center places wm centered on canvas', () => {
  const r = computeWatermarkRect({ ...POS_FIXTURE, watermark: { ...POS_FIXTURE.watermark, position: 'center' } });
  // x = (1000 - 100) / 2 = 450; y = (800 - 50) / 2 = 375
  assert.equal(r.x, 450);
  assert.equal(r.y, 375);
});

test('computeWatermarkRect: top edge centers horizontally with margin from top', () => {
  const r = computeWatermarkRect({ ...POS_FIXTURE, watermark: { ...POS_FIXTURE.watermark, position: 'top' } });
  assert.equal(r.x, 450);
  assert.equal(r.y, 20);
});

test('computeWatermarkRect: left edge centers vertically with margin from left', () => {
  const r = computeWatermarkRect({ ...POS_FIXTURE, watermark: { ...POS_FIXTURE.watermark, position: 'left' } });
  assert.equal(r.x, 20);
  assert.equal(r.y, 375);
});

// --------------------------------------------------------------------------
// computeWatermarkRect — tiled & custom
// --------------------------------------------------------------------------

test('computeWatermarkRect (tiled): returns one unit tile at origin (caller repeats)', () => {
  const r = computeWatermarkRect({
    canvasWidth: 1000,
    canvasHeight: 800,
    watermark: { enabled: true, type: 'image', position: 'tiled', scale: 0.10 },
    imageAspect: 2,
  });
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.width, 100);
  assert.equal(r.height, 50);
});

test('computeWatermarkRect (custom): centers wm on (customX, customY) fractions', () => {
  // 1000 × 800 canvas; wm 100×50; customX=0.4 → cx=400; customY=0.25 → cy=200.
  // x = 400 - 50 = 350; y = 200 - 25 = 175.
  const r = computeWatermarkRect({
    canvasWidth: 1000,
    canvasHeight: 800,
    watermark: {
      enabled: true, type: 'image', position: 'custom',
      scale: 0.10, customX: 0.4, customY: 0.25,
    },
    imageAspect: 2,
  });
  assert.equal(r.x, 350);
  assert.equal(r.y, 175);
});

test('computeWatermarkRect: unknown position falls back to center (no throw)', () => {
  const r = computeWatermarkRect({
    canvasWidth: 1000,
    canvasHeight: 800,
    watermark: { enabled: true, type: 'image', position: 'nonsense', scale: 0.10 },
    imageAspect: 2,
  });
  // Falls back to centered placement: (1000 - 100) / 2, (800 - 50) / 2.
  assert.equal(r.x, 450);
  assert.equal(r.y, 375);
});

// --------------------------------------------------------------------------
// applyWatermark — tiled grid stability under scale changes (Bug #16 regression)
// --------------------------------------------------------------------------
//
// Regression test for: dragging the scale slider from 30% to 28% used to
// shift the entire tile pattern to a completely different layout. Root cause
// was paintTiled computing cols from coverage and deriving startX as
// -((cols - 1) * stepX) / 2 — so when cols ticked over (e.g. 5 → 6), startX
// jumped by stepX/2 and the whole grid translated.
//
// The fix anchors the grid to the canvas center: tiles sit at xCenter = c *
// stepX for integer c, so c=0 is ALWAYS centered on the canvas regardless
// of step. We verify by spying on drawImage calls — at both scale=0.28 and
// scale=0.30, one of the tiles must land at the canvas center (in rotated
// coords, that's the local origin → after the ctx transform, it maps back
// to the canvas center).

// Minimal fake canvas context that records drawImage calls. We need just
// enough of the API for the watermark code path: save/restore/translate/
// rotate/drawImage/measureText/font/globalAlpha. We don't run any matrix
// math ourselves — we record the local-space rect each drawImage receives,
// then assert one of those is centered on (0, 0) in the tile's local frame
// (which paintTiled places at the canvas center).
function makeFakeCtx() {
  const drawCalls = [];
  return {
    drawCalls,
    globalAlpha: 1,
    font: '',
    fillStyle: '#000',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    measureText() { return { width: 10 }; },
    drawImage(_img, x, y, w, h) {
      drawCalls.push({ x, y, w, h });
    },
    fillText() {},
  };
}

// Fake bitmap with the dimensions paintTiled needs.
const FAKE_BITMAP = { width: 200, height: 200 };

test('applyWatermark (tiled): grid origin stays anchored when scale changes (no jumping)', () => {
  const cw = 1200, ch = 800;
  const baseWm = {
    enabled: true,
    type: 'image',
    position: 'tiled',
    opacity: 1,
    tiledAngle: -30,
    customX: 0.5, customY: 0.5,
    text: '',
    textFont: 'sans-serif',
    textColor: '#fff',
  };

  function runAt(scale) {
    const ctx = makeFakeCtx();
    applyWatermark(ctx, {
      canvasWidth: cw,
      canvasHeight: ch,
      watermark: { ...baseWm, scale },
      imageBitmap: FAKE_BITMAP,
    });
    return ctx.drawCalls;
  }

  const calls28 = runAt(0.28);
  const calls30 = runAt(0.30);

  // Each tile is rect{ x: xCenter - w/2, y: yCenter - h/2, w, h }. The c=0,
  // r=0 tile centers on the rotated-frame origin → x = -w/2, y = -h/2.
  // We just assert at least one drawImage call has |x + w/2| < epsilon AND
  // |y + h/2| < epsilon — i.e. the tile is centered on (0, 0) in local
  // coords. This holds at BOTH scales after the fix; before the fix, the
  // 28% and 30% grids could miss the center entirely (off by step/2).
  function hasCenteredTile(calls) {
    return calls.some(({ x, y, w, h }) => {
      return Math.abs(x + w / 2) < 0.5 && Math.abs(y + h / 2) < 0.5;
    });
  }

  assert.ok(calls28.length > 0, 'scale=0.28 should produce tile draws');
  assert.ok(calls30.length > 0, 'scale=0.30 should produce tile draws');
  assert.ok(hasCenteredTile(calls28), 'scale=0.28: a tile must be centered on the canvas center');
  assert.ok(hasCenteredTile(calls30), 'scale=0.30: a tile must be centered on the canvas center');
});

test('applyWatermark (tiled): the centered tile is invariant under scale changes', () => {
  // Stronger version: verify the centered tile's local (xCenter, yCenter)
  // is (0, 0) regardless of scale. We compute the tile center from the
  // recorded rect: xCenter = x + w/2.
  const cw = 1000, ch = 1000;
  const baseWm = {
    enabled: true,
    type: 'image',
    position: 'tiled',
    opacity: 1,
    tiledAngle: 0, // straight horizontal grid for easy reasoning
    text: '',
  };

  const scales = [0.10, 0.15, 0.20, 0.25, 0.28, 0.30, 0.35];
  for (const scale of scales) {
    const ctx = makeFakeCtx();
    applyWatermark(ctx, {
      canvasWidth: cw,
      canvasHeight: ch,
      watermark: { ...baseWm, scale },
      imageBitmap: FAKE_BITMAP,
    });
    const centeredCount = ctx.drawCalls.filter(({ x, y, w, h }) => {
      return Math.abs(x + w / 2) < 0.5 && Math.abs(y + h / 2) < 0.5;
    }).length;
    assert.equal(centeredCount, 1, `scale=${scale}: exactly one tile must be at the canvas center`);
  }
});
