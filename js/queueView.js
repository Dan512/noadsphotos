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
import { computeTrimBake, applyTrimBakeToState } from './ops/trim.js';
import {
  withBatchTransforms,
  withBatchAdjust,
  withBatchChromakey,
} from './historyOps.js';
import { recordTransaction, pickKeys, subscribeHistory, getLastChange, undo, redo, getHistoryStats } from './history.js';
import {
  exportBatch,
  exportEachIndividually,
  exportBatchPdf,
  pickSmallestFormat,
  formatBytes,
} from './exporter.js';
import { renderForExport } from './render/exportRenderer.js';
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
// History buttons live at the top of the batch panel (v1.1.2). Refs are set
// by buildBatchPanel() and used by the subscribeHistory callback in
// initQueueView() to toggle disabled state.
let batchUndoBtn = null;
let batchRedoBtn = null;

export function initQueueView() {
  render(getState());
  subscribe(render);
  // v1.1.2: single history subscriber that does two things:
  //   1. Refresh queue thumbnails on undo/redo so the grid reflects the
  //      reverted state. (Batch-op handlers refresh inline after their
  //      own ops, but undo()/redo() bypass those handlers.)
  //   2. Sync the batch panel's Undo/Redo button enabled state from the
  //      past/future counts (mirrors the editor toolbar's history buttons).
  subscribeHistory(stats => {
    syncBatchHistoryButtons(stats);
    const change = getLastChange();
    if (!change) return;
    if (change.kind !== 'undo' && change.kind !== 'redo') return;
    if (!Array.isArray(change.ids) || change.ids.length === 0) return;
    maybeRefreshThumbs(change.ids);
  });
}

function syncBatchHistoryButtons(stats) {
  if (batchUndoBtn) batchUndoBtn.disabled = !stats || stats.pastCount === 0;
  if (batchRedoBtn) batchRedoBtn.disabled = !stats || stats.futureCount === 0;
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
  if (batchPredictTimerId != null) {
    clearTimeout(batchPredictTimerId);
    batchPredictTimerId = null;
  }
  batchPredictRunSeq = 0;
  lastBatchPredictKey = null;
  lastBatchPredictBytes = null;
  batchSmallestInFlight = false;
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
      <li data-i18n="introFeatureHeic">${escapeHtml(t('introFeatureHeic'))}</li>
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

// Map from the batch-resize dropdown's `value` to the i18n key used for the
// Value-row label. Mirrors the dropdown options exactly so the row label
// re-uses the same translated text the user just picked. Exact mode collapses
// to "Width" because the Height field comes via its own row.
// (Same shape as editor.js's VALUE_ROW_LABEL_KEY_BY_MODE — kept duplicated
// rather than imported to avoid a fan-out from queueView → editor.)
const BATCH_VALUE_ROW_LABEL_KEY_BY_MODE = Object.freeze({
  longestSide:  'resizeModeLongest',
  shortestSide: 'resizeModeShortest',
  width:        'resizeModeWidth',
  height:       'resizeModeHeightLabel',
  percent:      'resizeModePercent',
  exact:        'resizeModeWidth',
});

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
  // PDF reuses the `exportFormatPdfAria` aria label key (see editor.js).
  { id: 'pdf',  i18n: 'exportFormatPdf'  },
];

// PDF dropdown option sets (mirrors the editor's export panel). Kept here
// rather than imported from editor.js so the batch panel doesn't get a
// circular import.
const PDF_PAGE_SIZES = [
  { id: 'fit',    i18n: 'pdfPageFit'    },
  { id: 'letter', i18n: 'pdfPageLetter' },
  { id: 'a4',     i18n: 'pdfPageA4'     },
  { id: 'legal',  i18n: 'pdfPageLegal'  },
  { id: 'a3',     i18n: 'pdfPageA3'     },
  { id: 'b5',     i18n: 'pdfPageB5'     },
];

const PDF_ORIENTATIONS = [
  { id: 'auto',      i18n: 'pdfOrientationAuto'      },
  { id: 'portrait',  i18n: 'pdfOrientationPortrait'  },
  { id: 'landscape', i18n: 'pdfOrientationLandscape' },
];

const PDF_FIT_MODES = [
  { id: 'contain', i18n: 'pdfFitContain' },
  { id: 'cover',   i18n: 'pdfFitCover'   },
];

function buildBatchPanel() {
  const panel = document.createElement('aside');
  panel.className = 'batch-panel';
  panel.setAttribute('aria-label', t('batchPanelLabel'));

  const heading = document.createElement('h2');
  heading.className = 'batch-panel-heading';
  heading.textContent = t('batchApplyToAll');
  panel.appendChild(heading);

  // History buttons. Visible Undo/Redo right under the heading so users on
  // the queue view aren't forced to remember Ctrl+Z to revert a batch op.
  // Wired to the same history.undo()/redo() the editor toolbar uses.
  // Initial disabled state is read from getHistoryStats(); thereafter the
  // subscribeHistory() callback in initQueueView() keeps them in sync.
  const historyRow = document.createElement('div');
  historyRow.className = 'batch-history';

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'batch-undo';
  undoBtn.setAttribute('aria-label', t('editorUndo'));
  undoBtn.title = t('editorUndo');
  undoBtn.textContent = '↶';
  undoBtn.addEventListener('click', () => { undo(); });
  historyRow.appendChild(undoBtn);

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'batch-redo';
  redoBtn.setAttribute('aria-label', t('editorRedo'));
  redoBtn.title = t('editorRedo');
  redoBtn.textContent = '↷';
  redoBtn.addEventListener('click', () => { redo(); });
  historyRow.appendChild(redoBtn);

  panel.appendChild(historyRow);
  batchUndoBtn = undoBtn;
  batchRedoBtn = redoBtn;
  // Set initial state synchronously so the first paint isn't briefly
  // "enabled then immediately disabled" before the subscriber fires.
  syncBatchHistoryButtons(getHistoryStats());

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

  // Build the Value row inline (instead of through labelRow) so we can keep
  // a reference to the label <span> and re-label it as the mode changes.
  // Matches the single-image resize panel's behavior (editor.js
  // updateValueRowForMode).
  const resizeValueRow = document.createElement('label');
  resizeValueRow.className = 'batch-row';
  const resizeValueLabelEl = document.createElement('span');
  resizeValueLabelEl.textContent = t('resizeValue');
  const resizeValue = document.createElement('input');
  resizeValue.type = 'number';
  resizeValue.min = '1';
  resizeValue.step = '1';
  resizeValue.className = 'batch-resize-value';
  resizeValue.setAttribute('aria-label', t('batchValueAria'));
  resizeValueRow.append(resizeValueLabelEl, resizeValue);
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

  // --- 4b. Trim (v1.1 Feature 3) -----------------------------------------
  // Same two modes as the editor's Resize panel, applied to every image in
  // the queue. The bake is destructive (commits current edits) so this is
  // recorded as ONE transaction — Ctrl+Z restores all images at once.
  const trimSection = buildSection(t('batchSectionTrim'), 'batch-trim-section', false);
  const trimHint = document.createElement('p');
  trimHint.className = 'batch-trim-hint';
  trimHint.textContent = t('trimTooltip');
  trimSection.body.appendChild(trimHint);

  const trimTransparentBtn = document.createElement('button');
  trimTransparentBtn.type = 'button';
  trimTransparentBtn.className = 'batch-apply batch-trim-transparent';
  trimTransparentBtn.textContent = t('batchTrimTransparentApply');
  trimTransparentBtn.setAttribute('aria-label', t('batchTrimTransparentApply'));
  trimSection.body.appendChild(trimTransparentBtn);

  const trimTolRow = document.createElement('div');
  trimTolRow.className = 'batch-row batch-trim-tol-row';
  const trimTolLbl = document.createElement('span');
  trimTolLbl.textContent = t('trimToleranceLabel');
  const trimTolInput = document.createElement('input');
  trimTolInput.type = 'range';
  trimTolInput.min = '0';
  trimTolInput.max = '50';
  trimTolInput.step = '1';
  trimTolInput.value = '8';
  trimTolInput.className = 'batch-trim-tol';
  trimTolInput.setAttribute('aria-label', t('trimToleranceAria'));
  const trimTolReadout = document.createElement('span');
  trimTolReadout.className = 'batch-trim-tol-readout';
  trimTolReadout.textContent = '8';
  trimTolRow.append(trimTolLbl, trimTolInput, trimTolReadout);
  trimSection.body.appendChild(trimTolRow);
  trimTolInput.addEventListener('input', () => {
    trimTolReadout.textContent = trimTolInput.value;
  });

  const trimColorBtn = document.createElement('button');
  trimColorBtn.type = 'button';
  trimColorBtn.className = 'batch-apply batch-trim-color';
  trimColorBtn.textContent = t('batchTrimColorApply');
  trimColorBtn.setAttribute('aria-label', t('batchTrimColorApply'));
  trimSection.body.appendChild(trimColorBtn);

  trimTransparentBtn.addEventListener('click', () => {
    onApplyBatchTrim('transparent', 0, [trimTransparentBtn, trimColorBtn]);
  });
  trimColorBtn.addEventListener('click', () => {
    onApplyBatchTrim('color', Number(trimTolInput.value) || 0, [trimTransparentBtn, trimColorBtn]);
  });
  panel.appendChild(trimSection.section);

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
    // PDF gets a dedicated aria label (the generic "Export queue as PDF"
    // interpolation reads fine but we prefer the canonical phrase).
    const ariaLabel = fmt.id === 'pdf' ? t('exportFormatPdfAria') : t('batchExportAsAria', { label: fmtLabel });
    btn.setAttribute('aria-label', ariaLabel);
    fmtRow.appendChild(btn);
    fmtBtns.set(fmt.id, btn);
    btn.addEventListener('click', () => {
      update(s => { s.export.format = fmt.id; });
    });
  }
  exportSection.body.appendChild(fmtRow);

  // "Smallest size" button — picks format/quality on the FIRST queue image
  // (assumed representative) and writes the winner to state.export.
  const smallestBtn = document.createElement('button');
  smallestBtn.type = 'button';
  smallestBtn.className = 'smallest-preset-btn batch-smallest-btn';
  smallestBtn.textContent = t('exportSmallestPreset');
  smallestBtn.setAttribute('aria-label', t('exportSmallestPresetAria'));
  exportSection.body.appendChild(smallestBtn);

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

  // PDF options block — mirrors the editor's export panel. Hidden unless
  // PDF is the active format.
  const pdfOptsRow = document.createElement('div');
  pdfOptsRow.className = 'batch-pdf-opts-row pdf-opts-row';
  pdfOptsRow.hidden = true;
  // Page size.
  const pdfPageSizeLabel = document.createElement('label');
  pdfPageSizeLabel.className = 'batch-pdf-pagesize-row';
  const pdfPageSizeSpan = document.createElement('span');
  pdfPageSizeSpan.textContent = t('pdfPageSize');
  pdfPageSizeLabel.appendChild(pdfPageSizeSpan);
  const pdfPageSizeSel = document.createElement('select');
  pdfPageSizeSel.className = 'batch-pdf-pagesize-select pdf-pagesize-select';
  pdfPageSizeSel.setAttribute('aria-label', t('pdfPageSizeAria'));
  for (const ps of PDF_PAGE_SIZES) {
    const opt = document.createElement('option');
    opt.value = ps.id;
    opt.textContent = t(ps.i18n);
    pdfPageSizeSel.appendChild(opt);
  }
  pdfPageSizeLabel.appendChild(pdfPageSizeSel);
  pdfPageSizeSel.addEventListener('change', () => onBatchPdfOptChange('pageSize', pdfPageSizeSel.value));
  pdfOptsRow.appendChild(pdfPageSizeLabel);
  // Orientation.
  const pdfOrientLabel = document.createElement('label');
  pdfOrientLabel.className = 'batch-pdf-orientation-row';
  const pdfOrientSpan = document.createElement('span');
  pdfOrientSpan.textContent = t('pdfOrientation');
  pdfOrientLabel.appendChild(pdfOrientSpan);
  const pdfOrientSel = document.createElement('select');
  pdfOrientSel.className = 'batch-pdf-orientation-select pdf-orientation-select';
  pdfOrientSel.setAttribute('aria-label', t('pdfOrientationAria'));
  for (const o of PDF_ORIENTATIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = t(o.i18n);
    pdfOrientSel.appendChild(opt);
  }
  pdfOrientLabel.appendChild(pdfOrientSel);
  pdfOrientSel.addEventListener('change', () => onBatchPdfOptChange('orientation', pdfOrientSel.value));
  pdfOptsRow.appendChild(pdfOrientLabel);
  // Margins.
  const pdfMarginLabel = document.createElement('label');
  pdfMarginLabel.className = 'batch-pdf-margin-row';
  const pdfMarginSpan = document.createElement('span');
  pdfMarginSpan.textContent = t('pdfMargins');
  pdfMarginLabel.appendChild(pdfMarginSpan);
  const pdfMarginInput = document.createElement('input');
  pdfMarginInput.type = 'number';
  pdfMarginInput.className = 'batch-pdf-margin-input pdf-margin-input';
  pdfMarginInput.min = '0';
  pdfMarginInput.max = '72';
  pdfMarginInput.step = '1';
  pdfMarginInput.value = '0';
  pdfMarginInput.setAttribute('aria-label', t('pdfMarginsAria'));
  pdfMarginLabel.appendChild(pdfMarginInput);
  pdfMarginInput.addEventListener('input', () => {
    const v = Number(pdfMarginInput.value);
    if (Number.isFinite(v)) onBatchPdfOptChange('margins', Math.max(0, Math.min(72, v)));
  });
  pdfOptsRow.appendChild(pdfMarginLabel);
  // Fit mode.
  const pdfFitLabel = document.createElement('label');
  pdfFitLabel.className = 'batch-pdf-fitmode-row';
  const pdfFitSpan = document.createElement('span');
  pdfFitSpan.textContent = t('pdfFitMode');
  pdfFitLabel.appendChild(pdfFitSpan);
  const pdfFitSel = document.createElement('select');
  pdfFitSel.className = 'batch-pdf-fitmode-select pdf-fitmode-select';
  pdfFitSel.setAttribute('aria-label', t('pdfFitModeAria'));
  for (const f of PDF_FIT_MODES) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = t(f.i18n);
    pdfFitSel.appendChild(opt);
  }
  pdfFitLabel.appendChild(pdfFitSel);
  pdfFitSel.addEventListener('change', () => onBatchPdfOptChange('fitMode', pdfFitSel.value));
  pdfOptsRow.appendChild(pdfFitLabel);
  exportSection.body.appendChild(pdfOptsRow);

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

  // Single-PDF export: bundle all queue images into one multi-page PDF.
  // Hidden unless PDF is the active format. Distinct from "Export queue (ZIP)"
  // — this produces ONE shareable file rather than an archive.
  const exportPdfBtn = document.createElement('button');
  exportPdfBtn.type = 'button';
  exportPdfBtn.className = 'batch-apply-secondary export-pdf-btn';
  exportPdfBtn.textContent = t('batchExportPdf');
  exportPdfBtn.setAttribute('aria-label', t('batchExportPdfAria'));
  exportPdfBtn.hidden = true;
  exportSection.body.appendChild(exportPdfBtn);

  // Metadata toggle (v1.1.2). Mirrors the editor's export panel — the
  // setting (state.export.stripMetadata) is global so the checkbox on
  // either panel reflects the same state. When unchecked AND source +
  // output are both JPEG, batch exporter splices source EXIF back in.
  const batchStripRow = document.createElement('label');
  batchStripRow.className = 'exif-status batch-exif-status';
  const batchStripInput = document.createElement('input');
  batchStripInput.type = 'checkbox';
  batchStripInput.className = 'strip-metadata batch-strip-metadata';
  batchStripInput.checked = true;
  batchStripInput.addEventListener('change', () => {
    update(s => { s.export.stripMetadata = !!batchStripInput.checked; });
  });
  batchStripRow.appendChild(batchStripInput);
  const batchStripLabel = document.createElement('span');
  batchStripLabel.className = 'exif-label';
  batchStripLabel.textContent = t('stripMetadataLabel');
  batchStripLabel.setAttribute('title', t('exifTooltip'));
  batchStripRow.appendChild(batchStripLabel);
  exportSection.body.appendChild(batchStripRow);

  // Hint shown only when the toggle is OFF — explains the JPEG-only limit.
  const batchStripHint = document.createElement('p');
  batchStripHint.className = 'strip-metadata-hint';
  batchStripHint.textContent = t('stripMetadataHint');
  batchStripHint.hidden = true;
  exportSection.body.appendChild(batchStripHint);

  panel.appendChild(exportSection.section);

  // --- Wire actions ------------------------------------------------------
  // Resize mode change: show/hide height field AND relabel the Value row to
  // match the chosen dimension (mirrors single-image resize panel). When the
  // mode is 'free' (Revert to original), the Value field has no meaning, so
  // hide the whole row.
  function updateBatchValueRowForMode(mode) {
    if (mode === 'free') {
      resizeValueRow.hidden = true;
      resizeHeightRow.hidden = true;
      return;
    }
    resizeValueRow.hidden = false;
    resizeHeightRow.hidden = mode !== 'exact';
    const key = BATCH_VALUE_ROW_LABEL_KEY_BY_MODE[mode] || 'resizeValue';
    const label = t(key);
    resizeValueLabelEl.textContent = label;
    resizeValue.setAttribute('aria-label', label);
  }
  resizeMode.addEventListener('change', () => {
    updateBatchValueRowForMode(resizeMode.value);
  });
  // Initial label sync.
  updateBatchValueRowForMode(resizeMode.value);

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
    exportPdfBtn.disabled = true;
    exportBatch().finally(() => {
      exportBtn.disabled = false;
      exportEachBtn.disabled = false;
      exportPdfBtn.disabled = false;
    });
  });
  exportEachBtn.addEventListener('click', () => {
    exportBtn.disabled = true;
    exportEachBtn.disabled = true;
    exportPdfBtn.disabled = true;
    exportEachIndividually().finally(() => {
      exportBtn.disabled = false;
      exportEachBtn.disabled = false;
      exportPdfBtn.disabled = false;
    });
  });
  exportPdfBtn.addEventListener('click', () => {
    exportBtn.disabled = true;
    exportEachBtn.disabled = true;
    exportPdfBtn.disabled = true;
    exportBatchPdf().finally(() => {
      exportBtn.disabled = false;
      exportEachBtn.disabled = false;
      exportPdfBtn.disabled = false;
    });
  });
  smallestBtn.addEventListener('click', () => {
    onBatchSmallestPreset(smallestBtn);
  });

  panelRefs = {
    panel,
    resizeMode, resizeValue, resizeHeight, resizeHeightRow, resizeApply,
    sliderRefs, presetSel, adjustApply,
    chromaColor, chromaTol, chromaTolReadout, chromaApply,
    bgBtn,
    fmtBtns, qInput, qReadout, qualityRow, fnInput, exportBtn, exportEachBtn, exportPdfBtn,
    smallestBtn, readout,
    pdfOptsRow, pdfPageSizeSel, pdfOrientSel, pdfMarginInput, pdfFitSel, pdfFitLabel,
    batchStripInput, batchStripHint,
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
  const pdfOpts = exp.pdf || { pageSize: 'fit', orientation: 'auto', margins: undefined, fitMode: 'contain' };
  const isPdf = exp.format === 'pdf';

  // Strip-metadata checkbox: sync from state and toggle the hint visibility
  // when the user opts out of stripping. Mirrors editor.js#syncExportPanel.
  if (panelRefs.batchStripInput) {
    const strip = exp.stripMetadata !== false;
    if (document.activeElement !== panelRefs.batchStripInput) {
      panelRefs.batchStripInput.checked = strip;
    }
    if (panelRefs.batchStripHint) panelRefs.batchStripHint.hidden = strip;
  }

  // Active format chip.
  for (const [id, btn] of panelRefs.fmtBtns) {
    btn.classList.toggle('is-active', id === exp.format);
    btn.setAttribute('aria-pressed', id === exp.format ? 'true' : 'false');
  }

  // Quality row visibility — only meaningful for JPG / WebP. PDF uses a
  // fixed embed quality (0.92), so the slider is irrelevant.
  const showQuality = exp.format === 'jpeg' || exp.format === 'webp';
  panelRefs.qualityRow.hidden = !showQuality;
  if (showQuality && document.activeElement !== panelRefs.qInput) {
    const q = Number.isFinite(exp.quality) ? exp.quality : 0.92;
    panelRefs.qInput.value = String(q);
    panelRefs.qReadout.textContent = String(Math.round(q * 100));
  }

  // PDF options + Export PDF button are visible only when PDF is the active
  // format. The ZIP and "each separately" buttons stay visible (they're
  // meaningless for PDF but we hide them too — see below — to keep the
  // primary action obvious).
  if (panelRefs.pdfOptsRow) panelRefs.pdfOptsRow.hidden = !isPdf;
  if (panelRefs.exportPdfBtn) panelRefs.exportPdfBtn.hidden = !isPdf;
  if (panelRefs.exportBtn) panelRefs.exportBtn.hidden = isPdf;
  if (panelRefs.exportEachBtn) panelRefs.exportEachBtn.hidden = isPdf;
  if (panelRefs.smallestBtn) panelRefs.smallestBtn.hidden = isPdf;
  if (panelRefs.pdfPageSizeSel && document.activeElement !== panelRefs.pdfPageSizeSel) {
    panelRefs.pdfPageSizeSel.value = pdfOpts.pageSize || 'fit';
  }
  if (panelRefs.pdfOrientSel && document.activeElement !== panelRefs.pdfOrientSel) {
    panelRefs.pdfOrientSel.value = pdfOpts.orientation || 'auto';
  }
  if (panelRefs.pdfMarginInput && document.activeElement !== panelRefs.pdfMarginInput) {
    const defaultMargin = (pdfOpts.pageSize === 'fit' || !pdfOpts.pageSize) ? 0 : 36;
    const m = Number.isFinite(pdfOpts.margins) ? pdfOpts.margins : defaultMargin;
    panelRefs.pdfMarginInput.value = String(m);
  }
  if (panelRefs.pdfFitSel && document.activeElement !== panelRefs.pdfFitSel) {
    panelRefs.pdfFitSel.value = pdfOpts.fitMode || 'contain';
  }
  if (panelRefs.pdfFitLabel) {
    const fitRelevant = (pdfOpts.pageSize && pdfOpts.pageSize !== 'fit');
    panelRefs.pdfFitLabel.hidden = !fitRelevant;
  }

  if (document.activeElement !== panelRefs.fnInput) {
    panelRefs.fnInput.value = exp.filenameTemplate || '{base}-edited';
  }

  // File count + estimated total size. Two-tier readout:
  //   (a) cheap pixel-based heuristic for the initial value and as the
  //       fallback shown while a real predict encode is in flight;
  //   (b) real predict encode of the FIRST image, scaled by queue length
  //       and a small fudge factor — updates the readout when ready.
  const count = state.queue.length;
  let totalPx = 0;
  for (const id of state.queue) {
    const img = state.images[id];
    if (!img || !img.source) continue;
    totalPx += (img.source.width || 0) * (img.source.height || 0);
  }
  const bytesPerPx = exp.format === 'png' ? 4 : exp.format === 'webp' ? 1 : 2;
  const estBytes = totalPx * bytesPerPx;
  const fallbackKey = count === 1 ? 'batchReadoutSingular' : 'batchReadoutPlural';
  const fallbackText = t(fallbackKey, { count, mb: (estBytes / (1024 * 1024)).toFixed(1) });

  if (isPdf) {
    // For PDF, skip the predict-encode pass — the result depends on jsPDF
    // container overhead and per-page bake size, which we'd need to actually
    // build to measure. Show a stable "approximate" note instead; the toast
    // after the real export shows the actual size.
    panelRefs.readout.textContent = t('exportPredictedPdfNote');
  } else {
    // If we have a cached predict result for this key, show it; otherwise
    // show the heuristic and schedule a real predict encode.
    const firstId = state.queue[0];
    const firstImg = firstId ? state.images[firstId] : null;
    if (firstImg) {
      const sig = batchStateSignature(firstImg);
      const key = `batch::${firstId}::${exp.format}::${exp.quality}::${count}::${sig}`;
      if (key === lastBatchPredictKey && lastBatchPredictBytes != null) {
        panelRefs.readout.textContent = t('exportPredictedSizeBatch', {
          count,
          size: formatBytes(lastBatchPredictBytes),
        });
      } else {
        panelRefs.readout.textContent = fallbackText;
        scheduleBatchPredictEncode(key, firstImg, exp.format, exp.quality, count);
      }
    } else {
      panelRefs.readout.textContent = fallbackText;
    }
  }
  panelRefs.exportBtn.disabled = count === 0;
  if (panelRefs.exportPdfBtn) panelRefs.exportPdfBtn.disabled = count === 0;
  if (panelRefs.smallestBtn) panelRefs.smallestBtn.disabled = count === 0 || batchSmallestInFlight;
}

function onBatchPdfOptChange(key, value) {
  update(s => {
    if (!s.export.pdf) s.export.pdf = { pageSize: 'fit', orientation: 'auto', margins: undefined, fitMode: 'contain' };
    s.export.pdf[key] = value;
  });
}

// --- batch predict encode + smallest -------------------------------------
//
// Mirrors editor.js's debounced predict-encode pattern, scoped to the FIRST
// queue image. The result's byte count is scaled by queue length × a small
// fudge factor (1.0 by default — we already do per-image encodes; the
// scaled value is "estimate per image × N"). For mixed-content queues this
// will be wrong, but it's clearly labeled "est."

let batchPredictTimerId = null;
let batchPredictRunSeq = 0;
let lastBatchPredictKey = null;
let lastBatchPredictBytes = null;
let batchSmallestInFlight = false;
const BATCH_PREDICT_DEBOUNCE_MS = 300;

function scheduleBatchPredictEncode(key, firstImg, format, quality, count) {
  if (batchPredictTimerId != null) clearTimeout(batchPredictTimerId);
  batchPredictTimerId = setTimeout(() => {
    batchPredictTimerId = null;
    runBatchPredictEncode(key, firstImg, format, quality, count);
  }, BATCH_PREDICT_DEBOUNCE_MS);
}

async function runBatchPredictEncode(key, firstImg, format, quality, count) {
  if (!ctxLifecycle || !ctxCaps) return;
  const mySeq = ++batchPredictRunSeq;
  let blob;
  try {
    blob = await renderForExport(firstImg, { format, quality }, ctxCaps, ctxLifecycle);
  } catch (err) {
    // Predict encodes are background work — don't toast. Just keep the
    // heuristic readout visible.
    return;
  }
  if (mySeq !== batchPredictRunSeq) return; // stale
  // Scale by queue length. For ZIP STORE compression the per-image bytes
  // are roughly additive (images don't recompress well); for individual
  // downloads it's exact-per-image.
  const projected = blob.size * Math.max(1, count);
  lastBatchPredictKey = key;
  lastBatchPredictBytes = projected;
  if (panelRefs && panelRefs.readout) {
    panelRefs.readout.textContent = t('exportPredictedSizeBatch', {
      count,
      size: formatBytes(projected),
    });
  }
}

async function onBatchSmallestPreset(btn) {
  if (!ctxLifecycle || !ctxCaps) return;
  const s = getState();
  const firstId = s.queue[0];
  const firstImg = firstId ? s.images[firstId] : null;
  if (!firstImg) return;
  if (batchSmallestInFlight) return;
  batchSmallestInFlight = true;
  const origLabel = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-working');
    btn.textContent = t('exportSmallestWorking');
  }
  try {
    const result = await pickSmallestFormat(firstImg, ctxCaps, ctxLifecycle);
    update(state => {
      state.export.format = result.format;
      state.export.quality = result.quality;
    });
    if (result.format === 'png') {
      showToast(t('exportSmallestNoSavings'), { variant: 'info' });
    } else {
      showToast(t('exportSmallestToastBatch', {
        format: formatLabelBatch(result.format),
        quality: Math.round((result.quality || 0) * 100),
      }), { variant: 'info' });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('onBatchSmallestPreset:', err);
    showToast(t('exportGenericFailed'), { variant: 'error' });
  } finally {
    batchSmallestInFlight = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-working');
      btn.textContent = origLabel || t('exportSmallestPreset');
    }
  }
}

function formatLabelBatch(fmt) {
  if (fmt === 'jpeg') return 'JPG';
  if (fmt === 'webp') return 'WebP';
  if (fmt === 'png')  return 'PNG';
  return String(fmt).toUpperCase();
}

// (Pre-v1.1.2 this file housed onBatchVerifyExif — the batch-panel
// counterpart to the editor's "Verify last export" button. Removed for
// the same reason: the framing implied the site cached export bytes
// after download, which contradicts the "files never leave the browser"
// promise. The privacy claim now lives in copy + DevTools, not a UI
// button that pretends to introspect "what you just downloaded".)

function batchStateSignature(img) {
  if (!img) return '';
  const parts = [
    safeStr(img.transforms),
    safeStr(img.adjust),
    String(img.filterPreset || 'none'),
    img.chromakeyMask ? `cm:${img.chromakeyMask.length}` : 'cm:0',
    img.bgMask ? `bm:${img.bgMask.length}` : 'bm:0',
    safeStr(img.chromakey),
    safeStr(img.overlays),
  ];
  return parts.join('|');
}

function safeStr(v) {
  if (v == null) return '';
  try { return JSON.stringify(v); } catch { return ''; }
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

// Trim every queue image. Each image is baked individually (its own
// renderForExport call) so an empty trim on one image doesn't poison the
// whole batch. We record ONE transaction across all images that actually
// changed; nothing-changed images are skipped.
async function onApplyBatchTrim(mode, tolerance, lockButtons) {
  const ctx = { lifecycle: ctxLifecycle, caps: ctxCaps };
  if (!ctx.lifecycle || !ctx.caps) {
    showToast(t('toastBootFailed'), { variant: 'error' });
    return;
  }

  const ids = getState().queue.slice();
  if (ids.length === 0) return;

  // Disable both trim buttons while we bake. Toast progress on completion.
  const prev = lockButtons.map(b => b.disabled);
  for (const b of lockButtons) b.disabled = true;

  const KEYS = ['source', 'transforms', 'adjust', 'filterPreset', 'chromakey', 'chromakeyMask', 'bgRemoved', 'bgMask'];

  const beforeByImage = Object.create(null);
  const bakeByImage = Object.create(null);
  let trimmedCount = 0;
  let skippedCount = 0;

  try {
    for (const id of ids) {
      const img = getState().images[id];
      if (!img) { skippedCount++; continue; }
      try {
        const bake = await computeTrimBake({
          imageState: img,
          caps: ctx.caps,
          lifecycle: ctx.lifecycle,
          renderForExport,
          mode,
          tolerance,
        });
        if (!bake) { skippedCount++; continue; }
        beforeByImage[id] = pickKeys(img, KEYS);
        bakeByImage[id] = bake;
        trimmedCount++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('batch trim: failed for', id, err);
        skippedCount++;
      }
    }

    const affectedIds = Object.keys(bakeByImage);
    if (affectedIds.length === 0) {
      showToast(t('batchToastTrimSkipped', { count: skippedCount }), { variant: 'warn' });
      return;
    }

    // Apply all bakes in a single update so subscribers fire once.
    update(s => {
      for (const id of affectedIds) {
        const target = s.images[id];
        if (!target) continue;
        applyTrimBakeToState(target, bakeByImage[id]);
        markBatch(target);
      }
    });

    // Record as one transaction. opKind 'transforms' → renderer reinvalidates
    // base on undo. The bake replaces `source` too, which the renderer
    // re-reads anyway when baseDirty is set.
    const afterByImage = Object.create(null);
    for (const id of affectedIds) {
      const img = getState().images[id];
      if (img) afterByImage[id] = pickKeys(img, KEYS);
    }
    recordTransaction({
      label: mode === 'transparent' ? 'Trim transparent edges (all)' : 'Trim background color (all)',
      affectedImageIds: affectedIds,
      beforeByImage,
      afterByImage,
      opKind: 'transforms',
    });

    toast(t('batchToastTrimmed', { count: trimmedCount }));
    maybeRefreshThumbs(affectedIds);
  } finally {
    for (let i = 0; i < lockButtons.length; i++) lockButtons[i].disabled = prev[i];
  }
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
// Badge-clearing hook: any single-image edit clears the (batch) badge.
//
// v1.1.1: this was previously done by a state subscriber here that did
// dirty-checking against the previous transforms/adjust snapshot to detect
// "per-image edits" and clear `_isBatch`. That model had a bug — repeated
// batch operations (e.g. rotating 90° four times via the batch panel) also
// changed transforms, so the subscriber incorrectly classified the second
// batch op as a per-image edit and cleared the pill. Pill flickered on/off
// across consecutive batch ops.
//
// New model: clearing is flag-based, not value-based. The single-image
// history wrappers in historyOps.js (withTransformsHistory,
// withAdjustHistory, withChromakeyHistory, withOverlaysHistory,
// withBgMaskHistory) explicitly set `img._isBatch = false` inside their
// update block. Batch wrappers (withBatchTransforms et al.) call
// markBatch() which sets `_isBatch = true`. The two paths can't conflict,
// and the pill behaves predictably regardless of the transform value.
//
// See: docs/plans/2026-05-22-v1.1.1-ui-refresh-design.md §7.
// --------------------------------------------------------------------------

// (Previously: stringifySafe + hasPerImageChange helpers used by the
// removed change-detection subscriber. See v1.1.1 design §7 for why
// they were dropped. Pill clearing is now flag-based via the single-image
// history wrappers in historyOps.js.)
