// tests/unit/batchFlag.test.js — regression test for the v1.1.1 batch-pill bug.
//
// Bug background: in v1.1, the (batch) pill on a queue thumbnail was driven
// by `img._isBatch`, which got set by markBatch() inside batch operations
// and cleared by a state subscriber in queueView.js that detected any change
// in the image's serialized transforms/adjust/etc. The clearing logic
// couldn't tell the difference between "batch op happened a second time" and
// "user made a single-image edit," so applying batch rotate +90° four times
// in a row toggled the pill on/off as the rotate value moved between angles.
//
// Fix (v1.1.1 §7): drop the change-detection subscriber. Set `_isBatch = true`
// inside batch wrappers, set `_isBatch = false` inside single-image history
// wrappers. Pure flag-based.
//
// This test exercises just the historyOps.js wrappers + state.js to verify
// the flag transitions correctly across multiple batch ops and a per-image
// edit.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getState, update } from '../../js/state.js';
import { clearHistory } from '../../js/history.js';
import {
  withTransformsHistory,
  withAdjustHistory,
  withBatchTransforms,
} from '../../js/historyOps.js';
import { applyRotate } from '../../js/ops/transforms.js';
import { applyAdjust } from '../../js/ops/adjust.js';

function makeImage(id) {
  return {
    id,
    source: { width: 100, height: 80, blob: null, bitmap: null, name: 'x', type: 'image/png', thumbnail: null },
    transforms: { crop: null, rotate: 0, flipH: false, flipV: false, resize: null },
    adjust:     { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filterPreset: 'none',
    chromakey: null,
    chromakeyMask: null,
    bgRemoved: false,
    bgMask: null,
    overlays: [],
    baseDirty: false,
    overlaysDirty: false,
    _isBatch: false,
  };
}

function setupTwoImages() {
  clearHistory();
  const s = getState();
  s.ui.view = 'queue';
  s.ui.activeImageId = null;
  s.queue.length = 0;
  for (const k of Object.keys(s.images)) delete s.images[k];
  const a = makeImage('a');
  const b = makeImage('b');
  s.images.a = a;
  s.images.b = b;
  s.queue.push('a', 'b');
}

beforeEach(setupTwoImages);

test('batch pill: rotating via batch sets _isBatch on every image', () => {
  withBatchTransforms('Rotate batch', ['a', 'b'], s => {
    applyRotate(s.images.a, 90);
    applyRotate(s.images.b, 90);
    s.images.a._isBatch = true;
    s.images.b._isBatch = true;
  });
  assert.equal(getState().images.a._isBatch, true);
  assert.equal(getState().images.b._isBatch, true);
});

test('batch pill: applying batch rotate four times keeps _isBatch true (regression for v1.1.1 §7)', () => {
  // Walk rotate value through 0 → 90 → 180 → 270 → 0 across four batch
  // operations. applyRotate(img, n) is set-not-add, so we compute the next
  // angle ourselves and pass it in. The KEY assertion is that _isBatch stays
  // true throughout — the v1.1 bug was that the change-detection subscriber
  // would flip it off whenever the serialized transforms returned to a
  // previously-seen state. With the v1.1.1 flag-based model, batch ops are
  // batch ops regardless of what value they write.
  for (let step = 0; step < 4; step++) {
    const angle = ((step + 1) * 90) % 360;  // 90, 180, 270, 0
    withBatchTransforms('Rotate batch', ['a', 'b'], s => {
      applyRotate(s.images.a, angle);
      applyRotate(s.images.b, angle);
      s.images.a._isBatch = true;
      s.images.b._isBatch = true;
    });
    // After each batch op, BOTH images must still be flagged.
    assert.equal(getState().images.a._isBatch, true, `step ${step}: image A`);
    assert.equal(getState().images.b._isBatch, true, `step ${step}: image B`);
  }
  // Final rotate value did, in fact, return to 0 (the v1.1 trigger angle).
  assert.equal(getState().images.a.transforms.rotate, 0);
});

test('batch pill: per-image withAdjustHistory edit clears _isBatch on that image only', () => {
  // Start with both flagged as batch.
  update(s => {
    s.images.a._isBatch = true;
    s.images.b._isBatch = true;
  });

  // Edit image A through a single-image history wrapper.
  withAdjustHistory('Adjust brightness on A', 'a', s => {
    applyAdjust(s.images.a, 'brightness', 30);
  });

  // A's flag cleared, B's untouched.
  assert.equal(getState().images.a._isBatch, false);
  assert.equal(getState().images.b._isBatch, true);
});

test('batch pill: per-image withTransformsHistory clears _isBatch even when the value matches the existing one', () => {
  // Set up: rotate=0 on A, mark batch.
  update(s => { s.images.a._isBatch = true; });

  // A no-op-style edit through the history wrapper (rotate by 0). The
  // wrapper should still clear the batch flag because the wrapper's
  // intent is "this is an explicit single-image edit," regardless of
  // whether the value actually changed.
  withTransformsHistory('Rotate +0° on A', 'a', s => {
    applyRotate(s.images.a, 0);
  });

  assert.equal(getState().images.a._isBatch, false);
});
