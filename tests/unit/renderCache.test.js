import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVALIDATE, invalidate, markClean } from '../../js/render/renderCache.js';

function makeImageState() {
  return { baseDirty: false, overlaysDirty: false };
}

test('INVALIDATE map: TRANSFORMS → base', () => {
  assert.equal(INVALIDATE.TRANSFORMS, 'base');
});

test('INVALIDATE map: CHROMAKEY → base', () => {
  assert.equal(INVALIDATE.CHROMAKEY, 'base');
});

test('INVALIDATE map: BGMASK → base', () => {
  assert.equal(INVALIDATE.BGMASK, 'base');
});

test('INVALIDATE map: OVERLAY → overlays', () => {
  assert.equal(INVALIDATE.OVERLAY, 'overlays');
});

test('INVALIDATE map: ADJUST is null (CSS-filter preview, no bake)', () => {
  assert.equal(INVALIDATE.ADJUST, null);
});

test('INVALIDATE map: FILTER_PRESET is null', () => {
  assert.equal(INVALIDATE.FILTER_PRESET, null);
});

test('INVALIDATE is frozen', () => {
  assert.equal(Object.isFrozen(INVALIDATE), true);
});

test('invalidate("TRANSFORMS") sets baseDirty', () => {
  const img = makeImageState();
  invalidate(img, 'TRANSFORMS');
  assert.equal(img.baseDirty, true);
  assert.equal(img.overlaysDirty, false);
});

test('invalidate("CHROMAKEY") sets baseDirty', () => {
  const img = makeImageState();
  invalidate(img, 'CHROMAKEY');
  assert.equal(img.baseDirty, true);
});

test('invalidate("BGMASK") sets baseDirty', () => {
  const img = makeImageState();
  invalidate(img, 'BGMASK');
  assert.equal(img.baseDirty, true);
});

test('invalidate("OVERLAY") sets overlaysDirty', () => {
  const img = makeImageState();
  invalidate(img, 'OVERLAY');
  assert.equal(img.overlaysDirty, true);
  assert.equal(img.baseDirty, false);
});

test('invalidate("ADJUST") is a no-op (null flag)', () => {
  const img = makeImageState();
  invalidate(img, 'ADJUST');
  assert.equal(img.baseDirty, false);
  assert.equal(img.overlaysDirty, false);
});

test('invalidate("FILTER_PRESET") is a no-op (null flag)', () => {
  const img = makeImageState();
  invalidate(img, 'FILTER_PRESET');
  assert.equal(img.baseDirty, false);
  assert.equal(img.overlaysDirty, false);
});

test('invalidate with unknown kind is a no-op', () => {
  const img = makeImageState();
  invalidate(img, 'UNKNOWN_KIND');
  assert.equal(img.baseDirty, false);
  assert.equal(img.overlaysDirty, false);
});

test('invalidate tolerates a null/undefined imageState (defensive)', () => {
  invalidate(null, 'TRANSFORMS');
  invalidate(undefined, 'TRANSFORMS');
  // No throw = pass.
  assert.ok(true);
});

test('markClean("base") clears baseDirty without touching overlaysDirty', () => {
  const img = { baseDirty: true, overlaysDirty: true };
  markClean(img, 'base');
  assert.equal(img.baseDirty, false);
  assert.equal(img.overlaysDirty, true);
});

test('markClean("overlays") clears overlaysDirty without touching baseDirty', () => {
  const img = { baseDirty: true, overlaysDirty: true };
  markClean(img, 'overlays');
  assert.equal(img.baseDirty, true);
  assert.equal(img.overlaysDirty, false);
});

test('markClean tolerates null imageState', () => {
  markClean(null, 'base');
  assert.ok(true);
});

test('invalidate + markClean round-trips: TRANSFORMS → base dirty, mark clean → false', () => {
  const img = makeImageState();
  invalidate(img, 'TRANSFORMS');
  assert.equal(img.baseDirty, true);
  markClean(img, 'base');
  assert.equal(img.baseDirty, false);
});
