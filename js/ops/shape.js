// js/ops/shape.js — shape primitives: line / rect / arrow / circle.
//
// Pure module: depends only on a 2D context API. The renderer and the
// export pipeline both call drawShape(). Coordinates are in SOURCE-IMAGE
// pixel space; the caller is responsible for setting up any
// zoom/rotate/flip transform first.
//
// Shape model:
//   - All four kinds are stored as a pair of endpoints (x1, y1) and
//     (x2, y2). Rect / circle use the bounding box; line / arrow use the
//     two points directly. This lets the tool create any shape with a
//     single drag (down → up) without special-casing per kind.
//   - stroke is always set; fill is optional (null = no fill).
//   - strokeWidth is in source-pixel space, same as brush size.

export const SHAPE_KINDS = Object.freeze(['line', 'rect', 'arrow', 'circle']);

const DEFAULT_STROKE = '#000000';
const DEFAULT_STROKE_WIDTH = 2;

/**
 * Create a new shape overlay of the given kind, spanning (x1,y1) → (x2,y2).
 * Throws on unknown kind.
 */
export function newShapeOverlay(kind, x1, y1, x2, y2, opts = {}) {
  if (!SHAPE_KINDS.includes(kind)) {
    throw new TypeError(`newShapeOverlay: unknown kind '${kind}'`);
  }
  return {
    id: crypto.randomUUID(),
    type: 'shape',
    kind,
    x1, y1, x2, y2,
    stroke: opts.stroke ?? DEFAULT_STROKE,
    fill: Object.prototype.hasOwnProperty.call(opts, 'fill') ? opts.fill : null,
    strokeWidth: Number.isFinite(opts.strokeWidth) ? opts.strokeWidth : DEFAULT_STROKE_WIDTH,
  };
}

/**
 * Draw a shape overlay. Dispatches by kind.
 */
export function drawShape(ctx, s) {
  if (!ctx || !s) return;
  ctx.save();
  ctx.strokeStyle = s.stroke || DEFAULT_STROKE;
  ctx.lineWidth = Number.isFinite(s.strokeWidth) ? s.strokeWidth : DEFAULT_STROKE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.fill) ctx.fillStyle = s.fill;

  if (s.kind === 'line') {
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
  } else if (s.kind === 'rect') {
    const x = Math.min(s.x1, s.x2);
    const y = Math.min(s.y1, s.y2);
    const w = Math.abs(s.x2 - s.x1);
    const h = Math.abs(s.y2 - s.y1);
    if (s.fill) ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  } else if (s.kind === 'arrow') {
    drawArrow(ctx, s.x1, s.y1, s.x2, s.y2, ctx.lineWidth);
  } else if (s.kind === 'circle') {
    const cx = (s.x1 + s.x2) / 2;
    const cy = (s.y1 + s.y2) / 2;
    const rx = Math.abs(s.x2 - s.x1) / 2;
    const ry = Math.abs(s.y2 - s.y1) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    if (s.fill) ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Draw a line from (x1,y1) to (x2,y2) with a triangular head at (x2,y2)
 * pointing along the line direction. Head size scales with strokeWidth so
 * thin arrows have small heads and thick arrows have proportionally larger
 * heads.
 *
 * Formula: headLen = 3 * strokeWidth + 6 px. Heuristic but visually
 * reasonable across strokeWidth values 1..20. The head is an isoceles
 * triangle with base = headLen, height = headLen.
 *
 * The shaft is drawn to a slightly inset point so the head's base aligns
 * with the shaft tip and there's no visible overlap artefact.
 */
function drawArrow(ctx, x1, y1, x2, y2, strokeWidth) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;

  const sw = Number.isFinite(strokeWidth) ? strokeWidth : DEFAULT_STROKE_WIDTH;
  const headLen = sw * 3 + 6;
  const headHalfWidth = headLen / 2;

  // Direction unit vector.
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular unit vector.
  const px = -uy;
  const py = ux;

  // Inset the shaft tip so the head sits flush.
  const shaftTipX = x2 - ux * headLen;
  const shaftTipY = y2 - uy * headLen;

  // Shaft.
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(shaftTipX, shaftTipY);
  ctx.stroke();

  // Head (triangle).
  const baseX = x2 - ux * headLen;
  const baseY = y2 - uy * headLen;
  const leftX = baseX + px * headHalfWidth;
  const leftY = baseY + py * headHalfWidth;
  const rightX = baseX - px * headHalfWidth;
  const rightY = baseY - py * headHalfWidth;

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(leftX, leftY);
  ctx.lineTo(rightX, rightY);
  ctx.closePath();
  // Fill with stroke color so the head is solid; stroke too so the edges
  // are crisp at the same width as the shaft.
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  ctx.stroke();
}

/**
 * Axis-aligned bounding box of the shape in source-pixel space. Used by
 * selection handles. Does NOT account for stroke width (Phase 14 can
 * refine).
 */
export function shapeBounds(s) {
  if (!s) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(s.x1, s.x2);
  const y = Math.min(s.y1, s.y2);
  const w = Math.abs(s.x2 - s.x1);
  const h = Math.abs(s.y2 - s.y1);
  return { x, y, w, h };
}
