// tests/unit/targetSize.test.js — pure logic for v1.3 Feature 11 (exact file size).
//
// Covers:
//   - bisectQuality: target hit at qHi, overshoot at qLo, monotonic
//     convergence, tolerance early exit, maxIters cap.
//   - bisectQualityWithResize: quality alone fits, needs one halving, reaches
//     minDimension (unreachable), zero/empty target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bisectQuality, bisectQualityWithResize } from '../../js/ops/targetSize.js';
import {
  TARGET_SIZE_PRESETS,
  getPresetById,
  getActiveTargetBytes,
} from '../../js/targetSizePresets.js';

// Build a fake Blob of arbitrary size. The encode() callback returns these
// so we can decouple "what size came out" from "what would actually encode."
function fakeBlob(size) {
  return new Blob([new Uint8Array(Math.max(0, Math.round(size)))], { type: 'image/jpeg' });
}

// --------------------------------------------------------------- bisectQuality

test('bisectQuality: target exactly hit at qHi → hit: exact, iters: 1', async () => {
  const encode = async (_q) => fakeBlob(1000);
  const result = await bisectQuality({ encode, target: 1000 });
  assert.equal(result.fits, true);
  assert.equal(result.hit, 'exact');
  assert.equal(result.iters, 1);
  assert.equal(result.quality, 1.00);
});

test('bisectQuality: target unreachable → hit: overshot, fits: false', async () => {
  // Encoder always returns 5000 bytes regardless of quality.
  const encode = async (_q) => fakeBlob(5000);
  const result = await bisectQuality({ encode, target: 1000 });
  assert.equal(result.fits, false);
  assert.equal(result.hit, 'overshot');
  // qHi tried first, qLo tried second → 2 iters before bailing.
  assert.equal(result.iters, 2);
});

test('bisectQuality: monotonic linear encoder converges', async () => {
  // size(q) = 500 + 4500 * q → q=1.0 yields 5000, q=0.2 yields 1400.
  // Target=3000 → solves to q ≈ 0.555.
  const encode = async (q) => fakeBlob(500 + 4500 * q);
  const result = await bisectQuality({ encode, target: 3000, tolerance: 0.01 });
  assert.equal(result.fits, true);
  assert.ok(result.quality > 0.4 && result.quality < 0.6, `quality=${result.quality}`);
  // Should converge well under 8 iters for this smooth linear function.
  assert.ok(result.iters <= 6, `iters=${result.iters}`);
  // Resulting blob should be at or under target.
  assert.ok(result.blob.size <= 3000);
});

test('bisectQuality: tolerance early exit', async () => {
  // Linear encoder that lands within 5% of target on first interior probe
  // (q=0.6 → size = 500 + 4500*0.6 = 3200; target 3250 → undershoot 1.5%).
  const encode = async (q) => fakeBlob(500 + 4500 * q);
  const result = await bisectQuality({
    encode,
    target: 3250,
    tolerance: 0.05,
  });
  assert.equal(result.fits, true);
  assert.equal(result.hit, 'within-tolerance');
  // qHi(5000>3250) + qLo(1400<=3250) + midpoint(0.6 → 3200) = 3 iters.
  assert.equal(result.iters, 3);
});

test('bisectQuality: maxIters cap returns best-fit', async () => {
  // Encoder is chaotic enough to never land within tolerance, but always
  // produces SOMETHING under target at qLo. We force maxIters=4 so the
  // bisect can't converge; verify we still return a fitting blob.
  // size(q) = 100 + 9000 * q^2 — strongly nonlinear. At qLo=0.2 = 460,
  // target=3000 → tight tolerance forces full budget.
  const encode = async (q) => fakeBlob(100 + 9000 * q * q);
  const result = await bisectQuality({
    encode,
    target: 3000,
    tolerance: 0.001,  // 0.1% — effectively unreachable
    maxIters: 4,
  });
  assert.equal(result.fits, true);
  assert.equal(result.hit, 'best-fit');
  assert.equal(result.iters, 4);
  assert.ok(result.blob.size <= 3000);
});

test('bisectQuality: default qLo/qHi defaults applied', async () => {
  let qSeen = null;
  const encode = async (q) => { qSeen = q; return fakeBlob(100); };
  await bisectQuality({ encode, target: 1000 });
  // First probe should be qHi default = 1.00.
  assert.equal(qSeen, 1.00);
});

// ---------------------------------------------------- bisectQualityWithResize

test('bisectQualityWithResize: quality alone fits → scale 1.0', async () => {
  const encodeAtScale = async (_scale, _q) => fakeBlob(800);
  const result = await bisectQualityWithResize({
    encodeAtScale,
    target: 1000,
    sourceWidth: 4000,
    sourceHeight: 3000,
  });
  assert.equal(result.fits, true);
  assert.equal(result.scale, 1);
  assert.equal(result.finalWidth, 4000);
  assert.equal(result.finalHeight, 3000);
});

test('bisectQualityWithResize: needs one halving', async () => {
  // At scale 1.0 → always overshoots (10000 bytes).
  // At scale 0.5 → fits at lower quality (size depends on quality).
  const encodeAtScale = async (scale, q) => {
    if (scale >= 0.99) return fakeBlob(10000);
    // size at scale 0.5: 100 + 1800*q, so even at q=1 we get 1900 (fits 2000).
    return fakeBlob(100 + 1800 * q);
  };
  const result = await bisectQualityWithResize({
    encodeAtScale,
    target: 2000,
    sourceWidth: 1000,
    sourceHeight: 1000,
    minDimension: 100,
  });
  assert.equal(result.fits, true);
  assert.equal(result.scale, 0.5);
  assert.equal(result.finalWidth, 500);
  assert.equal(result.finalHeight, 500);
});

test('bisectQualityWithResize: reaches minDimension → unreachable', async () => {
  // Encoder always overshoots. With sourceWidth=2560 and minDimension=320,
  // we'll halve 2560 → 1280 → 640 → 320, then stop. Final scale = 320/2560 = 0.125.
  const encodeAtScale = async (_scale, _q) => fakeBlob(999_999);
  const result = await bisectQualityWithResize({
    encodeAtScale,
    target: 1000,
    sourceWidth: 2560,
    sourceHeight: 1280,
    minDimension: 320,
    maxOuterIters: 10,
  });
  assert.equal(result.fits, false);
  assert.equal(result.hit, 'unreachable');
  // Final scale should be ≈ minDimension / sourceLongEdge.
  assert.ok(Math.abs(result.scale - (320 / 2560)) < 1e-9, `scale=${result.scale}`);
});

test('bisectQualityWithResize: zero / non-finite target → unreachable', async () => {
  const encodeAtScale = async (_scale, _q) => fakeBlob(100);
  const r1 = await bisectQualityWithResize({
    encodeAtScale,
    target: 0,
    sourceWidth: 1024,
    sourceHeight: 768,
  });
  assert.equal(r1.fits, false);
  assert.equal(r1.hit, 'unreachable');
  // Should NOT have looped — exactly one probe attempted.
  assert.equal(r1.totalIters, 1);

  const r2 = await bisectQualityWithResize({
    encodeAtScale,
    target: Number.NaN,
    sourceWidth: 1024,
    sourceHeight: 768,
  });
  assert.equal(r2.fits, false);
  assert.equal(r2.hit, 'unreachable');
});

test('bisectQualityWithResize: maxOuterIters bound respected', async () => {
  // Same overshooting encoder, but tight outer budget. Should still terminate.
  const encodeAtScale = async (_scale, _q) => fakeBlob(999_999);
  const result = await bisectQualityWithResize({
    encodeAtScale,
    target: 1000,
    sourceWidth: 4000,
    sourceHeight: 4000,
    minDimension: 10,
    maxOuterIters: 2,
  });
  // Budget=2 means we try scale 1.0 then 0.5 (2 outer iters), then bail.
  assert.equal(result.fits, false);
  assert.equal(result.hit, 'unreachable');
});

// --------------------------------------------------------- targetSizePresets
//
// `getActiveTargetBytes` is what the editor + batch panel UI both call to
// turn the user's chip / custom-value selection into a concrete byte budget
// for the exporter. The tests below pin the contract: every UI mode resolves
// to either a positive number or null (which means "disable Apply").

test('getActiveTargetBytes: preset mode → looks up by id, returns preset bytes', () => {
  const result = getActiveTargetBytes({ mode: 'preset', presetId: 'discord-25' });
  assert.equal(result, 25 * 1024 * 1024);
  // Sanity-check that the catalog entry actually exists (catches catalog
  // drift if someone renames a preset without updating the test name).
  assert.ok(getPresetById('discord-25'));
});

test('getActiveTargetBytes: preset mode with missing presetId → null', () => {
  const result = getActiveTargetBytes({ mode: 'preset', presetId: 'not-a-real-preset' });
  assert.equal(result, null);
});

test('getActiveTargetBytes: custom MB → value * 1024 * 1024', () => {
  const result = getActiveTargetBytes({
    mode: 'custom', customValue: 3, customUnit: 'MB',
  });
  assert.equal(result, 3 * 1024 * 1024);
});

test('getActiveTargetBytes: custom KB → value * 1024', () => {
  const result = getActiveTargetBytes({
    mode: 'custom', customValue: 500, customUnit: 'KB',
  });
  assert.equal(result, 500 * 1024);
});

test('getActiveTargetBytes: custom mode with invalid value → null', () => {
  // Zero, negative, NaN, missing — all must collapse to null so the UI can
  // disable Apply without each call site re-validating.
  assert.equal(getActiveTargetBytes({ mode: 'custom', customValue: 0,        customUnit: 'MB' }), null);
  assert.equal(getActiveTargetBytes({ mode: 'custom', customValue: -1,       customUnit: 'MB' }), null);
  assert.equal(getActiveTargetBytes({ mode: 'custom', customValue: Number.NaN, customUnit: 'MB' }), null);
  assert.equal(getActiveTargetBytes({ mode: 'custom',                          customUnit: 'MB' }), null);
  assert.equal(getActiveTargetBytes(null), null);
  assert.equal(getActiveTargetBytes(undefined), null);
});

test('TARGET_SIZE_PRESETS: every preset has unique id + sane byte target', () => {
  const ids = new Set();
  for (const p of TARGET_SIZE_PRESETS) {
    assert.equal(typeof p.id, 'string');
    assert.ok(p.id.length > 0);
    assert.ok(!ids.has(p.id), `duplicate id: ${p.id}`);
    ids.add(p.id);
    assert.equal(typeof p.labelKey, 'string');
    assert.ok(p.labelKey.startsWith('targetSizePreset'));
    assert.ok(p.bytes > 0 && p.bytes < 1024 * 1024 * 1024);
  }
});
