// js/exporter.js — single-image and batch export orchestration.
//
// The exporter sits between the export panel UI and the rendering pipeline.
// It owns the user-facing UX: warning about v1 limitations, triggering the
// browser download, and translating renderer errors into readable toasts.
//
// Filename templates support (single export):
//   - {base} → original filename without extension
//   - {date} → today's date as YYYYMMDD
//   - {n}    → image index in a batch (empty string for single export)
//
// Batch export adds:
//   - {ext}  → output extension (png|jpg|webp)
//   - {n}    → 1-based position in the queue, zero-padded to match queue
//              length (e.g. `01`..`12` for a 12-image queue).
//
// The download trick (anchor + URL.createObjectURL) works in every modern
// browser, including iOS Safari. We defer revoking the object URL by 60s
// because iOS Safari sometimes needs the URL alive for a moment after the
// click to actually start the download.
import { renderForExport } from './render/exportRenderer.js';
import { renderForPdf, renderForPdfBatch } from './render/pdfRenderer.js';
import { showToast } from './errors.js';
import { getState } from './state.js';
import { EncodeError } from './codec.js';
import { escapeHtml } from './escape.js';
import { loadJSZip } from './vendor/jszip-loader.js';
import { t } from './i18n.js';
import { extractExifSegment, injectExifIntoJpeg } from './exif.js';
import { bisectQuality, bisectQualityWithResize } from './ops/targetSize.js';
import { shouldDownscale } from './ops/uploadReady.js';

/**
 * Pretty-print a byte count. Used by the predicted-size readout, success
 * toasts, and the "Smallest size" comparison output.
 *
 *   1023        → '1023 B'
 *   1024..      → 'N KB'  (rounded to integer KB)
 *   1024*1024.. → 'N.M MB' (one decimal place)
 *
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Heuristically detect whether an image has, or will have, transparent
 * pixels in its exported output. We use a STATE-based check rather than
 * sampling the rendered canvas:
 *   - source PNG (which often carries alpha)
 *   - a chromakey was applied (silhouettes the picked color out)
 *   - a bgMask is present (background removed)
 *   - a redact overlay uses 'blur' (blur leaves edges semi-transparent
 *     in v1; pixelate stays opaque)
 *
 * False positives are fine (we just don't pick JPG when we could have);
 * false negatives risk silently picking JPG and ditching alpha. The
 * source-PNG check is the conservative default.
 *
 * @param {object} imageState
 * @returns {boolean}
 */
export function hasTransparency(imageState) {
  if (!imageState) return false;
  if (imageState.bgMask) return true;
  if (imageState.chromakeyMask) return true;
  const ck = imageState.chromakey;
  if (ck && (ck.hex || (typeof ck.tolerance === 'number' && ck.tolerance > 0))) return true;
  // Source PNG is the common "has alpha" case. We don't decode pixels here —
  // the source MIME is recorded at import time as `source.type`.
  const mime = imageState.source && (imageState.source.type || imageState.source.mime);
  if (mime === 'image/png') return true;
  return false;
}

/**
 * Format-comparison candidates for the "Smallest size" preset. Quality is
 * irrelevant for PNG (lossless); other formats sweep a small ladder so we
 * find the knee of the size/quality curve without running 50 encodes.
 *
 * The order matters only for ties: earlier entries win, so PNG-vs-other ties
 * go to the lossless format.
 */
const SMALLEST_CANDIDATES = Object.freeze([
  { format: 'png',  quality: 1.0,  alpha: true  },
  { format: 'webp', quality: 0.95, alpha: true  },
  { format: 'webp', quality: 0.85, alpha: true  },
  { format: 'webp', quality: 0.75, alpha: true  },
  { format: 'webp', quality: 0.65, alpha: true  },
  { format: 'jpeg', quality: 0.95, alpha: false },
  { format: 'jpeg', quality: 0.85, alpha: false },
  { format: 'jpeg', quality: 0.75, alpha: false },
  { format: 'jpeg', quality: 0.65, alpha: false },
]);

/**
 * Run the renderForExport pipeline once per candidate format/quality, return
 * the smallest blob along with its winning settings. PNG is the reference
 * size for the "% smaller than PNG" toast caller, so we always evaluate it
 * first and remember its size.
 *
 * If the image has transparency (per `hasTransparency`), JPEG candidates are
 * excluded so we never silently drop the alpha channel.
 *
 * Browsers without WebP encoding (per `caps.webp`) skip WebP candidates —
 * the codec would throw EncodeError otherwise.
 *
 * @param {object} imageState
 * @param {object} caps
 * @param {object} lifecycle
 * @returns {Promise<{format: string, quality: number, blob: Blob, pngSize: number|null, candidates: Array}>}
 */
export async function pickSmallestFormat(imageState, caps, lifecycle) {
  if (!imageState || !lifecycle) throw new Error('pickSmallestFormat: missing args');
  const supportsWebp = !!(caps && caps.webp);
  const wantsAlpha = hasTransparency(imageState);
  let best = null;
  let pngSize = null;
  const tried = [];

  for (const cand of SMALLEST_CANDIDATES) {
    if (cand.format === 'webp' && !supportsWebp) continue;
    if (wantsAlpha && !cand.alpha) continue;
    let blob;
    try {
      blob = await renderForExport(imageState, { format: cand.format, quality: cand.quality }, caps, lifecycle);
    } catch (err) {
      // Skip on any per-candidate failure — codec.js may reject when WebP
      // appears supported but encoding fails for this particular surface.
      // eslint-disable-next-line no-console
      console.warn('pickSmallestFormat: candidate failed', cand, err && err.message);
      continue;
    }
    tried.push({ ...cand, size: blob.size });
    if (cand.format === 'png') pngSize = blob.size;
    if (!best || blob.size < best.blob.size) {
      best = { format: cand.format, quality: cand.quality, blob };
    }
  }

  if (!best) throw new Error('pickSmallestFormat: no candidates succeeded');
  return { ...best, pngSize, candidates: tried };
}

// Module-scope context populated by setExportContext (called from main.js after
// lifecycle + caps are ready). Without this, the panel's Download button has
// nothing to plumb through.
let ctxLifecycle = null;
let ctxCaps = null;

// Predict-encode cache. The panel's "Predicted size" readout calls
// renderForExport at the current settings; we keep the resulting Blob on
// hand so a subsequent Download click can reuse it without a second encode.
// Keyed by {imageId, format, quality, stateHash} so it invalidates on any
// edit that affects the output bytes.
let predictCache = null; // { key: string, blob: Blob }

// Last successfully exported Blob — used by the "Verify last export" button
// in the Export panel to inspect for leaked metadata. Cleared on
// _resetForTest. We store BOTH the blob and the filename so the verify UI
// can mention what was inspected.
let lastExportedBlob = null;     // Blob | null
let lastExportedFilename = null; // string | null

function makePredictKey(imageId, format, quality, stateSignature) {
  return `${imageId}::${format}::${quality}::${stateSignature}`;
}

/**
 * Produce a stable, compact string fingerprint of the global watermark
 * settings that affect the rendered output. Used as part of the predict-
 * encode cache key so changes to watermark state (enable, scale, position,
 * color, etc.) invalidate the cache and force a fresh render on the next
 * export.
 *
 * Bug fix for v1.2.08: the cache key only included per-image state, so
 * toggling the watermark or tweaking its settings produced no cache miss —
 * stale bytes (with the wrong / no watermark) were re-served on Download.
 *
 * Skips transient fields (imageBlobUrl regenerates each session even for
 * the same logo). Uses imageBlobBase64.length as a cheap "is the logo
 * different" proxy — two different logos with the same base64 byte length
 * would be a false cache hit, but that's vanishingly unlikely AND only
 * matters when type === 'image'.
 *
 * @param {object|null|undefined} wm — state.ui.watermark shape
 * @returns {string}
 */
export function watermarkCacheKey(wm) {
  if (!wm || !wm.enabled) return 'wm:off';
  return [
    'wm:on',
    wm.type || '',
    wm.position || '',
    wm.customX, wm.customY,
    wm.opacity, wm.scale, wm.tiledAngle,
    wm.text || '',
    wm.textFont || '',
    wm.textSize,
    wm.textColor || '',
    (wm.imageBlobBase64 || '').length,
  ].join('|');
}

/**
 * Record the latest predict-encode result so a follow-up Download click can
 * reuse the bytes. Caller is responsible for keying — we just store last.
 */
export function setPredictCache(key, blob) {
  predictCache = (key && blob) ? { key, blob } : null;
}

/**
 * Read the cached predict blob iff its key matches. Returns null on miss.
 */
export function getPredictCache(key) {
  if (!predictCache || predictCache.key !== key) return null;
  return predictCache.blob;
}

export function clearPredictCache() {
  predictCache = null;
}

/**
 * Return the last successfully exported Blob (single or batch first image) so
 * the Export panel's "Verify last export" button can inspect its bytes for
 * leaked EXIF/XMP/GPS metadata. Null if nothing has been exported this
 * session.
 *
 * @returns {{ blob: Blob, filename: string } | null}
 */
export function getLastExportedBlob() {
  if (!lastExportedBlob) return null;
  return { blob: lastExportedBlob, filename: lastExportedFilename || '' };
}

/**
 * Internal helper — records the last exported blob. Exported for tests that
 * want to seed it directly.
 */
export function _setLastExported(blob, filename) {
  lastExportedBlob = blob || null;
  lastExportedFilename = filename || null;
}

/**
 * Provide lifecycle + caps refs so the export panel's Download button can
 * call exportSingle without re-deriving them. Called once at boot.
 */
export function setExportContext({ lifecycle, caps }) {
  ctxLifecycle = lifecycle || null;
  ctxCaps = caps || null;
}

export function getExportContext() {
  return { lifecycle: ctxLifecycle, caps: ctxCaps };
}

/**
 * Export a single image. Designed to be called from the editor's Download
 * button — it reads format/quality/filenameTemplate from state.export.
 *
 * @param {string} imageId
 * @param {object} [lifecycleOrOpts] - lifecycle, OR an opts object {lifecycle?, caps?, predictKey?}
 * @param {object} [caps]            - falls back to module ctx
 * @returns {Promise<Blob|null>} the exported blob, or null on failure (toasts shown).
 */
export async function exportSingle(imageId, lifecycleOrOpts = ctxLifecycle, caps = ctxCaps) {
  // Backwards-compat: legacy callers pass (id, lifecycle, caps). New callers
  // can pass (id, { lifecycle, caps, predictKey }) to take advantage of the
  // predict-encode cache.
  let lifecycle, opts;
  if (lifecycleOrOpts && typeof lifecycleOrOpts === 'object' && (
      'lifecycle' in lifecycleOrOpts || 'caps' in lifecycleOrOpts || 'predictKey' in lifecycleOrOpts)) {
    opts = lifecycleOrOpts;
    lifecycle = opts.lifecycle || ctxLifecycle;
    caps = opts.caps || caps || ctxCaps;
  } else {
    lifecycle = lifecycleOrOpts || ctxLifecycle;
    opts = null;
  }
  const s = getState();
  const img = s.images[imageId];
  if (!img) {
    showToast(t('exportNoImage'), { variant: 'warn' });
    return null;
  }
  if (!lifecycle || !caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return null;
  }

  const { format, quality, filenameTemplate } = s.export;

  // Surface known v1 limitations BEFORE the heavy work — the user can cancel
  // by closing the tab if the warning is a dealbreaker.
  warnIfNeeded(img, caps);

  // Reuse the predict-encode blob if the panel pre-computed one for the
  // current settings + state. The opts.predictKey passed in by the caller
  // should match what the panel registered via setPredictCache.
  let blob = null;
  if (opts && opts.predictKey) {
    const cached = getPredictCache(opts.predictKey);
    if (cached) blob = cached;
  }
  if (!blob) {
    try {
      blob = await renderForExport(img, { format, quality }, caps, lifecycle);
    } catch (err) {
      handleExportError(err);
      return null;
    }
  }

  // v1.1.2: optional EXIF preservation. When the user has unchecked "Strip
  // metadata" AND the source is JPEG AND the output is JPEG, splice the
  // source's APP1/Exif segment into the Canvas-encoded blob so GPS/camera
  // info survives the round-trip. Default (strip) is the safe path — no
  // metadata is injected and Canvas's natural strip behaviour wins.
  blob = await maybePreserveExif(img, blob, format, s.export.stripMetadata);

  const filename = makeFilename(img, format, filenameTemplate);
  try {
    triggerDownload(blob, filename);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportSingle: download trigger failed', err);
    showToast(t('exportDownloadFailedSingle'), { variant: 'error' });
    return blob;
  }
  // Remember the blob so the panel's "Verify last export" button can inspect
  // it for leaked EXIF/XMP/GPS metadata — the privacy guarantee we surface
  // to users.
  lastExportedBlob = blob;
  lastExportedFilename = filename;
  // Include the actual file size in the success toast so users see what
  // compression they got — the headline feature for "compress image online"
  // visitors.
  showToast(t('exportSuccessWithSize', { filename, size: formatBytes(blob.size) }), { variant: 'info' });
  return blob;
}

/**
 * Export an image to fit under a target file size by bisecting quality (and
 * optionally dimensions). Reuses the existing renderForExport pipeline for
 * each encoding attempt — no parallel canvas logic.
 *
 * The pure-math bisection lives in js/ops/targetSize.js; this function is the
 * thin wiring layer that builds the `encodeAtScale` callback, dispatches to
 * either bisectQuality or bisectQualityWithResize, and translates the result
 * into a download + filename.
 *
 * This function does NOT touch state.ui or surface its own toasts — the UI
 * task (follow-up) owns the user-facing progress and result feedback. The
 * caller gets the result object and decides what to render.
 *
 * @param {string} imageId
 * @param {{
 *   targetBytes: number,
 *   autoResize?: boolean,    // default true
 *   format?: 'jpeg' | 'webp', // default 'jpeg'
 *   minDimension?: number,    // default 320
 * }} config
 * @param {{
 *   lifecycle?: object,
 *   caps?: object,
 *   suppressDownload?: boolean,
 * }} [opts]
 * @returns {Promise<{
 *   blob: Blob | null,
 *   filename: string,
 *   quality: number,
 *   scale: number,
 *   finalWidth: number,
 *   finalHeight: number,
 *   totalIters: number,
 *   fits: boolean,
 *   hit: string,
 * }>}
 */
export async function exportToTargetSize(imageId, config, opts = {}) {
  const lifecycle = (opts && opts.lifecycle) || ctxLifecycle;
  const caps = (opts && opts.caps) || ctxCaps;
  if (!lifecycle || !caps) {
    throw new Error('exportToTargetSize: lifecycle/caps not ready');
  }
  const s = getState();
  const img = s.images && s.images[imageId];
  if (!img) throw new Error('exportToTargetSize: image not found');

  const targetBytes = Number(config && config.targetBytes);
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    throw new Error('exportToTargetSize: targetBytes must be a positive number');
  }
  const format = (config && config.format) || 'jpeg';
  // PNG would be a no-op for quality bisection (lossless); the panel UI will
  // restrict format to jpeg/webp but we sanity-check here too.
  if (format !== 'jpeg' && format !== 'webp') {
    throw new Error(`exportToTargetSize: unsupported format ${format}`);
  }
  const autoResize = config.autoResize !== false; // default true
  const minDimension = Number.isFinite(config.minDimension) ? config.minDimension : 320;

  // Determine the source long-edge (post-crop / 90s-rotate, pre-resize) so
  // bisectQualityWithResize can clamp at minDimension correctly. We use the
  // raw source dims as a proxy — fine for the clamp math; the actual output
  // size accounts for crop/rotate via effectiveImageSize inside the renderer.
  const sourceWidth = (img.source && img.source.width) || 0;
  const sourceHeight = (img.source && img.source.height) || 0;
  const sourceLong = Math.max(sourceWidth, sourceHeight);

  // Build a per-attempt state object that overrides transforms.resize with the
  // current scale factor, expressed as a `longestSide` value. scale=1.0 means
  // "no extra resize beyond whatever the user already configured"; scale<1
  // means "downsample to scale * sourceLong on the long edge." We deliberately
  // override the user's resize directive — auto-target IS the resize when
  // engaged.
  function stateAtScale(scale) {
    if (scale >= 0.9999) {
      // At full scale, preserve whatever resize the user configured.
      return img;
    }
    const targetLong = Math.max(1, Math.round(sourceLong * scale));
    return {
      ...img,
      transforms: {
        ...(img.transforms || {}),
        resize: { mode: 'longestSide', value: targetLong },
      },
    };
  }

  async function encodeAtScale(scale, quality) {
    const attemptState = stateAtScale(scale);
    try {
      return await renderForExport(attemptState, { format, quality }, caps, lifecycle);
    } catch (err) {
      // Re-throw EncodeError as-is so callers can distinguish it from a
      // generic render failure.
      if (err instanceof EncodeError) throw err;
      throw err;
    }
  }

  let bisectResult;
  if (autoResize) {
    bisectResult = await bisectQualityWithResize({
      encodeAtScale,
      target: targetBytes,
      sourceWidth,
      sourceHeight,
      minDimension,
    });
  } else {
    const encode = (q) => encodeAtScale(1, q);
    const inner = await bisectQuality({ encode, target: targetBytes });
    bisectResult = {
      blob: inner.blob,
      quality: inner.quality,
      scale: 1,
      finalWidth: sourceWidth,
      finalHeight: sourceHeight,
      totalIters: inner.iters,
      fits: inner.fits,
      hit: inner.hit === 'overshot' ? 'unreachable' : inner.hit,
    };
  }

  const filename = makeFilename(img, format, '{base}-targetsize');

  if (bisectResult.blob && !(opts && opts.suppressDownload)) {
    try {
      triggerDownload(bisectResult.blob, filename);
      lastExportedBlob = bisectResult.blob;
      lastExportedFilename = filename;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('exportToTargetSize: download trigger failed', err);
      // Still return the result so the caller can decide what to do.
    }
  }

  return {
    blob: bisectResult.blob,
    filename,
    quality: bisectResult.quality,
    scale: bisectResult.scale,
    finalWidth: bisectResult.finalWidth,
    finalHeight: bisectResult.finalHeight,
    totalIters: bisectResult.totalIters,
    fits: bisectResult.fits,
    hit: bisectResult.hit,
  };
}

/**
 * Batch-export every image in the queue under a target file size, bundled
 * into a single ZIP. Reuses `exportToTargetSize` per image with
 * `suppressDownload: true` so we collect Blobs instead of triggering N
 * individual browser downloads.
 *
 * Sequential to bound peak memory — one bisection runs at a time. After
 * each image is encoded, its decoded bitmap is evicted (if it isn't the
 * active editor image).
 *
 * `onProgress({ done, total })` fires after each image so the caller can
 * keep a progress toast in sync.
 *
 * @param {{
 *   targetBytes: number,
 *   autoResize?: boolean,
 *   format?: 'jpeg' | 'webp',
 *   minDimension?: number,
 * }} config
 * @param {{
 *   lifecycle?: object,
 *   caps?: object,
 *   onProgress?: (info: { done: number, total: number }) => void,
 * }} [opts]
 * @returns {Promise<{ done: number, total: number, failed: number, blobs: Array<{ id: string, blob: Blob, filename: string, fits: boolean }> } | null>}
 */
export async function exportBatchToTargetSize(config, opts = {}) {
  const lifecycle = opts.lifecycle || ctxLifecycle;
  const caps = opts.caps || ctxCaps;
  if (!lifecycle || !caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return null;
  }
  const s = getState();
  const ids = [...s.queue];
  const total = ids.length;
  if (total === 0) {
    showToast(t('exportQueueEmpty'), { variant: 'warn' });
    return null;
  }
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  let JSZip;
  try {
    JSZip = await loadJSZip();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatchToTargetSize: JSZip load failed', err);
    showToast(t('exportZipLibFailed'), { variant: 'error' });
    return null;
  }

  const zip = new JSZip();
  const usedNames = new Set();
  const blobs = [];
  let done = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const result = await exportToTargetSize(id, config, {
        lifecycle, caps, suppressDownload: true,
      });
      if (result && result.blob) {
        const safeName = uniquifyName(result.filename, usedNames);
        usedNames.add(safeName);
        zip.file(safeName, result.blob);
        blobs.push({ id, blob: result.blob, filename: safeName, fits: !!result.fits });
        done += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('exportBatchToTargetSize: per-image failed', id, err);
      failed += 1;
    }

    // Free decoded bitmap unless it's the active image. Mirrors exportBatch.
    if (id !== getState().ui.activeImageId && lifecycle && typeof lifecycle.evictAfterUse === 'function') {
      try { lifecycle.evictAfterUse(id); } catch { /* ignore */ }
    }

    if (onProgress) {
      try { onProgress({ done: done + failed, total }); } catch { /* ignore */ }
    }
  }

  if (done === 0) {
    showToast(t('exportNothingSucceeded'), { variant: 'error' });
    return { done: 0, total, failed, blobs: [] };
  }

  let zipBlob;
  try {
    zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatchToTargetSize: zip.generateAsync failed', err);
    showToast(t('exportZipBuildFailed'), { variant: 'error' });
    return { done, total, failed, blobs };
  }

  const zipName = `noadsphotos-targetsize-${Date.now()}.zip`;
  try {
    triggerDownload(zipBlob, zipName);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatchToTargetSize: download trigger failed', err);
    showToast(t('exportZipDownloadFailed'), { variant: 'error' });
  }

  return { done, total, failed, blobs };
}

/**
 * Apply the upload-ready preset (v1.3 Feature 9) to one or more images.
 * The preset is a fixed composition of existing operations:
 *
 *   - Resize: cap the long edge at `config.longEdge` (skipped when the
 *     source is already smaller — see `shouldDownscale`)
 *   - Encode: at `config.format` + `config.quality` (quality ignored for png)
 *   - EXIF: stripped by default (`stripExif: true`). If `stripExif: false`
 *     AND output is JPEG, the source's APP1 segment is spliced back in via
 *     the existing `maybePreserveExif` helper.
 *   - Filename: applied via `applyFilenameTemplate` with the user's template
 *
 * Single image: triggers a direct browser download. Multiple images: builds
 * a ZIP and triggers one download. Always honors `opts.suppressDownload` for
 * tests / batch wrappers that want the bytes without the side effect.
 *
 * Sequential per-image encode (mirrors exportBatch) to keep peak memory bounded.
 *
 * @param {string[]} imageIds
 * @param {{
 *   longEdge: number,
 *   format: 'jpeg'|'webp'|'png',
 *   quality: number,
 *   stripExif: boolean,
 *   filenameTemplate: string,
 * }} config
 * @param {{
 *   lifecycle?: object,
 *   caps?: object,
 *   suppressDownload?: boolean,
 *   onProgress?: (info: { done: number, total: number }) => void,
 * }} [opts]
 * @returns {Promise<{
 *   exported: number,
 *   failed: number,
 *   total: number,
 *   blobSize: number,
 *   zipBlob?: Blob,
 *   downloadedFilename?: string,
 * } | null>}
 */
export async function applyUploadReadyPreset(imageIds, config, opts = {}) {
  const lifecycle = opts.lifecycle || ctxLifecycle;
  const caps = opts.caps || ctxCaps;
  if (!lifecycle || !caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return null;
  }
  if (!Array.isArray(imageIds) || imageIds.length === 0) {
    showToast(t('exportQueueEmpty'), { variant: 'warn' });
    return null;
  }
  if (!config || typeof config !== 'object') {
    throw new Error('applyUploadReadyPreset: config is required');
  }
  const format = (config.format === 'png' || config.format === 'webp') ? config.format : 'jpeg';
  const longEdge = Number(config.longEdge);
  if (!Number.isFinite(longEdge) || longEdge <= 0) {
    throw new Error('applyUploadReadyPreset: longEdge must be a positive number');
  }
  const quality = Number.isFinite(config.quality) ? config.quality : 0.85;
  const stripExif = config.stripExif !== false;
  const filenameTemplate = (typeof config.filenameTemplate === 'string' && config.filenameTemplate.length > 0)
    ? config.filenameTemplate
    : '{base}-edited';
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const suppress = !!opts.suppressDownload;

  const state = getState();
  const total = imageIds.length;
  const encoded = []; // { id, blob, filename }
  let failed = 0;
  let totalBytes = 0;
  const usedNames = new Set();

  for (let i = 0; i < imageIds.length; i++) {
    const id = imageIds[i];
    const img = (state.images || {})[id] || (getState().images || {})[id];
    if (!img) {
      failed += 1;
      if (onProgress) {
        try { onProgress({ done: encoded.length + failed, total }); } catch { /* ignore */ }
      }
      continue;
    }
    // Build a per-attempt state object that overrides transforms.resize with
    // the preset's long-edge cap — but only when the source actually exceeds
    // it. This mirrors the pattern in exportToTargetSize (`stateAtScale`).
    const srcW = (img.source && img.source.width) || 0;
    const srcH = (img.source && img.source.height) || 0;
    let attemptState = img;
    if (shouldDownscale(srcW, srcH, longEdge)) {
      attemptState = {
        ...img,
        transforms: {
          ...(img.transforms || {}),
          resize: { mode: 'longestSide', value: longEdge },
        },
      };
    }

    let blob;
    try {
      blob = await renderForExport(attemptState, { format, quality }, caps, lifecycle);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('applyUploadReadyPreset: encode failed for', id, err);
      failed += 1;
      if (onProgress) {
        try { onProgress({ done: encoded.length + failed, total }); } catch { /* ignore */ }
      }
      continue;
    }

    // EXIF: preserve segment iff stripExif is OFF and output is JPEG. The
    // existing maybePreserveExif helper takes a "strip" boolean (true means
    // strip), so we pass !stripExif inverted to its semantics: stripExif
    // true → strip true → no-op; stripExif false → strip false → inject.
    try {
      blob = await maybePreserveExif(img, blob, format, stripExif);
    } catch (err) {
      // Soft fault — the stripped blob is still a valid export.
      // eslint-disable-next-line no-console
      console.warn('applyUploadReadyPreset: EXIF preserve failed for', id, err);
    }

    const baseName = applyFilenameTemplate(filenameTemplate, img, i, format, total);
    const filename = uniquifyName(baseName, usedNames);
    usedNames.add(filename);
    encoded.push({ id, blob, filename });
    totalBytes += blob.size;

    // Free decoded bitmap if not the active editor image (mirrors exportBatch).
    if (id !== getState().ui.activeImageId && lifecycle && typeof lifecycle.evictAfterUse === 'function') {
      try { lifecycle.evictAfterUse(id); } catch { /* ignore */ }
    }

    if (onProgress) {
      try { onProgress({ done: encoded.length + failed, total }); } catch { /* ignore */ }
    }
  }

  if (encoded.length === 0) {
    return { exported: 0, failed, total, blobSize: 0 };
  }

  // Single-image path: direct download, no ZIP wrapping.
  if (encoded.length === 1) {
    const { blob, filename } = encoded[0];
    if (!suppress) {
      try {
        triggerDownload(blob, filename);
        lastExportedBlob = blob;
        lastExportedFilename = filename;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('applyUploadReadyPreset: download trigger failed', err);
        showToast(t('exportDownloadFailedSingle'), { variant: 'error' });
      }
    }
    return {
      exported: 1,
      failed,
      total,
      blobSize: blob.size,
      downloadedFilename: filename,
    };
  }

  // Multi-image path: build ZIP, trigger one download.
  let JSZip;
  try {
    JSZip = await loadJSZip();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('applyUploadReadyPreset: JSZip load failed', err);
    showToast(t('exportZipLibFailed'), { variant: 'error' });
    return { exported: encoded.length, failed, total, blobSize: totalBytes };
  }
  const zip = new JSZip();
  for (const { blob, filename } of encoded) {
    zip.file(filename, blob);
  }
  let zipBlob;
  try {
    zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('applyUploadReadyPreset: zip.generateAsync failed', err);
    showToast(t('exportZipBuildFailed'), { variant: 'error' });
    return { exported: encoded.length, failed, total, blobSize: totalBytes };
  }
  const zipName = `upload-ready-${formatDate(new Date())}.zip`;
  if (!suppress) {
    try {
      triggerDownload(zipBlob, zipName);
      // Record the first per-image blob (not the ZIP) for "Verify last export"
      // — matches exportBatch's behavior so the metadata audit inspects a
      // representative image, not the archive container.
      lastExportedBlob = encoded[0].blob;
      lastExportedFilename = encoded[0].filename;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('applyUploadReadyPreset: download trigger failed', err);
      showToast(t('exportZipDownloadFailed'), { variant: 'error' });
    }
  }
  return {
    exported: encoded.length,
    failed,
    total,
    blobSize: zipBlob.size,
    zipBlob,
    downloadedFilename: zipName,
  };
}

/**
 * Export the entire queue as a ZIP. Streams sequentially — one decode + bake
 * + encode at a time — so peak memory stays bounded for large queues. After
 * each image is encoded, its decoded bitmap is evicted (if it isn't the
 * active editor image), so we never accumulate N decoded bitmaps in memory.
 *
 * @param {object} [opts]
 * @param {string} [opts.format]            override state.export.format
 * @param {number} [opts.quality]           override state.export.quality
 * @param {string} [opts.filenameTemplate]  override state.export.filenameTemplate
 * @param {object} [opts.lifecycle]         override module ctx
 * @param {object} [opts.caps]              override module ctx
 * @returns {Promise<{ count: number, failed: number, cancelled: boolean } | null>}
 */
export async function exportBatch(opts = {}) {
  const lifecycle = opts.lifecycle || ctxLifecycle;
  const caps = opts.caps || ctxCaps;
  if (!lifecycle || !caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return null;
  }

  const s = getState();
  const ids = [...s.queue];
  if (ids.length === 0) {
    showToast(t('exportQueueEmpty'), { variant: 'warn' });
    return null;
  }

  const format = opts.format || s.export.format || 'png';
  const quality = Number.isFinite(opts.quality) ? opts.quality : s.export.quality;
  const filenameTemplate = opts.filenameTemplate || s.export.filenameTemplate || '{base}-edited';

  // Estimate total output size. Heuristic per pixel by format — used only to
  // decide whether to warn before kicking off the heavy work.
  const estimatedMB = estimateBatchSize(ids, s.images, format);
  if (estimatedMB > 500 || ids.length > 50) {
    const proceed = await confirmHugeBatch(estimatedMB, ids.length);
    if (!proceed) return { count: 0, failed: 0, cancelled: true };
  }

  let JSZip;
  try {
    JSZip = await loadJSZip();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatch: JSZip load failed', err);
    showToast(t('exportZipLibFailed'), { variant: 'error' });
    return null;
  }

  const zip = new JSZip();
  const progress = openBatchProgressModal(ids, s.images);

  let cancelled = false;
  progress.onCancel(() => { cancelled = true; });

  let failed = 0;
  let successCount = 0;
  const usedNames = new Set();
  let firstBatchBlob = null;
  let firstBatchName = null;

  for (let i = 0; i < ids.length; i++) {
    if (cancelled) break;
    const id = ids[i];
    const img = (getState().images || {})[id];
    if (!img) {
      progress.itemUpdate(i, 'skipped', '(removed)');
      failed += 1;
      continue;
    }
    progress.itemUpdate(i, 'encoding', null);

    try {
      let blob = await renderForExport(img, { format, quality }, caps, lifecycle);
      blob = await maybePreserveExif(img, blob, format, s.export.stripMetadata);
      const baseName = applyFilenameTemplate(filenameTemplate, img, i, format, ids.length);
      const name = uniquifyName(baseName, usedNames);
      usedNames.add(name);
      zip.file(name, blob);
      successCount += 1;
      if (firstBatchBlob === null) {
        // First successful image in the batch — record for "Verify last export".
        firstBatchBlob = blob;
        firstBatchName = name;
      }
      progress.itemUpdate(i, 'done', name);
    } catch (err) {
      failed += 1;
      progress.itemUpdate(i, 'failed', err && err.message ? String(err.message) : 'error');
      // Continue — don't fail the whole batch on one image.
    }

    progress.tick(i + 1, ids.length);

    // Free decoded bitmap if not the editor's active image, so we don't
    // accumulate N decoded bitmaps across the whole batch.
    if (id !== getState().ui.activeImageId && lifecycle && typeof lifecycle.evictAfterUse === 'function') {
      try { lifecycle.evictAfterUse(id); } catch { /* ignore */ }
    }
  }

  if (cancelled) {
    progress.close();
    showToast(t('exportCancelled'), { variant: 'warn' });
    return { count: successCount, failed, cancelled: true };
  }

  if (successCount === 0) {
    progress.close();
    showToast(t('exportNothingSucceeded'), { variant: 'error' });
    return { count: 0, failed, cancelled: false };
  }

  progress.setBuilding();

  let zipBlob;
  try {
    zipBlob = await zip.generateAsync(
      {
        type: 'blob',
        // images are already compressed; STORE is fastest with the same final
        // size for PNG/JPEG/WebP payloads.
        compression: 'STORE',
        streamFiles: true,
      },
      meta => progress.setZipProgress(meta && meta.percent),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatch: zip.generateAsync failed', err);
    progress.close();
    showToast(t('exportZipBuildFailed'), { variant: 'error' });
    return { count: successCount, failed, cancelled: false };
  }

  // Trigger the download.
  const zipName = `noadsphotos-${formatDate(new Date())}-${Date.now()}.zip`;
  try {
    triggerDownload(zipBlob, zipName);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatch: download trigger failed', err);
    showToast(t('exportZipDownloadFailed'), { variant: 'error' });
  }

  // Surface the first per-image blob (NOT the ZIP) as the "last export" so
  // the verify-metadata UI inspects a representative image, not the ZIP
  // container itself. The ZIP would always look "clean" but tell us nothing
  // about whether the individual images leaked metadata.
  if (firstBatchBlob) {
    lastExportedBlob = firstBatchBlob;
    lastExportedFilename = firstBatchName;
  }

  progress.close();
  if (failed > 0) {
    showToast(t('exportBatchPartial', { count: successCount, failed }), { variant: 'warn' });
  } else {
    showToast(
      t('exportBatchDoneWithSize', { count: successCount, size: formatBytes(zipBlob.size) }),
      { variant: 'info' },
    );
  }
  return { count: successCount, failed, cancelled: false };
}

/**
 * Like exportBatch, but instead of bundling into a ZIP, triggers an individual
 * file download per image. Sequential — yields ~250ms between downloads so the
 * browser handles them gracefully (most browsers throttle rapid auto-downloads;
 * the first 2-3 may pass silently, after which Chrome prompts the user to
 * approve "multiple downloads from this site"). Useful especially on mobile,
 * where saving a ZIP requires a file-manager unzip step.
 *
 * Reuses the same render pipeline, progress modal, and filename template as
 * exportBatch.
 *
 * @returns {Promise<{ count: number, failed: number, cancelled: boolean } | null>}
 */
export async function exportEachIndividually(opts = {}) {
  const lifecycle = opts.lifecycle || ctxLifecycle;
  const caps = opts.caps || ctxCaps;
  if (!lifecycle || !caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return null;
  }

  const s = getState();
  const ids = [...s.queue];
  if (ids.length === 0) {
    showToast(t('exportQueueEmpty'), { variant: 'warn' });
    return null;
  }

  const format = opts.format || s.export.format || 'png';
  const quality = Number.isFinite(opts.quality) ? opts.quality : s.export.quality;
  const filenameTemplate = opts.filenameTemplate || s.export.filenameTemplate || '{base}-edited';

  // For "Each individually" we don't pre-warn at 500MB (since nothing is held
  // in memory across images — peak memory is one image at a time). But we do
  // warn at high file count, because each one is a browser download prompt /
  // dock notification.
  if (ids.length > 20) {
    const proceed = await confirmHugeBatch(0, ids.length, /* asIndividual */ true);
    if (!proceed) return { count: 0, failed: 0, cancelled: true };
  }

  const progress = openBatchProgressModal(ids, s.images);
  let cancelled = false;
  progress.onCancel(() => { cancelled = true; });

  let failed = 0;
  let successCount = 0;
  let totalBytes = 0;
  const usedNames = new Set();

  for (let i = 0; i < ids.length; i++) {
    if (cancelled) break;
    const id = ids[i];
    const img = (getState().images || {})[id];
    if (!img) {
      progress.itemUpdate(i, 'skipped', '(removed)');
      failed += 1;
      continue;
    }
    progress.itemUpdate(i, 'encoding', null);

    try {
      let blob = await renderForExport(img, { format, quality }, caps, lifecycle);
      blob = await maybePreserveExif(img, blob, format, s.export.stripMetadata);
      const baseName = applyFilenameTemplate(filenameTemplate, img, i, format, ids.length);
      const name = uniquifyName(baseName, usedNames);
      usedNames.add(name);
      triggerDownload(blob, name);
      successCount += 1;
      totalBytes += blob.size;
      // Record the LAST successful blob — for "Each individually" the latest
      // download is the closest match to "what the user just saw" if they
      // want to verify metadata stripping.
      lastExportedBlob = blob;
      lastExportedFilename = name;
      progress.itemUpdate(i, 'done', name);
    } catch (err) {
      failed += 1;
      progress.itemUpdate(i, 'failed', err && err.message ? String(err.message) : 'error');
    }

    progress.tick(i + 1, ids.length);

    if (id !== getState().ui.activeImageId && lifecycle && typeof lifecycle.evictAfterUse === 'function') {
      try { lifecycle.evictAfterUse(id); } catch { /* ignore */ }
    }

    // Yield to let the browser process the download before triggering the
    // next one. Without this, rapid <a download> clicks get coalesced and
    // the browser silently drops some.
    if (i < ids.length - 1 && !cancelled) {
      await new Promise(r => setTimeout(r, 250));
    }
  }

  progress.close();

  if (cancelled) {
    showToast(t('exportCancelled'), { variant: 'warn' });
    return { count: successCount, failed, cancelled: true };
  }
  if (successCount === 0) {
    showToast(t('exportNothingSucceeded'), { variant: 'error' });
    return { count: 0, failed, cancelled: false };
  }
  if (failed > 0) {
    showToast(t('exportBatchPartial', { count: successCount, failed }), { variant: 'warn' });
  } else {
    showToast(
      t('exportBatchEachDoneWithSize', { count: successCount, size: formatBytes(totalBytes) }),
      { variant: 'info' },
    );
  }
  return { count: successCount, failed, cancelled: false };
}

/**
 * Export a single image as a one-page PDF. Mirrors `exportSingle` in shape
 * (lifecycle/caps lookup, progress + toast UX, filename templating, last-
 * exported tracking) but routes through the PDF renderer instead of the
 * raw format encoder. The "PDF" extension is appended to the templated
 * filename so {base}-edited becomes {base}-edited.pdf.
 *
 * @param {string} imageId
 * @param {object} [opts] - { lifecycle?, caps?, pdf?: <renderer opts> }
 * @returns {Promise<Blob|null>} the exported PDF blob, or null on failure.
 */
export async function exportSinglePdf(imageId, opts = {}) {
  const lifecycle = opts.lifecycle || ctxLifecycle;
  const caps = opts.caps || ctxCaps;
  const s = getState();
  const img = s.images[imageId];
  if (!img) {
    showToast(t('exportNoImage'), { variant: 'warn' });
    return null;
  }
  if (!lifecycle || !caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return null;
  }
  warnIfNeeded(img, caps);

  const pdfOpts = opts.pdf || (s.export && s.export.pdf) || {};

  let blob;
  try {
    blob = await renderForPdf(img, pdfOpts, caps, lifecycle);
  } catch (err) {
    handleExportError(err);
    return null;
  }

  const filenameTemplate = (s.export && s.export.filenameTemplate) || '{base}-edited';
  const filename = makeFilename(img, 'pdf', filenameTemplate);
  try {
    triggerDownload(blob, filename);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportSinglePdf: download trigger failed', err);
    showToast(t('exportDownloadFailedSingle'), { variant: 'error' });
    return blob;
  }
  lastExportedBlob = blob;
  lastExportedFilename = filename;
  showToast(
    t('pdfExportSuccess', { filename, size: formatBytes(blob.size) }),
    { variant: 'info' },
  );
  return blob;
}

/**
 * Export the entire queue as a single multi-page PDF — one page per image,
 * in queue order, applying the page-size/orientation/margins/fitMode
 * options consistently across pages. This is the v1.1 differentiator vs
 * the "Export queue (ZIP)" path: a single shareable PDF file rather than
 * an archive of individual images.
 *
 * @param {object} [opts]
 * @returns {Promise<{ count: number, failed: number, cancelled: boolean } | null>}
 */
export async function exportBatchPdf(opts = {}) {
  const lifecycle = opts.lifecycle || ctxLifecycle;
  const caps = opts.caps || ctxCaps;
  if (!lifecycle || !caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return null;
  }

  const s = getState();
  const ids = [...s.queue];
  if (ids.length === 0) {
    showToast(t('exportQueueEmpty'), { variant: 'warn' });
    return null;
  }

  const pdfOpts = opts.pdf || (s.export && s.export.pdf) || {};

  // Reuse the per-image progress modal — the encoding work is identical
  // (per-image renderForExport + PDF placement); only the container differs.
  const progress = openBatchProgressModal(ids, s.images);
  let cancelled = false;
  progress.onCancel(() => { cancelled = true; });

  let result;
  try {
    result = await renderForPdfBatch(ids, pdfOpts, caps, lifecycle, {
      onProgress: ({ index, total, state, detail }) => {
        progress.itemUpdate(index, state, detail);
        progress.tick(index + 1, total);
      },
      onCancel: () => cancelled,
      getImage: (id) => (getState().images || {})[id] || null,
      evictAfterUse: (id) => {
        if (id !== getState().ui.activeImageId && lifecycle && typeof lifecycle.evictAfterUse === 'function') {
          try { lifecycle.evictAfterUse(id); } catch { /* ignore */ }
        }
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatchPdf: render failed', err);
    progress.close();
    showToast(t('exportGenericFailed'), { variant: 'error' });
    return null;
  }

  if (result.cancelled) {
    progress.close();
    showToast(t('exportCancelled'), { variant: 'warn' });
    return { count: result.count, failed: result.failed, cancelled: true };
  }
  if (result.count === 0 || !result.blob) {
    progress.close();
    showToast(t('exportNothingSucceeded'), { variant: 'error' });
    return { count: 0, failed: result.failed, cancelled: false };
  }

  progress.setBuilding();

  // Generate the download filename. We don't apply the per-image template
  // here — there's only one output file. Use a queue-level name with date
  // + timestamp so a repeated export from the same session doesn't collide.
  const pdfName = `noadsphotos-${formatDate(new Date())}-${Date.now()}.pdf`;
  try {
    triggerDownload(result.blob, pdfName);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportBatchPdf: download trigger failed', err);
    showToast(t('exportZipDownloadFailed'), { variant: 'error' });
  }

  lastExportedBlob = result.blob;
  lastExportedFilename = pdfName;

  progress.close();
  if (result.failed > 0) {
    showToast(t('exportBatchPartial', { count: result.count, failed: result.failed }), { variant: 'warn' });
  } else {
    showToast(
      t('pdfBatchSuccess', { count: result.count, size: formatBytes(result.blob.size) }),
      { variant: 'info' },
    );
  }
  return { count: result.count, failed: result.failed, cancelled: false };
}

// --- helpers ---------------------------------------------------------------

// Per-session flag so we only show the "blur won't bake" warning once.
let blurWarningShown = false;

function warnIfNeeded(img, caps) {
  const adjustBlur = img.adjust && img.adjust.blur;
  if (!blurWarningShown && (!caps || !caps.ctxFilter) && adjustBlur && adjustBlur > 0) {
    showToast(t('exportNoCtxFilter'), { variant: 'warn' });
    blurWarningShown = true;
  }
}

/**
 * Compose the filename from the template and image metadata. The base name
 * strips the original extension; the new extension is derived from `format`
 * (which can be either 'png'/'jpeg'/'webp' or the full MIME 'image/png' etc.).
 *
 * Exported for unit-style coverage from browser tests.
 */

/**
 * If the user opted out of metadata stripping AND the output is JPEG,
 * splice an APP1/Exif segment into the freshly-encoded output blob. The
 * segment comes from one of two places, in order of preference:
 *
 *   1. `img.source.exifSegment` — pre-extracted at import time, currently
 *      set only for HEIC sources (the HEIF container's `Exif` item gets
 *      transcoded into a JPEG-compatible segment via extractExifFromHeif
 *      in js/exif.js). HEIC pixels are re-encoded as PNG at import, so by
 *      the time we get here `source.blob` no longer contains the original
 *      metadata — but the stashed segment does.
 *   2. Extracted on the spot from `img.source.blob` — works for JPEG
 *      sources (the original APP1 sits inside source.blob unchanged).
 *
 * Combinations that DON'T preserve metadata (intentional):
 *   - Output != JPEG (PNG eXIf / WebP EXIF chunk could be implemented but
 *     consuming software handles them spottily — high-confidence JPEG path
 *     ships now; cross-format can follow if anyone asks).
 *   - Source is PNG or WebP with no stashed segment — nothing to recover.
 *   - Source was JPEG but got re-encoded due to oversize downscale (rare;
 *     the re-encoded blob is canvas output, no original APP1 remains).
 *
 * @param {object} img — per-image state with `.source.blob` + `.source.type`
 *                       (+ optional `.source.exifSegment`)
 * @param {Blob}   blob — the just-encoded output blob
 * @param {string} format — user-facing format string ('jpeg' / 'png' / etc.)
 * @param {boolean} strip — `state.export.stripMetadata`
 * @returns {Promise<Blob>}
 */
async function maybePreserveExif(img, blob, format, strip) {
  if (strip !== false) return blob;             // default path: keep stripping
  if (!img || !img.source) return blob;
  const outIsJpeg = String(format || '').toLowerCase().includes('jpeg') ||
                    String(format || '').toLowerCase() === 'jpg' ||
                    (blob && blob.type && blob.type.includes('jpeg'));
  if (!outIsJpeg) return blob;
  try {
    // Prefer the stashed segment (HEIC import path); fall back to extracting
    // from the source blob (JPEG import path).
    let segment = img.source.exifSegment;
    if (!segment && img.source.blob) {
      const srcType = String(img.source.type || '').toLowerCase();
      if (srcType.includes('jpeg')) {
        segment = await extractExifSegment(img.source.blob);
      }
    }
    if (!segment) return blob;
    return await injectExifIntoJpeg(blob, segment);
  } catch (err) {
    // Failing to preserve metadata is a soft fault — the export itself
    // still succeeds with the safe (stripped) blob. Log and continue.
    // eslint-disable-next-line no-console
    console.warn('maybePreserveExif: failed to inject EXIF', err);
    return blob;
  }
}

export function makeFilename(img, format, template) {
  const orig = (img && img.source && img.source.name) || 'image';
  const base = sanitizeFilenameBase(String(orig).replace(/\.[^.]+$/, '') || 'image');
  const date = formatDate(new Date());
  // n is reserved for batch export (Phase 10). Single export emits empty.
  const subbed = String(template || '{base}-edited')
    .replaceAll('{base}', base)
    .replaceAll('{date}', date)
    .replaceAll('{n}',    '')
    .replaceAll('{ext}',  extensionFor(format));
  // If template already ended in {ext} we may now have e.g. "name-png" —
  // detect that and don't double-append.
  const ext = extensionFor(format);
  if (subbed.toLowerCase().endsWith('.' + ext)) return subbed;
  return `${subbed}.${ext}`;
}

/**
 * Compose a batch filename. Distinct from makeFilename in two ways:
 *   - {n} is filled with the 1-based index, zero-padded to the queue length.
 *   - The template is treated as the BARE filename (no auto-extension), but
 *     we append the extension if the template doesn't already end in one.
 *
 * Exported for tests.
 */
export function applyFilenameTemplate(template, img, index, format, queueLen) {
  const orig = (img && img.source && img.source.name) || 'image';
  const base = sanitizeFilenameBase(String(orig).replace(/\.[^.]+$/, '') || 'image');
  const date = formatDate(new Date());
  const ext = extensionFor(format);
  const padLen = String(Math.max(1, Number(queueLen) || 1)).length;
  const n = String(index + 1).padStart(padLen, '0');
  const t = String(template || '{base}-edited');
  let subbed = t
    .replaceAll('{base}', base)
    .replaceAll('{date}', date)
    .replaceAll('{n}',    n)
    .replaceAll('{ext}',  ext);
  // Append extension if the template didn't already include it (or include
  // a different extension already).
  const lower = subbed.toLowerCase();
  if (!lower.endsWith('.' + ext)) subbed = `${subbed}.${ext}`;
  return subbed;
}

// Replace characters that are illegal in Windows filenames (and would confuse
// browsers on download too) with underscores. The base is whatever's before
// the extension — we don't sanitize the extension itself since we always
// generate that ourselves.
function sanitizeFilenameBase(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_');
}

// Append -2, -3, ... to a filename until it's unique within `used` (case-
// insensitive — Windows / case-insensitive HFS users get the same result).
function uniquifyName(name, used) {
  const lower = name.toLowerCase();
  if (!used.has(lower)) {
    used.add(lower);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}${ext}`;
    const candidateLower = candidate.toLowerCase();
    if (!used.has(candidateLower)) {
      used.add(candidateLower);
      return candidate;
    }
  }
  // Fallback — vanishingly unlikely. Use a timestamp to break the tie.
  const candidate = `${base}-${Date.now()}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function extensionFor(format) {
  const f = String(format || 'png').toLowerCase().replace(/^image\//, '');
  if (f === 'jpeg' || f === 'jpg') return 'jpg';
  if (f === 'pdf') return 'pdf';
  return f; // png | webp
}

function formatDate(d) {
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function estimateBatchSize(ids, images, format) {
  // Rough bytes-per-pixel by format. PNG = 4 (lossless RGBA), JPEG ~ 2 (Q92
  // chroma-subsampled), WebP ~ 1 (slightly tighter). These are the same
  // figures used in the design doc's batch-export memory section.
  const bytesPerPx = format === 'png' ? 4 : format === 'webp' ? 1 : 2;
  let bytes = 0;
  for (const id of ids) {
    const img = images[id];
    if (!img || !img.source) continue;
    bytes += (img.source.width || 0) * (img.source.height || 0) * bytesPerPx;
  }
  return bytes / (1024 * 1024);
}

/**
 * Trigger a browser download for the given blob. Uses an anchor element with
 * the `download` attribute. Exported for tests so they can spy on the click.
 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Some browsers need the anchor in the DOM to fire the click reliably.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so iOS Safari has time to grab the download. 60s is
  // generous; users will have triggered the save dialog by then.
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }, 60_000);
}

function handleExportError(err) {
  // eslint-disable-next-line no-console
  console.error('exportSingle:', err);
  if (err instanceof EncodeError || (err && err.code === 'format_unsupported')) {
    const requested = (err && err.requested) || 'this format';
    showToast(t('exportUnsupportedFormat', { format: requested }), { variant: 'error' });
    return;
  }
  if (err && err.message === 'output_exceeds_canvas_limit') {
    showToast(t('exportTooLarge'), { variant: 'error' });
    return;
  }
  if (err && err.message === 'source_bitmap_unavailable') {
    showToast(t('exportSourceMissing'), { variant: 'error' });
    return;
  }
  showToast(t('exportGenericFailed'), { variant: 'error' });
}

// --- progress modal -------------------------------------------------------
//
// A native <dialog> with a list of one row per image and a global progress
// bar. The modal is opened SYNCHRONOUSLY so the caller can wire up
// `onCancel` before the first item completes. Each `itemUpdate` mutates a
// single row's status; `tick` updates the global bar; `setBuilding` switches
// the heading once we're past per-image encode and into the JSZip build;
// `setZipProgress` shows the ZIP-build percent.

function openBatchProgressModal(ids, images) {
  const dialog = document.createElement('dialog');
  dialog.className = 'batch-progress-dialog';
  dialog.setAttribute('aria-label', t('batchProgressExportLabel'));

  const title = document.createElement('h2');
  title.className = 'batch-progress-title';
  const titleKey = ids.length === 1 ? 'batchProgressExportTitleSingular' : 'batchProgressExportTitlePlural';
  title.textContent = t(titleKey, { count: ids.length });
  dialog.appendChild(title);

  // Global progress bar.
  const bar = document.createElement('progress');
  bar.className = 'batch-progress-bar';
  bar.value = 0;
  bar.max = Math.max(1, ids.length);
  dialog.appendChild(bar);

  const status = document.createElement('p');
  status.className = 'batch-progress-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = t('batchProgressCountOf', { done: 0, total: ids.length });
  dialog.appendChild(status);

  // Per-image row list (scrolling).
  const list = document.createElement('ul');
  list.className = 'batch-progress-list';
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const img = images[id];
    const li = document.createElement('li');
    li.className = 'batch-progress-row';
    li.dataset.imageId = id;
    const name = document.createElement('span');
    name.className = 'batch-progress-row-name';
    name.textContent = (img && img.source && img.source.name) || `image-${i + 1}`;
    li.appendChild(name);
    const stat = document.createElement('span');
    stat.className = 'batch-progress-row-status';
    stat.textContent = t('batchProgressQueued');
    li.appendChild(stat);
    list.appendChild(li);
    rows.push({ li, stat, name });
  }
  dialog.appendChild(list);

  // Cancel button.
  const actions = document.createElement('div');
  actions.className = 'batch-progress-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'batch-progress-cancel';
  cancelBtn.textContent = t('batchProgressCancel');
  actions.appendChild(cancelBtn);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  try {
    dialog.showModal();
  } catch {
    // Non-modal fallback for tests / non-supporting browsers — just attach
    // and rely on z-index.
    dialog.setAttribute('open', '');
  }

  let onCancelFn = null;
  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = t('batchProgressCancelling');
    if (typeof onCancelFn === 'function') onCancelFn();
  });

  return {
    onCancel(fn) { onCancelFn = fn; },
    itemUpdate(index, state, detail) {
      const row = rows[index];
      if (!row) return;
      let label;
      // The state strings ('encoding', 'done', 'failed', 'skipped') flow
      // through the test harness as classnames; the visible labels go
      // through t() while preserving the detail suffix.
      switch (state) {
        case 'encoding': label = t('batchProgressEncodingExport'); break;
        case 'done':     label = `${t('batchProgressOk')}${detail ? ' · ' + detail : ''}`; break;
        case 'failed':   label = `${t('batchProgressFailed')}${detail ? ' · ' + detail : ''}`; break;
        case 'skipped':  label = `${t('batchProgressSkipped')}${detail ? ' · ' + detail : ''}`; break;
        default:         label = state || t('batchProgressQueued');
      }
      row.stat.textContent = label;
      row.li.classList.remove('is-encoding', 'is-done', 'is-failed', 'is-skipped');
      if (state) row.li.classList.add('is-' + state);
    },
    tick(done, total) {
      bar.value = done;
      bar.max = total;
      status.textContent = t('batchProgressCountOf', { done, total });
    },
    setBuilding() {
      title.textContent = t('batchProgressBuildingZip');
      status.textContent = t('batchProgressCompressingFiles');
      bar.removeAttribute('value');
      bar.max = 1;
      cancelBtn.disabled = true;
      cancelBtn.textContent = t('batchProgressWorking');
    },
    setZipProgress(percent) {
      if (Number.isFinite(percent)) {
        bar.value = Math.max(0, Math.min(1, percent / 100));
        bar.max = 1;
        status.textContent = t('batchProgressCompressingPct', { percent: Math.round(percent) });
      }
    },
    close() {
      try { if (dialog.open) dialog.close(); } catch { /* ignore */ }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    },
  };
}

// Warn-and-confirm modal for very large batches. Resolves to a boolean.
function confirmHugeBatch(estimatedMB, count, asIndividual = false) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'batch-confirm-dialog';
    // "Each individually" doesn't have a MB total worth quoting (no aggregate
    // in memory). Use a count-only message; the ZIP path keeps the size hint.
    const body = asIndividual
      ? t('batchConfirmHugeIndividual', { count })
      : t('batchConfirmHuge', { count, mb: Math.round(estimatedMB) });
    dialog.innerHTML = `
      <h2>${escapeHtml(t('batchConfirmHeadsUp'))}</h2>
      <p>${body}</p>
      <div class="batch-confirm-actions">
        <button type="button" class="batch-confirm-cancel">${escapeHtml(t('batchConfirmCancel'))}</button>
        <button type="button" class="batch-confirm-continue btn-primary">${escapeHtml(t('batchConfirmContinue'))}</button>
      </div>
    `;
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (proceed) => {
      if (settled) return;
      settled = true;
      try { if (dialog.open) dialog.close(); } catch { /* ignore */ }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      resolve(proceed);
    };
    dialog.querySelector('.batch-confirm-continue').addEventListener('click', () => finish(true));
    dialog.querySelector('.batch-confirm-cancel').addEventListener('click', () => finish(false));
    dialog.addEventListener('close', () => finish(false));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) finish(false);
    });

    try {
      dialog.showModal();
    } catch {
      const ok = window.confirm(`${count} images, ~${Math.round(estimatedMB)} MB. Continue? (Cancel to abort)`);
      finish(ok);
    }
  });
}

// Test-only hook so spec files can re-arm the once-per-session warnings.
export function _resetForTest() {
  ctxLifecycle = null;
  ctxCaps = null;
  blurWarningShown = false;
  predictCache = null;
  lastExportedBlob = null;
  lastExportedFilename = null;
}
