// js/ops/uploadReady.js — pure helpers for the v1.3 Feature 9 upload-ready
// preset. The orchestration (clone state → encode → ZIP → download) lives in
// js/exporter.js#applyUploadReadyPreset; this file isolates the small pure
// math so it can be unit-tested without dragging in canvas / lifecycle.

/**
 * Decide whether the upload-ready preset should resize a given source. Returns
 * true iff the source's longest edge exceeds the target. We deliberately do
 * NOT upscale — making a small image bigger only inflates file size without
 * adding detail, and the social-post "long edge ≤ N" rule is one-directional
 * (it's a cap, not a target).
 *
 * Garbage inputs (zero, negative, NaN) return false so the caller can safely
 * fall back to "no resize" rather than dividing by zero downstream.
 *
 * @param {number} srcW source width in source-image pixels
 * @param {number} srcH source height in source-image pixels
 * @param {number} longEdge target long-edge length in px
 * @returns {boolean}
 */
export function shouldDownscale(srcW, srcH, longEdge) {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || !Number.isFinite(longEdge)) return false;
  if (srcW <= 0 || srcH <= 0 || longEdge <= 0) return false;
  const sourceLong = Math.max(srcW, srcH);
  return sourceLong > longEdge;
}
