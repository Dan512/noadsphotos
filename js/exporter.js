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
import { showToast } from './errors.js';
import { getState } from './state.js';
import { EncodeError } from './codec.js';
import { escapeHtml } from './escape.js';
import { loadJSZip } from './vendor/jszip-loader.js';
import { t } from './i18n.js';

// Module-scope context populated by setExportContext (called from main.js after
// lifecycle + caps are ready). Without this, the panel's Download button has
// nothing to plumb through.
let ctxLifecycle = null;
let ctxCaps = null;

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
 * @param {object} [lifecycle] - falls back to module ctx
 * @param {object} [caps]      - falls back to module ctx
 * @returns {Promise<Blob|null>} the exported blob, or null on failure (toasts shown).
 */
export async function exportSingle(imageId, lifecycle = ctxLifecycle, caps = ctxCaps) {
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

  let blob;
  try {
    blob = await renderForExport(img, { format, quality }, caps, lifecycle);
  } catch (err) {
    handleExportError(err);
    return null;
  }

  const filename = makeFilename(img, format, filenameTemplate);
  try {
    triggerDownload(blob, filename);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('exportSingle: download trigger failed', err);
    showToast(t('exportDownloadFailedSingle'), { variant: 'error' });
    return blob;
  }
  showToast(t('exportSuccess', { filename }), { variant: 'info' });
  return blob;
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
      const blob = await renderForExport(img, { format, quality }, caps, lifecycle);
      const baseName = applyFilenameTemplate(filenameTemplate, img, i, format, ids.length);
      const name = uniquifyName(baseName, usedNames);
      usedNames.add(name);
      zip.file(name, blob);
      successCount += 1;
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

  progress.close();
  if (failed > 0) {
    showToast(t('exportBatchPartial', { count: successCount, failed }), { variant: 'warn' });
  } else {
    showToast(t('exportBatchDone', { count: successCount }), { variant: 'info' });
  }
  return { count: successCount, failed, cancelled: false };
}

// --- helpers ---------------------------------------------------------------

// Per-session flag so we only show the "blur won't bake" warning once.
let blurWarningShown = false;
let redactWarningShown = false;

function warnIfNeeded(img, caps) {
  const adjustBlur = img.adjust && img.adjust.blur;
  if (!blurWarningShown && (!caps || !caps.ctxFilter) && adjustBlur && adjustBlur > 0) {
    showToast(t('exportNoCtxFilter'), { variant: 'warn' });
    blurWarningShown = true;
  }
  const hasRedact = Array.isArray(img.overlays) && img.overlays.some(o => o && o.type === 'redact');
  if (!redactWarningShown && hasRedact) {
    showToast(t('exportRedactNote'), { variant: 'info' });
    redactWarningShown = true;
  }
}

/**
 * Compose the filename from the template and image metadata. The base name
 * strips the original extension; the new extension is derived from `format`
 * (which can be either 'png'/'jpeg'/'webp' or the full MIME 'image/png' etc.).
 *
 * Exported for unit-style coverage from browser tests.
 */
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
        case 'encoding': label = 'encoding…'; break;
        case 'done':     label = `ok${detail ? ' · ' + detail : ''}`; break;
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
function confirmHugeBatch(estimatedMB, count) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'batch-confirm-dialog';
    dialog.innerHTML = `
      <h2>${escapeHtml(t('batchConfirmHeadsUp'))}</h2>
      <p>${t('batchConfirmHuge', { count, mb: Math.round(estimatedMB) })}</p>
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
  redactWarningShown = false;
}
