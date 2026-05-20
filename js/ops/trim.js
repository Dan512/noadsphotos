// js/ops/trim.js — auto-crop transparent edges or matching background color.
//
// v1.1 Feature 3. Two flavors:
//   - Trim transparent edges: bounding box of pixels with alpha > 0.
//   - Trim background color:  bounding box of pixels that do NOT match the
//     top-left source pixel (within an RGB Euclidean tolerance).
//
// Geometry note: findContentBoundingBox is a totally pure function (takes
// ImageData + a predicate, returns a rect or null). The two predicate
// factories below are equally pure. Wiring (render → bbox → bake → crop)
// lives in editor.js / queueView.js so this pure portion stays
// unit-testable without a browser context.
//
// Bake semantics (computeTrimBake below): trimming COMMITS the current
// effective render — transforms, chromakey, bgMask, adjustments, filter
// preset — into a fresh source bitmap, then sets that bitmap's
// source.{bitmap,blob,width,height,type} and clears everything that's now
// baked. Overlays stay editable, since they're vector overlays drawn on
// top at export time. This is a destructive operation by design: the user
// invoked Trim explicitly, and one Ctrl+Z restores the whole pre-bake
// state via the snapshot we record in history.
//
// Why bake instead of "modify crop only": the bbox is computed in the
// POST-EVERYTHING rendered output. Mapping it back through the inverse of
// rotate + flip + resize + chromakey + bgMask + adjust into source-pixel
// space is fiddly and would have to refuse fractional rotations. Baking
// is conceptually simple, works for every starting state, and matches
// the "one click → tightly-cropped output" mental model.

/**
 * Find the axis-aligned bounding box of "kept" pixels in an ImageData.
 *
 * `predicate(r, g, b, a)` returns true when the pixel should be KEPT
 * (i.e., NOT trimmed away). The returned rect encloses every kept pixel.
 *
 * Returns `{ x, y, w, h }` in image-data pixel coordinates, or `null` when
 * all pixels are trimmed (image is entirely transparent or matches the
 * trim color).
 *
 * O(w * h) — single linear scan, no allocations beyond the result object.
 *
 * @param {ImageData|{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @param {(r:number, g:number, b:number, a:number) => boolean} predicate
 * @returns {{x:number, y:number, w:number, h:number}|null}
 */
export function findContentBoundingBox(imageData, predicate) {
  if (!imageData || typeof predicate !== 'function') return null;
  const { data, width, height } = imageData;
  if (!data || !width || !height) return null;

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = rowBase + x * 4;
      if (predicate(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // nothing kept
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Predicate that keeps any pixel whose alpha is greater than `threshold`.
 * `threshold = 0` (the default) keeps every non-fully-transparent pixel,
 * which is what the "Trim transparent edges" mode wants.
 *
 * @param {number} [threshold=0]
 * @returns {(r:number, g:number, b:number, a:number) => boolean}
 */
export function predicateTransparent(threshold = 0) {
  const thr = Number.isFinite(threshold) ? threshold : 0;
  return (_r, _g, _b, a) => a > thr;
}

/**
 * Predicate that keeps any pixel whose RGB Euclidean distance from the
 * reference color is strictly greater than `tolerance`. Fully transparent
 * pixels (a === 0) are treated as "trim" (not content) — they're the same
 * thing we'd trim in the transparent mode.
 *
 * @param {number} refR
 * @param {number} refG
 * @param {number} refB
 * @param {number} [tolerance=8]
 * @returns {(r:number, g:number, b:number, a:number) => boolean}
 */
export function predicateNotColor(refR, refG, refB, tolerance = 8) {
  const tol = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
  const tol2 = tol * tol;
  return (r, g, b, a) => {
    if (a === 0) return false;
    const dr = r - refR;
    const dg = g - refG;
    const db = b - refB;
    return (dr * dr + dg * dg + db * db) > tol2;
  };
}

/**
 * Sample the top-left pixel of an ImageData. Returns `null` if the
 * ImageData is empty.
 *
 * Used by the "Trim background color" mode to pick its reference color
 * without an eyedropper UI in v1.1.
 *
 * @param {ImageData|{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {{r:number, g:number, b:number, a:number}|null}
 */
export function sampleTopLeftPixel(imageData) {
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) return null;
  const d = imageData.data;
  return { r: d[0], g: d[1], b: d[2], a: d[3] };
}

/**
 * Replace `imageState.source` with the baked output of computeTrimBake and
 * clear every category that's now baked in. Caller is expected to wrap this
 * in `update(s => applyTrimBakeToState(s.images[id], bake))` so subscribers
 * fire. Overlays are intentionally left intact — they're vector overlays
 * drawn on top at export time.
 *
 * @param {object} imageState
 * @param {{bitmap: any, blob: Blob, width: number, height: number, type: string}} bake
 */
export function applyTrimBakeToState(imageState, bake) {
  if (!imageState || !bake) return;
  const prevName = imageState.source && imageState.source.name;
  const prevThumb = imageState.source && imageState.source.thumbnail;
  imageState.source = {
    blob: bake.blob,
    name: prevName || 'trimmed.png',
    type: bake.type || 'image/png',
    width: bake.width,
    height: bake.height,
    thumbnail: prevThumb || null,
    bitmap: bake.bitmap,
  };
  imageState.transforms = { crop: null, rotate: 0, flipH: false, flipV: false, resize: null };
  imageState.adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
  imageState.filterPreset = 'none';
  imageState.chromakey = null;
  imageState.chromakeyMask = null;
  imageState.bgRemoved = false;
  imageState.bgMask = null;
  imageState.baseDirty = true;
  imageState.overlaysDirty = true;
}

// --------------------------------------------------------------------------
// Runtime bake helper
//
// Renders the image's effective output to a canvas, reads ImageData,
// computes a bbox using the supplied predicate, crops the canvas to that
// bbox, and encodes a PNG. Returns the data needed to replace the source
// bitmap + blob.
//
// Designed as a single browser-only helper so editor.js + queueView.js
// share one code path. The unit-testable pure pieces above stand on their
// own.
//
// `mode`:
//   - 'transparent' → uses predicateTransparent(0)
//   - 'color'       → uses predicateNotColor(refR, refG, refB, tolerance)
//                     with the top-left pixel of the rendered output as
//                     reference unless `refColor` is provided. `tolerance`
//                     defaults to 8.
//
// `renderForExport` / `caps` / `lifecycle` are injected so this module
// stays leaf-importable without pulling render or capabilities deps when
// the trim feature isn't exercised.
//
// Returns:
//   { bitmap, blob, width, height, type, fromW, fromH, toW, toH }
//   on success, or null if the rendered output is entirely trimmed.
// --------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.imageState
 * @param {object} args.caps
 * @param {object} args.lifecycle
 * @param {(state:object, opts:object, caps:object, lifecycle:object) => Promise<Blob>} args.renderForExport
 * @param {'transparent'|'color'} args.mode
 * @param {number} [args.tolerance=8]
 * @param {{r:number,g:number,b:number}} [args.refColor]
 * @returns {Promise<null | {
 *   bitmap: ImageBitmap,
 *   blob: Blob,
 *   width: number,
 *   height: number,
 *   type: string,
 *   fromW: number,
 *   fromH: number,
 *   toW: number,
 *   toH: number,
 * }>}
 */
export async function computeTrimBake({
  imageState,
  caps,
  lifecycle,
  renderForExport,
  mode,
  tolerance = 8,
  refColor = null,
}) {
  if (!imageState || !caps || !lifecycle || typeof renderForExport !== 'function') {
    throw new Error('computeTrimBake: missing required args');
  }

  // Render the full effective output as a PNG blob. PNG so we always have
  // alpha (so the transparent-mode predicate sees real alpha values).
  const renderedBlob = await renderForExport(imageState, { format: 'png', quality: 1 }, caps, lifecycle);
  if (!renderedBlob) return null;

  // Decode + read pixels into ImageData. We need both the canvas (to crop
  // from) and the ImageData (to scan).
  const renderedBitmap = await createImageBitmap(renderedBlob);
  const fromW = renderedBitmap.width;
  const fromH = renderedBitmap.height;

  const scanCanvas = makeCanvas(fromW, fromH);
  const scanCtx = scanCanvas.getContext('2d');
  if (!scanCtx) {
    try { renderedBitmap.close(); } catch { /* ignore */ }
    throw new Error('computeTrimBake: 2d context unavailable');
  }
  scanCtx.drawImage(renderedBitmap, 0, 0);
  const imageData = scanCtx.getImageData(0, 0, fromW, fromH);

  // Pick predicate.
  let predicate;
  if (mode === 'color') {
    let r, g, b;
    if (refColor && Number.isFinite(refColor.r)) {
      r = refColor.r; g = refColor.g; b = refColor.b;
    } else {
      const top = sampleTopLeftPixel(imageData);
      if (!top) {
        try { renderedBitmap.close(); } catch { /* ignore */ }
        return null;
      }
      r = top.r; g = top.g; b = top.b;
    }
    predicate = predicateNotColor(r, g, b, tolerance);
  } else {
    // default to transparent mode
    predicate = predicateTransparent(0);
  }

  const bbox = findContentBoundingBox(imageData, predicate);
  if (!bbox) {
    try { renderedBitmap.close(); } catch { /* ignore */ }
    return null;
  }

  // Encode the cropped region as a PNG blob, and decode a fresh
  // ImageBitmap from that blob so lifecycle eviction → re-decode reads
  // bytes that exactly match the bitmap we install.
  const cropCanvas = makeCanvas(bbox.w, bbox.h);
  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) {
    try { renderedBitmap.close(); } catch { /* ignore */ }
    throw new Error('computeTrimBake: 2d context unavailable');
  }
  cropCtx.drawImage(
    renderedBitmap,
    bbox.x, bbox.y, bbox.w, bbox.h,
    0, 0, bbox.w, bbox.h,
  );
  try { renderedBitmap.close(); } catch { /* ignore */ }

  const blob = await canvasToBlob(cropCanvas, 'image/png');
  if (!blob) throw new Error('computeTrimBake: encode failed');
  const bitmap = await createImageBitmap(blob);

  return {
    bitmap,
    blob,
    width: bitmap.width,
    height: bitmap.height,
    type: 'image/png',
    fromW,
    fromH,
    toW: bbox.w,
    toH: bbox.h,
  };
}

// Internal helpers --------------------------------------------------------

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, mime) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mime });
  }
  return new Promise(resolve => {
    canvas.toBlob(b => resolve(b), mime);
  });
}
