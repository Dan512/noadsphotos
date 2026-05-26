// js/render/previewRenderer.js — base + overlay canvas renderer.
//
// Subscribes to state. When the editor view is active with an active image,
// keeps the canvas elements sized appropriately (CSS size = image × zoom;
// internal size = CSS size × DPR, capped at caps.maxCanvasSize) and runs a
// rAF loop that redraws whenever the image's dirty flags say to.
//
// Phase 2 scope:
//   - drawBase: clear + draw bitmap centered (transforms/chromakey/bgMask are
//     baked-in placeholders for future phases; for now this is just a
//     drawImage at canvas pixel dims).
//   - drawOverlays: just clears overlay canvas (nothing to draw yet).
//   - Async bitmap retry: if ensureBitmap hasn't resolved, mark baseDirty so
//     the next frame retries after the decode commits.
import { getState, subscribe, update } from './../state.js';
// Note: update is used by both compare-drag and OCR preview toggle.
import { markClean } from './renderCache.js';
import { cssFilterString } from '../ops/adjust.js';
import { drawText } from '../ops/text.js';
import { drawBrush } from '../ops/brush.js';
import { drawShape } from '../ops/shape.js';
import { drawRedact, applyRedactFx } from '../ops/redact.js';
import { drawOverlaySync, getOverlayBounds } from '../overlays.js';
import { getSetting } from '../settings.js';
import { effectiveImageSize } from '../geometry.js';
import { applyWatermark } from '../ops/watermark.js';
import { getCachedWatermarkBitmap } from '../tools/watermarkTool.js';

// Module-level registry of per-type overlay drawers. All four kinds are
// registered upfront — they're cheap pure functions and avoiding dynamic
// imports on the hot render loop keeps the cost of a frame predictable.
//
// brush is wrapped so the renderer can pass the user's
// `smoothBrushStrokes` setting through to drawBrush without every caller
// having to know about it.
// Redact is intentionally a no-op here: its actual effect is baked into the
// BASE canvas (see applyRedactsToBase below), not painted onto the overlay
// canvas as a separate layer. The selection indicator for a selected redact
// is drawn out-of-band in drawSelection().
const overlayDrawers = Object.freeze({
  text:   drawText,
  brush:  (ctx, brush) => drawBrush(ctx, brush, { smooth: getSetting('smoothBrushStrokes') !== false }),
  shape:  drawShape,
  redact: () => { /* baked into base; nothing to draw on overlay canvas */ },
});

const FRAME_PADDING = 16; // pixels inside .canvas-frame reserved for the zoom controls + margin

// --- Masked-source cache ----------------------------------------------------
//
// When an image has a chromakeyMask or bgMask, we apply those masks to the
// source bitmap in an offscreen canvas (at source resolution) once per mask
// change, then use that canvas as the drawImage input. The cache key is the
// pair (chromakeyMask, bgMask) — both Uint8Array instances are immutable per
// design (callers swap the whole array; never mutate in place), so a
// WeakMap-of-WeakMaps lookup never returns a stale canvas.
//
// Cache shape:
//   maskedSourceCache: WeakMap<bitmap, WeakMap<chromakeyMaskOrSentinel, WeakMap<bgMaskOrSentinel, canvas>>>
// A small sentinel object stands in for "no mask" so the WeakMap key is
// always an object reference. Cache entries are GC'd when any of the keying
// objects (bitmap or mask) becomes unreachable.
const NO_MASK_SENTINEL = Object.freeze({ __noMask: true });
const maskedSourceCache = new WeakMap();

function getMaskedSourceCanvas(img) {
  const bitmap = img.source.bitmap;
  if (!bitmap) return null;
  const cMask = img.chromakeyMask || NO_MASK_SENTINEL;
  const bMask = img.bgMask        || NO_MASK_SENTINEL;
  if (cMask === NO_MASK_SENTINEL && bMask === NO_MASK_SENTINEL) {
    // No masks → no need for an offscreen canvas; the renderer should draw
    // the raw bitmap.
    return null;
  }
  let l1 = maskedSourceCache.get(bitmap);
  if (!l1) {
    l1 = new WeakMap();
    maskedSourceCache.set(bitmap, l1);
  }
  let l2 = l1.get(cMask);
  if (!l2) {
    l2 = new WeakMap();
    l1.set(cMask, l2);
  }
  let canvas = l2.get(bMask);
  if (!canvas) {
    canvas = buildMaskedSourceCanvas(img);
    if (canvas) l2.set(bMask, canvas);
  }
  return canvas;
}

function buildMaskedSourceCanvas(img) {
  const bitmap = img.source.bitmap;
  const w = img.source.width;
  const h = img.source.height;
  if (!bitmap || !w || !h) return null;

  // Prefer OffscreenCanvas where available; fall back to a detached
  // <canvas>. Both expose the same 2d context API for our purposes.
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);

  const cMask = img.chromakeyMask;
  const bMask = img.bgMask;
  if (cMask || bMask) {
    const total = w * h;
    // Guard: if a mask is wrong-sized for any reason, skip applying it
    // rather than reading out of bounds. This lets callers swap masks
    // safely while sources change shape (it shouldn't happen, but...).
    const cOk = cMask && cMask.length === total;
    const bOk = bMask && bMask.length === total;
    if (cOk || bOk) {
      const idata = ctx.getImageData(0, 0, w, h);
      const px = idata.data;
      for (let p = 0, i = 0; p < total; p++, i += 4) {
        let a = px[i + 3];
        if (cOk) a = (a * cMask[p]) / 255;
        if (bOk) a = (a * bMask[p]) / 255;
        // The 2D context's putImageData clamps automatically, but we round
        // here for explicitness — a slightly fractional alpha would still
        // be clamped to 0..255.
        px[i + 3] = a;
      }
      ctx.putImageData(idata, 0, 0);
    }
  }

  return canvas;
}

// Module-level overlay drawer registry. Tools (cropTool, redactTool, …) call
// setOverlayDrawer() on activation so the rAF tick gives them a chance to
// paint into the overlay canvas AFTER it's been cleared. The function is
// invoked with (overlayCtx, overlayCanvas) every frame the overlay is
// drawn — i.e. on every tick while `overlaysDirty` was true OR on every
// tick while we keep marking the overlay dirty.
let overlayDrawer = null;

export function setOverlayDrawer(fn) {
  overlayDrawer = typeof fn === 'function' ? fn : null;
}

export function clearOverlayDrawer() {
  overlayDrawer = null;
}

// Module-level snapshot of the renderer's current forward-draw parameters,
// captured each frame the base canvas is drawn. canvasToSource() and the
// overlay-draw transform setup both read from this so the inverse mapping is
// always in lockstep with what was last painted to the base canvas.
//
// Shape:
//   { canvasW, canvasH, srcX, srcY, srcW, srcH, rot, flipH, flipV,
//     drawScale, drawW, drawH }
// where drawScale converts source pixels → canvas internal pixels.
let lastDrawState = null;

// Forward: source-pixel point → canvas-internal-pixel point. Mirrors the
// transform sequence used by drawBase / drawOverlays so the inverse used by
// canvasToSource stays in step.
function sourceToCanvasInternal(p, ds) {
  // Matches drawBase's chain (numbered same as the comment there).
  // 1. Subtract crop origin so the cropped area's top-left maps to (0,0)
  //    in source space.
  let x = p.x - ds.srcX - ds.srcW / 2;
  let y = p.y - ds.srcY - ds.srcH / 2;
  // 2. Apply flip (source frame).
  if (ds.flipH) x = -x;
  if (ds.flipV) y = -y;
  // 3. Apply rotation (still source-pixel units).
  if (ds.rot) {
    const rad = ds.rot * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    x = rx; y = ry;
  }
  // 4. Aspect-fit scale (non-uniform when resize squishes the image).
  x *= ds.aspectScaleX;
  y *= ds.aspectScaleY;
  // 5. Translate to canvas center.
  x += ds.canvasW / 2;
  y += ds.canvasH / 2;
  return { x, y };
}

// Map a source-pixel rect to its axis-aligned bounding box in canvas-internal
// pixel space, using the supplied draw-state. For 0/90/180/270 rotations the
// result is exact; for arbitrary rotations the AABB envelopes the rotated
// rect (the redact effect then covers a few extra pixels in the corners,
// which is harmless — better that than missing pixels inside the user's
// region).
function sourceRectToCanvasAABB(r, ds) {
  if (!r || !ds) return null;
  const corners = [
    { x: r.x,        y: r.y        },
    { x: r.x + r.w,  y: r.y        },
    { x: r.x + r.w,  y: r.y + r.h  },
    { x: r.x,        y: r.y + r.h  },
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of corners) {
    const p = sourceToCanvasInternal(c, ds);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const w = Math.max(1, Math.ceil(maxX - minX));
  const h = Math.max(1, Math.ceil(maxY - minY));
  return { x, y, w, h };
}

// Apply the renderer's current SOURCE → canvas-internal-pixel forward
// transform to the given context. Tools that paint a live preview from
// their per-tool overlayDrawer can call this so source-pixel coordinates
// land at the same canvas pixels as the committed overlays the renderer
// just drew. The context state is wrapped in save()/restore() by the
// caller (we don't do it here — callers may need to layer more state).
//
// Returns true if the transform was applied; false if there's no active
// image yet (in which case the caller should skip drawing).
export function applySourceTransform(ctx) {
  const ds = lastDrawState;
  if (!ds || !ctx) return false;
  // Match drawBase's chain (see comment there for ordering rationale).
  // Caller draws in source-pixel coords; we ensure they land in the same
  // canvas pixels the base bitmap occupies, including any aspect squish.
  ctx.translate(ds.canvasW / 2, ds.canvasH / 2);
  ctx.scale(ds.aspectScaleX, ds.aspectScaleY);
  if (ds.rot) ctx.rotate(ds.rot * Math.PI / 180);
  if (ds.flipH || ds.flipV) ctx.scale(ds.flipH ? -1 : 1, ds.flipV ? -1 : 1);
  ctx.translate(-ds.srcX - ds.srcW / 2, -ds.srcY - ds.srcH / 2);
  return true;
}

// Return the current SOURCE→canvas-CSS-pixel scale. One source pixel
// renders as `getDisplayZoom()` CSS pixels on screen, at the current zoom
// and image transform. Tools that need a CSS-pixel target (e.g. textTool's
// default font size of ~24 CSS px regardless of image size) use this to
// back-calculate the source-space value.
//
// Returns null if the renderer hasn't drawn a frame yet (no active image)
// or the overlay canvas is missing.
export function getDisplayZoom() {
  const ds = lastDrawState;
  if (!ds || !ds.drawScale) return null;
  const overlay = typeof document !== 'undefined'
    ? document.getElementById('overlay-canvas')
    : null;
  if (!overlay) return null;
  const cssW = parseFloat(overlay.style.width) || overlay.width;
  if (!cssW || !overlay.width) return null;
  // `drawScale` is source→canvas-internal-pixel; multiply by
  // (cssW / canvasInternalW) to land in CSS pixels.
  return ds.drawScale * (cssW / overlay.width);
}

// Inverse: canvas-element CSS-pixel point → source-pixel point. Used by
// tools (e.g. textTool) so a click on the overlay element lands in the
// correct image-pixel position regardless of zoom/rotate/flip/crop.
//
// The input is in CSS pixels relative to the overlay canvas element (the
// same space attachPointer reports). We first convert to canvas-internal
// pixels by multiplying by canvasInternalW / canvasCssW, then invert each
// step of the forward transform.
export function canvasToSource(p) {
  const ds = lastDrawState;
  if (!ds) return null;
  const overlay = document.getElementById('overlay-canvas');
  if (!overlay) return null;
  const cssW = parseFloat(overlay.style.width) || overlay.width;
  const cssH = parseFloat(overlay.style.height) || overlay.height;
  if (!cssW || !cssH) return null;
  // CSS → internal pixel scaling.
  const ix = (p.x / cssW) * overlay.width;
  const iy = (p.y / cssH) * overlay.height;

  // Reverse step 5: subtract canvas center.
  let x = ix - ds.canvasW / 2;
  let y = iy - ds.canvasH / 2;
  // Reverse step 4: undo aspect-fit scale.
  if (!ds.aspectScaleX || !ds.aspectScaleY) return null;
  x /= ds.aspectScaleX;
  y /= ds.aspectScaleY;
  // Reverse step 3: inverse rotation.
  if (ds.rot) {
    const rad = -ds.rot * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    x = rx; y = ry;
  }
  // Reverse step 2: inverse flip.
  if (ds.flipH) x = -x;
  if (ds.flipV) y = -y;
  // Reverse step 1: add crop origin + half source dims.
  x += ds.srcX + ds.srcW / 2;
  y += ds.srcY + ds.srcH / 2;
  return { x, y };
}

// Read --accent from the root style. Cheap; uses the same fallback color
// used elsewhere in the editor.
function getAccent() {
  try {
    const styles = getComputedStyle(document.documentElement);
    const v = styles.getPropertyValue('--accent').trim();
    if (v) return v;
  } catch { /* ignore */ }
  return '#2a8c69';
}

export function initPreviewRenderer(lifecycle, caps) {
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const maxSize = (caps && caps.maxCanvasSize) || 4096;

  let baseCanvas = null;
  let overlayCanvas = null;
  let frameEl = null;
  let baseCtx = null;
  let overlayCtx = null;

  // Sizing memo so we only mutate canvas dims when they actually change.
  let lastSizingKey = '';

  // Last seen active id so we can kick lifecycle.setWindow on transitions.
  let lastActiveId = null;

  // rAF handle.
  let raf = null;

  // Bind DOM refs lazily on first tick — editor.js may not have mounted yet
  // when initPreviewRenderer is called during boot.
  function bindDom() {
    if (baseCanvas && overlayCanvas && frameEl) return true;
    baseCanvas    = document.getElementById('base-canvas');
    overlayCanvas = document.getElementById('overlay-canvas');
    frameEl       = baseCanvas ? baseCanvas.parentElement : null;
    if (!baseCanvas || !overlayCanvas || !frameEl) return false;
    baseCtx    = baseCanvas.getContext('2d');
    overlayCtx = overlayCanvas.getContext('2d');
    return true;
  }

  // Compute the effective zoom factor from state. 'fit' returns the auto-fit
  // factor that keeps the image inside the frame without upscaling beyond 1×.
  function effectiveZoom(state, imgW, imgH) {
    const z = state.ui.zoom;
    if (z !== 'fit' && Number.isFinite(z) && z > 0) return z;
    // Compute fit. Frame might be hidden (0×0) if editor not yet visible.
    const rect = frameEl.getBoundingClientRect();
    const fw = Math.max(1, rect.width  - FRAME_PADDING * 2);
    const fh = Math.max(1, rect.height - FRAME_PADDING * 2);
    return Math.min(fw / imgW, fh / imgH, 1);
  }

  // Given an image, return its OUTPUT dims after applying crop + 90°-rotate
  // + resize. Used by sizeCanvases so the visible canvas matches the target
  // shape, including aspect-changing resize (e.g. "exact 200×400" from a
  // square source).
  //
  // For aspect-preserving resize (longestSide / percent / width / height /
  // etc.), the canvas shrinks proportionally — the bitmap fills it cleanly
  // and the pixelation pre-pass in `applyResizePixelation` still kicks in
  // when the canvas's painted pixel count exceeds the export's pixel
  // budget, so pixelation feedback is preserved.
  //
  // For aspect-changing resize ('exact' with mismatched value/height), the
  // canvas takes the new aspect ratio and the bitmap is drawn
  // proportionally centered inside it — bars in the unfilled region show
  // through as the page background. This is informational signal: the
  // export will squish the bitmap to fill the target shape (not letterbox),
  // and the bars tell the user "your source doesn't natively fit." A v1.3
  // refinement could make the preview squish-match-export by splitting
  // drawScale into per-axis factors; out of scope for this fix.
  function postTransformDims(img) {
    return effectiveImageSize(img);
  }

  function sizeCanvases(img) {
    const s = getState();
    const dims = postTransformDims(img);
    const w = dims.w;
    const h = dims.h;
    if (!w || !h) return;

    const zoom = effectiveZoom(s, w, h);
    // CSS size (logical pixels).
    let cssW = Math.max(1, Math.round(w * zoom));
    let cssH = Math.max(1, Math.round(h * zoom));
    // Internal pixel size capped at maxCanvasSize.
    let pixW = Math.min(maxSize, Math.round(cssW * dpr));
    let pixH = Math.min(maxSize, Math.round(cssH * dpr));
    // If we hit the cap, recompute the CSS size so the canvas remains visually
    // sized to its internal-pixel-resolution × (1/dpr) instead of stretching.
    if (pixW < cssW * dpr) cssW = Math.round(pixW / dpr);
    if (pixH < cssH * dpr) cssH = Math.round(pixH / dpr);

    // Key now includes the rotated/cropped dims so a transform that swaps
    // post-rotation orientation forces a re-fit.
    const key = `${cssW}x${cssH}@${pixW}x${pixH}`;
    if (key === lastSizingKey) return;
    lastSizingKey = key;

    for (const c of [baseCanvas, overlayCanvas]) {
      c.width  = pixW;
      c.height = pixH;
      c.style.width  = cssW + 'px';
      c.style.height = cssH + 'px';
    }
    // Re-bake on resize.
    img.baseDirty = true;
    img.overlaysDirty = true;
  }

  // Capture the forward-draw parameters for the active image. Called every
  // frame from `tick` so canvasToSource and the overlay transform setup stay
  // in lockstep with whatever the base canvas was last painted with — even
  // on frames where drawBase isn't re-invoked (because nothing changed).
  function captureDrawState(img) {
    if (!baseCanvas) return null;
    const { crop, rotate, flipH, flipV } = img.transforms;
    const src = crop && crop.w > 0 && crop.h > 0
      ? crop
      : { x: 0, y: 0, w: img.source.width, h: img.source.height };
    const rot = ((rotate % 360) + 360) % 360;
    let outW, outH;
    if (rot === 90 || rot === 270) {
      outW = src.h; outH = src.w;
    } else if (rot === 0 || rot === 180) {
      outW = src.w; outH = src.h;
    } else {
      const rad = rot * Math.PI / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      outW = src.w * cos + src.h * sin;
      outH = src.w * sin + src.h * cos;
    }
    const canvasW = baseCanvas.width;
    const canvasH = baseCanvas.height;
    if (!canvasW || !canvasH || !outW || !outH) return null;
    // v1.2.x: per-axis aspect-fit scale. When resize.mode === 'exact' with
    // mismatched dims, aspectScaleX ≠ aspectScaleY and the bitmap squishes
    // to fill the canvas — matching what the export pipeline does.
    // `drawScale` (uniform, min of the two) is kept for the few consumers
    // that still need a single scalar (blur radius, zoom calc).
    const aspectScaleX = canvasW / outW;
    const aspectScaleY = canvasH / outH;
    const drawScale = Math.min(aspectScaleX, aspectScaleY);
    return {
      canvasW, canvasH,
      srcX: src.x, srcY: src.y, srcW: src.w, srcH: src.h,
      outW, outH,
      rot, flipH: !!flipH, flipV: !!flipV,
      aspectScaleX, aspectScaleY,
      // Back-compat aliases — code that hasn't been updated to per-axis
      // semantics still works (using the uniform min). drawW/drawH are
      // computed as if no aspect change so the pixelation-pre-pass
      // threshold reads sensibly.
      drawScale,
      drawW: src.w * drawScale,
      drawH: src.h * drawScale,
    };
  }

  function drawBase(img) {
    if (!baseCtx) return;
    const bitmap = img.source.bitmap;
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    if (!bitmap) {
      // No bitmap yet — request decode and let the next tick retry.
      lifecycle.ensureBitmap(img.id).catch(err => {
        console.error('previewRenderer: ensureBitmap failed', err);
      });
      // Keep baseDirty true so the next frame redraws once the bitmap commits.
      return false;
    }

    // If chromakey or bgMask is set, draw from a pre-masked offscreen canvas
    // at source resolution instead of the raw bitmap. The masked canvas is
    // cached on a WeakMap keyed by the mask Uint8Array, so identical masks
    // reuse the same canvas across frames (masks are immutable per design).
    const sourceImage = getMaskedSourceCanvas(img) || bitmap;

    const ds = lastDrawState;
    if (!ds) return false;

    baseCtx.imageSmoothingEnabled = true;
    baseCtx.imageSmoothingQuality = 'high';
    baseCtx.save();
    // Transform chain (innermost → outermost; ctx applies last-set first):
    //   1. drawImage centered at (0, 0) at SOURCE dimensions
    //   2. flip (source frame)
    //   3. rotate (still source frame)
    //   4. aspect-fit scale — moves into canvas frame; non-uniform when
    //      resize.mode === 'exact' with mismatched dims, so the bitmap
    //      squishes to fill instead of letterboxing
    //   5. translate to canvas center
    baseCtx.translate(ds.canvasW / 2, ds.canvasH / 2);
    baseCtx.scale(ds.aspectScaleX, ds.aspectScaleY);
    if (ds.rot) baseCtx.rotate(ds.rot * Math.PI / 180);
    if (ds.flipH || ds.flipV) baseCtx.scale(ds.flipH ? -1 : 1, ds.flipV ? -1 : 1);
    baseCtx.drawImage(
      sourceImage,
      ds.srcX, ds.srcY, ds.srcW, ds.srcH,
      -ds.srcW / 2, -ds.srcH / 2, ds.srcW, ds.srcH,
    );
    baseCtx.restore();

    // Apply redact overlays directly to the base canvas. Each redact overlay
    // is rectangular in source-pixel space; we transform its corners through
    // the same forward transform the bitmap took, take the AABB, then call
    // applyRedactFx on the base canvas in raw-pixel coords. For arbitrary
    // rotations this can include a small sliver of pixels just outside the
    // user's rectangle (the AABB envelope), but for 0/90/180/270 — the only
    // rotations the toolbar offers — the mapping stays axis-aligned.
    applyRedactsToBase(img, ds);

    // Resize pixelation pre-pass. When `transforms.resize` shrinks the export
    // output below the canvas's current data resolution, we downsample the
    // base canvas to that smaller pixel count and then upsample it back with
    // nearest-neighbor — giving the user an honest visual preview of what
    // the export pixel budget looks like. Only applied when the resize's
    // long-side output is strictly less than the bitmap's painted long side,
    // because upsizing doesn't add pixelation.
    applyResizePixelation(img, ds);

    // Compare-with-original split (v1.2). If ui.compareMode is on, overpaint
    // the LEFT half of the canvas with the raw source bitmap (no transforms,
    // no adjustments, no overlays) so the user can A/B their edits against
    // the original. The split position is ui.compareSplit ∈ [0, 1] — for now
    // we ship a fixed 50/50 with a draggable divider as a follow-up if
    // anyone asks.
    applyCompareSplit(img, ds);

    // Watermark pass (v1.3 Feature 12). Painted AFTER compare-split so the
    // user sees the watermark on whichever side will actually be exported
    // (the right-hand "edited" side). The watermark itself is a global
    // setting (state.ui.watermark) — not part of img.overlays — so it
    // applies uniformly across the queue. Mirrors the exportRenderer pass
    // exactly: same applyWatermark, same canvas dims.
    applyWatermarkPass(img, ds);

    return true;
  }

  function applyWatermarkPass(img, ds) {
    if (!baseCtx || !ds) return;
    const wm = getState().ui && getState().ui.watermark;
    if (!wm || !wm.enabled) return;
    // In compare mode, restrict the watermark to the RIGHT (edited) side so
    // the original on the left stays clean — gives the user an honest
    // before/after where the watermark is part of "after."
    const s = getState();
    const compareMode = s.ui && s.ui.compareMode;
    baseCtx.save();
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (compareMode) {
      const split = Math.max(0, Math.min(1, Number.isFinite(s.ui.compareSplit) ? s.ui.compareSplit : 0.5));
      const splitX = Math.round(ds.canvasW * split);
      baseCtx.beginPath();
      baseCtx.rect(splitX, 0, ds.canvasW - splitX, ds.canvasH);
      baseCtx.clip();
    }
    applyWatermark(baseCtx, {
      canvasWidth: ds.canvasW,
      canvasHeight: ds.canvasH,
      watermark: wm,
      imageBitmap: wm.type === 'image' ? getCachedWatermarkBitmap() : null,
    });
    baseCtx.restore();
  }

  // Draw the raw source bitmap into the left portion of the base canvas
  // (clipped at `ui.compareSplit`) plus a thin vertical divider line. Runs
  // AFTER drawBase + applyRedactsToBase + applyResizePixelation, so what
  // gets covered is the fully-edited render — the user sees original on
  // the left, every-edit-applied on the right, and the seam between them.
  function applyCompareSplit(img, ds) {
    if (!baseCtx || !ds) return;
    const s = getState();
    if (!s.ui || !s.ui.compareMode) return;
    const split = Math.max(0, Math.min(1, Number.isFinite(s.ui.compareSplit) ? s.ui.compareSplit : 0.5));
    const splitX = Math.round(ds.canvasW * split);
    if (splitX <= 0) return; // nothing to overdraw

    const bitmap = img.source.bitmap;
    if (!bitmap) return;
    const src = ds.srcX != null
      ? { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
      : { x: 0, y: 0, w: bitmap.width, h: bitmap.height };

    baseCtx.save();
    // Clip to the LEFT region only — leaves the right half untouched
    // (which is still the fully-edited render).
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.beginPath();
    baseCtx.rect(0, 0, splitX, ds.canvasH);
    baseCtx.clip();
    baseCtx.clearRect(0, 0, splitX, ds.canvasH);

    // Draw the source bitmap centered + scaled to match the canvas (so the
    // original and the edit align spatially — same crop/zoom). We ignore
    // crop/rotate/flip on the LEFT side: the whole point is to see the
    // unmodified original.
    const fit = Math.min(ds.canvasW / src.w, ds.canvasH / src.h);
    const drawW = src.w * fit;
    const drawH = src.h * fit;
    baseCtx.imageSmoothingEnabled = true;
    baseCtx.imageSmoothingQuality = 'high';
    baseCtx.drawImage(
      bitmap,
      src.x, src.y, src.w, src.h,
      (ds.canvasW - drawW) / 2, (ds.canvasH - drawH) / 2, drawW, drawH,
    );
    baseCtx.restore();

    // Divider line + a grab-handle pill centered vertically. The handle is
    // a shape-based affordance (not just color) so it reads as "draggable"
    // for colorblind users too. Drag handler lives in attachCompareDragHandlers
    // below — tolerance is 12 CSS pixels around the divider X.
    baseCtx.save();
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    baseCtx.fillRect(splitX - 1, 0, 2, ds.canvasH);
    baseCtx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    baseCtx.lineWidth = 1;
    baseCtx.strokeRect(splitX - 1, 0, 2, ds.canvasH);

    // Grab handle pill. Sized as a fraction of canvas height with min/max
    // clamps so it stays usable on both tiny thumbnails and huge previews.
    const handleH = Math.min(48, Math.max(24, ds.canvasH * 0.07));
    const handleW = 14;
    const hx = splitX - handleW / 2;
    const hy = (ds.canvasH - handleH) / 2;
    const r = Math.min(6, handleW / 2);
    baseCtx.fillStyle   = 'rgba(255, 255, 255, 0.95)';
    baseCtx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    baseCtx.lineWidth   = 1;
    baseCtx.beginPath();
    baseCtx.moveTo(hx + r,           hy);
    baseCtx.lineTo(hx + handleW - r, hy);
    baseCtx.quadraticCurveTo(hx + handleW, hy,             hx + handleW, hy + r);
    baseCtx.lineTo(hx + handleW,     hy + handleH - r);
    baseCtx.quadraticCurveTo(hx + handleW, hy + handleH,   hx + handleW - r, hy + handleH);
    baseCtx.lineTo(hx + r,           hy + handleH);
    baseCtx.quadraticCurveTo(hx,     hy + handleH,         hx,           hy + handleH - r);
    baseCtx.lineTo(hx,               hy + r);
    baseCtx.quadraticCurveTo(hx,     hy,                   hx + r,       hy);
    baseCtx.closePath();
    baseCtx.fill();
    baseCtx.stroke();

    // Two chevron arrows inside the pill, pointing outward (← →).
    baseCtx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    baseCtx.lineWidth   = 1.5;
    baseCtx.lineCap     = 'round';
    baseCtx.lineJoin    = 'round';
    const midY = ds.canvasH / 2;
    baseCtx.beginPath();
    baseCtx.moveTo(splitX - 2, midY - 4);
    baseCtx.lineTo(splitX - 5, midY);
    baseCtx.lineTo(splitX - 2, midY + 4);
    baseCtx.moveTo(splitX + 2, midY - 4);
    baseCtx.lineTo(splitX + 5, midY);
    baseCtx.lineTo(splitX + 2, midY + 4);
    baseCtx.stroke();
    baseCtx.restore();
  }

  // Scratch offscreen canvas for the resize-pixelation pass. Reused across
  // frames; resized lazily when the export dims change. Module-local so the
  // GC keeps it alive while previewRenderer is initialized.
  let resizeScratchCanvas = null;

  function applyResizePixelation(img, ds) {
    if (!baseCtx || !ds) return;
    const resize = img && img.transforms && img.transforms.resize;
    if (!resize) return;
    const finalDims = effectiveImageSize(img);
    const eW = Math.max(1, Math.round(finalDims.w || 0));
    const eH = Math.max(1, Math.round(finalDims.h || 0));
    if (eW <= 0 || eH <= 0) return;
    // Only pixelate when the export output is smaller than the bitmap-as-
    // drawn into this canvas. Upsizing past the painted size doesn't add
    // visible degradation, so skip the pass.
    const paintedLong = Math.max(ds.drawW || 0, ds.drawH || 0);
    const finalLong = Math.max(eW, eH);
    if (finalLong >= paintedLong) return;

    // Allocate or resize the scratch canvas to the export dims.
    if (!resizeScratchCanvas || resizeScratchCanvas.width !== eW || resizeScratchCanvas.height !== eH) {
      if (typeof OffscreenCanvas !== 'undefined') {
        resizeScratchCanvas = new OffscreenCanvas(eW, eH);
      } else {
        resizeScratchCanvas = document.createElement('canvas');
        resizeScratchCanvas.width = eW;
        resizeScratchCanvas.height = eH;
      }
    }
    const offCtx = resizeScratchCanvas.getContext('2d');
    if (!offCtx) return;
    offCtx.imageSmoothingEnabled = true;
    offCtx.imageSmoothingQuality = 'high';
    offCtx.clearRect(0, 0, eW, eH);
    // Downsample the current canvas content to the export pixel budget.
    offCtx.drawImage(baseCanvas, 0, 0, eW, eH);

    // Upsample back to canvas with nearest-neighbor so pixelation is crisp
    // and obvious. The user explicitly wants "very pixelated" at tiny resize
    // values — bilinear upsampling would smear that signal.
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.imageSmoothingEnabled = false;
    baseCtx.drawImage(resizeScratchCanvas, 0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.imageSmoothingEnabled = true; // restore for any later draws this frame
  }

  // Apply each redact overlay's pixelate/blur effect to the base canvas in
  // place. Source-space coords are converted to canvas-internal pixels via
  // the renderer's forward transform.
  function applyRedactsToBase(img, ds) {
    const overlays = img && Array.isArray(img.overlays) ? img.overlays : null;
    if (!overlays || overlays.length === 0) return;
    for (const o of overlays) {
      if (!o || o.type !== 'redact') continue;
      const rect = sourceRectToCanvasAABB(o, ds);
      if (!rect) continue;
      // The blur strength is given in SOURCE pixels; scale by drawScale so
      // the radius is visually similar between preview and export (export
      // operates at source resolution, where strength is the literal radius).
      const scaledStrength = Math.max(1, Math.round(o.strength * (ds.drawScale || 1)));
      applyRedactFx(baseCtx, {
        x: rect.x, y: rect.y, w: rect.w, h: rect.h,
        mode: o.mode, strength: scaledStrength,
        color: o.color, // bug fix: was being dropped, so every mask rendered black
      }, caps);
    }
  }


  // Compute and write the CSS filter for the active image. Blur is given in
  // SOURCE pixels by the state, but on screen the image may be scaled (fit
  // zoom usually <= 1, zoom-in > 1). To keep the blur radius visually
  // consistent between preview and export we scale by displaySize /
  // sourceSize, using the smaller of the two ratios for safety so the blur
  // never appears too aggressive (consistent with the renderer's letterbox
  // logic).
  function applyCssFilter(img) {
    if (!baseCanvas) return;
    const adjust = img.adjust || { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
    const preset = img.filterPreset || 'none';

    let blurForPreview = adjust.blur;
    if (blurForPreview > 0) {
      // Source dims (post-crop, pre-rotation) tell us how big the underlying
      // pixel data is; CSS dims of the canvas tell us how it lands on
      // screen. The renderer letterboxes when source aspect != canvas
      // aspect, so the smaller ratio is the correct scale.
      const crop = img.transforms && img.transforms.crop;
      const sourceW = crop && crop.w > 0 ? crop.w : img.source.width;
      const sourceH = crop && crop.h > 0 ? crop.h : img.source.height;
      const cssW = parseFloat(baseCanvas.style.width) || baseCanvas.width;
      const cssH = parseFloat(baseCanvas.style.height) || baseCanvas.height;
      if (sourceW > 0 && sourceH > 0 && cssW > 0 && cssH > 0) {
        const scale = Math.min(cssW / sourceW, cssH / sourceH);
        blurForPreview = adjust.blur * scale;
      }
    }

    const value = cssFilterString(adjust, preset, blurForPreview);
    if (baseCanvas.style.filter !== value) {
      baseCanvas.style.filter = value;
    }
  }

  function drawOverlays(img) {
    if (!overlayCtx) return;
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // Committed overlays (text, brush, shape, redact) — draw FIRST so tools
    // can paint their interactive UI on top. We apply the same forward
    // transform the base canvas used so source-pixel coords land on the
    // same canvas pixels as the matching image pixels.
    const ds = lastDrawState;
    const overlays = img && Array.isArray(img.overlays) ? img.overlays : null;
    if (ds && overlays && overlays.length > 0) {
      overlayCtx.save();
      // Same transform as drawBase (see comment there): aspect-fit scale
      // is OUTERMOST so overlays squish in lockstep with the bitmap when
      // resize.mode === 'exact' with mismatched dims.
      overlayCtx.translate(ds.canvasW / 2, ds.canvasH / 2);
      overlayCtx.scale(ds.aspectScaleX, ds.aspectScaleY);
      if (ds.rot) overlayCtx.rotate(ds.rot * Math.PI / 180);
      if (ds.flipH || ds.flipV) overlayCtx.scale(ds.flipH ? -1 : 1, ds.flipV ? -1 : 1);
      // The overlay drawers operate in source-pixel coords; subtract the
      // crop origin so coordinate (srcX, srcY) lands at the cropped
      // region's top-left in the canvas.
      overlayCtx.translate(-ds.srcX - ds.srcW / 2, -ds.srcY - ds.srcH / 2);
      // The selected redact overlay gets its dashed bounding-box + label
      // drawn here so the user can see what they're editing. The actual
      // pixel effect is baked into the base canvas in applyRedactsToBase.
      const sSel = getState();
      const selectedId = sSel.ui && sSel.ui.selectedOverlayId;
      for (const o of overlays) {
        try {
          drawOverlaySync(overlayCtx, o, overlayDrawers);
          if (o && o.type === 'redact' && selectedId && o.id === selectedId) {
            drawRedact(overlayCtx, o);
          }
        } catch (err) {
          // Unknown overlay types (Phase 7B not yet implemented) throw —
          // log once per frame rather than spamming.
          console.warn('previewRenderer: drawOverlay failed', err.message);
        }
      }
      overlayCtx.restore();

      // Optional debug-style outlines around each overlay (settings:
      // showOverlayOutlines). Drawn AFTER the overlays themselves so the
      // outlines sit on top, in canvas-pixel space so the dash width stays
      // 1 logical pixel regardless of zoom.
      if (getSetting('showOverlayOutlines')) {
        drawOverlayOutlines(img, overlays);
      }

      // Selection adornment for the focused overlay. Drawn in canvas-pixel
      // space (no source-pixel transform) so the handle thickness doesn't
      // shrink with zoom.
      const s = getState();
      const selId = s.ui && s.ui.selectedOverlayId;
      if (selId) {
        drawSelection(img, selId);
      }
    }

    // v1.2.x OCR preview-select mode: draw a translucent box per detected
    // line in state.ui.ocrPreview.lines. Yellow when unselected, red when
    // selected. Source-pixel coordinates → use applySourceTransform.
    drawOcrPreview(img);

    // Per-tool overlay drawer (crop tool, etc.) gets the last word so it can
    // paint UI on top of any committed overlays.
    if (overlayDrawer) {
      try {
        overlayDrawer(overlayCtx, overlayCanvas);
      } catch (err) {
        console.error('previewRenderer: overlay drawer threw', err);
      }
    }
  }

  // Draw the OCR preview boxes (yellow for unselected, red for selected)
  // when state.ui.ocrPreview.active is true and the active image matches.
  // Each box is a translucent fill + 1.5px stroke in canvas-pixel space
  // (so line width stays constant across zoom).
  function drawOcrPreview(img) {
    if (!overlayCtx) return;
    const s = getState();
    const p = s.ui && s.ui.ocrPreview;
    if (!p || !p.active || !p.imageId || p.imageId !== img.id) return;
    const lines = Array.isArray(p.lines) ? p.lines : [];
    if (lines.length === 0) return;
    const ds = lastDrawState;
    if (!ds) return;

    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.lineWidth = 1.5;
    for (const line of lines) {
      if (!line || !line.rect) continue;
      const rect = sourceRectToCanvasAABB(line.rect, ds);
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;
      if (line.selected) {
        // Selected: red translucent fill + solid red border.
        overlayCtx.fillStyle   = 'rgba(220, 38, 38, 0.45)';
        overlayCtx.strokeStyle = 'rgba(220, 38, 38, 0.95)';
      } else {
        // Unselected: yellow translucent fill + amber border. autoFlag
        // gets a slightly bolder border so the user sees "this is a
        // candidate worth checking."
        overlayCtx.fillStyle   = 'rgba(250, 204, 21, 0.30)';
        overlayCtx.strokeStyle = line.autoFlag ? 'rgba(217, 119, 6, 0.95)' : 'rgba(180, 138, 10, 0.85)';
      }
      overlayCtx.fillRect(rect.x, rect.y, rect.w, rect.h);
      overlayCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    }
    overlayCtx.restore();
  }

  // Draw a 1px dashed outline around every overlay's bounding box. Used by
  // the `showOverlayOutlines` setting so users can locate overlays even when
  // they're empty (e.g. a text overlay with no content yet) or far off the
  // visible area. Distinct from drawSelection: outlines mark every overlay;
  // selection marks the focused one and adds handles.
  function drawOverlayOutlines(img, overlays) {
    if (!lastDrawState || !overlayCtx) return;
    const ds = lastDrawState;
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.lineWidth = 1;
    overlayCtx.setLineDash([4, 3]);
    overlayCtx.strokeStyle = getAccent();
    for (const o of overlays) {
      if (!o) continue;
      const bounds = getOverlayBounds(o, overlayCtx);
      if (!bounds || bounds.w <= 0 || bounds.h <= 0) continue;
      const corners = [
        { x: bounds.x,            y: bounds.y },
        { x: bounds.x + bounds.w, y: bounds.y },
        { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
        { x: bounds.x,            y: bounds.y + bounds.h },
      ];
      const screen = corners.map(c => sourceToCanvasInternal(c, ds));
      overlayCtx.beginPath();
      overlayCtx.moveTo(screen[0].x, screen[0].y);
      for (let i = 1; i < 4; i++) overlayCtx.lineTo(screen[i].x, screen[i].y);
      overlayCtx.closePath();
      overlayCtx.stroke();
    }
    overlayCtx.restore();
  }

  // Compute the selection bounding box for an overlay in CANVAS pixels and
  // draw a 1px outline plus 4 corner handles. Coordinates flow through the
  // same forward transform as the base canvas; the box is drawn aligned to
  // the rotated overlay where possible (text/shape support `rot`).
  function drawSelection(img, overlayId) {
    if (!lastDrawState || !overlayCtx) return;
    const ds = lastDrawState;
    const o = img.overlays.find(x => x && x.id === overlayId);
    if (!o) return;

    // Compute the overlay's source-pixel bounds via the shared dispatch.
    // getOverlayBounds handles text/brush/shape/redact uniformly.
    const bounds = getOverlayBounds(o, overlayCtx);
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;

    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);

    // Map each corner of the source-space rect into canvas pixels.
    const corners = [
      { x: bounds.x,            y: bounds.y },
      { x: bounds.x + bounds.w, y: bounds.y },
      { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
      { x: bounds.x,            y: bounds.y + bounds.h },
    ];
    const screen = corners.map(c => sourceToCanvasInternal(c, ds));

    const accent = getAccent();
    // Translucent fill + accent stroke.
    overlayCtx.lineWidth = 1.5;
    overlayCtx.strokeStyle = accent;
    overlayCtx.beginPath();
    overlayCtx.moveTo(screen[0].x, screen[0].y);
    for (let i = 1; i < 4; i++) overlayCtx.lineTo(screen[i].x, screen[i].y);
    overlayCtx.closePath();
    overlayCtx.stroke();

    // 4 corner handles (small filled squares with accent border).
    const HANDLE = 10;
    overlayCtx.fillStyle = '#ffffff';
    for (const p of screen) {
      overlayCtx.fillRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE);
      overlayCtx.strokeRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE);
    }
    overlayCtx.restore();
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!bindDom()) return;

    const s = getState();
    if (s.ui.view !== 'editor') return;
    const activeId = s.ui.activeImageId;
    if (!activeId) return;
    const img = s.images[activeId];
    if (!img) return;

    // On active-image change, refresh the lifecycle window. setWindow is
    // async but fire-and-forget here — the rAF loop retries baseDirty until
    // the bitmap is committed.
    if (activeId !== lastActiveId) {
      lastActiveId = activeId;
      lastSizingKey = ''; // force resize calc on new image
      lifecycle.setWindow(activeId).catch(err => {
        console.error('previewRenderer: setWindow failed', err);
      });
      img.baseDirty = true;
      img.overlaysDirty = true;
    }

    sizeCanvases(img);

    // Refresh the cached forward-draw parameters. canvasToSource() and the
    // overlay layer's transform setup both read this; recomputing every
    // tick keeps them in lockstep with any zoom/transform changes even on
    // frames where drawBase doesn't re-run.
    lastDrawState = captureDrawState(img);

    // Apply the live CSS filter for adjustments + preset every frame the
    // image is active. The filter string is cheap to compute and assigning
    // to style.filter is a no-op when the value is unchanged (browsers
    // dedupe), so we don't need a dirty flag of our own. We DO write
    // every tick so changes propagate even without baseDirty.
    applyCssFilter(img);

    // Redact overlays modify the BASE canvas (their effect is read-from /
    // write-to base pixels). When overlays change, if any redact overlays
    // exist for this image we also have to re-bake the base — otherwise a
    // strength/mode tweak or a fresh redact wouldn't actually be visible
    // until something else dirtied the base. We keep the dirty-flag map in
    // renderCache.js clean (OVERLAY → overlays only) by handling the
    // base-dirty escalation here instead.
    if (img.overlaysDirty && hasRedactOverlay(img)) {
      img.baseDirty = true;
    }

    if (img.baseDirty) {
      const drawn = drawBase(img);
      if (drawn) markClean(img, 'base');
      // else: leave baseDirty true so next frame retries after bitmap commits
    }
    // When an overlay drawer is registered (e.g. crop tool) we redraw every
    // frame so drags stay live without needing each pointermove to dirty
    // state. Without a drawer, we honour the cache flag.
    if (img.overlaysDirty || overlayDrawer) {
      drawOverlays(img);
      markClean(img, 'overlays');
    }
  }

  function hasRedactOverlay(img) {
    const overlays = img && Array.isArray(img.overlays) ? img.overlays : null;
    if (!overlays) return false;
    for (const o of overlays) {
      if (o && o.type === 'redact') return true;
    }
    return false;
  }

  // Kick a redirty + size recompute on viewport resize. Use ResizeObserver
  // when available so we react to the frame's actual box, not just the
  // window (the panel can change width independently in principle).
  const onResize = () => {
    lastSizingKey = '';
    const s = getState();
    const img = s.ui.activeImageId ? s.images[s.ui.activeImageId] : null;
    if (img) {
      img.baseDirty = true;
      img.overlaysDirty = true;
    }
  };
  window.addEventListener('resize', onResize);

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onResize);
    // Attach lazily after first DOM bind.
    const tryObserve = () => {
      if (bindDom()) {
        resizeObserver.observe(frameEl);
      } else {
        requestAnimationFrame(tryObserve);
      }
    };
    tryObserve();
  }

  // v1.2 compare-with-original: wire pointer events so the user can drag the
  // divider to move the original-vs-edited seam. Attached lazily on the
  // overlay canvas (which sits above the base canvas; tools also listen on
  // overlay canvas via attachPointer in bubble phase). We use capture phase
  // + stopImmediatePropagation so a click near the divider in compareMode
  // takes priority over the active tool's pointer handlers.
  //
  // Tolerance is 12 CSS pixels — wide enough for touch, narrow enough that
  // most clicks still pass through to the tool when compareMode is on but
  // the user isn't aiming for the divider.
  const COMPARE_GRAB_TOLERANCE = 12; // CSS pixels
  const tryAttachCompareDrag = () => {
    if (bindDom()) {
      attachCompareDragHandlers(overlayCanvas);
      attachOcrPreviewClickHandler(overlayCanvas);
    } else {
      requestAnimationFrame(tryAttachCompareDrag);
    }
  };
  tryAttachCompareDrag();

  // v1.2.x OCR preview-select mode click handler. When the user is in
  // preview mode and clicks the overlay canvas, find which detected line
  // (if any) the click landed inside and toggle its selected flag. Uses
  // capture-phase + stopImmediatePropagation so the redact tool's normal
  // pointerdown (which would start a freehand drag) doesn't also fire.
  function attachOcrPreviewClickHandler(canvas) {
    if (!canvas) return;

    function onDown(e) {
      const s = getState();
      const p = s.ui && s.ui.ocrPreview;
      if (!p || !p.active || !p.imageId) return;
      // Click position in canvas-internal pixel coords.
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      if (!canvas.width || !canvas.height || !rect.width || !rect.height) return;
      const ix = (cssX / rect.width)  * canvas.width;
      const iy = (cssY / rect.height) * canvas.height;
      // Walk lines in REVERSE so a click on the visually-topmost line
      // (last in array = drawn last = on top in z-order) wins. Lines
      // rarely overlap in practice but it's the safe default.
      const ds = lastDrawState;
      if (!ds) return;
      for (let i = p.lines.length - 1; i >= 0; i--) {
        const line = p.lines[i];
        if (!line || !line.rect) continue;
        const r = sourceRectToCanvasAABB(line.rect, ds);
        if (!r) continue;
        if (ix >= r.x && ix <= r.x + r.w && iy >= r.y && iy <= r.y + r.h) {
          // Hit — toggle selection and consume the event.
          const idx = i;
          update(state => {
            const lines = state.ui.ocrPreview.lines;
            if (idx >= 0 && idx < lines.length) {
              lines[idx].selected = !lines[idx].selected;
            }
          });
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
      }
      // Click missed all preview boxes — let the active tool handle it
      // (or absorb harmlessly if no tool's listening). No action here.
    }

    canvas.addEventListener('pointerdown', onDown, true);
  }

  function attachCompareDragHandlers(canvas) {
    if (!canvas) return;
    let dragging = false;
    let captureId = null;

    const eventCssX = (e) => e.clientX - canvas.getBoundingClientRect().left;
    const canvasCssW = () => canvas.clientWidth || canvas.getBoundingClientRect().width || 0;

    function getDividerCssX() {
      const s = getState();
      const raw = s.ui && Number.isFinite(s.ui.compareSplit) ? s.ui.compareSplit : 0.5;
      const split = Math.max(0, Math.min(1, raw));
      return canvasCssW() * split;
    }

    function onDown(e) {
      const s = getState();
      if (!s.ui || !s.ui.compareMode) return;
      const w = canvasCssW();
      if (!w) return;
      const distance = Math.abs(eventCssX(e) - getDividerCssX());
      if (distance > COMPARE_GRAB_TOLERANCE) return;
      dragging = true;
      captureId = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* older browsers — ok */ }
      // Also update split to clicked position immediately, so a tap (no drag)
      // still re-positions the divider.
      const split = Math.max(0, Math.min(1, eventCssX(e) / w));
      update(state => { state.ui.compareSplit = split; });
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onMove(e) {
      if (!dragging || e.pointerId !== captureId) return;
      const w = canvasCssW();
      if (!w) return;
      const split = Math.max(0, Math.min(1, eventCssX(e) / w));
      update(state => { state.ui.compareSplit = split; });
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onUp(e) {
      if (!dragging) return;
      // Even if the released pointerId isn't the one we captured (rare —
      // multi-touch), end the drag to avoid getting stuck.
      dragging = false;
      captureId = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    canvas.addEventListener('pointerdown',   onDown, true);
    canvas.addEventListener('pointermove',   onMove, true);
    canvas.addEventListener('pointerup',     onUp,   true);
    canvas.addEventListener('pointercancel', onUp,   true);
  }

  // Subscribe to state so transitions wake the loop and trigger redraws.
  // We also mark the overlay layer dirty here so changes that don't flow
  // through invalidate(img, 'OVERLAY') (e.g. ui.selectedOverlayId switching
  // between overlays via the overlays panel, or showOverlayOutlines /
  // smoothBrushStrokes settings flipping) still redraw the selection.
  let lastSelectedId = null;
  let lastOverlayOutlines = null;
  let lastSmoothBrush = null;
  let lastCompareMode = false;
  let lastCompareSplit = 0.5;
  let lastOcrPreviewKey = '';
  let lastWatermarkKey = '';
  subscribe(() => {
    const s = getState();
    if (s.ui.view === 'editor') {
      const id = s.ui.activeImageId;
      if (id && s.images[id]) {
        // Treat any state change while editor is open as a hint to recheck
        // sizing (zoom may have changed). Marking dirty is cheap.
        lastSizingKey = '';
        const selId = s.ui.selectedOverlayId || null;
        if (selId !== lastSelectedId) {
          lastSelectedId = selId;
          s.images[id].overlaysDirty = true;
        }
        const outlines = getSetting('showOverlayOutlines');
        if (outlines !== lastOverlayOutlines) {
          lastOverlayOutlines = outlines;
          s.images[id].overlaysDirty = true;
        }
        const smooth = getSetting('smoothBrushStrokes');
        if (smooth !== lastSmoothBrush) {
          lastSmoothBrush = smooth;
          s.images[id].overlaysDirty = true;
        }
        // v1.2 compare-with-original: any change to compareMode or
        // compareSplit needs a base re-bake (the split is painted INTO
        // the base canvas, not on a separate layer).
        const cm = !!s.ui.compareMode;
        const cs = Number.isFinite(s.ui.compareSplit) ? s.ui.compareSplit : 0.5;
        if (cm !== lastCompareMode || cs !== lastCompareSplit) {
          lastCompareMode = cm;
          lastCompareSplit = cs;
          s.images[id].baseDirty = true;
        }
        // v1.2.x OCR preview: any change to the preview slice (entering,
        // exiting, line toggle) needs an overlay re-paint. We don't try
        // to deep-diff the lines array; just re-paint on any change to
        // active/imageId/lines-length/lines-selection-sum (cheap proxy
        // that captures all the cases we care about).
        const op = s.ui.ocrPreview || {};
        const opActive = !!op.active;
        const opLines = Array.isArray(op.lines) ? op.lines : [];
        const opSelectedCount = opLines.reduce((n, l) => n + (l && l.selected ? 1 : 0), 0);
        const opKey = opActive + '|' + (op.imageId || '') + '|' + opLines.length + '|' + opSelectedCount;
        if (opKey !== lastOcrPreviewKey) {
          lastOcrPreviewKey = opKey;
          s.images[id].overlaysDirty = true;
        }
        // v1.3 watermark (Feature 12): any change to the watermark slice
        // needs a base re-bake (watermark is painted INTO the base canvas,
        // not on a separate layer). Cheap stringified key — the slice is
        // small and JSON-safe.
        const wm = s.ui.watermark || {};
        const wmKey = [
          wm.enabled ? 1 : 0,
          wm.type, wm.text, wm.textFont, wm.textColor,
          wm.imageBlobUrl || '',
          wm.position, wm.customX, wm.customY,
          wm.opacity, wm.scale, wm.tiledAngle,
        ].join('|');
        if (wmKey !== lastWatermarkKey) {
          lastWatermarkKey = wmKey;
          s.images[id].baseDirty = true;
        }
      }
    }
  });

  // Start the rAF loop. It self-perpetuates and is cheap when there's
  // nothing to draw — early returns short-circuit any work.
  if (!raf) raf = requestAnimationFrame(tick);
}
