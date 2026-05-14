// js/overlays.js — overlay CRUD + draw dispatch.
//
// Pure module: no DOM. Mutates imageState.overlays (the ordered list of
// overlays for one image) and tags the renderCache so the renderer redraws
// the overlay canvas on its next rAF tick.
//
// All coordinates are in SOURCE-IMAGE pixel space — same as crop rects in
// state.transforms.crop and the rest of the editor's per-image geometry.
//
// Overlay shapes (per the design doc):
//   { id, type: 'text',   x, y, rot, text, font, size, weight, color, align }
//   { id, type: 'brush',  rot, color, size, points: Float32Array(x0,y0,p0, x1,y1,p1, …) }  // stride 3
//   { id, type: 'shape',  kind, x1, y1, x2, y2, stroke, fill, strokeWidth }
//   { id, type: 'redact', x, y, w, h, mode: 'pixelate'|'blur', strength }
//
// Phase 7B implements brush/shape/redact as well; the draw dispatch
// loads their modules dynamically so callers that only need one type
// don't pay for the others.

import { invalidate } from './render/renderCache.js';

const KNOWN_TYPES = new Set(['text', 'brush', 'shape', 'redact']);

// Brush points are stride-3 (x, y, pressure). Shared with ops/brush.js;
// duplicated as a local constant rather than imported so this module
// stays free of the per-type implementation imports.
const BRUSH_STRIDE = 3;

// --- CRUD ------------------------------------------------------------------

/**
 * Append a new overlay to the image's overlay list. The overlay must already
 * have an `id` (use `createOverlayId()` upstream) and a known `type`. Returns
 * the overlay's id for callers that want to chain a selection update.
 */
export function addOverlay(imageState, overlay) {
  if (!overlay || typeof overlay !== 'object') {
    throw new TypeError('addOverlay: overlay must be an object');
  }
  if (typeof overlay.id !== 'string' || !overlay.id) {
    throw new TypeError('addOverlay: overlay.id must be a non-empty string');
  }
  if (!KNOWN_TYPES.has(overlay.type)) {
    throw new TypeError(`addOverlay: unknown overlay type '${overlay.type}'`);
  }
  if (!imageState) return overlay.id;
  if (!Array.isArray(imageState.overlays)) imageState.overlays = [];
  imageState.overlays.push(overlay);
  invalidate(imageState, 'OVERLAY');
  return overlay.id;
}

/**
 * Remove the overlay with the given id. No-op if missing.
 */
export function removeOverlay(imageState, id) {
  if (!imageState || !Array.isArray(imageState.overlays)) return;
  const idx = imageState.overlays.findIndex(o => o && o.id === id);
  if (idx === -1) return;
  imageState.overlays.splice(idx, 1);
  invalidate(imageState, 'OVERLAY');
}

/**
 * Return the overlay with the given id, or null.
 */
export function getOverlay(imageState, id) {
  if (!imageState || !Array.isArray(imageState.overlays)) return null;
  for (const o of imageState.overlays) {
    if (o && o.id === id) return o;
  }
  return null;
}

/**
 * Translate an overlay by (dx, dy) in source-pixel space.
 *   - text  / redact: shift x and y by dx, dy.
 *   - shape:          shift x1, y1, x2, y2.
 *   - brush:          shift every point's (x, y) (pressure untouched).
 * No-op on unknown id.
 */
export function moveOverlay(imageState, id, dx, dy) {
  const o = getOverlay(imageState, id);
  if (!o) return;
  if (o.type === 'brush') {
    if (o.points && typeof o.points.length === 'number') {
      for (let i = 0; i < o.points.length; i += BRUSH_STRIDE) {
        o.points[i]     = o.points[i] + dx;
        o.points[i + 1] = o.points[i + 1] + dy;
      }
    }
  } else if (o.type === 'shape') {
    if (typeof o.x1 === 'number') o.x1 += dx;
    if (typeof o.y1 === 'number') o.y1 += dy;
    if (typeof o.x2 === 'number') o.x2 += dx;
    if (typeof o.y2 === 'number') o.y2 += dy;
  } else {
    // text / redact — single x/y anchor.
    if (typeof o.x === 'number') o.x += dx;
    if (typeof o.y === 'number') o.y += dy;
  }
  invalidate(imageState, 'OVERLAY');
}

/**
 * Shallow-merge `patch` into the overlay with the given id. No-op on unknown
 * id. Caller is responsible for the legality of the patch (we don't validate
 * arbitrary shape changes).
 */
export function updateOverlay(imageState, id, patch) {
  const o = getOverlay(imageState, id);
  if (!o || !patch || typeof patch !== 'object') return;
  for (const k of Object.keys(patch)) {
    o[k] = patch[k];
  }
  invalidate(imageState, 'OVERLAY');
}

/**
 * Move an overlay from one z-order position to another. The list is ordered
 * such that index 0 is drawn FIRST (= visually behind everything else); the
 * overlays-panel UI displays this in reverse so "top of list" feels right.
 * Throws RangeError on out-of-bounds.
 */
export function reorderOverlays(imageState, fromIndex, toIndex) {
  if (!imageState || !Array.isArray(imageState.overlays)) {
    throw new RangeError('reorderOverlays: no overlay list');
  }
  const arr = imageState.overlays;
  const n = arr.length;
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= n) {
    throw new RangeError(`reorderOverlays: fromIndex ${fromIndex} out of range [0, ${n})`);
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= n) {
    throw new RangeError(`reorderOverlays: toIndex ${toIndex} out of range [0, ${n})`);
  }
  if (fromIndex === toIndex) return;
  const [item] = arr.splice(fromIndex, 1);
  arr.splice(toIndex, 0, item);
  invalidate(imageState, 'OVERLAY');
}

/**
 * Generate a fresh overlay id. Tiny wrapper so tests can stub it out if
 * needed; the production implementation just delegates to crypto.randomUUID.
 */
export function createOverlayId() {
  return crypto.randomUUID();
}

// --- Bounds dispatch -------------------------------------------------------

/**
 * Return an axis-aligned bounding box {x, y, w, h} for an overlay in
 * SOURCE-pixel space. Used by selection handles and hit-tests.
 *
 * Brush / shape / redact bounds are derived from the overlay's own geometry.
 * Text bounds need a 2D context to measure the rendered glyph widths; if a
 * `ctx` is supplied we call ops/text.js measureText, otherwise we fall back
 * to a lower-bound estimate based on size × char count.
 *
 * Returns {x:0,y:0,w:0,h:0} for unknown types or null input.
 */
export function getOverlayBounds(overlay, ctx = null) {
  if (!overlay || typeof overlay !== 'object') return { x: 0, y: 0, w: 0, h: 0 };
  if (overlay.type === 'text') {
    return textBounds(overlay, ctx);
  }
  if (overlay.type === 'brush') {
    return brushBoundsLocal(overlay);
  }
  if (overlay.type === 'shape') {
    return shapeBoundsLocal(overlay);
  }
  if (overlay.type === 'redact') {
    return {
      x: overlay.x ?? 0,
      y: overlay.y ?? 0,
      w: overlay.w ?? 0,
      h: overlay.h ?? 0,
    };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

// Estimate a text overlay's bounds. Uses ctx.measureText if available;
// otherwise returns a coarse lower bound from size + char count so callers
// still get a non-zero box for things like hit-tests.
function textBounds(o, ctx) {
  const text = String(o.text || '');
  const lines = text.split('\n');
  const size = Number.isFinite(o.size) ? o.size : 32;
  const lineHeight = size * 1.2;
  let maxW;
  if (ctx && typeof ctx.measureText === 'function') {
    const weight = Number.isFinite(o.weight) ? o.weight : 500;
    const family = o.font || 'Onest, system-ui, sans-serif';
    const prevFont = ctx.font;
    ctx.font = `${weight} ${size}px ${family}`;
    maxW = 0;
    for (const line of lines) {
      const m = ctx.measureText(line);
      const w = m && Number.isFinite(m.width) ? m.width : 0;
      if (w > maxW) maxW = w;
    }
    ctx.font = prevFont;
  } else {
    // Coarse lower-bound estimate. Avg char ~ size * 0.55 for system fonts.
    maxW = 0;
    for (const line of lines) {
      const w = line.length * size * 0.55;
      if (w > maxW) maxW = w;
    }
  }
  return {
    x: o.x ?? 0,
    y: o.y ?? 0,
    w: maxW,
    h: lines.length * lineHeight,
  };
}

function brushBoundsLocal(o) {
  const pts = o && o.points;
  if (!pts || pts.length < BRUSH_STRIDE) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += BRUSH_STRIDE) {
    const x = pts[i], y = pts[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function shapeBoundsLocal(o) {
  if (!o) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(o.x1, o.x2);
  const y = Math.min(o.y1, o.y2);
  const w = Math.abs(o.x2 - o.x1);
  const h = Math.abs(o.y2 - o.y1);
  return { x, y, w, h };
}

// --- Draw dispatch ---------------------------------------------------------

/**
 * Draw a single overlay onto the given 2D context. Coordinates assumed to
 * already be in the context's coordinate system (caller has applied the
 * preview's zoom/rotate/flip transform). Dispatches by overlay.type to the
 * per-op draw fn.
 *
 * Async because it dynamically imports the per-type module — used by the
 * export pipeline and other ad-hoc paths. The render loop should use
 * `drawOverlaySync` with a pre-loaded `drawers` map.
 */
export async function drawOverlay(ctx, overlay) {
  if (!overlay || typeof overlay !== 'object') {
    throw new TypeError('drawOverlay: overlay must be an object');
  }
  if (overlay.type === 'text') {
    const m = await import('./ops/text.js');
    return m.drawText(ctx, overlay);
  }
  if (overlay.type === 'brush') {
    const m = await import('./ops/brush.js');
    return m.drawBrush(ctx, overlay);
  }
  if (overlay.type === 'shape') {
    const m = await import('./ops/shape.js');
    return m.drawShape(ctx, overlay);
  }
  if (overlay.type === 'redact') {
    const m = await import('./ops/redact.js');
    return m.drawRedact(ctx, overlay);
  }
  throw new Error(`Unknown overlay type: ${overlay.type}`);
}

/**
 * Synchronous draw — used by the render loop, which imports per-type
 * modules upfront and passes them in. `drawers` is a {type: fn} map.
 * Throws if no drawer is registered for the overlay's type.
 */
export function drawOverlaySync(ctx, overlay, drawers) {
  if (!overlay || typeof overlay !== 'object') {
    throw new TypeError('drawOverlaySync: overlay must be an object');
  }
  if (!drawers || typeof drawers !== 'object') {
    throw new TypeError('drawOverlaySync: drawers must be an object');
  }
  const fn = drawers[overlay.type];
  if (typeof fn !== 'function') {
    throw new Error(`No drawer registered for overlay type: ${overlay.type}`);
  }
  return fn(ctx, overlay);
}
