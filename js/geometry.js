// js/geometry.js — transform math, hit-test, crop handle helpers.
//
// Pure module: no DOM, no browser APIs. Runs identically in Node.
// Conventions:
//   - Points are {x, y}.
//   - Rects are {x, y, w, h} where x/y is the top-left corner and w/h are
//     non-negative dimensions (callers should normalize via rectFromHandles
//     when they have unordered handle drags).
//   - Rotation arguments are in DEGREES (so the wider codebase doesn't have
//     to convert; internal math converts to radians).
//   - "Display" / "screen" space is the post-transform canvas-pixel space.
//     "World" / "source" space is the underlying image-pixel space.
//
// All functions are total (well-defined on the documented inputs) and avoid
// throwing on edge values like zero-size rects or scale==0 (callers can
// validate upstream if they need to).

// --------------------------------------------------------------------------
// Basic points / rects
// --------------------------------------------------------------------------

export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function lerp(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

// Inclusive on every edge: a point exactly on a side counts as inside.
export function pointInRect(p, rect) {
  return p.x >= rect.x
      && p.x <= rect.x + rect.w
      && p.y >= rect.y
      && p.y <= rect.y + rect.h;
}

// Rotation is around the rect's geometric center, in degrees (positive =
// counter-clockwise in screen space when y points down; the formula below
// matches a standard rotation matrix applied to the test point's offset
// from the rect's center).
export function pointInRotatedRect(p, rect, rotDeg) {
  if (!rotDeg) return pointInRect(p, rect);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const rad = -rotDeg * Math.PI / 180; // inverse rotation
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const localX = dx * cos - dy * sin + cx;
  const localY = dx * sin + dy * cos + cy;
  return pointInRect({ x: localX, y: localY }, rect);
}

// --------------------------------------------------------------------------
// Coordinate transforms (world ↔ screen)
//
// The transform represents the image's display state:
//   - scale: zoom factor (>0).
//   - panX / panY: screen-space translation applied AFTER scale/rotate.
//     World origin (0,0) maps to (panX, panY) when scale=1, rotation=0.
//   - rotation: degrees, around the world origin.
//   - flipH / flipV: mirror axes in world space BEFORE scale/rotate.
//
// forward(p) takes a world point to screen.
// inverse(p) takes a screen point to world.
//
// We expose factor numbers (cos/sin/sx/sy) and the helpers so consumers can
// inline the math without paying a function-call per pixel when needed.
// --------------------------------------------------------------------------

export function makeTransform({
  scale = 1,
  panX = 0,
  panY = 0,
  rotation = 0,
  flipH = false,
  flipV = false,
} = {}) {
  const rad = rotation * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const sx = flipH ? -scale : scale;
  const sy = flipV ? -scale : scale;

  // Forward: world → screen.
  //   1. flip * scale: (x * sx, y * sy)
  //   2. rotate by `rotation`
  //   3. translate by (panX, panY)
  function forward(p) {
    const fx = p.x * sx;
    const fy = p.y * sy;
    return {
      x: fx * cos - fy * sin + panX,
      y: fx * sin + fy * cos + panY,
    };
  }

  // Inverse: screen → world. Apply the inverse operations in reverse order.
  function inverse(p) {
    const dx = p.x - panX;
    const dy = p.y - panY;
    // Inverse rotation: cos→cos, sin→-sin.
    const rx = dx * cos + dy * sin;
    const ry = -dx * sin + dy * cos;
    return {
      // Inverse flip*scale: divide by sx / sy. Guard against scale 0 below.
      x: sx === 0 ? 0 : rx / sx,
      y: sy === 0 ? 0 : ry / sy,
    };
  }

  return {
    forward, inverse,
    scale, panX, panY, rotation, flipH, flipV,
    cos, sin, sx, sy,
  };
}

export function worldToScreen(point, transform) {
  return transform.forward(point);
}

export function screenToWorld(point, transform) {
  return transform.inverse(point);
}

// --------------------------------------------------------------------------
// Crop helpers
// --------------------------------------------------------------------------

// Normalize two arbitrary handle points into a {x,y,w,h} rect where x/y is
// the top-left and w/h are non-negative. Used when a user drags from any
// corner — we don't know which one is "start" until we look at coords.
export function rectFromHandles(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  return { x, y, w, h };
}

// Clamp a rect to live entirely inside an axis-aligned image. The returned
// rect always has w >= 0 and h >= 0. If the rect is larger than the image
// in either axis the result is the image bounds on that axis.
export function clampCropToImage(rect, imageSize) {
  const iw = imageSize.w;
  const ih = imageSize.h;

  // Shrink width/height first so we never overflow when shifting.
  let w = Math.min(rect.w, iw);
  let h = Math.min(rect.h, ih);
  if (w < 0) w = 0;
  if (h < 0) h = 0;

  let x = rect.x;
  let y = rect.y;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > iw) x = iw - w;
  if (y + h > ih) y = ih - h;

  return { x, y, w, h };
}

// Aspect-locked resize when the user drags a handle on a crop rect.
//
// `anchor` names the HANDLE that the user is dragging (the moving one).
// The OPPOSITE corner/edge stays put. So 'br' means the user is dragging
// the bottom-right corner — the top-left corner of the rect stays fixed.
//
// Handle codes:
//   'tl' top-left,  'tr' top-right, 'bl' bottom-left, 'br' bottom-right,
//   't'  top edge,  'b'  bottom edge, 'l' left edge,  'r' right edge.
//
// `target` is the new screen-space position of the moving handle.
// `aspect` = width / height. Pass a finite positive number to enable the
// lock. Pass `aspect <= 0` or non-finite to disable it.
//
// For edge drags ('t'/'b'/'l'/'r'), only one axis moves with the target;
// the perpendicular axis is derived from the aspect (when locked) or kept
// unchanged (when free). When locked, the rect grows/shrinks symmetrically
// around the perpendicular midpoint of the stationary axis.
export function aspectLockResize(rect, anchor, target, aspect) {
  const useAspect = Number.isFinite(aspect) && aspect > 0;

  // Fixed (stationary) point — the corner OPPOSITE the dragged handle, or
  // the midpoint of the edge opposite a dragged edge.
  const fx = (anchor === 'tr' || anchor === 'br' || anchor === 'r')
    ? rect.x                              // moving right edge → left stays
    : (anchor === 'tl' || anchor === 'bl' || anchor === 'l')
      ? rect.x + rect.w                   // moving left edge → right stays
      : rect.x + rect.w / 2;              // 't' / 'b' → x-center stays
  const fy = (anchor === 'bl' || anchor === 'br' || anchor === 'b')
    ? rect.y                              // moving bottom edge → top stays
    : (anchor === 'tl' || anchor === 'tr' || anchor === 't')
      ? rect.y + rect.h                   // moving top edge → bottom stays
      : rect.y + rect.h / 2;              // 'l' / 'r' → y-center stays

  // Edge drags: one axis moves with target, the other is derived.
  if (anchor === 't' || anchor === 'b') {
    let h = (anchor === 'b') ? (target.y - rect.y) : (rect.y + rect.h - target.y);
    h = Math.max(0, h);
    const w = useAspect ? h * aspect : rect.w;
    const x = fx - w / 2;                 // centered on the stationary x
    const y = (anchor === 'b') ? rect.y : (rect.y + rect.h - h);
    return { x, y, w, h };
  }
  if (anchor === 'l' || anchor === 'r') {
    let w = (anchor === 'r') ? (target.x - rect.x) : (rect.x + rect.w - target.x);
    w = Math.max(0, w);
    const h = useAspect ? w / aspect : rect.h;
    const y = fy - h / 2;                 // centered on the stationary y
    const x = (anchor === 'r') ? rect.x : (rect.x + rect.w - w);
    return { x, y, w, h };
  }

  // Corner drag: desired width/height come from the offset between the
  // stationary corner and the target cursor position.
  let w = Math.abs(target.x - fx);
  let h = Math.abs(target.y - fy);

  if (useAspect) {
    // Reconcile w/h against aspect. Pick whichever axis demands the larger
    // rect so the moving corner stays covered by the cursor (typical UX).
    const wFromH = h * aspect;
    if (w > wFromH) {
      h = w / aspect;
    } else {
      w = wFromH;
    }
  }

  // Place the rect so the stationary corner stays put.
  const x = (anchor === 'tr' || anchor === 'br') ? fx : fx - w;
  const y = (anchor === 'bl' || anchor === 'br') ? fy : fy - h;
  return { x, y, w, h };
}

// Axis-aligned bounding box of a rect rotated around its center.
// Output is always axis-aligned (you lose orientation, but gain a quick
// hit-region for layout / culling).
export function rotateRect(rect, rotDeg) {
  // Modulo-aware fast paths: 0/180 → unchanged dims; 90/270 → swap.
  const norm = ((rotDeg % 360) + 360) % 360;
  if (norm === 0 || norm === 180) {
    return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }
  if (norm === 90 || norm === 270) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return {
      x: cx - rect.h / 2,
      y: cy - rect.w / 2,
      w: rect.h,
      h: rect.w,
    };
  }
  const rad = norm * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const bw = rect.w * cos + rect.h * sin;
  const bh = rect.w * sin + rect.h * cos;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    x: cx - bw / 2,
    y: cy - bh / 2,
    w: bw,
    h: bh,
  };
}

// --------------------------------------------------------------------------
// effectiveImageSize — used by the renderer and export pipelines to know
// the final output dimensions before drawing.
//
// Applies, in order:
//   1. crop (if set): output = crop.w × crop.h
//   2. rotate (multiples of 90 swap w/h; non-multiples are passed through
//      via bounding box for now — Phase 6 will refine).
//   3. resize: 'longestSide' | 'shortestSide' | 'width' | 'height' | 'exact'
//
// `imageState` is the shape used in app state. Source dims default to
// imageState.source.{width,height}.
// --------------------------------------------------------------------------

export function effectiveImageSize(imageState) {
  if (!imageState || !imageState.source) return { w: 0, h: 0 };

  const sw = imageState.source.width  || 0;
  const sh = imageState.source.height || 0;

  // 1. crop
  const crop = imageState.transforms && imageState.transforms.crop;
  let w = sw;
  let h = sh;
  if (crop && Number.isFinite(crop.w) && Number.isFinite(crop.h)) {
    w = crop.w;
    h = crop.h;
  }

  // 2. rotate (only effects on dims for multiples of 90).
  const rot = (imageState.transforms && imageState.transforms.rotate) || 0;
  const norm = ((rot % 360) + 360) % 360;
  if (norm === 90 || norm === 270) {
    const tmp = w;
    w = h;
    h = tmp;
  } else if (norm !== 0 && norm !== 180) {
    // Non-90 rotation: bounding box.
    const r = rotateRect({ x: 0, y: 0, w, h }, norm);
    w = r.w;
    h = r.h;
  }

  // 3. resize.
  const resize = imageState.transforms && imageState.transforms.resize;
  if (resize && Number.isFinite(resize.value) && resize.value > 0) {
    const value = resize.value;
    switch (resize.mode) {
      case 'longestSide': {
        const longest = Math.max(w, h);
        if (longest === 0) break;
        const factor = value / longest;
        w = w * factor;
        h = h * factor;
        break;
      }
      case 'shortestSide': {
        const shortest = Math.min(w, h);
        if (shortest === 0) break;
        const factor = value / shortest;
        w = w * factor;
        h = h * factor;
        break;
      }
      case 'width': {
        if (w === 0) break;
        const factor = value / w;
        w = value;
        h = h * factor;
        break;
      }
      case 'height': {
        if (h === 0) break;
        const factor = value / h;
        h = value;
        w = w * factor;
        break;
      }
      case 'exact': {
        // 'exact' takes both axes explicitly — value applies to width;
        // resize.height (if provided) applies to height. Otherwise treat
        // value as a uniform scale on both axes.
        w = value;
        h = Number.isFinite(resize.height) && resize.height > 0
          ? resize.height
          : value;
        break;
      }
      case 'percent': {
        // 'percent' scales both axes uniformly by value/100.
        // value=10 → 10% of original. value=200 → 2× original.
        const factor = value / 100;
        w = w * factor;
        h = h * factor;
        break;
      }
      default:
        // Unknown mode → leave dims as-is.
        break;
    }
  }

  return { w, h };
}
