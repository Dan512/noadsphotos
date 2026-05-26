// js/ops/targetSize.js — pure-math quality bisection + resize fallback.
//
// v1.3 Feature 11 — "Exact-file-size export." Users frequently need to fit an
// output under a specific byte budget (Discord 10/25 MB, Email 25 MB, IRS
// 1 MB, …). This module binary-searches the JPEG/WebP quality that lands the
// resulting blob under the target — and if quality alone can't satisfy,
// halves dimensions and retries (bisectQualityWithResize).
//
// Pure on purpose: NO DOM, NO canvas, NO state. The caller supplies an
// `encode(quality)` (or `encodeAtScale(scale, quality)`) callback that does
// the rendering + encoding; we just decide which q/scale to try next. That
// keeps this file 100% unit-testable in plain Node.
//
// Algorithm notes
//   - bisectQuality returns the LARGEST quality in [qLo, qHi] whose encoded
//     blob fits under target. If even qLo overshoots, it returns the qLo
//     attempt with `fits: false` and `hit: 'overshot'` so the caller can
//     escalate (e.g. engage auto-resize).
//   - Tolerance is a fractional under-shoot ceiling: if size <= target AND
//     (target - size) / target <= tolerance, we return early. This avoids
//     burning the full iteration budget chasing a marginal-quality bump.
//   - bisectQualityWithResize wraps the above with an outer loop that halves
//     the dimension scale (1.0 → 0.5 → 0.25 → ...) when the inner loop
//     overshoots at the current scale, clamping at minDimension so we never
//     produce a thumbnail-sized export when the user wanted a usable image.

/**
 * Binary-search a quality value q in [qLo, qHi] such that encode(q) returns a
 * Blob with size <= target. Returns the LARGEST quality that fits, or the
 * result at qLo if even qLo overshoots.
 *
 * @param {{
 *   encode: (q: number) => Promise<Blob>,
 *   target: number,                     // bytes
 *   qLo?: number,                       // default 0.20
 *   qHi?: number,                       // default 1.00
 *   maxIters?: number,                  // default 8
 *   tolerance?: number,                 // fractional. Default 0.05 (5%).
 * }} opts
 * @returns {Promise<{
 *   blob: Blob,
 *   quality: number,
 *   iters: number,
 *   fits: boolean,                      // false if even qLo overshoots
 *   hit: 'exact' | 'within-tolerance' | 'best-fit' | 'overshot',
 * }>}
 */
export async function bisectQuality({
  encode,
  target,
  qLo = 0.20,
  qHi = 1.00,
  maxIters = 8,
  tolerance = 0.05,
} = {}) {
  if (typeof encode !== 'function') throw new TypeError('bisectQuality: encode must be a function');
  if (!(Number.isFinite(target) && target > 0)) {
    // Degenerate target — defer to caller logic, but don't infinite-loop.
    // Encode once at qLo and report overshot.
    const blob = await encode(qLo);
    return { blob, quality: qLo, iters: 1, fits: false, hit: 'overshot' };
  }

  let iters = 0;

  // 1. Try qHi first. If it already fits, we're done.
  iters += 1;
  const hiBlob = await encode(qHi);
  if (hiBlob.size <= target) {
    return { blob: hiBlob, quality: qHi, iters, fits: true, hit: 'exact' };
  }

  // 2. Try qLo. If even qLo overshoots, escalate.
  iters += 1;
  const loBlob = await encode(qLo);
  if (loBlob.size > target) {
    return { blob: loBlob, quality: qLo, iters, fits: false, hit: 'overshot' };
  }

  // Track best-fitting result encountered so far (must satisfy size <= target).
  let best = { blob: loBlob, quality: qLo, size: loBlob.size };

  // 3. Binary-search the open interval.
  let lo = qLo;
  let hi = qHi;
  while (iters < maxIters) {
    const q = (lo + hi) / 2;
    iters += 1;
    const blob = await encode(q);
    if (blob.size <= target) {
      // Update best if this is closer to target (larger quality + smaller
      // undershoot).
      if (blob.size >= best.size) {
        best = { blob, quality: q, size: blob.size };
      }
      // Early exit: within tolerance of target (from below).
      const undershoot = (target - blob.size) / target;
      if (undershoot <= tolerance) {
        return { blob, quality: q, iters, fits: true, hit: 'within-tolerance' };
      }
      // Fits — try a higher quality next.
      lo = q;
    } else {
      // Overshot at q — try a lower quality next.
      hi = q;
    }
  }

  return { blob: best.blob, quality: best.quality, iters, fits: true, hit: 'best-fit' };
}

/**
 * Quality bisection combined with dimension halving. Used when quality alone
 * might not be enough to hit the target — e.g. a 20 MP source with a 100 KB
 * budget will need downscaling regardless of quality.
 *
 * @param {{
 *   encodeAtScale: (scale: number, q: number) => Promise<Blob>,
 *   target: number,                       // bytes
 *   sourceWidth: number,
 *   sourceHeight: number,
 *   qLo?: number,
 *   qHi?: number,
 *   maxIters?: number,
 *   tolerance?: number,
 *   minDimension?: number,                // smallest long edge in px. Default 320.
 *   maxOuterIters?: number,               // max halving rounds. Default 4.
 * }} opts
 * @returns {Promise<{
 *   blob: Blob,
 *   quality: number,
 *   scale: number,
 *   finalWidth: number,
 *   finalHeight: number,
 *   totalIters: number,
 *   fits: boolean,
 *   hit: 'exact' | 'within-tolerance' | 'best-fit' | 'unreachable',
 * }>}
 */
export async function bisectQualityWithResize({
  encodeAtScale,
  target,
  sourceWidth,
  sourceHeight,
  qLo = 0.20,
  qHi = 1.00,
  maxIters = 8,
  tolerance = 0.05,
  minDimension = 320,
  maxOuterIters = 4,
} = {}) {
  if (typeof encodeAtScale !== 'function') {
    throw new TypeError('bisectQualityWithResize: encodeAtScale must be a function');
  }
  const longEdge = Math.max(Number(sourceWidth) || 0, Number(sourceHeight) || 0);

  // Degenerate target → don't loop. One probing encode so the caller has
  // something to log, then bail.
  if (!(Number.isFinite(target) && target > 0)) {
    const blob = await encodeAtScale(1, qLo);
    return {
      blob,
      quality: qLo,
      scale: 1,
      finalWidth: sourceWidth,
      finalHeight: sourceHeight,
      totalIters: 1,
      fits: false,
      hit: 'unreachable',
    };
  }

  let scale = 1;
  let totalIters = 0;
  let lastAttempt = null; // { blob, quality, scale }

  for (let outer = 0; outer < Math.max(1, maxOuterIters + 1); outer += 1) {
    // Clamp scale upwards at this round so we don't recurse below minDimension.
    // If sourceWidth is unknown / zero, skip the clamp (best-effort).
    if (longEdge > 0) {
      const minScale = minDimension / longEdge;
      if (scale < minScale) {
        scale = Math.max(0, minScale);
      }
    }

    const encode = (q) => encodeAtScale(scale, q);
    const inner = await bisectQuality({ encode, target, qLo, qHi, maxIters, tolerance });
    totalIters += inner.iters;
    lastAttempt = { blob: inner.blob, quality: inner.quality, scale };

    if (inner.fits) {
      return {
        blob: inner.blob,
        quality: inner.quality,
        scale,
        finalWidth: Math.max(1, Math.round(sourceWidth * scale)),
        finalHeight: Math.max(1, Math.round(sourceHeight * scale)),
        totalIters,
        fits: true,
        hit: inner.hit,
      };
    }

    // Overshot at this scale — check whether we can halve again.
    const nextScale = scale / 2;
    if (longEdge > 0 && nextScale * longEdge < minDimension) break;
    if (outer + 1 >= maxOuterIters) break;
    scale = nextScale;
  }

  // Exhausted: return the last attempt with fits:false.
  const w = Math.max(1, Math.round(sourceWidth * (lastAttempt ? lastAttempt.scale : 1)));
  const h = Math.max(1, Math.round(sourceHeight * (lastAttempt ? lastAttempt.scale : 1)));
  return {
    blob: lastAttempt ? lastAttempt.blob : null,
    quality: lastAttempt ? lastAttempt.quality : qLo,
    scale: lastAttempt ? lastAttempt.scale : 1,
    finalWidth: w,
    finalHeight: h,
    totalIters,
    fits: false,
    hit: 'unreachable',
  };
}
