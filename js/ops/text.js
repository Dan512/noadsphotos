// js/ops/text.js — text overlay drawing.
//
// Pure module: depends only on a 2D context API (Canvas2D or compatible
// offscreen variant). The renderer and the export pipeline both call this
// function with their respective contexts.
//
// Coordinates are in SOURCE-IMAGE pixel space. The caller is responsible for
// setting up any zoom/rotate/flip transform before calling drawText.

const DEFAULT_FONT   = 'Onest, system-ui, sans-serif';
const DEFAULT_SIZE   = 32;
const DEFAULT_WEIGHT = 500;
const DEFAULT_COLOR  = '#000000';
const DEFAULT_ALIGN  = 'left';
const LINE_HEIGHT_FACTOR = 1.2;

/**
 * Draw a text overlay onto the given 2D context at its (x, y) position.
 *
 *   - rot (degrees) rotates the text around its (x, y) anchor.
 *   - Multiline text via '\n' is supported; each line is drawn at
 *     size * LINE_HEIGHT_FACTOR pixels below the previous one.
 *   - textBaseline is set to 'top' so (x, y) is the top-left of the first
 *     line (consistent with the bounding box returned by measureText).
 */
export function drawText(ctx, t) {
  if (!ctx || !t) return;
  ctx.save();
  if (t.rot) {
    ctx.translate(t.x, t.y);
    ctx.rotate((t.rot * Math.PI) / 180);
    ctx.translate(-t.x, -t.y);
  }
  ctx.font = buildFontShorthand(t);
  ctx.fillStyle = t.color || DEFAULT_COLOR;
  ctx.textAlign = t.align || DEFAULT_ALIGN;
  ctx.textBaseline = 'top';
  const lines = String(t.text || '').split('\n');
  const size  = Number.isFinite(t.size) ? t.size : DEFAULT_SIZE;
  const lineHeight = size * LINE_HEIGHT_FACTOR;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], t.x, t.y + i * lineHeight);
  }
  ctx.restore();
}

/**
 * Return the {w, h} bounding box of the rendered text in source-pixel space.
 * Used for hit-testing (clicks on existing overlays) and for drawing the
 * selection rectangle in the preview renderer.
 */
export function measureText(ctx, t) {
  if (!ctx || !t) return { w: 0, h: 0 };
  ctx.save();
  ctx.font = buildFontShorthand(t);
  const lines = String(t.text || '').split('\n');
  const size  = Number.isFinite(t.size) ? t.size : DEFAULT_SIZE;
  const lineHeight = size * LINE_HEIGHT_FACTOR;
  let maxW = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    const w = m && Number.isFinite(m.width) ? m.width : 0;
    if (w > maxW) maxW = w;
  }
  ctx.restore();
  return { w: maxW, h: lines.length * lineHeight };
}

/**
 * Create a fresh text overlay at the given source-pixel position. Defaults
 * line up with the panel's UI defaults (Onest 32px, weight 500, black).
 */
export function newTextOverlay(x, y, opts = {}) {
  return {
    id: crypto.randomUUID(),
    type: 'text',
    x, y, rot: 0,
    text:   opts.text   ?? 'Text',
    font:   opts.font   ?? DEFAULT_FONT,
    size:   opts.size   ?? DEFAULT_SIZE,
    weight: opts.weight ?? DEFAULT_WEIGHT,
    color:  opts.color  ?? DEFAULT_COLOR,
    align:  opts.align  ?? DEFAULT_ALIGN,
  };
}

// Build the CSS-shorthand `font` string for a text overlay. Browsers want
// "<weight> <size>px <family>" in that order.
function buildFontShorthand(t) {
  const weight = Number.isFinite(t.weight) ? t.weight : DEFAULT_WEIGHT;
  const size   = Number.isFinite(t.size)   ? t.size   : DEFAULT_SIZE;
  const family = t.font || DEFAULT_FONT;
  return `${weight} ${size}px ${family}`;
}
