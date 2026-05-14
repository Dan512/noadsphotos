// js/ops/redact.js — selective blur or pixelate over a region.
//
// Pure module: depends only on a 2D context API.
//
// IMPORTANT v1 LIMITATION:
//   The overlay canvas in the live preview pipeline sits ABOVE the base
//   image canvas and does NOT have access to the rendered base pixels.
//   That means a "live" blur/pixelate effect over the region would require
//   either reading back from the base canvas every frame (expensive) or
//   keeping a synchronised offscreen copy of the rendered base (memory).
//
//   For v1 the redact overlay paints a translucent placeholder showing
//   WHERE the region is, plus a small label indicating the chosen mode +
//   strength. The actual blur/pixelate is baked into the export pipeline
//   (Phase 9), where we have direct pixel access to the rendered output.
//
//   This is acknowledged in the design doc as a v2 nicety; the trade-off
//   is documented here so future maintainers don't try to do too much in
//   the renderer.

const DEFAULT_MODE = 'blur';
const DEFAULT_STRENGTH = 12;

const MODES = Object.freeze(['blur', 'pixelate']);

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
  };
}

/**
 * Draw the redact region for the live preview. See module-level note —
 * this is a PLACEHOLDER visualisation, not the actual blurred/pixelated
 * result.
 *
 * Visual recipe:
 *   - Translucent fill so the underlying image shows through, with a
 *     slightly different alpha for blur vs pixelate so the two modes are
 *     visually distinguishable without relying solely on the label text.
 *   - Dotted white border to mark the rectangle clearly.
 *   - Mode + strength label at the top-left corner with a dark backdrop
 *     so the white text stays legible against any image content.
 */
export function drawRedact(ctx, r) {
  if (!ctx || !r) return;
  const w = r.w;
  const h = r.h;
  if (w <= 0 || h <= 0) return;

  ctx.save();

  // Translucent fill. Pixelate uses slightly less alpha so the two modes
  // are visually distinguishable without colour (Dan is colorblind).
  ctx.fillStyle = r.mode === 'pixelate'
    ? 'rgba(0, 0, 0, 0.35)'
    : 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(r.x, r.y, w, h);

  // Dotted white border.
  ctx.strokeStyle = '#ffffff';
  ctx.setLineDash([8, 4]);
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x, r.y, w, h);
  ctx.setLineDash([]);

  // Mode label in the top-left.
  ctx.font = '500 12px Onest, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const label = r.mode === 'pixelate'
    ? `pixelate ${r.strength}`
    : `blur ${r.strength}`;
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
