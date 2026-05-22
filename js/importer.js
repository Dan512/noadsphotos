// js/importer.js — drag/drop, paste, file input. Decodes, normalizes EXIF, oversize-warns, thumbnails, enqueues.
import { addImage, createId, getActiveId, getQueue } from './queue.js';
import { update } from './state.js';
import { showToast } from './errors.js';
import { escapeHtml } from './escape.js';
import { t } from './i18n.js';
import { loadHeicDecoder } from './vendor/heic-loader.js';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// HEIC/HEIF go through the lazy libheif-js path (see vendor/heic-loader.js).
// We accept by MIME (some OS/browsers set 'image/heic' or 'image/heif') AND
// by .heic / .heif extension (some platforms leave the MIME blank).
const HEIC_TYPES = ['image/heic', 'image/heif'];
const HEIC_EXTENSIONS = ['.heic', '.heif'];
const THUMB_MAX = 200;

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

  let addedCount = 0;
  for (const file of accepted) {
    try {
      const added = await importOne(file, caps);
      if (added) addedCount += 1;
    } catch (err) {
      console.error('importFiles: failed for', file.name, err);
      showToast(t('importerDecodeFailed', { name: file.name }), { variant: 'error' });
    }
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
  // HEIC/HEIF require the lazy libheif-js decoder. We replace `file` with a
  // PNG-encoded blob of the decoded bitmap so the rest of the importer
  // pipeline — and every downstream consumer of `source.blob` (lifecycle
  // re-decode, predict-encode cache, EXIF strip check, thumbnail re-gen) —
  // treats it as a standard PNG. This drops the original HEIC bytes from
  // memory (typically ~5-15 MB per phone photo) in exchange for a clean
  // pipeline downstream. Same trade as the oversize downscale path below.
  if (isHeicFile(file)) {
    const decoded = await decodeHeicFile(file);
    if (!decoded) return false;
    file = decoded;
  }

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

  // imageData can be one of: {data, width, height} (ImageData-like), Blob, or
  // ImageBitmap (when a test injects a fake decoder). Normalize to a PNG Blob.
  let pngBlob;
  try {
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
  } catch (err) {
    dismissToast(decodingToast);
    // eslint-disable-next-line no-console
    console.error('importer: HEIC post-decode encode failed', err);
    showToast(t('heicDecodeFailed', { filename: file.name }), { variant: 'error' });
    return null;
  }

  dismissToast(decodingToast);
  // Swap the .heic/.heif extension for .png in the displayed filename so the
  // export panel's filename template defaults make sense.
  const newName = file.name.replace(/\.(heic|heif)$/i, '.png') || `${file.name}.png`;
  return new File([pngBlob], newName, { type: 'image/png' });
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
