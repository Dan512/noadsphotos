// js/ops/transforms.js — pure transform mutations on ImageState.
//
// These functions mutate the passed `imageState` directly. They never touch
// the DOM and never call `subscribe` / `update` themselves — callers wrap them
// in `state.update(s => applyCrop(s.images[id], rect))` when they want
// subscribers to fire.
//
// Each mutator marks the base canvas dirty via renderCache.invalidate so the
// preview pipeline re-bakes the transformed bitmap on its next rAF tick.
import { clampCropToImage } from '../geometry.js';
import { invalidate } from '../render/renderCache.js';

// Resize modes accepted by applyResize. Anything else is ignored (no-op) so
// callers can't silently store garbage modes that effectiveImageSize would
// quietly drop.
const RESIZE_MODES = new Set([
  'longestSide',
  'shortestSide',
  'width',
  'height',
  'percent',
  'exact',
]);

// Set / clear the crop rect. When `cropRect` is null the crop is cleared.
// Otherwise the rect is clamped to the image's source bounds first so we
// can't store something outside the image (matches geometry.js convention).
export function applyCrop(imageState, cropRect) {
  if (!imageState) return;
  if (cropRect === null || cropRect === undefined) {
    imageState.transforms.crop = null;
  } else {
    imageState.transforms.crop = clampCropToImage(cropRect, {
      w: imageState.source.width,
      h: imageState.source.height,
    });
  }
  invalidate(imageState, 'TRANSFORMS');
}

// Set / clear the resize directive. Validates the mode against the allowlist
// — unknown modes are a no-op (state untouched) so unit tests can verify the
// validation without surprises. `null` clears the resize.
export function applyResize(imageState, resize) {
  if (!imageState) return;
  if (resize === null || resize === undefined) {
    imageState.transforms.resize = null;
    invalidate(imageState, 'TRANSFORMS');
    return;
  }
  if (!resize || typeof resize !== 'object') return;
  if (!RESIZE_MODES.has(resize.mode)) return;
  imageState.transforms.resize = { ...resize };
  invalidate(imageState, 'TRANSFORMS');
}

// Set rotation. Normalises the input to [0, 360) so a slider can pass any
// integer (incl. negatives or values > 360) without us needing to wrap.
export function applyRotate(imageState, deg) {
  if (!imageState) return;
  const n = Number(deg);
  if (!Number.isFinite(n)) return;
  imageState.transforms.rotate = ((n % 360) + 360) % 360;
  invalidate(imageState, 'TRANSFORMS');
}

// Toggle flip on the given axis. 'h' → flipH, 'v' → flipV. Anything else is
// ignored.
export function applyFlip(imageState, axis) {
  if (!imageState) return;
  if (axis === 'h') {
    imageState.transforms.flipH = !imageState.transforms.flipH;
  } else if (axis === 'v') {
    imageState.transforms.flipV = !imageState.transforms.flipV;
  } else {
    return;
  }
  invalidate(imageState, 'TRANSFORMS');
}
