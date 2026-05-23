// js/historyOps.js — typed wrappers around withHistory.
//
// Each op kind in the editor has a fixed set of state keys it touches.
// Rather than spell that out at every callsite, this module exposes thin
// helpers that know the right snapshotKeys for each kind. The result is one
// import per tool instead of two, and one fewer place to drift if the state
// shape grows.
//
// Usage:
//   import { withTransformsHistory } from '../historyOps.js';
//   withTransformsHistory('Rotate 90°', imageId, state => {
//     applyRotate(state.images[imageId], 90);
//   });
//
// The mutator MUST be wrapped in `update()` if subscribers need to fire.
// withHistory does NOT auto-wrap — see the design note in history.js — but
// these wrappers DO wrap, because every editor callsite needs subscriber
// notifications and it would be a footgun to forget. Tests can still call
// withHistory directly for the unwrapped path.

import { update } from './state.js';
import { withHistory, withBatchTransaction } from './history.js';

// Wrap the mutator in update() so the renderer + UI fire.
function wrap(mutator) {
  return state => {
    update(s => mutator(s));
  };
}

// Single-image edit wrapper. Same as `wrap()` but also clears the per-image
// `_isBatch` flag on the touched image, so the (batch) badge on that
// thumbnail goes away the moment the user makes an individual edit. This is
// the flag-based version of the old change-detection subscriber in
// queueView.js — see docs/plans/2026-05-22-v1.1.1-ui-refresh-design.md §7
// for the rationale.
function wrapClearBatch(imageId, mutator) {
  return state => {
    update(s => {
      mutator(s);
      const img = s.images[imageId];
      if (img && img._isBatch) img._isBatch = false;
    });
  };
}

// Each snapshotKeys array is the minimum sub-tree of the ImageState that the
// op kind can touch. Keeping these tight is the main lever on history size.

const KEYS_TRANSFORMS = ['transforms'];
const KEYS_ADJUST     = ['adjust', 'filterPreset'];
const KEYS_CHROMAKEY  = ['chromakey', 'chromakeyMask'];
const KEYS_OVERLAYS   = ['overlays'];
const KEYS_BGMASK     = ['bgRemoved', 'bgMask'];

export function withTransformsHistory(label, imageId, mutator) {
  return withHistory(label, imageId, 'transforms', KEYS_TRANSFORMS, wrapClearBatch(imageId, mutator));
}

export function withAdjustHistory(label, imageId, mutator) {
  return withHistory(label, imageId, 'adjust', KEYS_ADJUST, wrapClearBatch(imageId, mutator));
}

export function withChromakeyHistory(label, imageId, mutator) {
  return withHistory(label, imageId, 'chromakey', KEYS_CHROMAKEY, wrapClearBatch(imageId, mutator));
}

export function withOverlaysHistory(label, imageId, mutator) {
  return withHistory(label, imageId, 'overlay', KEYS_OVERLAYS, wrapClearBatch(imageId, mutator));
}

export function withBgMaskHistory(label, imageId, mutator) {
  return withHistory(label, imageId, 'bgmask', KEYS_BGMASK, wrapClearBatch(imageId, mutator));
}

// Batch variants ----------------------------------------------------------

export function withBatchAdjust(label, imageIds, mutator) {
  return withBatchTransaction(label, imageIds, 'adjust', KEYS_ADJUST, wrap(mutator));
}

export function withBatchTransforms(label, imageIds, mutator) {
  return withBatchTransaction(label, imageIds, 'transforms', KEYS_TRANSFORMS, wrap(mutator));
}

export function withBatchChromakey(label, imageIds, mutator) {
  return withBatchTransaction(label, imageIds, 'chromakey', KEYS_CHROMAKEY, wrap(mutator));
}

// v1.2 Feature 1 + 4: batch face / text auto-redact records every touched
// image's overlays in a single transaction so one Ctrl+Z reverts the whole
// AI-detect pass.
export function withBatchOverlays(label, imageIds, mutator) {
  return withBatchTransaction(label, imageIds, 'overlay', KEYS_OVERLAYS, wrap(mutator));
}
