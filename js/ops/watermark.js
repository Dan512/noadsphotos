// js/ops/watermark.js — pure ops for the watermark preset (Feature #12).
//
// Two flavors of watermark: text + image. Both render the same way:
//   - The user picks a position (one of the 9-point grid, 'tiled', or 'custom').
//   - The watermark is sized as a fraction of the canvas long edge.
//   - Painted with a chosen opacity, baked into the export but kept
//     non-destructive in the preview (stored in state.ui.watermark).
//
// Coordinate model:
//   - All positioning math here is canvas-space (pixels of the OUTPUT canvas
//     the watermark is being painted into).
//   - The watermark itself has its own (width, height) in canvas pixels; we
//     compute its top-left and call drawImage/fillText.
//   - Custom positions are stored as fractions 0..1 of canvas size so they
//     translate cleanly when the canvas changes dims (rotate, crop, resize).
//
// This module is pure-ish — applyWatermark touches the 2D canvas API but
// nothing else (no DOM, no state, no localStorage). Tests cover the math;
// the canvas-touching parts are exercised by browser smoke tests.

// The 9-point grid + tiled + custom. POSITION_PRESETS is the user-facing list
// (custom is only set programmatically from a drag).
export const POSITION_PRESETS = Object.freeze([
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
  'tiled',
]);

// Margin from the canvas edge for the corner/edge presets, as a fraction of
// the canvas long edge. Center watermarks ignore this; tiled uses its own
// spacing. 2% gives a visible "anchored to corner" look without crowding.
const EDGE_MARGIN_FRACTION = 0.02;

// Spacing between repeated tiles, expressed as a multiple of the watermark's
// own diagonal length. 1.6× = ample whitespace; 1.0× would crowd.
const TILE_SPACING_MULTIPLIER = 1.6;

/**
 * Map a 9-point position name to an anchor (fx, fy) ∈ {0, 0.5, 1}² that
 * describes which corner/edge of the canvas the watermark sticks to.
 *
 * (0, 0) is top-left; (1, 1) is bottom-right; (0.5, 0.5) is center.
 *
 * Returns null for unknown values (including 'tiled' and 'custom' — neither
 * uses a simple anchor; they have their own paint paths).
 *
 * @param {string} position
 * @returns {{fx: number, fy: number} | null}
 */
export function positionToFractions(position) {
  switch (position) {
    case 'top-left':     return { fx: 0,   fy: 0   };
    case 'top':          return { fx: 0.5, fy: 0   };
    case 'top-right':    return { fx: 1,   fy: 0   };
    case 'left':         return { fx: 0,   fy: 0.5 };
    case 'center':       return { fx: 0.5, fy: 0.5 };
    case 'right':        return { fx: 1,   fy: 0.5 };
    case 'bottom-left':  return { fx: 0,   fy: 1   };
    case 'bottom':       return { fx: 0.5, fy: 1   };
    case 'bottom-right': return { fx: 1,   fy: 1   };
    default:             return null;
  }
}

/**
 * Compute the rendered watermark rect in canvas-pixel coords for the given
 * canvas + watermark config. Returns { x, y, width, height } where (x, y) is
 * the top-left of the watermark on the canvas.
 *
 * For text watermarks: height = font size (scale × longEdge), width comes from
 * the measureWidth callback (passed in so this module never touches canvas).
 *
 * For image watermarks: long-edge dimension = scale × longEdge, and the
 * orthogonal dimension is derived from imageAspect (width / height).
 *
 * For 'tiled', returns ONE unit tile rect — the caller is responsible for
 * repeating it across the canvas (see applyWatermark below).
 *
 * @param {object} opts
 * @param {number} opts.canvasWidth
 * @param {number} opts.canvasHeight
 * @param {object} opts.watermark   state.ui.watermark shape
 * @param {(text: string, fontSize: number) => number} [opts.measureWidth]
 * @param {number} [opts.imageAspect]  width / height
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function computeWatermarkRect({
  canvasWidth,
  canvasHeight,
  watermark,
  measureWidth,
  imageAspect,
}) {
  const cw = Math.max(1, Number(canvasWidth) || 0);
  const ch = Math.max(1, Number(canvasHeight) || 0);
  const longEdge = Math.max(cw, ch);
  const scale = clamp01(Number(watermark && watermark.scale) || 0.15);

  // Compute the watermark's own (width, height) in canvas pixels.
  let width, height;
  if ((watermark && watermark.type) === 'image') {
    // Long-edge of the watermark = scale × canvas long edge. The other axis
    // follows from the image's aspect ratio (width / height). If aspect is
    // missing or invalid, fall back to a square — safer than NaN downstream.
    const a = Number(imageAspect);
    const wmLong = scale * longEdge;
    if (Number.isFinite(a) && a > 0) {
      if (a >= 1) {
        // Landscape or square — width is the long edge.
        width = wmLong;
        height = wmLong / a;
      } else {
        // Portrait — height is the long edge.
        height = wmLong;
        width = wmLong * a;
      }
    } else {
      width = wmLong;
      height = wmLong;
    }
  } else {
    // Text. The "size" is the font size in canvas pixels; width comes from
    // the caller's measure function (which knows about the current font).
    const fontSize = Math.max(1, scale * longEdge);
    height = fontSize;
    let measured = 0;
    if (typeof measureWidth === 'function') {
      try {
        measured = Math.max(0, Number(measureWidth(String(watermark.text || ''), fontSize)) || 0);
      } catch { measured = 0; }
    }
    // Fallback width if the measureWidth callback is unavailable or returns 0:
    // assume ~0.55 average glyph width × char count. Better than 0 (which would
    // make the rect a zero-width column the user can't drag).
    if (measured <= 0) {
      measured = String(watermark.text || '').length * fontSize * 0.55;
    }
    width = Math.max(1, measured);
  }

  // Position the rect.
  const position = (watermark && watermark.position) || 'bottom-right';
  let x, y;
  if (position === 'tiled') {
    // Unit tile — top-left at (0, 0). Caller repeats.
    x = 0; y = 0;
  } else if (position === 'custom') {
    // Center the watermark on (customX, customY). Fractions are 0..1 of canvas.
    const cx = clamp01(Number(watermark.customX));
    const cy = clamp01(Number(watermark.customY));
    x = cx * cw - width / 2;
    y = cy * ch - height / 2;
  } else {
    const a = positionToFractions(position);
    if (!a) {
      // Unknown position string — fall back to center to avoid throwing in
      // the render path.
      x = (cw - width) / 2;
      y = (ch - height) / 2;
    } else {
      const margin = EDGE_MARGIN_FRACTION * longEdge;
      // x anchors: 0 → flush-left (margin), 0.5 → centered, 1 → flush-right.
      if (a.fx === 0) x = margin;
      else if (a.fx === 1) x = cw - width - margin;
      else x = (cw - width) / 2;
      if (a.fy === 0) y = margin;
      else if (a.fy === 1) y = ch - height - margin;
      else y = (ch - height) / 2;
    }
  }

  return { x, y, width, height };
}

/**
 * Apply a watermark to a canvas, mutating it in place. Used by both the
 * preview renderer and the export renderer so what the user sees is what
 * they get.
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {number} opts.canvasWidth
 * @param {number} opts.canvasHeight
 * @param {object} opts.watermark   state.ui.watermark
 * @param {*} [opts.imageBitmap]    ImageBitmap or canvas-like for image type
 */
export function applyWatermark(ctx, opts) {
  if (!ctx || !opts) return;
  const wm = opts.watermark;
  if (!wm || !wm.enabled) return;
  const cw = Math.max(1, Number(opts.canvasWidth) || 0);
  const ch = Math.max(1, Number(opts.canvasHeight) || 0);
  const opacity = clamp01(Number(wm.opacity) || 0);
  if (opacity <= 0) return; // 0% opacity → nothing to paint

  // Compute the per-tile width/height + (for non-tiled) the placement rect.
  const measureWidth = (text, fontSize) => {
    if (wm.type !== 'image') {
      ctx.save();
      ctx.font = `${fontSize}px ${wm.textFont || 'system-ui, sans-serif'}`;
      const m = ctx.measureText(String(text || ''));
      ctx.restore();
      return m && m.width ? m.width : 0;
    }
    return 0;
  };
  let imageAspect = null;
  if (wm.type === 'image' && opts.imageBitmap && opts.imageBitmap.width && opts.imageBitmap.height) {
    imageAspect = opts.imageBitmap.width / opts.imageBitmap.height;
  }
  const rect = computeWatermarkRect({
    canvasWidth: cw,
    canvasHeight: ch,
    watermark: wm,
    measureWidth,
    imageAspect,
  });

  // Skip impossibly small or NaN rects defensively — drawing a 0px-wide
  // watermark is a no-op anyway, but it can stem from a state corruption
  // (logo blob revoked but URL still in state) we'd rather just skip.
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
  if (rect.width <= 0 || rect.height <= 0) return;

  ctx.save();
  ctx.globalAlpha = opacity;

  if (wm.position === 'tiled') {
    paintTiled(ctx, rect, wm, opts.imageBitmap, cw, ch);
  } else {
    paintOnce(ctx, rect, wm, opts.imageBitmap);
  }

  ctx.restore();
}

// Paint a single watermark instance at the given rect. Text: fillText at the
// text baseline (the rect's top is the cap top; we offset by .85 of size for
// a visually-centered baseline). Image: drawImage at the rect.
function paintOnce(ctx, rect, wm, imageBitmap) {
  if (wm.type === 'image') {
    if (!imageBitmap) return; // no logo loaded yet
    try {
      ctx.drawImage(imageBitmap, rect.x, rect.y, rect.width, rect.height);
    } catch {
      // Defensive: a closed ImageBitmap will throw. Swallow — the next render
      // tick after the user re-uploads will recover.
    }
    return;
  }
  // Text. We treat rect.height as the font size (computeWatermarkRect set it
  // that way for type=text). Baseline `top` makes the rect.y the visual top.
  const fontSize = rect.height;
  ctx.font = `${fontSize}px ${wm.textFont || 'system-ui, sans-serif'}`;
  ctx.fillStyle = wm.textColor || '#ffffff';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(String(wm.text || ''), rect.x, rect.y);
}

// Tile the watermark across the whole canvas at a diagonal angle. Repeats
// with enough spacing that adjacent tiles don't overlap.
//
// The grid is anchored to (0, 0) in the rotated coord space — i.e. the
// canvas center. The center is always a tile position; neighbors sit at
// ±step, ±2*step, etc. This keeps the pattern stable when the user adjusts
// the scale slider: changing `step` changes the spacing between tiles, but
// not the grid's origin. (Earlier impl computed cols/startX from coverage,
// which made startX jump by step/2 whenever cols ticked over — so a 30%→28%
// scale tweak could reshuffle the whole pattern.)
function paintTiled(ctx, tile, wm, imageBitmap, cw, ch) {
  const angleDeg = Number.isFinite(Number(wm.tiledAngle)) ? Number(wm.tiledAngle) : -30;
  const rad = angleDeg * Math.PI / 180;

  // Cover beyond the canvas diagonal so the rotated grid still fills it
  // even at the worst-case 45° angle. A small cushion (1.2×) absorbs
  // rounding at the edges so the corners don't show a half-tile gap.
  const diag = Math.sqrt(cw * cw + ch * ch);
  const coverage = diag * 1.2;
  const stepX = Math.max(1, tile.width  * TILE_SPACING_MULTIPLIER);
  const stepY = Math.max(1, tile.height * TILE_SPACING_MULTIPLIER * 1.8); // more vertical breathing room

  ctx.save();
  // Rotate around the canvas center so the tile pattern stays balanced.
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rad);

  // Iterate in fixed step increments anchored to (0, 0). colsHalf/rowsHalf
  // give us symmetric coverage around the center.
  const colsHalf = Math.ceil(coverage / stepX);
  const rowsHalf = Math.ceil(coverage / stepY);
  for (let r = -rowsHalf; r <= rowsHalf; r++) {
    const yCenter = r * stepY;
    for (let c = -colsHalf; c <= colsHalf; c++) {
      const xCenter = c * stepX;
      paintOnce(
        ctx,
        {
          x: xCenter - tile.width / 2,
          y: yCenter - tile.height / 2,
          width: tile.width,
          height: tile.height,
        },
        wm,
        imageBitmap,
      );
    }
  }
  ctx.restore();
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
