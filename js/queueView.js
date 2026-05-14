// js/queueView.js — queue view shell.
//
// Phase 1 / 2 scope: the thumbnail grid + empty state.
// Phase 10 scope:   a right-hand batch operations panel — resize, rotate /
//                   flip, adjust, color-to-transparent, background remove
//                   placeholder, export-queue-as-ZIP. Each Apply-to-all
//                   writes via withBatchTransaction so one Ctrl+Z reverts
//                   the whole batch.
//
// Layout: two-column grid (`grid-template-columns: 1fr 360px`) on desktop,
// collapses to a single column under 768px (CSS handles that). On the empty
// state the batch panel is hidden (nothing to apply to).
import { getState, subscribe, update } from './state.js';
import { setActive, removeImage } from './queue.js';
import { escapeHtml } from './escape.js';
import { applyResize, applyRotate, applyFlip } from './ops/transforms.js';
import { applyAdjust, applyFilterPreset, ADJUST_RANGES } from './ops/adjust.js';
import { applyChromakey, setChromakeyMask, buildChromakeyMask, normalizeHex } from './ops/chromakey.js';
import {
  withBatchTransforms,
  withBatchAdjust,
  withBatchChromakey,
} from './historyOps.js';
import { exportBatch, exportEachIndividually } from './exporter.js';
import { showToast } from './errors.js';
import { applyBgRemoveBatch } from './ops/bgremove.js';
import { t } from './i18n.js';
import { getSetting } from './settings.js';
import { renderThumbnail } from './render/exportRenderer.js';

// Track per-thumb DOM nodes and their object URLs so we can diff-render
// without rebuilding the grid on every state change.
const rendered = new Map(); // id -> { node: HTMLElement, url: string, thumbnailBlob: Blob, badgeEl: HTMLElement|null }
let gridEl = null;
let emptyEl = null;
let introEl = null;
let panelEl = null;
let panelRefs = null;   // refs to inputs inside the batch panel
let panelSubscribed = false;
let exportPanelSubsBound = false;

export function initQueueView() {
  render(getState());
  subscribe(render);
}

// --------------------------------------------------------------------------
// Thumbnail auto-refresh — context + sequential per-image regeneration.
//
// Wired from main.js after lifecycle + caps are ready. We deliberately use a
// dedicated setter rather than reach into exporter.js's context so the two
// modules stay loosely coupled.
// --------------------------------------------------------------------------
let ctxLifecycle = null;
let ctxCaps = null;
let refreshInFlight = false;
let pendingRefresh = null;

export function setQueueViewContext({ lifecycle, caps } = {}) {
  ctxLifecycle = lifecycle || null;
  ctxCaps = caps || null;
}

// Test escape hatch: reset internal state so a spec re-arms cleanly.
export function _resetThumbRefreshForTest() {
  ctxLifecycle = null;
  ctxCaps = null;
  refreshInFlight = false;
  pendingRefresh = null;
}

/**
 * Fire-and-forget thumbnail refresh for the supplied ids. Honors the
 * `autoRefreshThumbnails` setting (default true). Coalesces overlapping
 * batch calls into a single follow-up pass.
 *
 * The function returns synchronously; callers in batch handlers don't await.
 * Tests can `await` the returned promise to wait for completion.
 *
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
export async function maybeRefreshThumbs(ids) {
  if (!getSetting('autoRefreshThumbnails')) return;
  if (!ids || ids.length === 0) return;
  if (!ctxLifecycle || !ctxCaps) return; // not yet wired — no-op

  if (refreshInFlight) {
    // Collapse: just remember the latest ids so we run them once after the
    // current pass finishes.
    pendingRefresh = [...ids];
    return;
  }
  refreshInFlight = true;
  try {
    await refreshThumbsSequential([...ids]);
    while (pendingRefresh) {
      const next = pendingRefresh;
      pendingRefresh = null;
      await refreshThumbsSequential(next);
    }
  } finally {
    refreshInFlight = false;
  }
}

async function refreshThumbsSequential(ids) {
  const lifecycle = ctxLifecycle;
  const caps = ctxCaps;
  if (!lifecycle || !caps) return;

  for (const id of ids) {
    const s = getState();
    const img = s.images[id];
    if (!img) continue;
    try {
      const newThumb = await renderThumbnail(img, caps, lifecycle);
      update(state => {
        const i = state.images[id];
        if (i && i.source) i.source.thumbnail = newThumb;
      });
      // Yield to let the browser paint the new thumbnail before moving on,
      // so the user sees the batch advance one image at a time.
      await new Promise(r => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
        else setTimeout(r, 0);
      });
    } catch (err) {
      // Don't break the batch on a single image. Common failures:
      // output_exceeds_canvas_limit, source_bitmap_unavailable.
      // eslint-disable-next-line no-console
      console.warn('queueView: thumbnail refresh failed for', id, err);
    } finally {
      // Free the source bitmap if we decoded it just for the thumbnail and
      // it isn't the editor's active image. Skips no-ops.
      if (id !== getState().ui.activeImageId
          && lifecycle && typeof lifecycle.evictAfterUse === 'function') {
        try { lifecycle.evictAfterUse(id); } catch { /* ignore */ }
      }
    }
  }
}

function render(state) {
  const root = document.getElementById('queue-view');
  if (!root) return;

  // View-level visibility is owned by js/views.js. This module only renders
  // the queue contents.

  const queue = state.queue;

  if (queue.length === 0) {
    ensureIntro(root);
    ensureEmptyState(root);
    if (gridEl && gridEl.parentNode) gridEl.parentNode.removeChild(gridEl);
    gridEl = null;
    cleanupAllThumbs();
    // Hide batch panel when there are no images.
    if (panelEl) panelEl.hidden = true;
    return;
  }

  // Populated state: ensure the intro + empty pane are gone and the grid +
  // batch panel exist.
  if (introEl && introEl.parentNode) introEl.parentNode.removeChild(introEl);
  introEl = null;
  if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
  emptyEl = null;
  if (!gridEl) {
    gridEl = document.createElement('div');
    gridEl.className = 'queue-grid';
    // Insert BEFORE panelEl if the panel already exists (left over from a
    // previous populated state). Otherwise append. This keeps the grid in
    // column 1 (1fr) and the panel in column 2 (360px) of the CSS grid.
    if (panelEl && panelEl.parentNode === root) {
      root.insertBefore(gridEl, panelEl);
    } else {
      root.appendChild(gridEl);
    }
  }
  if (!panelEl) {
    panelEl = buildBatchPanel();
    root.appendChild(panelEl);
  }
  panelEl.hidden = false;

  diffRender(state);
  syncBatchPanel(state);
}

function ensureEmptyState(root) {
  if (emptyEl && emptyEl.isConnected) return;
  emptyEl = document.createElement('div');
  emptyEl.className = 'queue-empty';
  emptyEl.innerHTML = `
    <div>
      <p>${escapeHtml(t('queueEmptyDragHint'))} <button type="button" class="text-link queue-browse">${escapeHtml(t('queueEmptyClickToBrowse'))}</button>.</p>
    </div>
  `;
  emptyEl.querySelector('.queue-browse').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('noadsimages:openFileBrowser'));
  });
  root.appendChild(emptyEl);
}

// Intro landing copy, rendered ABOVE the drop zone when the queue is empty.
// The <h1> here is the canonical content heading on the page — the topbar
// wordmark is a <p> so the document has exactly one h1.
function ensureIntro(root) {
  if (introEl && introEl.isConnected) return;
  introEl = document.createElement('section');
  introEl.className = 'queue-intro';
  // No user-derived content here; t() output is HTML-escaped for variable
  // interpolation, and our keys contain only static literals + safe glyphs.
  introEl.innerHTML = `
    <h1 class="intro-title" data-i18n="introTitle">${escapeHtml(t('introTitle'))}</h1>
    <p class="intro-lead" data-i18n="introLead">${escapeHtml(t('introLead'))}</p>
    <p class="intro-tags" data-i18n="introTags">${escapeHtml(t('introTags'))}</p>
    <ul class="intro-features">
      <li data-i18n="introFeatureBatch">${escapeHtml(t('introFeatureBatch'))}</li>
      <li data-i18n="introFeatureBgRemove">${escapeHtml(t('introFeatureBgRemove'))}</li>
      <li data-i18n="introFeatureRedact">${escapeHtml(t('introFeatureRedact'))}</li>
      <li data-i18n="introFeatureChromakey">${escapeHtml(t('introFeatureChromakey'))}</li>
      <li data-i18n="introFeatureExport">${escapeHtml(t('introFeatureExport'))}</li>
    </ul>
  `;
  // Prepend so the intro sits ABOVE the drop zone, regardless of order of
  // calls in render().
  root.insertBefore(introEl, root.firstChild);
}

function diffRender(state) {
  const queue = state.queue;
  const images = state.images;
  const activeId = state.ui.activeImageId;
  const wanted = new Set(queue);

  // Remove thumbs not in the queue anymore.
  for (const [id, entry] of rendered) {
    if (!wanted.has(id)) {
      removeThumb(id, entry);
    }
  }

  // Add or update thumbs in queue order.
  let prev = null;
  for (const id of queue) {
    const img = images[id];
    if (!img) continue;
    let entry = rendered.get(id);
    if (!entry) {
      entry = createThumb(id, img);
      rendered.set(id, entry);
    } else if (entry.thumbnailBlob !== img.source.thumbnail) {
      URL.revokeObjectURL(entry.url);
      entry.url = URL.createObjectURL(img.source.thumbnail);
      entry.thumbnailBlob = img.source.thumbnail;
      entry.node.querySelector('img').src = entry.url;
    }

    // Active state.
    entry.node.classList.toggle('is-active', id === activeId);
    entry.node.setAttribute('aria-pressed', id === activeId ? 'true' : 'false');

    // (batch) badge — driven by the per-image _isBatch flag set by the
    // batch panel and cleared on first per-image edit.
    syncBatchBadge(entry, img);

    // Re-attach into queue order: insertAfter(prev) or prepend.
    if (prev === null) {
      if (gridEl.firstChild !== entry.node) gridEl.insertBefore(entry.node, gridEl.firstChild);
    } else if (prev.nextSibling !== entry.node) {
      gridEl.insertBefore(entry.node, prev.nextSibling);
    }
    prev = entry.node;
  }
}

function createThumb(id, img) {
  const url = URL.createObjectURL(img.source.thumbnail);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'queue-thumb';
  btn.dataset.imageId = id;
  btn.setAttribute('aria-label', t('queueOpenImage', { name: img.source.name }));
  btn.innerHTML = `
    <img alt="" src="${escapeHtml(url)}" draggable="false">
    <span class="queue-thumb-remove" role="button" tabindex="0" aria-label="${escapeHtml(t('queueRemoveImage', { name: img.source.name }))}">×</span>
  `;
  const removeEl = btn.querySelector('.queue-thumb-remove');
  // Confirm-on-remove is a per-user setting. We use the native confirm()
  // dialog rather than rolling a custom modal for v1: it keeps the
  // removal action synchronous (no extra dialog state to manage) and
  // works on every platform Playwright tests run on. When the setting is
  // off (default), the × button is one-click as before.
  const attemptRemove = () => {
    if (getSetting('confirmBeforeRemove')) {
      const name = img && img.source && img.source.name ? img.source.name : 'this image';
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('settingsConfirmRemovePrompt', { name }))
        : true;
      if (!ok) return;
    }
    removeImage(id);
  };
  removeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    attemptRemove();
  });
  removeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      attemptRemove();
    }
  });
  btn.addEventListener('click', (e) => {
    if (e.target === removeEl || removeEl.contains(e.target)) return;
    setActive(id);
    update(s => { s.ui.view = 'editor'; });
  });
  return { node: btn, url, thumbnailBlob: img.source.thumbnail, badgeEl: null };
}

function syncBatchBadge(entry, img) {
  const wantBadge = !!img._isBatch;
  if (wantBadge && !entry.badgeEl) {
    const badge = document.createElement('span');
    badge.className = 'queue-thumb-batch-badge';
    badge.textContent = t('queueBatchBadge');
    badge.setAttribute('aria-hidden', 'true');
    entry.node.appendChild(badge);
    entry.badgeEl = badge;
  } else if (!wantBadge && entry.badgeEl) {
    entry.badgeEl.remove();
    entry.badgeEl = null;
  }
}

function removeThumb(id, entry) {
  try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
  if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
  rendered.delete(id);
}

function cleanupAllThumbs() {
  for (const [id, entry] of rendered) {
    try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
    if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
  }
  rendered.clear();
}

// --------------------------------------------------------------------------
// Batch panel — built once on first populated render, then synced.
// --------------------------------------------------------------------------

const RESIZE_MODES = [
  { value: 'free',         i18n: 'resizeModeFree' },
  { value: 'longestSide',  i18n: 'resizeModeLongest' },
  { value: 'shortestSide', i18n: 'resizeModeShortest' },
  { value: 'width',        i18n: 'resizeModeWidth' },
  { value: 'height',       i18n: 'resizeModeHeightLabel' },
  { value: 'percent',      i18n: 'resizeModePercent' },
  { value: 'exact',        i18n: 'resizeModeExact' },
];

const FILTER_OPTIONS = [
  { value: 'none',      i18n: 'filterPresetNone' },
  { value: 'grayscale', i18n: 'filterPresetGrayscale' },
  { value: 'sepia',     i18n: 'filterPresetSepia' },
  { value: 'invert',    i18n: 'filterPresetInvert' },
];

const EXPORT_FORMATS = [
  { id: 'png',  i18n: 'exportFormatPng'  },
  { id: 'jpeg', i18n: 'exportFormatJpg'  },
  { id: 'webp', i18n: 'exportFormatWebp' },
];

function buildBatchPanel() {
  const panel = document.createElement('aside');
  panel.className = 'batch-panel';
  panel.setAttribute('aria-label', t('batchPanelLabel'));

  const heading = document.createElement('h2');
  heading.className = 'batch-panel-heading';
  heading.textContent = t('batchApplyToAll');
  panel.appendChild(heading);

  // --- 1. Resize -----------------------------------------------------------
  const resizeSection = buildSection(t('batchSectionResize'), 'batch-resize-section', true);
  const resizeMode = document.createElement('select');
  resizeMode.className = 'batch-resize-mode';
  resizeMode.setAttribute('aria-label', t('batchModeAria'));
  for (const m of RESIZE_MODES) {
    const o = document.createElement('option');
    o.value = m.value;
    o.textContent = t(m.i18n);
    resizeMode.appendChild(o);
  }
  resizeSection.body.appendChild(labelRow(t('resizeMode'), resizeMode));

  const resizeValue = document.createElement('input');
  resizeValue.type = 'number';
  resizeValue.min = '1';
  resizeValue.step = '1';
  resizeValue.className = 'batch-resize-value';
  resizeValue.setAttribute('aria-label', t('batchValueAria'));
  const resizeValueRow = labelRow(t('resizeValue'), resizeValue);
  resizeSection.body.appendChild(resizeValueRow);

  const resizeHeight = document.createElement('input');
  resizeHeight.type = 'number';
  resizeHeight.min = '1';
  resizeHeight.step = '1';
  resizeHeight.className = 'batch-resize-height';
  resizeHeight.setAttribute('aria-label', t('batchHeightAria'));
  const resizeHeightRow = labelRow(t('resizeHeight'), resizeHeight);
  resizeHeightRow.hidden = true;
  resizeSection.body.appendChild(resizeHeightRow);

  const resizeApply = applyButton(t('batchResizeApply'));
  resizeApply.className += ' batch-resize-apply';
  resizeSection.body.appendChild(resizeApply);
  panel.appendChild(resizeSection.section);

  // --- 2. Rotate / Flip ---------------------------------------------------
  const rotateSection = buildSection(t('batchSectionRotate'), 'batch-rotate-section', false);
  const rotGroup = document.createElement('div');
  rotGroup.className = 'batch-rotate-group';
  // Glyphs + degree number stay literal (locale-independent for v1).
  const rotLeftBtn  = simpleBtn('↺ 90°', 'batch-rotate-left');
  const rotRightBtn = simpleBtn('↻ 90°', 'batch-rotate-right');
  const flipHBtn    = simpleBtn(t('selectFlipH'), 'batch-flip-h');
  const flipVBtn    = simpleBtn(t('selectFlipV'), 'batch-flip-v');
  rotGroup.append(rotLeftBtn, rotRightBtn, flipHBtn, flipVBtn);
  rotateSection.body.appendChild(rotGroup);
  panel.appendChild(rotateSection.section);

  // --- 3. Adjust ----------------------------------------------------------
  const adjustSection = buildSection(t('batchSectionAdjust'), 'batch-adjust-section', false);
  const sliderRefs = new Map();
  for (const key of ['brightness', 'contrast', 'saturation', 'blur']) {
    const range = ADJUST_RANGES[key];
    const row = document.createElement('div');
    row.className = 'batch-adjust-row';
    const lbl = document.createElement('span');
    lbl.className = 'batch-adjust-label';
    // Re-use the per-image adjust labels — same meaning across views.
    lbl.textContent = t(`adjust${capitalize(key)}`);
    row.appendChild(lbl);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = '1';
    input.value = '0';
    input.className = `batch-adjust-slider batch-adjust-${key}`;
    input.setAttribute('aria-label', t('batchSliderAria', { key }));
    row.appendChild(input);
    const readout = document.createElement('span');
    readout.className = 'batch-adjust-readout';
    readout.textContent = key === 'blur' ? '0px' : '0';
    row.appendChild(readout);
    adjustSection.body.appendChild(row);
    input.addEventListener('input', () => {
      readout.textContent = key === 'blur' ? `${input.value}px` : input.value;
    });
    sliderRefs.set(key, { input, readout });
  }
  // Filter preset row.
  const presetSel = document.createElement('select');
  presetSel.className = 'batch-adjust-preset';
  presetSel.setAttribute('aria-label', t('batchPresetAria'));
  for (const o of FILTER_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = t(o.i18n);
    presetSel.appendChild(opt);
  }
  adjustSection.body.appendChild(labelRow(t('filterPresetLabel'), presetSel));
  const adjustApply = applyButton(t('batchAdjustApply'));
  adjustApply.className += ' batch-adjust-apply';
  adjustSection.body.appendChild(adjustApply);
  panel.appendChild(adjustSection.section);

  // --- 4. Color-to-transparent -------------------------------------------
  const chromaSection = buildSection(t('batchSectionChroma'), 'batch-chroma-section', false);
  const chromaColor = document.createElement('input');
  chromaColor.type = 'color';
  chromaColor.className = 'batch-chroma-color';
  chromaColor.value = '#ffffff';
  chromaColor.setAttribute('aria-label', t('batchChromaColorAria'));
  chromaSection.body.appendChild(labelRow(t('brushColor'), chromaColor));

  const chromaTol = document.createElement('input');
  chromaTol.type = 'range';
  chromaTol.min = '0';
  chromaTol.max = '100';
  chromaTol.step = '1';
  chromaTol.value = '25';
  chromaTol.className = 'batch-chroma-tol';
  chromaTol.setAttribute('aria-label', t('batchChromaTolAria'));
  const chromaTolReadout = document.createElement('span');
  chromaTolReadout.className = 'batch-chroma-tol-readout';
  chromaTolReadout.textContent = '25';
  const tolRow = document.createElement('div');
  tolRow.className = 'batch-row batch-row--tol';
  const tolLbl = document.createElement('span'); tolLbl.textContent = t('eyedropperTolerance');
  tolRow.append(tolLbl, chromaTol, chromaTolReadout);
  chromaSection.body.appendChild(tolRow);
  chromaTol.addEventListener('input', () => { chromaTolReadout.textContent = chromaTol.value; });

  const chromaApply = applyButton(t('batchChromaApply'));
  chromaApply.className += ' batch-chroma-apply';
  chromaSection.body.appendChild(chromaApply);
  panel.appendChild(chromaSection.section);

  // --- 5. Background remove ----------------------------------------------
  const bgSection = buildSection(t('batchSectionBg'), 'batch-bg-section', false);
  const bgHint = document.createElement('p');
  bgHint.className = 'batch-bg-hint';
  bgHint.textContent = t('batchBgHint');
  bgSection.body.appendChild(bgHint);
  const bgBtn = document.createElement('button');
  bgBtn.type = 'button';
  bgBtn.className = 'batch-apply batch-bg-apply';
  bgBtn.textContent = t('batchBgRun');
  bgBtn.setAttribute('aria-label', t('batchBgRunAria'));
  bgBtn.addEventListener('click', () => {
    onApplyBgRemove();
  });
  bgSection.body.appendChild(bgBtn);
  panel.appendChild(bgSection.section);

  // --- 6. Export ---------------------------------------------------------
  const exportSection = buildSection(t('batchSectionExport'), 'batch-export-section', true);

  const fmtRow = document.createElement('div');
  fmtRow.className = 'batch-format-row';
  const fmtBtns = new Map();
  for (const fmt of EXPORT_FORMATS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'batch-format-chip';
    btn.dataset.format = fmt.id;
    const fmtLabel = t(fmt.i18n);
    btn.textContent = fmtLabel;
    btn.setAttribute('aria-label', t('batchExportAsAria', { label: fmtLabel }));
    fmtRow.appendChild(btn);
    fmtBtns.set(fmt.id, btn);
    btn.addEventListener('click', () => {
      update(s => { s.export.format = fmt.id; });
    });
  }
  exportSection.body.appendChild(fmtRow);

  const qualityRow = document.createElement('div');
  qualityRow.className = 'batch-quality-row';
  const qLbl = document.createElement('span'); qLbl.textContent = t('exportQuality');
  const qInput = document.createElement('input');
  qInput.type = 'range';
  qInput.min = '0'; qInput.max = '1'; qInput.step = '0.01';
  qInput.value = '0.92';
  qInput.className = 'batch-quality-slider';
  qInput.setAttribute('aria-label', t('batchQualityAria'));
  const qReadout = document.createElement('span');
  qReadout.className = 'batch-quality-readout';
  qReadout.textContent = '92';
  qualityRow.append(qLbl, qInput, qReadout);
  exportSection.body.appendChild(qualityRow);
  qInput.addEventListener('input', () => {
    qReadout.textContent = String(Math.round(Number(qInput.value) * 100));
    update(s => { s.export.quality = Number(qInput.value); });
  });

  const fnRow = document.createElement('div');
  fnRow.className = 'batch-filename-row';
  const fnLbl = document.createElement('span'); fnLbl.textContent = t('exportFilename');
  const fnInput = document.createElement('input');
  fnInput.type = 'text';
  fnInput.className = 'batch-filename-template';
  fnInput.value = '{base}-edited';
  fnInput.spellcheck = false;
  fnInput.autocomplete = 'off';
  fnInput.setAttribute('aria-label', t('batchFilenameAria'));
  fnRow.append(fnLbl, fnInput);
  exportSection.body.appendChild(fnRow);
  const fnHelp = document.createElement('p');
  fnHelp.className = 'batch-filename-help';
  // {base}/{n}/{ext} are template syntax — t() without vars keeps them raw.
  fnHelp.textContent = t('batchFilenameHelp');
  exportSection.body.appendChild(fnHelp);
  fnInput.addEventListener('input', () => {
    const v = fnInput.value;
    update(s => { s.export.filenameTemplate = v.length > 0 ? v : '{base}-edited'; });
  });

  const readout = document.createElement('p');
  readout.className = 'batch-export-readout';
  readout.setAttribute('aria-live', 'polite');
  exportSection.body.appendChild(readout);

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'batch-apply export-queue-btn';
  exportBtn.textContent = t('batchExportZip');
  exportBtn.setAttribute('aria-label', t('batchExportZipAria'));
  exportSection.body.appendChild(exportBtn);

  // Secondary export: trigger an individual file download per image. Useful
  // on mobile where a ZIP requires a separate unzip step.
  const exportEachBtn = document.createElement('button');
  exportEachBtn.type = 'button';
  exportEachBtn.className = 'batch-apply-secondary export-each-btn';
  exportEachBtn.textContent = t('batchExportEach');
  exportEachBtn.setAttribute('aria-label', t('batchExportEachAria'));
  exportSection.body.appendChild(exportEachBtn);

  panel.appendChild(exportSection.section);

  // --- Wire actions ------------------------------------------------------
  // Resize mode change: show/hide height field.
  resizeMode.addEventListener('change', () => {
    resizeHeightRow.hidden = resizeMode.value !== 'exact';
  });

  resizeApply.addEventListener('click', () => {
    onApplyResize(resizeMode.value, resizeValue.value, resizeHeight.value);
  });

  rotLeftBtn.addEventListener('click',  () => onApplyRotate(-90));
  rotRightBtn.addEventListener('click', () => onApplyRotate(90));
  flipHBtn.addEventListener('click',    () => onApplyFlip('h'));
  flipVBtn.addEventListener('click',    () => onApplyFlip('v'));

  adjustApply.addEventListener('click', () => {
    const values = {};
    for (const [k, ref] of sliderRefs) values[k] = Number(ref.input.value);
    onApplyAdjust(values, presetSel.value);
  });

  chromaApply.addEventListener('click', () => {
    onApplyChromakey(chromaColor.value, Number(chromaTol.value));
  });

  exportBtn.addEventListener('click', () => {
    // Disable button during export to prevent double-click; re-enabled in
    // finally.
    exportBtn.disabled = true;
    exportEachBtn.disabled = true;
    exportBatch().finally(() => {
      exportBtn.disabled = false;
      exportEachBtn.disabled = false;
    });
  });
  exportEachBtn.addEventListener('click', () => {
    exportBtn.disabled = true;
    exportEachBtn.disabled = true;
    exportEachIndividually().finally(() => {
      exportBtn.disabled = false;
      exportEachBtn.disabled = false;
    });
  });

  panelRefs = {
    panel,
    resizeMode, resizeValue, resizeHeight, resizeHeightRow, resizeApply,
    sliderRefs, presetSel, adjustApply,
    chromaColor, chromaTol, chromaTolReadout, chromaApply,
    bgBtn,
    fmtBtns, qInput, qReadout, qualityRow, fnInput, exportBtn, readout,
  };

  if (!panelSubscribed) {
    panelSubscribed = true;
    // No additional subscription needed — render() already runs on every
    // state change and calls syncBatchPanel below.
  }

  return panel;
}

function buildSection(title, sectionClass, openByDefault) {
  const section = document.createElement('details');
  section.className = `batch-section ${sectionClass}`;
  if (openByDefault) section.open = true;
  const summary = document.createElement('summary');
  summary.textContent = title;
  section.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'batch-section-body';
  section.appendChild(body);
  return { section, body };
}

function labelRow(text, control) {
  const row = document.createElement('label');
  row.className = 'batch-row';
  const lbl = document.createElement('span');
  lbl.textContent = text;
  row.append(lbl, control);
  return row;
}

function applyButton(label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'batch-apply';
  b.textContent = label;
  return b;
}

function simpleBtn(label, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --------------------------------------------------------------------------
// Batch panel sync — keeps the panel inputs reflecting state where it
// matters (just the export side; the per-section inputs are write-only
// scratch pads). Also updates the file-count / size readout.
// --------------------------------------------------------------------------

function syncBatchPanel(state) {
  if (!panelRefs) return;
  const exp = state.export || { format: 'png', quality: 0.92, filenameTemplate: '{base}-edited' };

  // Active format chip.
  for (const [id, btn] of panelRefs.fmtBtns) {
    btn.classList.toggle('is-active', id === exp.format);
    btn.setAttribute('aria-pressed', id === exp.format ? 'true' : 'false');
  }

  // Quality row visibility — only meaningful for JPG / WebP.
  const showQuality = exp.format === 'jpeg' || exp.format === 'webp';
  panelRefs.qualityRow.hidden = !showQuality;
  if (showQuality && document.activeElement !== panelRefs.qInput) {
    const q = Number.isFinite(exp.quality) ? exp.quality : 0.92;
    panelRefs.qInput.value = String(q);
    panelRefs.qReadout.textContent = String(Math.round(q * 100));
  }

  if (document.activeElement !== panelRefs.fnInput) {
    panelRefs.fnInput.value = exp.filenameTemplate || '{base}-edited';
  }

  // File count + estimated total size.
  const count = state.queue.length;
  let totalPx = 0;
  for (const id of state.queue) {
    const img = state.images[id];
    if (!img || !img.source) continue;
    totalPx += (img.source.width || 0) * (img.source.height || 0);
  }
  const bytesPerPx = exp.format === 'png' ? 4 : exp.format === 'webp' ? 1 : 2;
  const estMB = (totalPx * bytesPerPx) / (1024 * 1024);
  const key = count === 1 ? 'batchReadoutSingular' : 'batchReadoutPlural';
  panelRefs.readout.textContent = t(key, { count, mb: estMB.toFixed(1) });
  panelRefs.exportBtn.disabled = count === 0;
}

// --------------------------------------------------------------------------
// Apply-to-all handlers — each records ONE batch transaction so a single
// Ctrl+Z reverts the whole thing.
// --------------------------------------------------------------------------

function onApplyResize(mode, valueStr, heightStr) {
  const ids = getState().queue.slice();
  if (ids.length === 0) return;

  if (mode === 'free') {
    withBatchTransforms('Clear resize on all', ids, (state) => {
      for (const id of ids) {
        const img = state.images[id];
        if (!img) continue;
        applyResize(img, null);
        markBatch(img);
      }
    });
    toast(t('batchToastResizeCleared', { count: ids.length }));
    maybeRefreshThumbs(ids);
    return;
  }

  const value = Number(valueStr);
  if (!Number.isFinite(value) || value <= 0) {
    showToast(t('batchToastResizeInvalid'), { variant: 'warn' });
    return;
  }
  const payload = { mode, value };
  if (mode === 'exact') {
    const heightVal = Number(heightStr);
    payload.height = Number.isFinite(heightVal) && heightVal > 0 ? heightVal : value;
  }

  withBatchTransforms('Apply resize to all', ids, (state) => {
    for (const id of ids) {
      const img = state.images[id];
      if (!img) continue;
      applyResize(img, payload);
      markBatch(img);
    }
  });
  toast(t('batchToastResizeApplied', { count: ids.length }));
  maybeRefreshThumbs(ids);
}

function onApplyRotate(delta) {
  const ids = getState().queue.slice();
  if (ids.length === 0) return;
  withBatchTransforms(`Rotate ${delta > 0 ? '+' : ''}${delta}° on all`, ids, (state) => {
    for (const id of ids) {
      const img = state.images[id];
      if (!img) continue;
      const cur = (img.transforms && img.transforms.rotate) || 0;
      applyRotate(img, cur + delta);
      markBatch(img);
    }
  });
  toast(t('batchToastRotated', { count: ids.length }));
  maybeRefreshThumbs(ids);
}

function onApplyFlip(axis) {
  const ids = getState().queue.slice();
  if (ids.length === 0) return;
  withBatchTransforms(`Flip ${axis === 'h' ? 'horizontal' : 'vertical'} on all`, ids, (state) => {
    for (const id of ids) {
      const img = state.images[id];
      if (!img) continue;
      applyFlip(img, axis);
      markBatch(img);
    }
  });
  toast(t('batchToastFlipped', { count: ids.length }));
  maybeRefreshThumbs(ids);
}

function onApplyAdjust(values, preset) {
  const ids = getState().queue.slice();
  if (ids.length === 0) return;
  withBatchAdjust('Apply adjust to all', ids, (state) => {
    for (const id of ids) {
      const img = state.images[id];
      if (!img) continue;
      for (const [key, val] of Object.entries(values)) {
        applyAdjust(img, key, val);
      }
      applyFilterPreset(img, preset);
      markBatch(img);
    }
  });
  toast(t('batchToastAdjusted', { count: ids.length }));
  maybeRefreshThumbs(ids);
}

async function onApplyChromakey(hexInput, tolerance) {
  const ids = getState().queue.slice();
  if (ids.length === 0) return;
  const hex = normalizeHex(hexInput);
  const tol = Math.max(0, Math.min(100, Number(tolerance) || 0));

  // Build masks first, OUTSIDE the transaction, so the transaction body is a
  // synchronous mutator (matches the requirement of withBatchTransaction).
  // Mask build needs source-pixel ImageData, which requires a decoded
  // bitmap. We decode on-demand from the blob — same pattern as the
  // eyedropper tool, but here we don't lean on lifecycle since the queue
  // might have 100 images and only 3 decoded at any moment.
  const maskByImage = Object.create(null);
  for (const id of ids) {
    const img = getState().images[id];
    if (!img || !img.source) continue;
    try {
      const idata = await readSourceImageData(img);
      if (!idata) continue;
      maskByImage[id] = buildChromakeyMask(idata, hex, tol);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('batch chromakey: mask build failed for', id, err);
    }
  }

  withBatchChromakey('Apply chromakey to all', ids, (state) => {
    for (const id of ids) {
      const img = state.images[id];
      if (!img) continue;
      applyChromakey(img, { hex, tolerance: tol });
      const mask = maskByImage[id];
      if (mask) setChromakeyMask(img, mask);
      markBatch(img);
    }
  });
  toast(t('batchToastChromakey', { count: ids.length }));
  maybeRefreshThumbs(ids);
}

async function onApplyBgRemove() {
  const ids = getState().queue.slice();
  if (ids.length === 0) return;

  // Show a progress modal that mirrors the export progress UX (per-row
  // status + global bar + Cancel). The ops/bgremove module already handles
  // the consent prompt and model load before iterating.
  const progress = openBgRemoveProgressModal(ids);
  const cancelRef = { value: false };
  progress.onCancel(() => { cancelRef.value = true; });

  let result;
  try {
    result = await applyBgRemoveBatch(ids, (i, total, label) => {
      progress.itemUpdate(i, label);
      progress.tick(i + (label === 'done' || label === 'failed' || label === 'skipped' ? 1 : 0), total);
    }, cancelRef);
  } finally {
    progress.close();
  }

  if (!result) return;
  if (result.cancelled) {
    showToast(t('batchBgCancelled'), { variant: 'warn' });
  } else if (result.failed > 0) {
    showToast(t('batchBgPartial', { count: result.count, failed: result.failed }), { variant: 'warn' });
  } else {
    showToast(t('batchBgDone', { count: result.count }), { variant: 'info' });
  }
  // Refresh queue thumbnails so the (now alpha-cut) results show on each
  // tile. The bg-remove loop already had its own progress modal so we
  // intentionally do this AFTER, not during, the per-image runs.
  maybeRefreshThumbs(ids);
}

function openBgRemoveProgressModal(ids) {
  const dialog = document.createElement('dialog');
  dialog.className = 'batch-progress-dialog bgremove-progress-dialog';
  dialog.setAttribute('aria-label', t('batchProgressBgLabel'));

  const title = document.createElement('h2');
  title.className = 'batch-progress-title';
  const titleKey = ids.length === 1 ? 'batchProgressBgTitleSingular' : 'batchProgressBgTitlePlural';
  title.textContent = t(titleKey, { count: ids.length });
  dialog.appendChild(title);

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

  const list = document.createElement('ul');
  list.className = 'batch-progress-list';
  const rows = [];
  const state = getState();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const img = state.images[id];
    const li = document.createElement('li');
    li.className = 'batch-progress-row';
    const name = document.createElement('span');
    name.className = 'batch-progress-row-name';
    name.textContent = (img && img.source && img.source.name) || `image-${i + 1}`;
    li.appendChild(name);
    const stat = document.createElement('span');
    stat.className = 'batch-progress-row-status';
    stat.textContent = t('batchProgressQueued');
    li.appendChild(stat);
    list.appendChild(li);
    rows.push({ li, stat });
  }
  dialog.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'batch-progress-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'batch-progress-cancel';
  cancelBtn.textContent = t('batchProgressCancel');
  actions.appendChild(cancelBtn);
  dialog.appendChild(actions);

  document.body.appendChild(dialog);
  try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }

  let onCancelFn = null;
  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = t('batchProgressCancelling');
    if (typeof onCancelFn === 'function') onCancelFn();
  });

  return {
    onCancel(fn) { onCancelFn = fn; },
    itemUpdate(index, label) {
      const row = rows[index];
      if (!row) return;
      let text;
      switch (label) {
        case 'encoding': text = t('batchProgressEncoding'); break;
        case 'done':     text = t('batchProgressDone'); break;
        case 'failed':   text = t('batchProgressFailed'); break;
        case 'skipped':  text = t('batchProgressSkipped'); break;
        default:         text = String(label || t('batchProgressQueued'));
      }
      row.stat.textContent = text;
      row.li.classList.remove('is-encoding', 'is-done', 'is-failed', 'is-skipped');
      if (label) row.li.classList.add('is-' + label);
    },
    tick(done, total) {
      bar.value = done;
      bar.max = Math.max(1, total);
      status.textContent = t('batchProgressCountOf', { done, total });
    },
    close() {
      try { if (dialog.open) dialog.close(); } catch { /* ignore */ }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    },
  };
}

// Tag an image as currently reflecting a batch apply. Cleared on first
// per-image edit (see "Wired badge clearing" below).
function markBatch(img) {
  if (!img) return;
  img._isBatch = true;
}


function toast(message) {
  showToast(message, { variant: 'info' });
}

// --- Read source pixels for chromakey mask build -----------------------
// Build an ImageData from an image's source blob (decode-on-demand so we
// don't depend on lifecycle.setWindow having decoded everything in the
// queue — a queue of 100 images would never have them all decoded at
// once).
async function readSourceImageData(img) {
  const w = img.source.width;
  const h = img.source.height;
  if (!w || !h) return null;

  let bitmap = img.source.bitmap;
  let createdHere = false;
  if (!bitmap) {
    try {
      bitmap = await createImageBitmap(img.source.blob);
      createdHere = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('batch chromakey: createImageBitmap failed', err);
      return null;
    }
  }
  try {
    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    if (createdHere) {
      try { bitmap.close(); } catch { /* ignore */ }
    }
  }
}

// --------------------------------------------------------------------------
// Badge-clearing hook: any per-image edit clears the (batch) badge by
// flipping img._isBatch = false. We piggyback on state changes — the
// state subscriber below resets the flag whenever the active image
// changes through editor history events. Simpler model: every state
// change that DOESN'T come from this module's batch handlers can clear
// the flag.
//
// In practice we let the editor's per-image actions clear the flag
// explicitly. Since editor.js already wraps its history records, we
// attach a state listener that watches for editing of an individual
// image's category and clears the flag on first edit. This is the
// "simple flag" model from the Phase 10 spec.
// --------------------------------------------------------------------------

// Track last-seen image snapshots to detect per-image changes.
const lastSeen = new Map();    // id → { transforms, adjust, filterPreset, chromakey, overlays }

subscribe(state => {
  // Only matters once images exist.
  if (!state || !state.images) return;
  for (const id of state.queue) {
    const img = state.images[id];
    if (!img) continue;
    const cur = snapshot(img);
    const prev = lastSeen.get(id);
    if (img._isBatch && prev && prev.isBatch && hasPerImageChange(prev, cur)) {
      img._isBatch = false;
      cur.isBatch = false;
    }
    lastSeen.set(id, cur);
  }
  // Drop stale entries.
  for (const id of [...lastSeen.keys()]) {
    if (!state.images[id]) lastSeen.delete(id);
  }
});

// Snapshot the fields whose change indicates a per-image edit. We
// serialize transforms / adjust into strings because those subobjects are
// mutated in place by their respective ops modules (applyResize mutates
// transforms.resize without creating a new transforms object), so
// reference identity wouldn't catch any change. filterPreset is a
// primitive. chromakey + overlays ARE re-assigned wholesale by their ops
// so reference identity does catch them — we keep them as refs to avoid
// stringifying typed arrays or large overlay payloads.
function snapshot(img) {
  return {
    transforms:   stringifySafe(img.transforms),
    adjust:       stringifySafe(img.adjust),
    filterPreset: img.filterPreset,
    chromakey:    img.chromakey,
    overlays:     img.overlays,
    isBatch:      !!img._isBatch,
  };
}

function stringifySafe(v) {
  if (v == null) return '';
  try { return JSON.stringify(v); } catch { return ''; }
}

function hasPerImageChange(prev, cur) {
  return prev.transforms   !== cur.transforms
      || prev.adjust       !== cur.adjust
      || prev.filterPreset !== cur.filterPreset
      || prev.chromakey    !== cur.chromakey
      || prev.overlays     !== cur.overlays;
}
