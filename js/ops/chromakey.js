// js/ops/chromakey.js — color-to-transparent. Pure pixel scan; produces Uint8Array alpha mask.
//
// Phase 6 of the v1 plan: the eyedropper tool picks a pixel from the displayed
// canvas, the tolerance slider sets a threshold, and matching pixels are
// rendered transparent in the preview / export pipeline.
//
// State shape on imageState:
//   chromakey:     null | { hex: '#RRGGBB', tolerance: number /* 0..100 slider */ }
//   chromakeyMask: null | Uint8Array (length = source.w * source.h, 0..255)
//
// The mask is at SOURCE resolution. Re-rendering of the masked source canvas
// is handled by render/previewRenderer.js; this module is pure pixel math and
// state mutation, with no DOM access.
//
// Tolerance slider 0..100 maps to a raw Euclidean RGB distance threshold of
// 0..80 (max possible Euclidean distance in RGB ≈ 441, so 80 is a reasonable
// "obvious match" upper bound). A soft anti-aliasing band of 25% of the
// threshold width gives a smooth edge so chromakey doesn't look hard-clipped.

import { invalidate } from '../render/renderCache.js';

// --- Public API ----------------------------------------------------------

/**
 * Set chromakey parameters on an ImageState. Caller is responsible for then
 * regenerating the mask via buildChromakeyMask + setChromakeyMask (or the
 * tool's debounced helper).
 *
 * Passing null clears both `chromakey` and `chromakeyMask`.
 *
 * @param {object} imageState
 * @param {{hex: string, tolerance: number} | null} params
 */
export function applyChromakey(imageState, params) {
  if (!imageState) return;
  if (params === null || params === undefined) {
    imageState.chromakey = null;
    imageState.chromakeyMask = null;
    invalidate(imageState, 'CHROMAKEY');
    return;
  }
  // Validate hex; allowlist tolerance to a number in [0, 100].
  const hex = normalizeHex(params.hex);
  const rawTol = Number(params.tolerance);
  const tol = Math.max(0, Math.min(100, Number.isFinite(rawTol) ? rawTol : 0));
  imageState.chromakey = { hex, tolerance: tol };
  invalidate(imageState, 'CHROMAKEY');
}

/**
 * Attach (or clear) the chromakey alpha mask for an ImageState. The mask is
 * treated as immutable by the renderer — callers should build a new Uint8Array
 * via buildChromakeyMask rather than mutating an existing one in place, so the
 * renderer's WeakMap-keyed cache invalidates correctly.
 *
 * @param {object} imageState
 * @param {Uint8Array | null} mask
 */
export function setChromakeyMask(imageState, mask) {
  if (!imageState) return;
  imageState.chromakeyMask = mask ?? null;
  invalidate(imageState, 'CHROMAKEY');
}

/**
 * Build a chromakey alpha mask. Pure: no DOM, no state — given the same
 * ImageData/hex/tolerance it always produces the same Uint8Array.
 *
 * @param {ImageData} imageData full-image pixels (RGBA, source resolution).
 * @param {string} hex target color, e.g. '#000000'. Accepts the same forms
 *                     as normalizeHex().
 * @param {number} tolerance slider value 0..100.
 * @returns {Uint8Array} length = imageData.width * imageData.height.
 *                       0 = transparent (matches target), 255 = keep (no match).
 *                       Soft transition at the edge for anti-aliasing.
 */
export function buildChromakeyMask(imageData, hex, tolerance) {
  const { width, height, data } = imageData;
  const target = normalizeHex(hex);
  const tr = parseInt(target.slice(1, 3), 16);
  const tg = parseInt(target.slice(3, 5), 16);
  const tb = parseInt(target.slice(5, 7), 16);

  const tolNum = Number(tolerance);
  const tolClamped = Math.max(0, Math.min(100, Number.isFinite(tolNum) ? tolNum : 0));
  // Map slider 0..100 to RGB distance 0..160 (doubled from the previous
  // 0..80 range). Users reported the previous scale was underpowered for
  // anti-aliased / lightly-compressed backgrounds — slider 100 now matches
  // what would previously have required slider 200.
  const rawTol = tolClamped * 1.6;         // 0..160
  const softness = rawTol * 0.25;          // 25% soft edge band

  const total = width * height;
  const mask = new Uint8Array(total);
  for (let i = 0, p = 0; p < total; p++, i += 4) {
    const dr = data[i]     - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= rawTol) {
      mask[p] = 0;
    } else if (softness <= 0 || dist >= rawTol + softness) {
      mask[p] = 255;
    } else {
      // Soft band: linear ramp from 0 (matches) at rawTol to 255 (kept) at
      // rawTol + softness. Round (not floor) so the midpoint hits ~128.
      mask[p] = Math.round(((dist - rawTol) / softness) * 255);
    }
  }
  return mask;
}

/**
 * Normalize a hex color string to canonical '#RRGGBB' uppercase form.
 * Accepts '#abc', '#abcdef', 'abc', 'abcdef' (with surrounding whitespace).
 * Invalid input falls back to '#000000' (deliberate — chromakey defaults to
 * "remove black" so an unrecognized value is still a coherent state).
 *
 * @param {*} input
 * @returns {string} '#RRGGBB'
 */
export function normalizeHex(input) {
  if (input == null) return '#000000';
  let s = String(input).trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) {
    if (!/^[0-9a-fA-F]{3}$/.test(s)) return '#000000';
    s = s.split('').map(c => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return '#000000';
  return '#' + s.toUpperCase();
}

/**
 * Convert an RGB triple (0..255) into '#RRGGBB'. Values are clamped to the
 * 0..255 range and rounded so callers can pass float ImageData reads directly.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function pixelToHex(r, g, b) {
  const h = n => {
    const clamped = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
    return clamped.toString(16).padStart(2, '0').toUpperCase();
  };
  return '#' + h(r) + h(g) + h(b);
}
