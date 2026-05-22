// js/ops/redact.js — selective blur or pixelate over a region.
//
// Pure module: depends only on a 2D context API.
//
// The effect is applied DIRECTLY to the base canvas (live preview) and the
// export canvas — by reading pixels back from the target ctx, processing,
// and writing them back over the same region. See applyRedactFx() below.
//
// `drawRedact()` is now ONLY the selection indicator (dashed border + small
// mode/strength label). The actual pixel-mutating effect lives in
// `applyRedactFx()` and is invoked by the preview/export renderers
// against the base canvas, not the overlay canvas.

// v1.2: 'mask' (solid color rectangle) is the default. The "blur is
// reversible" privacy claim (multiple sources cited in the v1.2 research
// round) makes a solid block the safe default. Blur + pixelate remain
// available as "visual only" options for the cases where users WANT the
// effect to be visually softer (e.g., redacting a face in a photo where
// a black box looks too jarring).
const DEFAULT_MODE = 'mask';
const DEFAULT_STRENGTH = 12;
const DEFAULT_COLOR = '#000000';

const MODES = Object.freeze(['mask', 'blur', 'pixelate']);

/**
 * Create a new redact overlay over the given rect.
 */
export function newRedactOverlay(x, y, w, h, opts = {}) {
  return {
    id: crypto.randomUUID(),
    type: 'redact',
    rot: 0,
    x, y, w, h,
    mode: MODES.includes(opts.mode) ? opts.mode : DEFAULT_MODE,
    strength: Number.isFinite(opts.strength) ? opts.strength : DEFAULT_STRENGTH,
    // v1.2: hex string used by 'mask' mode (ignored by blur/pixelate).
    // Default black; users can change in the edit panel.
    color: typeof opts.color === 'string' ? opts.color : DEFAULT_COLOR,
  };
}

/**
 * Bake the redact effect into the supplied canvas context, in-place. Reads
 * from the canvas, blurs/pixelates the region, writes back. Used by both
 * the preview and the export pipeline.
 *
 * The caller must have already applied any source→canvas-pixel transform
 * before invoking this — the (x, y, w, h) rect is taken as already being
 * in the context's CURRENT user-coordinate space (which for our renderers
 * is source-pixel space when this is called).
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {{ x:number, y:number, w:number, h:number,
 *           mode:'blur'|'pixelate', strength:number }} r
 * @param {{ ctxFilter?: boolean }} [caps]  - capability probe; when
 *   `ctx.filter` is unavailable, blur falls back to pixelate so the user
 *   gets _some_ redaction rather than no effect.
 */
export function applyRedactFx(ctx, r, caps) {
  if (!ctx || !r) return;
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.max(1, Math.round(r.w));
  const h = Math.max(1, Math.round(r.h));
  if (w <= 0 || h <= 0) return;
  const strength = Math.max(1, Math.round(Number.isFinite(r.strength) ? r.strength : DEFAULT_STRENGTH));

  // Clamp the region against the canvas so we never sample/write out of bounds.
  const canvasW = ctx.canvas && ctx.canvas.width;
  const canvasH = ctx.canvas && ctx.canvas.height;
  if (!canvasW || !canvasH) return;
  const cx = Math.min(x, Math.max(0, canvasW - 1));
  const cy = Math.min(y, Math.max(0, canvasH - 1));
  const cw = Math.min(w, Math.max(1, canvasW - cx));
  const ch = Math.min(h, Math.max(1, canvasH - cy));
  if (cw <= 0 || ch <= 0) return;

  const mode = MODES.includes(r.mode) ? r.mode : DEFAULT_MODE;
  if (mode === 'mask') {
    applyMask(ctx, cx, cy, cw, ch, typeof r.color === 'string' ? r.color : DEFAULT_COLOR);
  } else if (mode === 'pixelate') {
    applyPixelate(ctx, cx, cy, cw, ch, strength);
  } else {
    if (caps && caps.ctxFilter === false) {
      // Graceful fallback when ctx.filter is unavailable (very old browsers).
      applyPixelate(ctx, cx, cy, cw, ch, strength);
    } else {
      applyBlur(ctx, cx, cy, cw, ch, strength);
    }
  }
}

// Solid-color rectangle. The privacy-safe default — no information about
// the underlying pixels survives, unlike blur (reversible at low strength)
// or pixelate (high-frequency patterns can sometimes survive).
function applyMask(ctx, x, y, w, h, color) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = color;
  ctx.clearRect(x, y, w, h);
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function applyPixelate(ctx, x, y, w, h, blockSize) {
  // Strength is the literal pixel size of each block in canvas-pixel space.
  // We downsample the region with smoothing ENABLED (so each output pixel is
  // a multi-pixel average), then upsample back to full size with smoothing
  // DISABLED — that produces uniform chunky blocks whose color is the mean
  // of the underlying pixels, the visual effect users expect from
  // "pixelate" (and the effect that actually destroys recognizability,
  // unlike pure nearest-neighbor downsampling which just picks one source
  // pixel per block).
  const smallW = Math.max(1, Math.floor(w / blockSize));
  const smallH = Math.max(1, Math.floor(h / blockSize));
  const temp = createWorkCanvas(smallW, smallH);
  if (!temp) return;
  const tCtx = temp.getContext('2d');
  if (!tCtx) return;
  // Average the region into temp.
  tCtx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in tCtx) tCtx.imageSmoothingQuality = 'high';
  // Source the region from the live canvas.
  try {
    tCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, smallW, smallH);
  } catch {
    // Tainted canvas or other read failure — silently skip.
    return;
  }
  // Write it back at full size with smoothing off — chunky blocks.
  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(x, y, w, h);
  ctx.drawImage(temp, 0, 0, smallW, smallH, x, y, w, h);
  ctx.restore();
  ctx.imageSmoothingEnabled = prevSmoothing;
}

function applyBlur(ctx, x, y, w, h, strength) {
  // Use a temporary canvas with ctx.filter for a clean Gaussian blur. Expand
  // the read by the blur radius so edges don't darken from sampling outside
  // the region.
  const r = strength;
  const sx = Math.max(0, x - r);
  const sy = Math.max(0, y - r);
  const sw = Math.min(ctx.canvas.width  - sx, w + r * 2);
  const sh = Math.min(ctx.canvas.height - sy, h + r * 2);
  if (sw <= 0 || sh <= 0) return;
  const temp = createWorkCanvas(sw, sh);
  if (!temp) return;
  const tCtx = temp.getContext('2d');
  if (!tCtx) return;
  tCtx.filter = `blur(${r}px)`;
  try {
    tCtx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  } catch {
    // Tainted canvas or other read failure — silently skip.
    return;
  }
  // Now clip back to the user's actual region and draw the blurred temp
  // back onto the original canvas at the same position. The clip path
  // ensures blurred edges outside the requested region don't leak.
  ctx.save();
  // Drop any active transform so the clip rect and drawImage use raw
  // canvas pixels — matches the coords we just used to read.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.clearRect(x, y, w, h);
  ctx.drawImage(temp, 0, 0, sw, sh, sx, sy, sw, sh);
  ctx.restore();
}

function createWorkCanvas(w, h) {
  // OffscreenCanvas when available (workers + main thread on Chrome/FF),
  // fallback to a detached <canvas> element.
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return null;
}

/**
 * Selection-indicator draw — dashed bounding box + small mode/strength label
 * in the corner. Used ONLY when this redact overlay is the selected one (so
 * the user can see what they're editing). NOT the effect itself; the effect
 * is handled by applyRedactFx() against the base/export canvas.
 *
 * Kept as the `drawRedact` export so the renderer's `overlayDrawers` map and
 * the dynamic dispatch in overlays.js keep working unchanged — but it now
 * only draws the indicator, not the placeholder fill.
 */
export function drawRedact(ctx, r) {
  if (!ctx || !r) return;
  const w = r.w;
  const h = r.h;
  if (w <= 0 || h <= 0) return;

  ctx.save();

  // Dashed white border so the region is visible on top of the now-actually-
  // -applied effect. Two-tone (dark backing + white dashes) keeps it legible
  // against any image content without relying on hue.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.setLineDash([]);
  ctx.lineWidth = 3;
  ctx.strokeRect(r.x, r.y, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.setLineDash([8, 4]);
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x, r.y, w, h);
  ctx.setLineDash([]);

  // Small mode label at the top-left.
  ctx.font = '500 12px Onest, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const label = r.mode === 'mask'
    ? 'mask'
    : (r.mode === 'pixelate' ? `pixelate ${r.strength}` : `blur ${r.strength}`);
  const padX = 4;
  const padY = 2;
  const metrics = ctx.measureText(label);
  const labelW = (metrics && Number.isFinite(metrics.width) ? metrics.width : label.length * 7) + padX * 2;
  const labelH = 16;
  // Backdrop so the white text stays legible against any image content.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(r.x, r.y, labelW, labelH);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, r.x + padX, r.y + padY);

  ctx.restore();
}

/**
 * Axis-aligned bounding box of the redact region.
 */
export function redactBounds(r) {
  if (!r) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

export const REDACT_MODES = MODES;
