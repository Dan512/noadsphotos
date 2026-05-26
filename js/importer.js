// js/importer.js — drag/drop, paste, file input. Decodes, normalizes EXIF, oversize-warns, thumbnails, enqueues.
import { addImage, createId, getActiveId, getQueue } from './queue.js';
import { update } from './state.js';
import { showToast } from './errors.js';
import { escapeHtml } from './escape.js';
import { t } from './i18n.js';
import { loadHeicDecoder } from './vendor/heic-loader.js';
import { decodeHeicBatch } from './heicPool.js';
import { extractExifFromHeif } from './exif.js';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// HEIC/HEIF go through the lazy libheif-js path (see vendor/heic-loader.js).
// We accept by MIME (some OS/browsers set 'image/heic' or 'image/heif') AND
// by .heic / .heif extension (some platforms leave the MIME blank).
const HEIC_TYPES = ['image/heic', 'image/heif'];
const HEIC_EXTENSIONS = ['.heic', '.heif'];
const THUMB_MAX = 200;

/**
 * Maps internal HEIC decode/init error strings to user-friendly reasons.
 * The worker (js/workers/heicWorker.js) emits codes like 'heic_no_images',
 * 'worker_init_failed: ...', 'heic_wasm_abort: ...' that are useful in console
 * logs but unfit for user-facing toasts. Unknown codes fall back to a generic
 * message. Raw codes are still console-logged at the call site for debugging.
 */
function friendlyHeicError(rawCode) {
  if (!rawCode) return 'unknown error';
  const code = String(rawCode);
  // Match by prefix where codes carry detail (e.g. 'worker_init_failed: ...').
  if (code.startsWith('worker_init_failed')) return 'decoder failed to start';
  if (code.startsWith('heic_wasm_abort'))     return 'decoder crashed';
  if (code === 'heic_no_images')              return 'file contained no images';
  if (code === 'heic_invalid_dimensions')     return 'invalid image dimensions';
  if (code === 'heic_display_failed')         return 'pixel data decode failed';
  if (code === 'heic_consent_declined')       return 'consent declined';
  if (code === 'decode_failed')               return 'decode failed';
  return 'unknown error';
}

/**
 * True if a file should be routed through the HEIC decode path.
 * Exported for tests; consumed by importOne().
 */
export function isHeicFile(file) {
  if (!file) return false;
  const type = ((file.type || '') + '').toLowerCase();
  if (HEIC_TYPES.includes(type)) return true;
  const name = ((file.name || '') + '').toLowerCase();
  return HEIC_EXTENSIONS.some(ext => name.endsWith(ext));
}

/**
 * True if a file is an image NoAdsPhotos can ingest. Accepts the standard
 * web formats (JPEG/PNG/WebP/GIF) by MIME, AND HEIC/HEIF by MIME-or-extension.
 * Exported for unit tests.
 */
export function isAcceptedImageFile(file) {
  if (!file) return false;
  const type = ((file.type || '') + '').toLowerCase();
  if (ACCEPTED_TYPES.includes(type)) return true;
  return isHeicFile(file);
}

// Wire up document-level listeners and the hidden file <input>. Idempotent —
// repeated calls are a no-op (guarded by a data attribute on body).
export function initImporter(caps, lifecycle) {
  if (document.body.dataset.importerReady === '1') return;
  document.body.dataset.importerReady = '1';

  // --- drag & drop ---
  let dragDepth = 0;
  const onDragEnter = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('is-drag-active');
  };
  const onDragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-drag-active');
  };
  const onDrop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-drag-active');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await importFiles(files, caps, lifecycle);
    }
  };
  document.body.addEventListener('dragenter', onDragEnter);
  document.body.addEventListener('dragover', onDragOver);
  document.body.addEventListener('dragleave', onDragLeave);
  document.body.addEventListener('drop', onDrop);

  // --- paste ---
  document.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      await importFiles(files, caps, lifecycle);
    }
  });

  // --- hidden file input + custom event to trigger it ---
  let fileInput = document.getElementById('noadsimages-file-input');
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'noadsimages-file-input';
    fileInput.multiple = true;
    // `image/*` covers the modern web formats. iOS/Android browsers honor
    // explicit `.heic`/`.heif` extensions; macOS/Linux/Windows fall back to
    // the MIME hint. Listing both is belt-and-braces.
    fileInput.accept = 'image/*,image/heic,image/heif,.heic,.heif';
    fileInput.hidden = true;
    document.body.appendChild(fileInput);
  }
  fileInput.addEventListener('change', async () => {
    if (fileInput.files && fileInput.files.length > 0) {
      await importFiles(fileInput.files, caps, lifecycle);
      // Reset so re-selecting the same file fires `change` again.
      fileInput.value = '';
    }
  });
  document.addEventListener('noadsimages:openFileBrowser', () => {
    fileInput.click();
  });
}

function hasFiles(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // DataTransfer.types is a DOMStringList-like; check for 'Files'.
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

// The testable workhorse. Decodes each file, prompts for oversize, generates
// thumbnail, adds to queue. Returns when all files have been processed.
export async function importFiles(fileList, caps, lifecycle) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  // Partition by acceptance; toast once per rejected mime type.
  const accepted = [];
  const rejectedTypes = new Set();
  for (const f of files) {
    if (isAcceptedImageFile(f)) {
      accepted.push(f);
    } else {
      rejectedTypes.add(f.type || 'unknown');
    }
  }
  for (const type of rejectedTypes) {
    showToast(t('importerRejectedType', { type }), { variant: 'error' });
  }

  // v1.3: partition HEIC vs everything else so we can pool-decode multiple
  // HEIC files in parallel. Single-file HEIC stays on the existing fast path
  // (avoids the postMessage round-trip + worker spawn for the common case).
  const heicAccepted = [];
  const otherAccepted = [];
  for (const f of accepted) {
    if (isHeicFile(f)) heicAccepted.push(f);
    else otherAccepted.push(f);
  }

  let addedCount = 0;

  // Non-HEIC: existing serial path, no behavior change.
  for (const file of otherAccepted) {
    try {
      const added = await importOne(file, caps);
      if (added) addedCount += 1;
    } catch (err) {
      console.error('importFiles: failed for', file.name, err);
      showToast(t('importerDecodeFailed', { name: file.name }), { variant: 'error' });
    }
  }

  // HEIC: route ≥2 files through the worker pool for parallel decode;
  // a single HEIC keeps using the inline path inside importOne (cheaper
  // than spawning a worker + a postMessage hop).
  if (heicAccepted.length === 1) {
    try {
      const added = await importOne(heicAccepted[0], caps);
      if (added) addedCount += 1;
    } catch (err) {
      console.error('importFiles: failed for', heicAccepted[0].name, err);
      showToast(t('importerDecodeFailed', { name: heicAccepted[0].name }), { variant: 'error' });
    }
  } else if (heicAccepted.length > 1) {
    addedCount += await importHeicBatch(heicAccepted, caps);
  }

  // After processing all files, refresh the lifecycle window so the active
  // (or first) image gets decoded for the editor.
  if (addedCount > 0 && lifecycle) {
    const activeId = getActiveId();
    const targetId = activeId || getQueue()[0] || null;
    if (targetId) {
      try {
        await lifecycle.setWindow(targetId);
      } catch (err) {
        console.error('importFiles: lifecycle.setWindow failed', err);
      }
    }
  }

  // v1.1.1: when the user has imported only a single image AND the queue
  // ends up with just one image total (i.e. they didn't append to an
  // existing batch), drop them straight into the editor for that image.
  // Multi-image imports stay on the queue view so the user can review
  // thumbnails before choosing one to edit.
  //
  // We check the queue length AFTER imports complete so we honor both
  // first-import and append-to-empty scenarios. If the user already had a
  // queue going, we leave the view alone — they're in batch mode.
  if (addedCount === 1) {
    const queue = getQueue();
    if (queue.length === 1) {
      const onlyId = queue[0];
      update(s => {
        s.ui.activeImageId = onlyId;
        s.ui.view = 'editor';
      });
    }
  }
}

async function importOne(file, caps) {
  // v1.1.2: if the user later opts out of metadata stripping on export,
  // we need access to the SOURCE EXIF. JPEG sources keep their APP1/Exif
  // inside `source.blob` (we just read it lazily during export). HEIC
  // sources are different — the importer re-encodes them as PNG below,
  // which drops the original HEIF `Exif` item along with the rest of the
  // metadata boxes. So we extract the EXIF segment from the raw HEIC
  // bytes RIGHT NOW, before re-encoding, and stash it on the image state.
  // Then `maybePreserveExif` can splice it into a JPEG export later.
  let stashedExifSegment = null;
  // Remember the original-source format BEFORE we swap the HEIC file out for
  // the PNG-backed decode result. Downstream consumers (getSmartDefaultFormat
  // in js/ops/formatSmart.js) need this to pick JPEG, not PNG, as the smart
  // export default for iPhone-origin images.
  const fromHeic = isHeicFile(file);
  if (fromHeic) {
    try {
      stashedExifSegment = await extractExifFromHeif(file);
    } catch (err) {
      // EXIF extraction is best-effort. If the HEIC has no metadata, has
      // a malformed `meta` box, or trips a parser edge case, the export
      // simply won't have metadata to splice — same as PNG output.
      // eslint-disable-next-line no-console
      console.warn('importOne: HEIC EXIF extract failed (will export without metadata)', err);
    }
    const decoded = await decodeHeicFile(file);
    if (!decoded) return false;
    file = decoded;
  }

  // HEIC/HEIF require the lazy libheif-js decoder. We replace `file` with a
  // PNG-encoded blob of the decoded bitmap so the rest of the importer
  // pipeline — and every downstream consumer of `source.blob` (lifecycle
  // re-decode, predict-encode cache, EXIF strip check, thumbnail re-gen) —
  // treats it as a standard PNG. This drops the original HEIC bytes from
  // memory (typically ~5-15 MB per phone photo) in exchange for a clean
  // pipeline downstream. Same trade as the oversize downscale path below.

  // Decode the source bitmap with EXIF orientation applied (modern browsers).
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    showToast(t('importerDecodeFailed', { name: file.name }), { variant: 'error' });
    return false;
  }

  // Oversize guard.
  if (bitmap.width > caps.maxCanvasSize || bitmap.height > caps.maxCanvasSize) {
    const action = await askOversizeAction(file.name, bitmap.width, bitmap.height, caps.maxCanvasSize);
    if (action !== 'downscale') {
      try { bitmap.close(); } catch { /* ignore */ }
      return false;
    }
    const scaled = await downscaleBitmap(bitmap, caps.maxCanvasSize);
    try { bitmap.close(); } catch { /* ignore */ }
    bitmap = scaled.bitmap;
    // Re-encode the source blob so .source.blob matches the new dimensions
    // (otherwise re-decode from the original would re-trigger oversize).
    file = scaled.blob;
  }

  // Generate thumbnail.
  let thumbBlob;
  try {
    thumbBlob = await makeThumbnail(bitmap);
  } catch (err) {
    console.error('importOne: thumbnail failed', err);
    showToast(t('importerThumbFailed', { name: file.name }), { variant: 'error' });
    try { bitmap.close(); } catch { /* ignore */ }
    return false;
  }

  const imageState = {
    id: createId(),
    source: {
      blob: file,
      // EXIF segment extracted from a HEIC source at import time (null for
      // every other format). The exporter consults this when the user has
      // opted to keep metadata + the output is JPEG. See
      // js/exif.js#extractExifFromHeif + js/exporter.js#maybePreserveExif.
      exifSegment: stashedExifSegment,
      // True iff the original (pre-decode) input was HEIC/HEIF. HEIC importers
      // re-encode to PNG for storage, so `type` reads 'image/png' downstream
      // — formatSmart consults this flag to pick JPEG as the export default
      // for iPhone-origin images. See js/ops/formatSmart.js.
      fromHeic,
      name: file.name,
      type: file.type,
      width: bitmap.width,
      height: bitmap.height,
      thumbnail: thumbBlob,
      bitmap: null, // lifecycle.setWindow will populate
    },
    transforms: { crop: null, rotate: 0, flipH: false, flipV: false, resize: null },
    adjust:     { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filterPreset: 'none',
    chromakey: null,
    chromakeyMask: null,
    bgRemoved: false,
    bgMask: null,
    overlays: [],
    baseDirty: true,
    overlaysDirty: true,
  };

  // Close the temporary decode bitmap — lifecycle will re-decode from blob.
  try { bitmap.close(); } catch { /* ignore */ }

  addImage(imageState);
  return true;
}

/**
 * Decode a HEIC/HEIF File via the lazy libheif-js loader, then return a
 * fresh PNG-backed File with the same name (extension swapped to `.png`).
 * Returns null if the user cancelled consent, or if decode/load failed
 * (an appropriate toast is already shown in that case).
 *
 * @param {File} file
 * @returns {Promise<File|null>}
 */
async function decodeHeicFile(file) {
  // Show a non-blocking "decoding…" toast so the user knows what's happening
  // while the wasm streams in + decodes. HEIC decode of a 10 MB phone photo
  // is typically 2-5 seconds; the user shouldn't wonder if the click registered.
  // duration:0 makes the toast sticky — we explicitly dismiss it below.
  const decodingToast = showToast(t('heicLoading', { name: file.name }), { variant: 'info', duration: 0 });
  let loader;
  try {
    loader = await loadHeicDecoder();
  } catch (err) {
    dismissToast(decodingToast);
    if (err && err.message === 'heic_consent_declined') {
      showToast(t('heicConsentDeclined'), { variant: 'warn' });
    } else {
      // eslint-disable-next-line no-console
      console.error('importer: HEIC loader failed', err);
      showToast(t('heicLoaderFailed'), { variant: 'error' });
    }
    return null;
  }
  let imageData;
  try {
    const arrayBuffer = await file.arrayBuffer();
    imageData = await loader.decode(arrayBuffer);
  } catch (err) {
    dismissToast(decodingToast);
    // eslint-disable-next-line no-console
    console.error('importer: HEIC decode failed', err);
    showToast(t('heicDecodeFailed', { filename: file.name }), { variant: 'error' });
    return null;
  }

  let pngFile;
  try {
    pngFile = await imageDataToPngFile(file, imageData);
  } catch (err) {
    dismissToast(decodingToast);
    // eslint-disable-next-line no-console
    console.error('importer: HEIC post-decode encode failed', err);
    showToast(t('heicDecodeFailed', { filename: file.name }), { variant: 'error' });
    return null;
  }

  dismissToast(decodingToast);
  return pngFile;
}

/**
 * Convert a decoded HEIC payload to a PNG-encoded File. Accepts the three
 * shapes any of our decoders return:
 *   - Blob (some decoders return PNG/JPEG bytes directly)
 *   - ImageBitmap (test fakes occasionally do this)
 *   - { data, width, height } ImageData-like (libheif + the worker pool)
 *
 * Filename keeps the original stem with .png swapped in. Reused by both the
 * inline single-file path and the worker-pool batch path so we only maintain
 * the canvas → PNG dance in one place.
 *
 * @param {File} sourceFile — original HEIC source (used for name only)
 * @param {Blob | ImageBitmap | {data: Uint8ClampedArray, width: number, height: number}} imageData
 * @returns {Promise<File>}
 */
async function imageDataToPngFile(sourceFile, imageData) {
  let pngBlob;
  if (imageData instanceof Blob) {
    pngBlob = imageData;
  } else if (typeof ImageBitmap !== 'undefined' && imageData instanceof ImageBitmap) {
    const c = createCanvas(imageData.width, imageData.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(imageData, 0, 0);
    pngBlob = await canvasToBlob(c, 'image/png', 1);
  } else if (imageData && imageData.data && imageData.width && imageData.height) {
    const c = createCanvas(imageData.width, imageData.height);
    const ctx = c.getContext('2d');
    // ImageData expects a Uint8ClampedArray; coerce if a plain Uint8Array
    // sneaks in from a quirky decoder build.
    const clampedData = imageData.data instanceof Uint8ClampedArray
      ? imageData.data
      : new Uint8ClampedArray(imageData.data);
    const id = ctx.createImageData(imageData.width, imageData.height);
    id.data.set(clampedData);
    ctx.putImageData(id, 0, 0);
    pngBlob = await canvasToBlob(c, 'image/png', 1);
  } else {
    throw new Error('heic_decoder_returned_unknown_shape');
  }
  // Swap the .heic/.heif extension for .png in the displayed filename so the
  // export panel's filename template defaults make sense.
  const newName = sourceFile.name.replace(/\.(heic|heif)$/i, '.png') || `${sourceFile.name}.png`;
  return new File([pngBlob], newName, { type: 'image/png' });
}

/**
 * Decode 2+ HEIC files in parallel via the worker pool, then funnel each
 * successful result back through importOne's pipeline (oversize check,
 * thumbnail, EXIF stash, queue add). Per-item failures fall back to
 * tryImportAsRegularImage — covers the misnamed-JPEG case where a file
 * has a .heic extension but is actually a regular image the browser can
 * decode natively. Truly corrupt files surface one toast each.
 *
 * Returns the count of images successfully added to the queue.
 *
 * @param {File[]} heicFiles
 * @param {*} caps
 * @returns {Promise<number>}
 */
async function importHeicBatch(heicFiles, caps) {
  // Consent on the main thread (single prompt for the whole batch — the
  // workers can't show modals). loadHeicDecoder also lazy-pre-warms the
  // main-thread libheif build, which we don't strictly need for the pool,
  // but the consent gate is what we're really after here.
  try {
    await loadHeicDecoder();
  } catch (err) {
    if (err && err.message === 'heic_consent_declined') {
      showToast(t('heicConsentDeclined'), { variant: 'warn' });
    } else {
      // eslint-disable-next-line no-console
      console.error('importer: HEIC loader failed', err);
      showToast(t('heicLoaderFailed'), { variant: 'error' });
    }
    return 0;
  }

  // Streaming pipeline (v1.3): there are no longer two phases (decode →
  // post-decode). The worker pool reports each file as it finishes, and
  // we immediately spawn its post-decode (EXIF stash, thumbnail, queue
  // add) on the main thread without waiting for the rest of the batch.
  // First thumbnail appears as soon as the first worker's first file
  // decodes; later files trickle in interleaved with subsequent decodes.
  //
  // ONE aggregate toast for the whole batch. errors.js#showToast doesn't
  // support in-place updates, so on every per-file completion we dismiss
  // and re-show with a fresh count. The user only sees "Importing X/Y"
  // because that's the only number they can actually verify against the
  // queue.
  let addedCount = 0;
  const failures = []; // [{ name, reason, sourceIndex }] — see ordering note below
  let aggregateDismiss = showToast(
    t('heicPoolImporting', { done: 0, total: heicFiles.length }),
    { variant: 'info', duration: 0 },
  );
  const refreshToast = () => {
    dismissToast(aggregateDismiss);
    aggregateDismiss = showToast(
      t('heicPoolImporting', {
        done: addedCount + failures.length,
        total: heicFiles.length,
      }),
      { variant: 'info', duration: 0 },
    );
  };

  // Read every source into an ArrayBuffer up-front — the pool transfers
  // these into the workers (zero-copy) and we keep the File ref + source
  // index for the post-decode pipeline (name, EXIF stash, fallback path,
  // failure ordering).
  const items = await Promise.all(heicFiles.map(async (file, idx) => ({
    id: 'heic-' + idx,
    file,
    sourceIndex: idx,
    arrayBuffer: await file.arrayBuffer(),
  })));
  const poolInput = items.map(({ id, arrayBuffer }) => ({ id, arrayBuffer }));
  const itemByID = new Map(items.map(it => [it.id, it]));

  // Track all in-flight post-decode jobs so we can await them after the
  // pool drains. Each job is started as soon as its worker reports — we
  // do NOT await per-file inside the onResult callback, that would
  // serialise the stream and erase the parallelism win.
  const postDecodeJobs = [];

  try {
    await decodeHeicBatch(
      poolInput,
      () => { /* no-op: we drive the toast from per-file results */ },
      (id, result) => {
        const item = itemByID.get(id);
        if (!item) return;
        const job = (async () => {
          const r = await processOneHeicResult(item.file, result, caps);
          if (r.ok) addedCount += 1;
          if (r.failure) failures.push({ ...r.failure, sourceIndex: item.sourceIndex });
          refreshToast();
          // Yield to the renderer so this file's thumbnail paints before
          // the next per-file post-decode steals the main thread. rAF in
          // the browser, setTimeout(0) in jsdom-based test environments.
          await new Promise(resolve => (
            typeof requestAnimationFrame === 'function'
              ? requestAnimationFrame(resolve)
              : setTimeout(resolve, 0)
          ));
        })();
        postDecodeJobs.push(job);
      },
    );

    // Pool drained — wait for every per-file post-decode to finish before
    // we run the failure aggregation.
    await Promise.all(postDecodeJobs);
  } finally {
    // Drop the streaming toast regardless of how we got here so the
    // failure summary (if any) doesn't visually stack on top of it.
    dismissToast(aggregateDismiss);
  }

  // Failures stream in completion order (workers finish in roughly
  // round-robin order, but a slow file delays its own bucket). Sort by
  // source index so the "N of M files: a, b, c" toast lists names in
  // the order the user dropped them. Stable + cheap.
  failures.sort((a, b) => a.sourceIndex - b.sourceIndex);

  // One toast for the whole batch, sized to the failure count.
  //   1   → name + reason
  //   2-5 → "N of M files: name1, name2, …"
  //   6+  → "N of M files (see console for filenames)" + dump list to console
  if (failures.length === 1) {
    showToast(
      t('heicBatchFailedSingle', { name: failures[0].name, reason: failures[0].reason }),
      { variant: 'error' },
    );
  } else if (failures.length >= 2 && failures.length <= 5) {
    showToast(
      t('heicBatchFailedSummary', {
        failed: failures.length,
        total: heicFiles.length,
        names: failures.map(f => f.name).join(', '),
      }),
      { variant: 'error' },
    );
  } else if (failures.length > 5) {
    // eslint-disable-next-line no-console
    console.warn('importer: HEIC failures', failures);
    showToast(
      t('heicBatchFailedSummaryMany', {
        failed: failures.length,
        total: heicFiles.length,
      }),
      { variant: 'error' },
    );
  }

  return addedCount;
}

/**
 * Per-file post-decode for the streaming HEIC pipeline. Extracted so the
 * onResult callback in importHeicBatch stays thin — one of these spawns
 * per worker message. Mirrors what the old chunked items.map(async ...)
 * body did, just for a single file.
 *
 * Returns `{ ok, failure? }`:
 *   - `{ ok: true }`            — image landed in the queue
 *   - `{ ok: false, failure }`  — file failed; failure has { name, reason }
 *   - `{ ok: false }` for oversize-skip etc. (no failure surfaces)
 *
 * @param {File} file
 * @param {*} result — entry from the pool's results Map
 * @param {*} caps
 * @returns {Promise<{ok: boolean, failure?: {name: string, reason: string}}>}
 */
async function processOneHeicResult(file, result, caps) {
  if (result && !result.error && result.data && result.width && result.height) {
    try {
      // Re-extract EXIF on the main thread (same best-effort policy as
      // importOne's HEIC branch). The pool only returns pixels.
      let stashedExifSegment = null;
      try {
        stashedExifSegment = await extractExifFromHeif(file);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('importHeicBatch: HEIC EXIF extract failed', err);
      }
      // Fast path: worker encoded the PNG for us AND createImageBitmap
      // can consume the raw ImageData. Skips the redundant
      // putImageData → toBlob → createImageBitmap round-trip on main.
      if (result.pngBlob) {
        try {
          const bitmap = await createImageBitmap(
            new ImageData(result.data, result.width, result.height),
          );
          // Swap the .heic/.heif extension for .png in the displayed
          // filename so downstream UI / export defaults make sense —
          // mirrors imageDataToPngFile's naming.
          const newName = file.name.replace(/\.(heic|heif)$/i, '.png') || `${file.name}.png`;
          const pngFile = new File([result.pngBlob], newName, { type: 'image/png' });
          const ok = await importPreDecodedHeicFrame({
            pngFile, bitmap, caps, stashedExifSegment,
          });
          return { ok };
        } catch (err) {
          // createImageBitmap(ImageData) is on every modern browser, but
          // old Safari builds reject it. Fall through to the legacy
          // PNG-round-trip path so we still produce a correct queue item.
          // eslint-disable-next-line no-console
          console.warn('importHeicBatch: fast path failed, falling back', err);
        }
      }
      // Legacy path: either the worker couldn't encode (pngBlob: null)
      // or createImageBitmap(ImageData) failed. Re-encode on main thread
      // and run through the original importDecodedFile pipeline.
      const pngFile = await imageDataToPngFile(file, result);
      const ok = await importDecodedFile(pngFile, caps, stashedExifSegment);
      return { ok };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('importHeicBatch: post-decode failed for', file.name, err);
      const rawCode = (err && err.message) ? err.message : 'decode_failed';
      return { ok: false, failure: { name: file.name, reason: friendlyHeicError(rawCode) } };
    }
  } else {
    // HEIC decode failed — try the file as a regular image. Covers the
    // common case of an iPhone JPEG mis-labelled with a .heic extension
    // (it happens). If that ALSO fails, add it to the aggregate failure list.
    const ok = await tryImportAsRegularImage(file, caps);
    if (ok) return { ok: true };
    const rawCode = (result && result.error) ? result.error : 'decode_failed';
    // Log the raw worker code for debugging — only the friendly version
    // makes it into the user-facing toast.
    // eslint-disable-next-line no-console
    console.error('importHeicBatch: decode failed for', file.name, '—', rawCode);
    return { ok: false, failure: { name: file.name, reason: friendlyHeicError(rawCode) } };
  }
}

/**
 * Probe a file with createImageBitmap; on success, run it through importOne
 * as a regular image. Used as the HEIC-decode fallback so misnamed JPEGs
 * still import cleanly. Returns true iff the file made it into the queue.
 *
 * @param {File} file
 * @param {*} caps
 * @returns {Promise<boolean>}
 */
async function tryImportAsRegularImage(file, caps) {
  try {
    const probe = await createImageBitmap(file);
    try { probe.close(); } catch { /* ignore */ }
  } catch {
    return false;
  }
  try {
    return await importOne(file, caps);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('tryImportAsRegularImage: importOne threw for', file.name, err);
    return false;
  }
}

/**
 * Run a pre-decoded (HEIC-via-pool) PNG file through the same pipeline
 * importOne uses post-HEIC-decode: createImageBitmap → oversize guard →
 * thumbnail → queue add. Mirrors importOne's tail; factored out so the
 * batch path can supply a pre-extracted EXIF segment instead of
 * re-extracting from the (now-discarded) HEIC bytes a second time.
 *
 * @param {File} pngFile — the PNG-encoded result of the HEIC decode
 * @param {*} caps
 * @param {Uint8Array | null} stashedExifSegment
 * @returns {Promise<boolean>}
 */
async function importDecodedFile(pngFile, caps, stashedExifSegment) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(pngFile, { imageOrientation: 'from-image' });
  } catch (err) {
    showToast(t('importerDecodeFailed', { name: pngFile.name }), { variant: 'error' });
    return false;
  }
  return importPreDecodedHeicFrame({ pngFile, bitmap, caps, stashedExifSegment });
}

/**
 * v1.3 fast path for the HEIC pool: the worker has already encoded the PNG
 * AND we've already decoded a bitmap on the main thread from the raw
 * ImageData (via createImageBitmap(new ImageData(...))), so we skip the
 * redundant PNG decode pass. Shares the oversize → thumbnail → addImage
 * tail with importDecodedFile.
 *
 * @param {{
 *   pngFile: File,                  // worker-encoded PNG, used as source.blob
 *   bitmap: ImageBitmap,            // already-decoded pixels
 *   caps: *,
 *   stashedExifSegment: Uint8Array | null,
 * }} args
 * @returns {Promise<boolean>}
 */
async function importPreDecodedHeicFrame({ pngFile, bitmap, caps, stashedExifSegment }) {
  let file = pngFile;

  if (bitmap.width > caps.maxCanvasSize || bitmap.height > caps.maxCanvasSize) {
    const action = await askOversizeAction(file.name, bitmap.width, bitmap.height, caps.maxCanvasSize);
    if (action !== 'downscale') {
      try { bitmap.close(); } catch { /* ignore */ }
      return false;
    }
    const scaled = await downscaleBitmap(bitmap, caps.maxCanvasSize);
    try { bitmap.close(); } catch { /* ignore */ }
    bitmap = scaled.bitmap;
    file = scaled.blob;
  }

  let thumbBlob;
  try {
    thumbBlob = await makeThumbnail(bitmap);
  } catch (err) {
    console.error('importPreDecodedHeicFrame: thumbnail failed', err);
    showToast(t('importerThumbFailed', { name: file.name }), { variant: 'error' });
    try { bitmap.close(); } catch { /* ignore */ }
    return false;
  }

  const imageState = {
    id: createId(),
    source: {
      blob: file,
      exifSegment: stashedExifSegment,
      // Pool path is HEIC-only — see importHeicBatch / processOneHeicResult.
      // Mirror importOne's `fromHeic` tag so formatSmart picks JPEG, not PNG,
      // as the export default for these too.
      fromHeic: true,
      name: file.name,
      type: file.type,
      width: bitmap.width,
      height: bitmap.height,
      thumbnail: thumbBlob,
      bitmap: null,
    },
    transforms: { crop: null, rotate: 0, flipH: false, flipV: false, resize: null },
    adjust:     { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filterPreset: 'none',
    chromakey: null,
    chromakeyMask: null,
    bgRemoved: false,
    bgMask: null,
    overlays: [],
    baseDirty: true,
    overlaysDirty: true,
  };

  try { bitmap.close(); } catch { /* ignore */ }

  addImage(imageState);
  return true;
}

// Best-effort dismiss helper — showToast() returns a dismiss function (see
// js/errors.js). Tolerate undefined and call shapes so future toast variants
// don't break this path.
function dismissToast(handle) {
  if (typeof handle === 'function') {
    try { handle(); } catch { /* ignore */ }
    return;
  }
  if (handle && typeof handle.dismiss === 'function') {
    try { handle.dismiss(); } catch { /* ignore */ }
  }
}

// Downscale a bitmap so its long side equals maxSize. Returns the new
// bitmap and a re-encoded source blob (PNG, lossless).
async function downscaleBitmap(bitmap, maxSize) {
  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(maxSize / w, maxSize / h);
  const newW = Math.max(1, Math.round(w * scale));
  const newH = Math.max(1, Math.round(h * scale));

  const canvas = createCanvas(newW, newH);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, newW, newH);

  const blob = await canvasToBlob(canvas, 'image/png', 1);
  const newBitmap = await createImageBitmap(blob);
  return { bitmap: newBitmap, blob };
}

// Generate a JPEG thumbnail blob no larger than THUMB_MAX on the long side.
async function makeThumbnail(bitmap) {
  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  const canvas = createCanvas(tw, th);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, tw, th);

  return canvasToBlob(canvas, 'image/jpeg', 0.7);
}

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, mime, quality) {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null')),
      mime,
      quality,
    );
  });
}

// Native <dialog> modal. Resolves with 'downscale' or 'skip'.
// Escape, click outside, or the Skip button all resolve as 'skip'.
export async function askOversizeAction(filename, width, height, maxSize) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'oversize-dialog';
    // Wrap the filename in <code> tags around the i18n'd body — we do this
    // by replacing the {filename} placeholder ourselves after calling t()
    // so the template stays language-friendly.
    const body = t('importerOversizeBody', { filename: 'PLACEHOLDER', width, height, max: maxSize })
      .replace('PLACEHOLDER', `<code>${escapeHtml(filename)}</code>`);
    dialog.innerHTML = `
      <form method="dialog">
        <h2>${escapeHtml(t('importerOversizeTitle'))}</h2>
        <p>${body}</p>
        <div class="oversize-actions">
          <button type="button" class="oversize-skip">${escapeHtml(t('importerOversizeSkip'))}</button>
          <button type="button" class="oversize-downscale btn-primary">${escapeHtml(t('importerOversizeDownscale'))}</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      try { if (dialog.open) dialog.close(); } catch { /* ignore */ }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      resolve(action);
    };

    dialog.querySelector('.oversize-downscale').addEventListener('click', () => finish('downscale'));
    dialog.querySelector('.oversize-skip').addEventListener('click', () => finish('skip'));
    // Esc, etc.
    dialog.addEventListener('close', () => finish('skip'));
    // Click on backdrop = skip.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) finish('skip');
    });

    // showModal may throw if the dialog is detached; guard.
    try {
      dialog.showModal();
    } catch (err) {
      console.error('askOversizeAction: showModal failed, falling back to confirm()', err);
      const ok = window.confirm(
        `${filename} is ${width}×${height}px. Downscale to ${maxSize}px? (Cancel = skip)`,
      );
      finish(ok ? 'downscale' : 'skip');
    }
  });
}
