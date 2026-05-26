// js/render/exportRenderer.js — full-resolution bake of all edits, producing an encoded Blob.
//
// The export pipeline is the single moment "an image leaves the user's edit
// session as a file." It is read-only with respect to state — nothing here
// records history or mutates the imageState. Callers (exporter.js) own the
// surrounding UX (toasts, download triggers).
//
// Pipeline (high level):
//   1. Resolve the source bitmap via lifecycle.ensureBitmap.
//   2. Compute output dimensions via effectiveImageSize (crop + 90s rotate +
//      resize). Reject if either axis exceeds caps.maxCanvasSize.
//   3. Build a working canvas at the post-crop/post-rotate size and draw the
//      source through the transform stack.
//   4. Multiply alpha by chromakeyMask and bgMask (both at source resolution
//      — we mask the source canvas BEFORE the transform stack so coordinate
//      systems stay simple).
//   5. Apply adjustments + filter preset:
//        - caps.ctxFilter → ctx.filter re-draw via a temp canvas (avoids the
//          read-from-self feedback issue).
//        - else            → softwareApply on getImageData/putImageData.
//      Blur is a documented gap in the software fallback (no Gaussian pass
//      in v1; the exporter surfaces a one-time toast warning).
//   6. Draw overlays in source-pixel space (text/brush/shape/redact). The
//      same forward transform used by the source draw is applied so overlay
//      coords land where the user placed them in the preview.
//   7. If a resize directive is present, downscale to the final output size
//      via a fresh canvas. We chose "build pre-resize, then downscale" over
//      "bake resize into step 3's drawImage" because the post-pass keeps
//      step 3 simple to test (the resized output is just a scaled copy of
//      the pre-resize canvas).
//   8. Encode via codec.encodeCanvas so the output blob's MIME type is
//      verified (browsers silently fall back to PNG when WebP/JPEG isn't
//      supported; codec.js detects that and throws EncodeError).
import { effectiveImageSize } from '../geometry.js';
import { cssFilterString, softwareApply } from '../ops/adjust.js';
import { drawOverlaySync } from '../overlays.js';
import { drawText } from '../ops/text.js';
import { drawBrush } from '../ops/brush.js';
import { drawShape } from '../ops/shape.js';
import { applyRedactFx } from '../ops/redact.js';
import { encodeCanvas } from '../codec.js';
import { applyWatermark } from '../ops/watermark.js';
import { getState } from '../state.js';
import { getCachedWatermarkBitmap } from '../tools/watermarkTool.js';

// Redact is intentionally NOT in this map: its pixel-mutating effect runs
// in a dedicated pass against the working canvas (see applyRedactsToCanvas)
// before the other overlays are drawn. That ordering means text/brush/shape
// land ON TOP of the pixelated/blurred region.
const overlayDrawers = Object.freeze({
  text: drawText,
  brush: drawBrush,
  shape: drawShape,
  redact: () => { /* baked separately via applyRedactFx */ },
});

/**
 * Render the image with all edits applied at full source resolution, then
 * encode. Returns a Promise<Blob>.
 *
 * @param {object} imageState  - The image's state (transforms, overlays, …).
 * @param {{format: string, quality: number}} opts - Export options.
 * @param {object} caps         - capabilities probe result.
 * @param {object} lifecycle    - lifecycle.ensureBitmap is called.
 * @returns {Promise<Blob>}
 * @throws  - 'source_bitmap_unavailable' if ensureBitmap returns null.
 *          - 'output_exceeds_canvas_limit' if final dims > caps.maxCanvasSize.
 *          - EncodeError from codec.encodeCanvas.
 */
export async function renderForExport(imageState, opts, caps, lifecycle) {
  if (!imageState) throw new Error('source_bitmap_unavailable');

  const bitmap = await lifecycle.ensureBitmap(imageState.id);
  if (!bitmap) throw new Error('source_bitmap_unavailable');

  const finalDims = effectiveImageSize(imageState);
  const maxSize = (caps && caps.maxCanvasSize) || 4096;
  if (finalDims.w > maxSize || finalDims.h > maxSize) {
    throw new Error('output_exceeds_canvas_limit');
  }
  if (finalDims.w <= 0 || finalDims.h <= 0) {
    throw new Error('output_invalid_dimensions');
  }

  // Pre-resize dimensions = crop + 90s rotate, without the resize directive.
  // We render into this size first and downscale at the end if a resize is
  // configured. This keeps the transform-stack math identical regardless of
  // whether the user picked a resize.
  const preResize = computePreResizeDims(imageState);
  if (preResize.w <= 0 || preResize.h <= 0) {
    throw new Error('output_invalid_dimensions');
  }
  // We also cap the working canvas — a 6000×8000 source with no resize on iOS
  // would still fail here, but with a clearer error than a silent OOM.
  if (preResize.w > maxSize || preResize.h > maxSize) {
    throw new Error('output_exceeds_canvas_limit');
  }

  // Apply masks to the source bitmap once, into a source-sized canvas. The
  // working canvas then draws from THIS canvas so the masks travel through
  // the transform stack naturally.
  const maskedSource = applyMasksToSource(bitmap, imageState);

  // 1. Working canvas at the pre-resize output size (crop + 90s rotate).
  const canvas = makeCanvas(preResize.w, preResize.h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('export_ctx_unavailable');

  // 2. Draw the (masked) source through the transform stack.
  drawTransformedSource(ctx, maskedSource, imageState, preResize);

  // 3. Apply adjustments + filter preset in-place on the working canvas.
  await applyAdjustments(ctx, canvas, imageState, caps);

  // 4. Apply each redact overlay's effect directly to the working canvas.
  // Sits BETWEEN adjustments and other overlays so:
  //   - the blur reads the post-adjustment pixels (the redaction's source
  //     content matches what surrounds it visually), and
  //   - text/brush/shape annotations drawn next land on top of the
  //     pixelated/blurred region rather than under it.
  applyRedactsToCanvas(ctx, imageState, preResize, caps);

  // 5. Draw committed overlays in source-pixel space.
  drawOverlaysAtSourcePixels(ctx, imageState, preResize);

  // 5. If a resize directive is present, downscale to the final dims now.
  // We do this AFTER overlays so text/strokes remain at their source-pixel
  // density (matching the preview semantics) and only the rasterized output
  // is scaled.
  const outputCanvas = needsResize(preResize, finalDims)
    ? downscale(canvas, finalDims.w, finalDims.h)
    : canvas;

  // 6. Watermark pass (v1.3 Feature 12). Painted AFTER resize so the
  // watermark's scale is a fraction of the FINAL exported dimensions — the
  // user picked "15% of long edge" and gets 15% of the file they receive,
  // not 15% of some pre-resize intermediate. This is also why we read the
  // global state.ui.watermark here rather than off the imageState: the
  // watermark is a one-knob preference that applies uniformly to every
  // export, not a per-image overlay.
  applyWatermarkToCanvas(outputCanvas);

  // 7. Encode. Quality is ignored for PNG; codec.encodeCanvas passes it
  // through to canvas.toBlob, which handles that. We normalize the requested
  // format here so callers can pass the short form ('png') that state.export
  // stores OR a full MIME ('image/png') — the codec checks blob.type strictly
  // against this string.
  return encodeCanvas(outputCanvas, normalizeMime(opts.format), opts.quality);
}

// Paint the watermark onto the given output canvas in place. No-op when the
// master toggle is off. Reads state directly because this is a global
// setting, not a per-image concern.
function applyWatermarkToCanvas(canvas) {
  if (!canvas) return;
  const s = getState();
  const wm = s && s.ui && s.ui.watermark;
  if (!wm || !wm.enabled) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  applyWatermark(ctx, {
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    watermark: wm,
    imageBitmap: wm.type === 'image' ? getCachedWatermarkBitmap() : null,
  });
}

/**
 * Render a thumbnail-sized preview reflecting all per-image state (transforms,
 * chromakey, bgMask, adjustments, filter preset, overlays). Used for refreshing
 * queue thumbnails after batch operations.
 *
 * The user's actual `transforms.resize` is overridden to fit the long side at
 * roughly `targetSize` px — but we cap at the image's natural effective size
 * so a 10%-resized 1024px source renders at its true ~102px output (no
 * upscale) rather than being stretched to 200px.
 *
 * Returns a JPEG Blob at quality 0.7 (matches importer's thumbnail format).
 *
 * @param {object} imageState
 * @param {object} caps
 * @param {object} lifecycle
 * @param {{targetSize?: number}} [opts]
 * @returns {Promise<Blob>}
 */
export async function renderThumbnail(imageState, caps, lifecycle, { targetSize = 200 } = {}) {
  if (!imageState) throw new Error('source_bitmap_unavailable');
  // Determine the effective output size given the user's transforms + resize,
  // then clamp the thumbnail's long side at min(effectiveLongest, targetSize)
  // so we don't upscale small outputs.
  const finalDims = effectiveImageSize(imageState);
  const longest = Math.max(finalDims.w || 0, finalDims.h || 0);
  const targetLongest = longest > 0 ? Math.min(longest, targetSize) : targetSize;

  const thumbState = {
    ...imageState,
    transforms: {
      ...(imageState.transforms || {}),
      resize: { mode: 'longestSide', value: Math.max(1, Math.round(targetLongest)) },
    },
  };
  return renderForExport(thumbState, { format: 'jpeg', quality: 0.7 }, caps, lifecycle);
}

function normalizeMime(format) {
  if (!format) return 'image/png';
  const f = String(format).toLowerCase();
  if (f.startsWith('image/')) return f === 'image/jpg' ? 'image/jpeg' : f;
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg';
  if (f === 'png' || f === 'webp') return `image/${f}`;
  return f; // pass-through so unknown values are caught downstream
}

// --- helpers ---------------------------------------------------------------

function makeCanvas(w, h) {
  // Prefer OffscreenCanvas where available (no DOM pollution, parallel-able
  // in workers if we ever lift export off-main-thread). Fall back to a
  // detached <canvas>. Both expose the same 2D context API for our purposes.
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(w, h);
    } catch {
      // Fall through to <canvas>.
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Compute the (crop + 90s rotate) dimensions, ignoring any resize directive.
// effectiveImageSize bakes in the resize at the end; we want the size of the
// "raw bake" before scaling.
function computePreResizeDims(imageState) {
  const sw = imageState.source.width || 0;
  const sh = imageState.source.height || 0;
  const crop = imageState.transforms && imageState.transforms.crop;
  let w = sw, h = sh;
  if (crop && Number.isFinite(crop.w) && Number.isFinite(crop.h)) {
    w = crop.w;
    h = crop.h;
  }
  const rot = (imageState.transforms && imageState.transforms.rotate) || 0;
  const norm = ((rot % 360) + 360) % 360;
  if (norm === 90 || norm === 270) {
    const tmp = w; w = h; h = tmp;
  } else if (norm !== 0 && norm !== 180) {
    // Non-90 rotation: axis-aligned bounding box. Mirrors geometry.rotateRect.
    const rad = norm * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const oW = w * cos + h * sin;
    const oH = w * sin + h * cos;
    w = oW;
    h = oH;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

// Build a source-sized canvas with the bitmap drawn and chromakey/bgMask
// applied via per-pixel alpha multiplication. Returns the bitmap untouched
// if neither mask is set. Mirrors previewRenderer's masked-source approach.
function applyMasksToSource(bitmap, imageState) {
  const w = imageState.source.width;
  const h = imageState.source.height;
  const cMask = imageState.chromakeyMask;
  const bMask = imageState.bgMask;
  const hasMasks = (cMask && cMask.length === w * h) || (bMask && bMask.length === w * h);
  if (!hasMasks) return bitmap;

  const masked = makeCanvas(w, h);
  const ctx = masked.getContext('2d');
  if (!ctx) return bitmap;
  ctx.drawImage(bitmap, 0, 0);

  const idata = ctx.getImageData(0, 0, w, h);
  const px = idata.data;
  const total = w * h;
  const cOk = !!(cMask && cMask.length === total);
  const bOk = !!(bMask && bMask.length === total);
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    let a = px[i + 3];
    if (cOk) a = (a * cMask[p]) / 255;
    if (bOk) a = (a * bMask[p]) / 255;
    px[i + 3] = a;
  }
  ctx.putImageData(idata, 0, 0);
  return masked;
}

// Draw the source (possibly pre-masked) into the working canvas through the
// transform stack: translate to center → rotate → flip → drawImage from the
// crop region centered on (0, 0).
function drawTransformedSource(ctx, source, imageState, outDims) {
  const t = imageState.transforms || {};
  const crop = t.crop;
  const src = (crop && crop.w > 0 && crop.h > 0)
    ? crop
    : { x: 0, y: 0, w: imageState.source.width, h: imageState.source.height };
  const rot = ((t.rotate || 0) % 360 + 360) % 360;
  const flipH = !!t.flipH;
  const flipV = !!t.flipV;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(outDims.w / 2, outDims.h / 2);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  if (flipH || flipV) ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(
    source,
    src.x, src.y, src.w, src.h,
    -src.w / 2, -src.h / 2, src.w, src.h,
  );
  ctx.restore();
}

// Apply adjustments + filter preset. Two paths:
//   - caps.ctxFilter: use ctx.filter for a fast GPU-backed re-draw. Because
//     ctx.filter can't read from the same canvas it writes to (the spec
//     allows undefined results), we draw the current canvas into a temp
//     canvas first, then draw the temp back through the filter.
//   - software fallback: getImageData + softwareApply + putImageData.
//     Blur is NOT applied in the fallback (softwareApply doesn't include
//     it); the exporter.js surface this with a toast before triggering the
//     bake.
async function applyAdjustments(ctx, canvas, imageState, caps) {
  const adjust = imageState.adjust || { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
  const preset = imageState.filterPreset || 'none';
  const filterStr = cssFilterString(adjust, preset, adjust.blur);
  if (filterStr === 'none') return;

  if (caps && caps.ctxFilter) {
    // Fast path. The temp canvas absorbs the read; we then clear the
    // working canvas and re-draw the temp through ctx.filter.
    const tmp = makeCanvas(canvas.width, canvas.height);
    const tmpCtx = tmp.getContext('2d');
    if (!tmpCtx) return;
    tmpCtx.drawImage(canvas, 0, 0);
    ctx.save();
    ctx.filter = filterStr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    return;
  }

  // Software fallback. Skip blur (documented gap; exporter warns).
  // Pass adjust + preset through unmodified — softwareApply ignores blur.
  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (err) {
    // Tainted canvas or OOM — surface as an export failure rather than
    // silently shipping an unadjusted image.
    throw new Error(`adjust_software_path_failed: ${err.message}`);
  }
  softwareApply(imageData, adjust, preset);
  ctx.putImageData(imageData, 0, 0);
}

// Apply each redact overlay's pixel-mutating effect to the working canvas
// in place. The redact rect lives in SOURCE-pixel space; we transform its
// corners through the same forward transform the bitmap took, take the
// axis-aligned bounding box, then hand that rect off to applyRedactFx
// (which works in canvas-pixel coords).
//
// For 0/90/180/270 rotations — the only ones the toolbar exposes — the AABB
// is identical to the rotated rect. Arbitrary rotations would over-cover
// the corners by a few pixels; harmless for redaction.
function applyRedactsToCanvas(ctx, imageState, outDims, caps) {
  const overlays = imageState.overlays;
  if (!overlays || !Array.isArray(overlays) || overlays.length === 0) return;

  const t = imageState.transforms || {};
  const crop = t.crop;
  const src = (crop && crop.w > 0 && crop.h > 0)
    ? crop
    : { x: 0, y: 0, w: imageState.source.width, h: imageState.source.height };
  const rot = ((t.rotate || 0) % 360 + 360) % 360;
  const flipH = !!t.flipH;
  const flipV = !!t.flipV;
  const rad = rot * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Forward: source pixel → working canvas pixel. Mirrors drawTransformedSource.
  function sourceToCanvas(sx, sy) {
    // 1. Subtract crop center → coords in source space centered on the crop.
    let x = sx - src.x - src.w / 2;
    let y = sy - src.y - src.h / 2;
    // 2. Apply flip.
    if (flipH) x = -x;
    if (flipV) y = -y;
    // 3. Rotate.
    if (rot) {
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      x = rx; y = ry;
    }
    // 4. Translate to canvas center.
    x += outDims.w / 2;
    y += outDims.h / 2;
    return { x, y };
  }

  for (const o of overlays) {
    if (!o || o.type !== 'redact') continue;
    const corners = [
      sourceToCanvas(o.x,         o.y        ),
      sourceToCanvas(o.x + o.w,   o.y        ),
      sourceToCanvas(o.x + o.w,   o.y + o.h  ),
      sourceToCanvas(o.x,         o.y + o.h  ),
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }
    const x = Math.max(0, Math.floor(minX));
    const y = Math.max(0, Math.floor(minY));
    const w = Math.max(1, Math.ceil(maxX - minX));
    const h = Math.max(1, Math.ceil(maxY - minY));
    applyRedactFx(ctx, {
      x, y, w, h,
      mode: o.mode,
      strength: o.strength,
      color: o.color, // bug fix: was being dropped, so every mask exported black
    }, caps);
  }
}

// Draw committed overlays at their source-pixel coordinates. Mirrors the
// preview renderer's overlay transform: the working canvas is sized to the
// post-crop/rotate output, so we set up a transform from source pixels to
// that output and dispatch each overlay's drawer.
function drawOverlaysAtSourcePixels(ctx, imageState, outDims) {
  const overlays = imageState.overlays;
  if (!overlays || !Array.isArray(overlays) || overlays.length === 0) return;

  const t = imageState.transforms || {};
  const crop = t.crop;
  const src = (crop && crop.w > 0 && crop.h > 0)
    ? crop
    : { x: 0, y: 0, w: imageState.source.width, h: imageState.source.height };
  const rot = ((t.rotate || 0) % 360 + 360) % 360;
  const flipH = !!t.flipH;
  const flipV = !!t.flipV;

  ctx.save();
  ctx.translate(outDims.w / 2, outDims.h / 2);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  if (flipH || flipV) ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  // Now we are in source-pixel space centered on the crop region's center.
  // Translate so source-pixel (srcX, srcY) maps to the working-canvas origin
  // of the cropped region.
  ctx.translate(-src.x - src.w / 2, -src.y - src.h / 2);

  for (const overlay of overlays) {
    if (!overlay) continue;
    try {
      drawOverlaySync(ctx, overlay, overlayDrawers);
    } catch (err) {
      // Don't let one broken overlay nuke the export — log and continue.
      // eslint-disable-next-line no-console
      console.warn('exportRenderer: overlay draw failed', err && err.message);
    }
  }
  ctx.restore();
}

function needsResize(preResize, finalDims) {
  return Math.round(preResize.w) !== Math.round(finalDims.w)
      || Math.round(preResize.h) !== Math.round(finalDims.h);
}

function downscale(source, w, h) {
  const dst = makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = dst.getContext('2d');
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, dst.width, dst.height);
  return dst;
}
