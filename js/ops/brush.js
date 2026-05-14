// js/ops/brush.js — freehand brush overlay model + draw.
//
// Pure module: depends only on a 2D context API. The renderer and the
// export pipeline both call drawBrush().
//
// Storage model:
//   - points is a Float32Array with stride 3: [x0, y0, p0, x1, y1, p1, ...].
//     x/y are in SOURCE-IMAGE pixel space; p is pressure in [0,1].
//   - For v1 pressure is preserved on the data model but not used at draw
//     time (no variable stroke width). It's there so future enhancements
//     can use it without a state migration.
//
// Draw strategy:
//   - Resample the sparse pointer-supplied points with Catmull-Rom so the
//     stroke looks smooth even when the user moves quickly. We use the
//     standard "open uniform" variant with endpoints duplicated so the
//     curve starts and ends exactly at P0 and Pn.
//   - Use round line caps + joins so the stroke doesn't have visible
//     square corners where segments meet.

const STRIDE = 3; // x, y, pressure

const DEFAULT_COLOR = '#000000';
const DEFAULT_SIZE  = 8;
const DEFAULT_SAMPLES_PER_SEGMENT = 8;

/**
 * Create a fresh brush overlay. Points are empty initially; the tool fills
 * them as the user drags.
 */
export function newBrushOverlay({ color = DEFAULT_COLOR, size = DEFAULT_SIZE } = {}) {
  return {
    id: crypto.randomUUID(),
    type: 'brush',
    rot: 0,
    color,
    size,
    points: new Float32Array(0),
  };
}

/**
 * Append (x, y, pressure) to a points Float32Array. Allocates a new array
 * one stride longer; callers assign it back:
 *   overlay.points = appendPoint(overlay.points, x, y, p);
 *
 * We don't grow the array in-place because Float32Array has a fixed length.
 * Allocations happen on every pointermove during a stroke, which is fine in
 * practice — even at 1000 samples per stroke the GC pressure is negligible
 * compared to the canvas redraws.
 */
export function appendPoint(points, x, y, pressure = 0.5) {
  const len = points ? points.length : 0;
  const next = new Float32Array(len + STRIDE);
  if (points && len > 0) next.set(points);
  next[len]     = x;
  next[len + 1] = y;
  next[len + 2] = pressure;
  return next;
}

/**
 * Shift every point in the points array by (dx, dy). Mutates in place.
 * Pressure values are left untouched.
 */
export function shiftPoints(points, dx, dy) {
  if (!points) return;
  for (let i = 0; i < points.length; i += STRIDE) {
    points[i]     = points[i]     + dx;
    points[i + 1] = points[i + 1] + dy;
  }
}

/**
 * Catmull-Rom interpolation of a sparse points array.
 *
 * Returns a new Float32Array with one entry per interpolated sample, also
 * stride-3 (x, y, pressure). The original endpoints are preserved exactly
 * (open-uniform variant — duplicate the end-points as phantom control
 * points so the curve passes through them).
 *
 * For a stroke with N points, we emit (N - 1) * samplesPerSegment + 1
 * interpolated samples (so each segment contributes samplesPerSegment
 * sub-samples and the last endpoint is appended once).
 *
 * Edge cases:
 *   - 0 points → empty array
 *   - 1 point  → returns the single point (no curve)
 *   - 2 points → linear interpolation between them (Catmull-Rom with
 *     duplicated endpoints degenerates to a line, which is what we want)
 */
export function resampleCatmullRom(points, samplesPerSegment = DEFAULT_SAMPLES_PER_SEGMENT) {
  if (!points || points.length === 0) return new Float32Array(0);
  if (points.length === STRIDE) {
    // Single point — return as-is.
    return new Float32Array(points);
  }
  if (!Number.isFinite(samplesPerSegment) || samplesPerSegment < 1) {
    samplesPerSegment = 1;
  }
  const n = points.length / STRIDE; // number of original points
  const segments = n - 1;
  const outLen = (segments * samplesPerSegment + 1) * STRIDE;
  const out = new Float32Array(outLen);
  let oi = 0;

  for (let i = 0; i < segments; i++) {
    // P0..P3 are the four control points for this segment.
    // Use duplicated endpoints when at the boundaries so the spline starts
    // and ends on the actual first/last point.
    const i0 = Math.max(0, i - 1);
    const i1 = i;
    const i2 = i + 1;
    const i3 = Math.min(segments, i + 2);
    const p0x = points[i0 * STRIDE],     p0y = points[i0 * STRIDE + 1], p0p = points[i0 * STRIDE + 2];
    const p1x = points[i1 * STRIDE],     p1y = points[i1 * STRIDE + 1], p1p = points[i1 * STRIDE + 2];
    const p2x = points[i2 * STRIDE],     p2y = points[i2 * STRIDE + 1], p2p = points[i2 * STRIDE + 2];
    const p3x = points[i3 * STRIDE],     p3y = points[i3 * STRIDE + 1], p3p = points[i3 * STRIDE + 2];

    for (let k = 0; k < samplesPerSegment; k++) {
      const t = k / samplesPerSegment;
      const { x, y, p } = catmullRomSample(
        p0x, p0y, p0p, p1x, p1y, p1p, p2x, p2y, p2p, p3x, p3y, p3p, t,
      );
      out[oi++] = x;
      out[oi++] = y;
      out[oi++] = p;
    }
  }
  // Append the final point exactly.
  const lastBase = (n - 1) * STRIDE;
  out[oi++] = points[lastBase];
  out[oi++] = points[lastBase + 1];
  out[oi++] = points[lastBase + 2];
  return out;
}

/**
 * Catmull-Rom interpolation between p1 and p2 with neighbours p0 and p3.
 * Uses the standard centripetal-form parameter tau = 0.5 (classic
 * uniform Catmull-Rom). Pressure is interpolated linearly between p1.p
 * and p2.p; smoothing pressure with the same spline isn't useful for v1
 * (no variable stroke width).
 */
function catmullRomSample(
  p0x, p0y, p0p,
  p1x, p1y, p1p,
  p2x, p2y, p2p,
  p3x, p3y, p3p,
  t,
) {
  const t2 = t * t;
  const t3 = t2 * t;
  const x = 0.5 * (
    (2 * p1x) +
    (-p0x + p2x) * t +
    (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2 +
    (-p0x + 3 * p1x - 3 * p2x + p3x) * t3
  );
  const y = 0.5 * (
    (2 * p1y) +
    (-p0y + p2y) * t +
    (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 +
    (-p0y + 3 * p1y - 3 * p2y + p3y) * t3
  );
  // Linear pressure interpolation; spline-smoothing pressure adds nothing
  // visible without variable stroke width.
  const p = p1p + (p2p - p1p) * t;
  return { x, y, p };
}

/**
 * Draw a brush overlay onto the given 2D context. Coordinates are in
 * source-pixel space; the caller is responsible for setting up the
 * preview's zoom/rotate/flip transform first.
 *
 * Options:
 *   - smooth: when false, draw raw point-to-point lines (no Catmull-Rom
 *     resampling). Default true. The brush tool / renderer reads
 *     `getSetting('smoothBrushStrokes')` and passes it through.
 */
export function drawBrush(ctx, brush, opts) {
  if (!ctx || !brush) return;
  const pts = brush.points;
  if (!pts || pts.length < STRIDE) return;
  const smooth = !opts || opts.smooth !== false;

  ctx.save();
  ctx.strokeStyle = brush.color || DEFAULT_COLOR;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = brush.size || DEFAULT_SIZE;

  if (pts.length === STRIDE) {
    // Single dot — draw a tiny line segment so the round cap fills a
    // circle the size of the stroke width. Without this, lineCap='round'
    // with a zero-length stroke renders nothing in some browsers.
    const x = pts[0];
    const y = pts[1];
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // smooth=true: Catmull-Rom resampling (current default).
  // smooth=false: walk the raw points directly so each stroke is a
  // sequence of straight line segments between recorded samples.
  const path = smooth ? resampleCatmullRom(pts, DEFAULT_SAMPLES_PER_SEGMENT) : pts;
  ctx.beginPath();
  ctx.moveTo(path[0], path[1]);
  for (let i = STRIDE; i < path.length; i += STRIDE) {
    ctx.lineTo(path[i], path[i + 1]);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Axis-aligned bounding box of the stroke's control points (in source-pixel
 * space). Does NOT account for stroke width; Phase 14 polish can refine
 * this if the selection outline needs to wrap the painted area.
 */
export function brushBounds(brush) {
  const pts = brush && brush.points;
  if (!pts || pts.length < STRIDE) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += STRIDE) {
    const x = pts[i], y = pts[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Re-export STRIDE so callers + tests don't hard-code the magic number.
export const BRUSH_STRIDE = STRIDE;
