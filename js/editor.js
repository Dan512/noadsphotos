// js/editor.js — editor view shell: toolbar, canvas frame, side panel.
//
// Phase 2 scope: lays out the editor chrome only. The previewRenderer fills
// the canvases; tool buttons toggle state.ui.activeTool with no behavior yet
// (tools land in Phases 4+). Zoom controls drive state.ui.zoom and the
// renderer picks up the change via its state subscription.
//
// Phase 4 additions:
//   - A fifth "Resize" details section sits between Tool and Adjust. Its body
//     is filled by renderResizePanel() (resize is image-state-driven, not
//     tool-driven, so it lives directly in editor.js).
//   - setToolPanel() / clearToolPanel() let tool modules (cropTool, selectTool,
//     …) own the Tool options section without each one re-touching DOM
//     bookkeeping.
import { getState, subscribe, update } from './state.js';
import { applyResize } from './ops/transforms.js';
import { applyAdjust, applyFilterPreset, resetAllAdjust, ADJUST_RANGES } from './ops/adjust.js';
import { effectiveImageSize } from './geometry.js';
import { removeOverlay, reorderOverlays } from './overlays.js';
import { undo, redo, getHistoryStats, subscribeHistory, recordOp } from './history.js';
import {
  withTransformsHistory,
  withAdjustHistory,
  withOverlaysHistory,
} from './historyOps.js';
import { exportSingle } from './exporter.js';
import { t } from './i18n.js';

// Tool list. Labels go through t() at render time; the i18n key is stored
// alongside so render code can re-derive on language switch.
const TOOLS = [
  { id: 'select',     icon: '↖', i18n: 'editorToolSelect' },
  { id: 'crop',       icon: '▭', i18n: 'editorToolCrop' },
  { id: 'text',       icon: 'T',      i18n: 'editorToolText' },
  { id: 'brush',      icon: '✎', i18n: 'editorToolBrush' },
  { id: 'shape',      icon: '◯', i18n: 'editorToolShape' },
  { id: 'redact',     icon: '▦', i18n: 'editorToolRedact' },
  { id: 'eyedropper', icon: '⌖', i18n: 'editorToolEyedropper' },
  { id: 'bg-remove',  icon: '✄', i18n: 'editorToolBgRemove' },
];

// Zoom presets shown in the Fit dropdown. 'fit' is i18n'd; numeric presets
// are formatted numbers (locale-independent for v1).
const ZOOM_PRESETS = [
  { value: 'fit',  i18n: 'editorZoomFit', label: 'Fit'  },
  { value: 0.5,    label: '50%'  },
  { value: 1,      label: '100%' },
  { value: 2,      label: '200%' },
  { value: 4,      label: '400%' },
  { value: 8,      label: '800%' },
];

// Bounds for +/- buttons.
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8.0;

// Resize modes exposed in the Resize panel dropdown. 'free' is the local
// label for "no resize stored" — it clears state.transforms.resize.
const RESIZE_MODES = [
  { value: 'free',         i18n: 'resizeModeFree' },
  { value: 'longestSide',  i18n: 'resizeModeLongest' },
  { value: 'shortestSide', i18n: 'resizeModeShortest' },
  { value: 'width',        i18n: 'resizeModeWidth' },
  { value: 'height',       i18n: 'resizeModeHeightLabel' },
  { value: 'percent',      i18n: 'resizeModePercent' },
  { value: 'exact',        i18n: 'resizeModeExact' },
];

// Cached DOM refs so render() doesn't rebuild the whole shell on every state
// change — we only mutate the bits that depend on state.
let editorEl   = null;
let toolBtns   = null;     // Map<toolId, HTMLButtonElement>
let zoomSelect = null;
let zoomReadout = null;
let toolPanelBody = null;
let resizePanelBody = null;
let adjustPanelBody = null;
let overlaysPanelBody = null;
let exportPanelBody = null;
let undoBtnEl = null;
let redoBtnEl = null;
let initialized = false;

export function initEditor() {
  editorEl = document.getElementById('editor-view');
  if (!editorEl) return;
  if (initialized) return;
  initialized = true;

  buildShell();
  render();
  subscribe(render);
  subscribeHistory(syncHistoryButtons);
  syncHistoryButtons(getHistoryStats());
}

function syncHistoryButtons(stats) {
  if (undoBtnEl) undoBtnEl.disabled = !stats || stats.pastCount === 0;
  if (redoBtnEl) redoBtnEl.disabled = !stats || stats.futureCount === 0;
}

function buildShell() {
  // Toolbar -----------------------------------------------------------------
  const toolbar = document.createElement('div');
  toolbar.className = 'editor-toolbar';

  toolBtns = new Map();
  for (const tool of TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.tool = tool.id;
    const label = t(tool.i18n);
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.textContent = tool.icon;
    btn.addEventListener('click', () => {
      update(s => { s.ui.activeTool = tool.id; });
    });
    toolbar.appendChild(btn);
    toolBtns.set(tool.id, btn);
  }

  const divider = document.createElement('span');
  divider.className = 'divider';
  divider.setAttribute('aria-hidden', 'true');
  toolbar.appendChild(divider);

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.id = 'undo-btn';
  undoBtn.setAttribute('aria-label', t('editorUndo'));
  undoBtn.title = t('editorUndo');
  undoBtn.textContent = '↶';
  undoBtn.disabled = true;
  undoBtn.addEventListener('click', () => { undo(); });
  toolbar.appendChild(undoBtn);
  undoBtnEl = undoBtn;

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.id = 'redo-btn';
  redoBtn.setAttribute('aria-label', t('editorRedo'));
  redoBtn.title = t('editorRedo');
  redoBtn.textContent = '↷';
  redoBtn.disabled = true;
  redoBtn.addEventListener('click', () => { redo(); });
  toolbar.appendChild(redoBtn);
  redoBtnEl = redoBtn;

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  toolbar.appendChild(spacer);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.id = 'back-to-queue';
  backBtn.setAttribute('aria-label', t('editorBackToQueue'));
  backBtn.textContent = t('editorBackToQueueLabel');
  backBtn.addEventListener('click', () => {
    update(s => { s.ui.view = 'queue'; });
  });
  toolbar.appendChild(backBtn);

  // Canvas frame ------------------------------------------------------------
  const frame = document.createElement('div');
  frame.className = 'canvas-frame';

  const baseCanvas = document.createElement('canvas');
  baseCanvas.id = 'base-canvas';
  frame.appendChild(baseCanvas);

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.id = 'overlay-canvas';
  frame.appendChild(overlayCanvas);

  // Long-running operation overlay (bg-remove, future heavy ops). Hidden by
  // default. js/canvasProgress.js queries this element by id; the markup
  // lives here because the canvas frame owns the layout. The progressbar
  // role gives assistive tech something to read; aria-live on the stage
  // label means stage transitions are announced.
  const progressOverlay = document.createElement('div');
  progressOverlay.id = 'canvas-progress-overlay';
  progressOverlay.className = 'canvas-progress-overlay';
  progressOverlay.setAttribute('role', 'status');
  progressOverlay.setAttribute('aria-live', 'polite');
  progressOverlay.setAttribute('aria-hidden', 'true');
  progressOverlay.hidden = true;
  const progressCard = document.createElement('div');
  progressCard.className = 'canvas-progress-card';
  const progressTitle = document.createElement('h3');
  progressTitle.className = 'canvas-progress-title';
  progressCard.appendChild(progressTitle);
  const progressBar = document.createElement('div');
  progressBar.className = 'canvas-progress-bar';
  progressBar.setAttribute('role', 'progressbar');
  progressBar.setAttribute('aria-valuemin', '0');
  progressBar.setAttribute('aria-valuemax', '100');
  progressCard.appendChild(progressBar);
  const progressMeta = document.createElement('div');
  progressMeta.className = 'canvas-progress-meta';
  const progressStage = document.createElement('span');
  progressStage.className = 'canvas-progress-stage';
  progressMeta.appendChild(progressStage);
  const progressPercent = document.createElement('span');
  progressPercent.className = 'canvas-progress-percent';
  progressMeta.appendChild(progressPercent);
  progressCard.appendChild(progressMeta);
  progressOverlay.appendChild(progressCard);
  frame.appendChild(progressOverlay);

  // Zoom controls below the canvases (positioned absolute inside frame).
  const zoomControls = document.createElement('div');
  zoomControls.className = 'zoom-controls';

  zoomSelect = document.createElement('select');
  zoomSelect.setAttribute('aria-label', t('editorZoomPresetAria'));
  for (const preset of ZOOM_PRESETS) {
    const opt = document.createElement('option');
    opt.value = String(preset.value);
    opt.textContent = preset.i18n ? t(preset.i18n) : preset.label;
    zoomSelect.appendChild(opt);
  }
  zoomSelect.addEventListener('change', () => {
    const v = zoomSelect.value;
    const next = v === 'fit' ? 'fit' : Number(v);
    update(s => { s.ui.zoom = Number.isFinite(next) || next === 'fit' ? next : 'fit'; });
  });
  zoomControls.appendChild(zoomSelect);

  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.className = 'zoom-out';
  zoomOut.setAttribute('aria-label', t('editorZoomOut'));
  zoomOut.textContent = '−';
  zoomOut.addEventListener('click', () => stepZoom(-1));
  zoomControls.appendChild(zoomOut);

  zoomReadout = document.createElement('span');
  zoomReadout.className = 'zoom-readout';
  zoomReadout.setAttribute('aria-live', 'polite');
  zoomReadout.textContent = t('editorZoomFit');
  zoomControls.appendChild(zoomReadout);

  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.className = 'zoom-in';
  zoomIn.setAttribute('aria-label', t('editorZoomIn'));
  zoomIn.textContent = '+';
  zoomIn.addEventListener('click', () => stepZoom(1));
  zoomControls.appendChild(zoomIn);

  frame.appendChild(zoomControls);

  // Side panel --------------------------------------------------------------
  const panel = document.createElement('aside');
  panel.className = 'editor-panel';
  panel.setAttribute('aria-label', t('editorPanelsLabel'));

  for (const [titleKey, panelId] of [
    ['panelToolOptions', 'panel-tool'],
    ['panelResize',      'panel-resize'],
    ['panelAdjust',      'panel-adjust'],
    ['panelOverlays',    'panel-overlays'],
    ['panelExport',      'panel-export'],
  ]) {
    const d = document.createElement('details');
    d.id = panelId;
    d.open = true;
    const s = document.createElement('summary');
    s.textContent = t(titleKey);
    d.appendChild(s);
    const body = document.createElement('div');
    body.className = 'panel-body';
    d.appendChild(body);
    panel.appendChild(d);

    if (panelId === 'panel-tool') toolPanelBody = body;
    if (panelId === 'panel-resize') resizePanelBody = body;
    if (panelId === 'panel-adjust') adjustPanelBody = body;
    if (panelId === 'panel-overlays') overlaysPanelBody = body;
    if (panelId === 'panel-export') exportPanelBody = body;
  }

  // Mount -------------------------------------------------------------------
  editorEl.replaceChildren(toolbar, frame, panel);

  // Wire the Resize and Adjust panel inputs. Done once at build time because
  // the panel bodies own their DOM regardless of activeTool.
  buildResizePanel();
  buildAdjustPanel();
  buildOverlaysPanel();
  buildExportPanel();
}

// Step zoom by one preset rung (factor 2 per step). 'fit' becomes a concrete
// number derived from current renderer; here we approximate by snapping to 1
// (the renderer will refit on next 'fit' selection).
function stepZoom(direction) {
  const cur = getState().ui.zoom;
  let nextNum;
  if (cur === 'fit' || !Number.isFinite(cur)) {
    nextNum = direction > 0 ? 1 : 0.5;
  } else {
    nextNum = direction > 0 ? cur * 2 : cur / 2;
  }
  nextNum = clamp(nextNum, ZOOM_MIN, ZOOM_MAX);
  update(s => { s.ui.zoom = nextNum; });
}

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function render() {
  const s = getState();

  // Active tool indicator.
  if (toolBtns) {
    const active = s.ui.activeTool;
    for (const [id, btn] of toolBtns) {
      btn.classList.toggle('is-active', id === active);
    }
  }

  // Zoom display.
  if (zoomSelect && zoomReadout) {
    const z = s.ui.zoom;
    if (z === 'fit') {
      if (zoomSelect.value !== 'fit') zoomSelect.value = 'fit';
      zoomReadout.textContent = t('editorZoomFit');
    } else if (Number.isFinite(z)) {
      // If the value matches a preset, sync the select; else show a custom
      // readout while leaving the select on its last preset (or default 100%).
      const match = ZOOM_PRESETS.find(p => p.value === z);
      if (match) {
        if (zoomSelect.value !== String(z)) zoomSelect.value = String(z);
      }
      zoomReadout.textContent = `${Math.round(z * 100)}%`;
    }
  }

  // Refresh the Resize panel readout when the active image or its transforms
  // change (the readout depends on effectiveImageSize, so cropping/rotating
  // changes the predicted output dims).
  syncResizePanel();

  // Refresh the Adjust panel inputs so external state changes (e.g.
  // Reset all, programmatic test setup) propagate to the sliders.
  syncAdjustPanel();

  // Re-render the Overlays panel rows.
  syncOverlaysPanel();

  // Refresh export panel readouts (output dims, active format chip).
  syncExportPanel();
}

// --------------------------------------------------------------------------
// Tool panel API — used by js/tools/*.js
//
// Tools can both write and clear the Tool options panel. To avoid one tool
// clobbering another's content during a state-change cycle (since multiple
// tools subscribe to state and run in registration order), we track the
// last setter ("owner"). clearToolPanel({ owner }) only clears if the
// requesting owner matches the current owner. setToolPanel always succeeds
// and updates the owner.
// --------------------------------------------------------------------------

let toolPanelOwner = null;

// Replace the contents of the Tool options details body. Accepts an HTML
// string, a DOM node, or an array of nodes. Tools call this when they
// activate, passing their own name as `owner` so a later clearToolPanel
// from a different tool won't erase this content.
export function setToolPanel(content, { owner = null } = {}) {
  if (!toolPanelBody) return;
  toolPanelOwner = owner;
  if (content == null) {
    toolPanelBody.replaceChildren();
    return;
  }
  if (typeof content === 'string') {
    toolPanelBody.innerHTML = content;
  } else if (content instanceof Node) {
    toolPanelBody.replaceChildren(content);
  } else if (Array.isArray(content)) {
    toolPanelBody.replaceChildren(...content);
  }
}

// Clear the panel only if the requesting owner matches the current one. If
// `owner` is omitted (legacy callers), the clear is unconditional.
export function clearToolPanel({ owner = null } = {}) {
  if (!toolPanelBody) return;
  if (owner !== null && toolPanelOwner !== owner) return;
  toolPanelBody.replaceChildren();
  toolPanelOwner = null;
}

// Expose the tool panel body so tools can attach interactive listeners
// without having to re-query the DOM.
export function getToolPanelBody() {
  return toolPanelBody;
}

// --------------------------------------------------------------------------
// Resize panel — lives entirely in editor.js
// --------------------------------------------------------------------------

let resizeEls = null; // { modeSel, valueLabel, valueInput, heightInput, heightWrap, lockChk, lockWrap, readout }

function buildResizePanel() {
  if (!resizePanelBody) return;

  const root = document.createElement('div');
  root.className = 'resize-panel';

  const modeLabel = document.createElement('label');
  modeLabel.className = 'resize-row';
  modeLabel.textContent = t('resizeMode');
  const modeSel = document.createElement('select');
  modeSel.className = 'resize-mode';
  modeSel.setAttribute('aria-label', t('resizeModeAria'));
  for (const m of RESIZE_MODES) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = t(m.i18n);
    modeSel.appendChild(opt);
  }
  modeLabel.appendChild(modeSel);
  root.appendChild(modeLabel);

  const valueWrap = document.createElement('label');
  valueWrap.className = 'resize-row';
  const valueLabel = document.createElement('span');
  valueLabel.textContent = t('resizeValue');
  valueWrap.appendChild(valueLabel);
  const valueInput = document.createElement('input');
  valueInput.type = 'number';
  valueInput.min = '1';
  valueInput.step = '1';
  valueInput.className = 'resize-value';
  valueInput.setAttribute('aria-label', t('resizeValueAria'));
  valueWrap.appendChild(valueInput);
  root.appendChild(valueWrap);

  const heightWrap = document.createElement('label');
  heightWrap.className = 'resize-row resize-height-row';
  const heightLabel = document.createElement('span');
  heightLabel.textContent = t('resizeHeight');
  heightWrap.appendChild(heightLabel);
  const heightInput = document.createElement('input');
  heightInput.type = 'number';
  heightInput.min = '1';
  heightInput.step = '1';
  heightInput.className = 'resize-height';
  heightInput.setAttribute('aria-label', t('resizeHeightAria'));
  heightWrap.appendChild(heightInput);
  heightWrap.hidden = true;
  root.appendChild(heightWrap);

  const lockWrap = document.createElement('label');
  lockWrap.className = 'resize-row resize-lock-row';
  const lockChk = document.createElement('input');
  lockChk.type = 'checkbox';
  lockChk.className = 'resize-lock';
  lockChk.checked = true;
  lockChk.setAttribute('aria-label', t('resizeLockAria'));
  lockWrap.appendChild(lockChk);
  const lockText = document.createElement('span');
  lockText.textContent = t('resizeLock');
  lockWrap.appendChild(lockText);
  root.appendChild(lockWrap);

  const readout = document.createElement('div');
  readout.className = 'resize-readout';
  readout.setAttribute('aria-live', 'polite');
  readout.textContent = t('resizeOutputEmpty');
  root.appendChild(readout);

  resizePanelBody.replaceChildren(root);
  resizeEls = { modeSel, valueLabel, valueInput, heightWrap, heightInput, lockWrap, lockChk, readout };

  // History capture for resize:
  //   - mode select / lock checkbox: discrete actions, record per change.
  //   - value / height inputs: focusin captures the before-snapshot,
  //     focusout/change records the after-snapshot (one history entry per
  //     edit session, not per keystroke).
  modeSel.addEventListener('change', () => {
    captureResizeBefore();
    onResizeInput();
    commitResizeHistory('Resize mode');
  });
  lockChk.addEventListener('change', () => {
    // Lock toggle alone doesn't write through applyResize — keep behavior.
    onResizeInput();
  });
  valueInput.addEventListener('focus', captureResizeBefore);
  valueInput.addEventListener('input', onResizeInput);
  valueInput.addEventListener('change', () => commitResizeHistory('Resize'));
  valueInput.addEventListener('blur',   () => commitResizeHistory('Resize'));
  heightInput.addEventListener('focus', captureResizeBefore);
  heightInput.addEventListener('input', onResizeInput);
  heightInput.addEventListener('change', () => commitResizeHistory('Resize'));
  heightInput.addEventListener('blur',   () => commitResizeHistory('Resize'));
}

// --- Resize history capture: one entry per edit session ------------------
// We snapshot the image's transforms BEFORE the first input event in a
// session (focusin), then record on focusout / change. This keeps slider /
// number-stepper drags from producing a hundred history entries.

let resizeHistoryImageId = null;
let resizeHistoryBefore = null;

function captureResizeBefore() {
  const img = getActiveImage();
  if (!img) { resizeHistoryImageId = null; resizeHistoryBefore = null; return; }
  resizeHistoryImageId = img.id;
  // Deep snapshot transforms so subsequent live edits don't mutate it.
  resizeHistoryBefore = JSON.parse(JSON.stringify(img.transforms));
}

function commitResizeHistory(label) {
  if (!resizeHistoryImageId || !resizeHistoryBefore) return;
  const id = resizeHistoryImageId;
  const before = resizeHistoryBefore;
  resizeHistoryImageId = null;
  resizeHistoryBefore = null;

  const img = getState().images[id];
  if (!img) return;
  const after = JSON.parse(JSON.stringify(img.transforms));
  if (JSON.stringify(before) === JSON.stringify(after)) return;

  recordOp({
    label,
    imageId: id,
    kind: 'transforms',
    before: { transforms: before },
    after:  { transforms: after  },
  });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

function onResizeInput() {
  if (!resizeEls) return;
  const img = getActiveImage();
  if (!img) return;

  const mode = resizeEls.modeSel.value;
  // Show/hide height field for exact mode and lock checkbox for non-exact modes.
  resizeEls.heightWrap.hidden = mode !== 'exact';
  resizeEls.lockWrap.hidden = mode === 'exact' || mode === 'free';

  if (mode === 'free') {
    update(s => { applyResize(s.images[img.id], null); });
    return;
  }

  const value = Number(resizeEls.valueInput.value);
  if (!Number.isFinite(value) || value <= 0) {
    // Invalid value — don't commit and don't sync (user is still typing).
    // Just refresh the readout to show "—" until input is valid.
    if (resizeEls.readout) resizeEls.readout.textContent = t('resizeOutputEmpty');
    return;
  }

  const payload = { mode, value };
  if (mode === 'exact') {
    const heightVal = Number(resizeEls.heightInput.value);
    if (Number.isFinite(heightVal) && heightVal > 0) {
      payload.height = heightVal;
    } else {
      payload.height = value; // mirror width as a fallback
    }
  }
  update(s => { applyResize(s.images[img.id], payload); });
}

function syncResizePanel() {
  if (!resizeEls) return;
  const img = getActiveImage();
  if (!img) {
    resizeEls.readout.textContent = t('resizeOutputEmpty');
    return;
  }

  const resize = img.transforms.resize;
  const focused = document.activeElement;

  // Only force-sync the mode select when state has a resize and the dropdown
  // doesn't match. When state has no resize, leave the dropdown alone — the
  // user may have just picked a mode and not yet entered a value.
  if (resize) {
    if (resizeEls.modeSel.value !== resize.mode && focused !== resizeEls.modeSel) {
      resizeEls.modeSel.value = resize.mode;
    }
    resizeEls.heightWrap.hidden = resize.mode !== 'exact';
    resizeEls.lockWrap.hidden = resize.mode === 'exact';
    if (focused !== resizeEls.valueInput) {
      resizeEls.valueInput.value = String(resize.value ?? '');
    }
    if (focused !== resizeEls.heightInput && resize.mode === 'exact') {
      resizeEls.heightInput.value = String(resize.height ?? '');
    }
  } else {
    // No resize stored. Show/hide is driven by current select value.
    const cur = resizeEls.modeSel.value;
    resizeEls.heightWrap.hidden = cur !== 'exact';
    resizeEls.lockWrap.hidden = cur === 'exact' || cur === 'free';
  }

  const dims = effectiveImageSize(img);
  if (dims.w > 0 && dims.h > 0) {
    resizeEls.readout.textContent = t('resizeOutput', { w: Math.round(dims.w), h: Math.round(dims.h) });
  } else {
    resizeEls.readout.textContent = t('resizeOutputEmpty');
  }
}

// --------------------------------------------------------------------------
// Adjust panel — lives entirely in editor.js
//
// Holds 4 sliders (brightness / contrast / saturation / blur), each with a
// numeric readout and a per-slider Reset button, plus a filter preset
// <select> at the top and a "Reset all" button at the bottom.
//
// Live-preview wiring is intentionally minimal here: every `input` event on
// a slider is coalesced into the next rAF via a single pending flag, and
// then applied through update(s => applyAdjust(...)). The previewRenderer
// reads img.adjust + img.filterPreset on every frame it draws and writes
// the corresponding `style.filter` to the base canvas — so we don't need
// to call any renderer API here.
// --------------------------------------------------------------------------

// Slider rows configured by key. Labels resolve via t(i18n).
const ADJUST_SLIDERS = [
  { key: 'brightness', i18n: 'adjustBrightness', step: 1 },
  { key: 'contrast',   i18n: 'adjustContrast',   step: 1 },
  { key: 'saturation', i18n: 'adjustSaturation', step: 1 },
  { key: 'blur',       i18n: 'adjustBlur',       step: 1, suffix: 'px' },
];

// Filter preset option labels. Visible text is fed through data-i18n;
// values stay as the canonical 'none'/'grayscale'/'sepia'/'invert'.
const ADJUST_FILTER_OPTIONS = [
  { value: 'none',      i18n: 'filterPresetNone' },
  { value: 'grayscale', i18n: 'filterPresetGrayscale' },
  { value: 'sepia',     i18n: 'filterPresetSepia' },
  { value: 'invert',    i18n: 'filterPresetInvert' },
];

let adjustEls = null; // { presetSel, rows: Map<key, {input, readout, resetBtn}>, resetAllBtn }
// rAF coalescing for slider drags: while pendingRaf is non-null we know an
// applyAdjust pass is scheduled; subsequent input events just update the
// pending value, and only the latest write reaches state.
let adjustRafHandle = null;
const adjustPendingValues = new Map();
let adjustPendingPreset = null;

function buildAdjustPanel() {
  if (!adjustPanelBody) return;

  const root = document.createElement('div');
  root.className = 'adjust-panel';

  // Preset row (above sliders).
  const presetRow = document.createElement('label');
  presetRow.className = 'preset-row';
  const presetLabel = document.createElement('span');
  presetLabel.textContent = t('filterPresetLabel');
  presetLabel.dataset.i18n = 'filterPresetLabel';
  presetRow.appendChild(presetLabel);
  const presetSel = document.createElement('select');
  presetSel.className = 'adjust-preset';
  presetSel.setAttribute('aria-label', t('filterPresetAria'));
  for (const opt of ADJUST_FILTER_OPTIONS) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = t(opt.i18n);
    o.dataset.i18n = opt.i18n;
    presetSel.appendChild(o);
  }
  presetRow.appendChild(presetSel);
  root.appendChild(presetRow);

  // Slider rows.
  const rows = new Map();
  for (const slider of ADJUST_SLIDERS) {
    const range = ADJUST_RANGES[slider.key];
    const row = document.createElement('div');
    row.className = 'adjust-row';
    row.dataset.adjustKey = slider.key;

    const label = document.createElement('label');
    const sliderLabel = t(slider.i18n);
    label.textContent = sliderLabel;
    label.dataset.i18n = slider.i18n;
    const inputId = `adjust-${slider.key}`;
    label.setAttribute('for', inputId);

    // 3-column grid: label, slider+readout group, reset button.
    // Wrap input + readout in their own container so the grid columns line up.
    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'adjust-slider-wrap';

    const input = document.createElement('input');
    input.type = 'range';
    input.id = inputId;
    input.className = `adjust-slider adjust-${slider.key}`;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(slider.step);
    input.value = '0';
    input.setAttribute('aria-label', sliderLabel);
    sliderWrap.appendChild(input);

    const readout = document.createElement('span');
    readout.className = 'readout';
    readout.setAttribute('aria-live', 'polite');
    readout.textContent = slider.suffix ? `0${slider.suffix}` : '0';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = `reset-btn adjust-${slider.key}-reset`;
    resetBtn.textContent = '↺';
    const resetAria = t('adjustReset', { label: sliderLabel.toLowerCase() });
    resetBtn.title = resetAria;
    resetBtn.setAttribute('aria-label', resetAria);

    row.appendChild(label);
    row.appendChild(sliderWrap);
    row.appendChild(readout);
    row.appendChild(resetBtn);
    root.appendChild(row);

    rows.set(slider.key, { input, readout, resetBtn, suffix: slider.suffix || '' });

    // Listeners.
    input.addEventListener('input', () => onAdjustInput(slider.key, input.value));
    input.addEventListener('change', () => onAdjustChange(slider.key));
    resetBtn.addEventListener('click', () => onAdjustReset(slider.key));
  }

  // Reset-all button.
  const resetAllBtn = document.createElement('button');
  resetAllBtn.type = 'button';
  resetAllBtn.className = 'adjust-reset-all';
  resetAllBtn.textContent = t('adjustResetAll');
  resetAllBtn.dataset.i18n = 'adjustResetAll';
  root.appendChild(resetAllBtn);

  adjustPanelBody.replaceChildren(root);
  adjustEls = { presetSel, rows, resetAllBtn };

  presetSel.addEventListener('change', () => onPresetChange(presetSel.value));
  resetAllBtn.addEventListener('click', onResetAll);
}

// --- Adjust history capture ------------------------------------------------
// Each slider records ONE history entry per drag session. The before-snapshot
// is captured lazily on the first `input` event in a session (which fires
// while the user is dragging); the entry is recorded on `change`, which the
// browser fires once on slider release.

const adjustHistoryBefore = new Map(); // key → { imageId, before }

function ensureAdjustBefore(key) {
  if (adjustHistoryBefore.has(key)) return;
  const img = getActiveImage();
  if (!img) return;
  adjustHistoryBefore.set(key, {
    imageId: img.id,
    before:  { adjust: { ...img.adjust }, filterPreset: img.filterPreset },
  });
}

function flushAdjustHistory(key, label) {
  const session = adjustHistoryBefore.get(key);
  if (!session) return;
  adjustHistoryBefore.delete(key);
  const img = getState().images[session.imageId];
  if (!img) return;
  const after = { adjust: { ...img.adjust }, filterPreset: img.filterPreset };
  if (JSON.stringify(session.before) === JSON.stringify(after)) return;
  recordOp({
    label,
    imageId: session.imageId,
    kind: 'adjust',
    before: session.before,
    after,
  });
}

// Coalesce slider input via rAF so drag-storms only commit the latest value
// per frame. We still update the readout immediately so the UI feels live;
// the state write is what's batched.
function onAdjustInput(key, rawValue) {
  if (!adjustEls) return;
  ensureAdjustBefore(key);
  const num = Number(rawValue);
  const row = adjustEls.rows.get(key);
  if (row) row.readout.textContent = formatAdjustReadout(num, row.suffix);
  adjustPendingValues.set(key, num);
  scheduleAdjustFlush();
}

// Slider 'change' fires once on release — flush any pending writes then
// record one history entry for the whole drag session.
function onAdjustChange(key) {
  // Make sure any rAF-pending value lands before we snapshot the "after".
  if (adjustRafHandle != null) {
    cancelAnimationFrame(adjustRafHandle);
    adjustRafHandle = null;
    flushAdjustPending();
  }
  flushAdjustHistory(key, `Adjust ${key}`);
}

function onAdjustReset(key) {
  const img = getActiveImage();
  if (!img) return;
  const before = { adjust: { ...img.adjust }, filterPreset: img.filterPreset };
  const row = adjustEls && adjustEls.rows.get(key);
  if (row) {
    row.input.value = '0';
    row.readout.textContent = formatAdjustReadout(0, row.suffix);
  }
  // Reset is a discrete action — commit synchronously rather than going
  // through the rAF coalescer (avoids visual lag on a quick double-click).
  update(s => { applyAdjust(s.images[img.id], key, 0); });
  const afterImg = getState().images[img.id];
  if (afterImg) {
    const after = { adjust: { ...afterImg.adjust }, filterPreset: afterImg.filterPreset };
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      recordOp({ label: `Reset ${key}`, imageId: img.id, kind: 'adjust', before, after });
    }
  }
}

function onPresetChange(value) {
  const img = getActiveImage();
  if (!img) return;
  // Snapshot before applying.
  const before = { adjust: { ...img.adjust }, filterPreset: img.filterPreset };
  adjustPendingPreset = value;
  scheduleAdjustFlush();
  // Flush eagerly so we can snapshot a stable after — change is discrete.
  if (adjustRafHandle != null) {
    cancelAnimationFrame(adjustRafHandle);
    adjustRafHandle = null;
    flushAdjustPending();
  }
  const afterImg = getState().images[img.id];
  if (!afterImg) return;
  const after = { adjust: { ...afterImg.adjust }, filterPreset: afterImg.filterPreset };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    recordOp({ label: 'Filter preset', imageId: img.id, kind: 'adjust', before, after });
  }
}

function onResetAll() {
  const img = getActiveImage();
  if (!img) return;
  const before = { adjust: { ...img.adjust }, filterPreset: img.filterPreset };
  update(s => { resetAllAdjust(s.images[img.id]); });
  // Pending coalesced writes are stale now — drop them. Same for any
  // pending history-session captures (they'd record an inconsistent before).
  adjustPendingValues.clear();
  adjustPendingPreset = null;
  adjustHistoryBefore.clear();
  if (adjustRafHandle != null) {
    cancelAnimationFrame(adjustRafHandle);
    adjustRafHandle = null;
  }
  const afterImg = getState().images[img.id];
  if (!afterImg) return;
  const after = { adjust: { ...afterImg.adjust }, filterPreset: afterImg.filterPreset };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    recordOp({ label: 'Reset all', imageId: img.id, kind: 'adjust', before, after });
  }
}

function scheduleAdjustFlush() {
  if (adjustRafHandle != null) return;
  adjustRafHandle = requestAnimationFrame(() => {
    adjustRafHandle = null;
    flushAdjustPending();
  });
}

function flushAdjustPending() {
  const img = getActiveImage();
  if (!img) {
    adjustPendingValues.clear();
    adjustPendingPreset = null;
    return;
  }
  if (adjustPendingValues.size === 0 && adjustPendingPreset == null) return;

  const sliders = [...adjustPendingValues.entries()];
  const preset = adjustPendingPreset;
  adjustPendingValues.clear();
  adjustPendingPreset = null;

  update(s => {
    const target = s.images[img.id];
    if (!target) return;
    for (const [key, value] of sliders) {
      applyAdjust(target, key, value);
    }
    if (preset != null) {
      applyFilterPreset(target, preset);
    }
  });
}

function formatAdjustReadout(value, suffix) {
  const rounded = Math.round(value);
  return suffix ? `${rounded}${suffix}` : `${rounded}`;
}

function syncAdjustPanel() {
  if (!adjustEls) return;
  const img = getActiveImage();
  if (!img) {
    // No active image — leave the UI in its current state but reset
    // readouts to neutral so nothing implies "this is the saved value".
    for (const [key, row] of adjustEls.rows) {
      if (document.activeElement !== row.input) {
        row.input.value = '0';
        row.readout.textContent = formatAdjustReadout(0, row.suffix);
      }
    }
    if (document.activeElement !== adjustEls.presetSel) {
      adjustEls.presetSel.value = 'none';
    }
    return;
  }
  // Mirror state into the inputs. Don't clobber whatever the user is
  // actively dragging (focus-aware skip).
  const focused = document.activeElement;
  for (const [key, row] of adjustEls.rows) {
    const stateVal = img.adjust[key] ?? 0;
    if (focused !== row.input) {
      row.input.value = String(stateVal);
    }
    row.readout.textContent = formatAdjustReadout(stateVal, row.suffix);
  }
  if (focused !== adjustEls.presetSel) {
    adjustEls.presetSel.value = img.filterPreset || 'none';
  }
}

// Test-only reset hook so spec files can re-initialize the shell when they
// programmatically reset state. Not exported in production paths.
export function _resetForTest() {
  editorEl = null;
  toolBtns = null;
  zoomSelect = null;
  zoomReadout = null;
  toolPanelBody = null;
  resizePanelBody = null;
  adjustPanelBody = null;
  overlaysPanelBody = null;
  exportPanelBody = null;
  resizeEls = null;
  adjustEls = null;
  overlaysEls = null;
  exportEls = null;
  toolPanelOwner = null;
  initialized = false;
  if (adjustRafHandle != null) {
    cancelAnimationFrame(adjustRafHandle);
    adjustRafHandle = null;
  }
  if (exportQualityRafHandle != null) {
    cancelAnimationFrame(exportQualityRafHandle);
    exportQualityRafHandle = null;
  }
  adjustPendingValues.clear();
  adjustPendingPreset = null;
  exportPendingQuality = null;
}

// --------------------------------------------------------------------------
// Export panel — format chips, quality slider (only for JPG/WebP), filename
// template input, output-dims readout, and the Download button.
//
// Like Adjust/Resize, the panel writes directly to state (state.export, not
// per-image), reads back via syncExportPanel() on every state change, and
// debounces the quality slider through rAF so a drag doesn't write 1000
// times.
// --------------------------------------------------------------------------

const EXPORT_FORMATS = [
  { id: 'png',  i18n: 'exportFormatPng',  mime: 'image/png'  },
  { id: 'jpeg', i18n: 'exportFormatJpg',  mime: 'image/jpeg' },
  { id: 'webp', i18n: 'exportFormatWebp', mime: 'image/webp' },
];

let exportEls = null; // { root, formatBtns: Map<id, btn>, qualityRow, qualityInput, qualityReadout, filenameInput, filenameHelp, dimsReadout, downloadBtn }
let exportQualityRafHandle = null;
let exportPendingQuality = null;

function buildExportPanel() {
  if (!exportPanelBody) return;

  const root = document.createElement('div');
  root.className = 'export-panel';

  // --- Format chips row ---
  const formatRow = document.createElement('div');
  formatRow.className = 'format-row';
  const formatBtns = new Map();
  for (const fmt of EXPORT_FORMATS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'format-chip';
    btn.dataset.format = fmt.id;
    const fmtLabel = t(fmt.i18n);
    btn.textContent = fmtLabel;
    btn.setAttribute('aria-label', t('exportFormatAria', { label: fmtLabel }));
    btn.addEventListener('click', () => onFormatChange(fmt.id));
    formatRow.appendChild(btn);
    formatBtns.set(fmt.id, btn);
  }
  root.appendChild(formatRow);

  // --- Quality slider row (only visible for JPG/WebP) ---
  const qualityRow = document.createElement('label');
  qualityRow.className = 'quality-row';
  const qualityLabel = document.createElement('span');
  qualityLabel.textContent = t('exportQuality');
  qualityRow.appendChild(qualityLabel);
  const qualityInput = document.createElement('input');
  qualityInput.type = 'range';
  qualityInput.className = 'quality-slider';
  qualityInput.min = '0';
  qualityInput.max = '1';
  qualityInput.step = '0.01';
  qualityInput.value = '0.92';
  qualityInput.setAttribute('aria-label', t('exportQualityAria'));
  qualityRow.appendChild(qualityInput);
  const qualityReadout = document.createElement('span');
  qualityReadout.className = 'quality-readout';
  qualityReadout.setAttribute('aria-live', 'polite');
  qualityReadout.textContent = '92';
  qualityRow.appendChild(qualityReadout);
  qualityInput.addEventListener('input', () => onQualityInput(qualityInput.value));
  qualityInput.addEventListener('change', () => onQualityCommit());
  root.appendChild(qualityRow);

  // --- Filename template input ---
  const filenameRow = document.createElement('label');
  filenameRow.className = 'filename-row';
  const filenameLabel = document.createElement('span');
  filenameLabel.textContent = t('exportFilename');
  filenameRow.appendChild(filenameLabel);
  const filenameInput = document.createElement('input');
  filenameInput.type = 'text';
  filenameInput.className = 'filename-template';
  filenameInput.spellcheck = false;
  filenameInput.autocomplete = 'off';
  filenameInput.setAttribute('aria-label', t('exportFilenameAria'));
  filenameRow.appendChild(filenameInput);
  filenameInput.addEventListener('input', () => onFilenameInput(filenameInput.value));
  root.appendChild(filenameRow);

  const filenameHelp = document.createElement('p');
  filenameHelp.className = 'filename-help';
  // The {base} / {date} placeholders are template syntax — keep them as-is
  // in the help string. We construct the help text directly rather than
  // through t({...}) interpolation so the curly braces aren't substituted.
  // The {base} / {date} placeholders are template syntax for the export
  // filename — they're not i18n variables. Calling t() without a vars
  // object skips substitution so the raw braces survive.
  filenameHelp.textContent = t('exportFilenameHelp');
  root.appendChild(filenameHelp);

  // --- Output dimensions readout ---
  const dimsReadout = document.createElement('div');
  dimsReadout.className = 'output-dims';
  dimsReadout.setAttribute('aria-live', 'polite');
  dimsReadout.textContent = t('exportOutputEmpty');
  root.appendChild(dimsReadout);

  // --- Download button ---
  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'download-btn';
  downloadBtn.textContent = t('exportDownload');
  downloadBtn.setAttribute('aria-label', t('exportDownloadAria'));
  downloadBtn.addEventListener('click', onDownload);
  root.appendChild(downloadBtn);

  exportPanelBody.replaceChildren(root);
  exportEls = {
    root, formatBtns, qualityRow, qualityInput, qualityReadout,
    filenameInput, filenameHelp, dimsReadout, downloadBtn,
  };
  syncExportPanel();
}

function onFormatChange(format) {
  update(s => { s.export.format = format; });
}

function onQualityInput(rawValue) {
  if (!exportEls) return;
  const num = Number(rawValue);
  if (!Number.isFinite(num)) return;
  const clamped = Math.max(0, Math.min(1, num));
  exportEls.qualityReadout.textContent = String(Math.round(clamped * 100));
  exportPendingQuality = clamped;
  if (exportQualityRafHandle == null) {
    exportQualityRafHandle = requestAnimationFrame(() => {
      exportQualityRafHandle = null;
      flushQuality();
    });
  }
}

function onQualityCommit() {
  if (exportQualityRafHandle != null) {
    cancelAnimationFrame(exportQualityRafHandle);
    exportQualityRafHandle = null;
  }
  flushQuality();
}

function flushQuality() {
  if (exportPendingQuality == null) return;
  const v = exportPendingQuality;
  exportPendingQuality = null;
  update(s => { s.export.quality = v; });
}

function onFilenameInput(rawValue) {
  // Empty string means "fall back to default" — keep state consistent so
  // makeFilename doesn't produce ".png" from a blank template.
  const v = String(rawValue == null ? '' : rawValue);
  update(s => { s.export.filenameTemplate = v.length > 0 ? v : '{base}-edited'; });
}

function onDownload() {
  const img = getActiveImage();
  if (!img) return;
  // Fire-and-forget; exporter shows toasts internally on success/failure.
  exportSingle(img.id).catch(err => {
    // exportSingle catches its own errors, but guard against unexpected throws.
    // eslint-disable-next-line no-console
    console.error('Download button:', err);
  });
}

function syncExportPanel() {
  if (!exportEls) return;
  const s = getState();
  const exp = s.export || { format: 'png', quality: 0.92, filenameTemplate: '{base}-edited' };

  // Active format chip.
  for (const [id, btn] of exportEls.formatBtns) {
    btn.classList.toggle('is-active', id === exp.format);
    btn.setAttribute('aria-pressed', id === exp.format ? 'true' : 'false');
  }

  // Quality slider: visible for JPG/WebP, hidden for PNG (lossless).
  const showQuality = exp.format === 'jpeg' || exp.format === 'webp';
  exportEls.qualityRow.hidden = !showQuality;
  if (showQuality && document.activeElement !== exportEls.qualityInput) {
    const q = Number.isFinite(exp.quality) ? exp.quality : 0.92;
    exportEls.qualityInput.value = String(q);
    exportEls.qualityReadout.textContent = String(Math.round(q * 100));
  }

  // Filename template (don't clobber while the user is typing).
  if (document.activeElement !== exportEls.filenameInput) {
    exportEls.filenameInput.value = exp.filenameTemplate || '{base}-edited';
  }

  // Output dims for the active image.
  const img = getActiveImage();
  if (!img) {
    exportEls.dimsReadout.textContent = t('exportOutputEmpty');
    exportEls.downloadBtn.disabled = true;
    return;
  }
  exportEls.downloadBtn.disabled = false;
  const dims = effectiveImageSize(img);
  if (dims.w > 0 && dims.h > 0) {
    exportEls.dimsReadout.textContent = t('exportOutput', { w: Math.round(dims.w), h: Math.round(dims.h) });
  } else {
    exportEls.dimsReadout.textContent = t('exportOutputEmpty');
  }
}

// --------------------------------------------------------------------------
// Overlays panel — lists overlays for the active image, supports select /
// delete / reorder. Lives in editor.js so it has direct access to the side
// panel scaffolding; tools (textTool / brushTool / …) only need to read +
// write state.images[id].overlays via the overlay CRUD helpers.
//
// Z-order convention: state.images[id].overlays[0] is drawn FIRST (visually
// behind everything else); the last entry is on top. We render the list in
// REVERSE so the visually-topmost row is at the top of the panel — matches
// how most editors present a "layers" stack.
// --------------------------------------------------------------------------

let overlaysEls = null; // { root, list, empty, listenersAttached }

// Per-type label/icon for the row. Brush / shape / redact land in Phase 7B
// but the dispatch is already wired up. Labels resolve via t() at render
// time so they re-translate on language change.
const OVERLAY_ICONS = Object.freeze({
  text:   { icon: 'T', i18n: 'overlayLabelText'   },
  brush:  { icon: '✎', i18n: 'overlayLabelBrush'  },
  shape:  { icon: '◯', i18n: 'overlayLabelShape'  },
  redact: { icon: '▦', i18n: 'overlayLabelRedact' },
});

function buildOverlaysPanel() {
  if (!overlaysPanelBody) return;
  const root = document.createElement('div');
  root.className = 'overlays-panel';

  const list = document.createElement('div');
  list.className = 'overlays-list';
  root.appendChild(list);

  const empty = document.createElement('p');
  empty.className = 'overlay-empty';
  empty.textContent = t('overlaysEmpty');
  root.appendChild(empty);

  overlaysPanelBody.replaceChildren(root);
  overlaysEls = { root, list, empty };
  syncOverlaysPanel();
}

function syncOverlaysPanel() {
  if (!overlaysEls) return;
  const { list, empty } = overlaysEls;
  const img = getActiveImage();
  const overlays = img && Array.isArray(img.overlays) ? img.overlays : [];

  if (overlays.length === 0) {
    list.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const selectedId = getState().ui.selectedOverlayId;

  // Render rows in reverse order: top-of-list = top-of-stack.
  const rows = [];
  for (let i = overlays.length - 1; i >= 0; i--) {
    const o = overlays[i];
    if (!o) continue;
    rows.push(buildOverlayRow(o, i, selectedId));
  }
  list.replaceChildren(...rows);
}

function buildOverlayRow(overlay, index, selectedId) {
  const row = document.createElement('div');
  row.className = 'overlay-row';
  row.dataset.overlayId = overlay.id;
  row.dataset.overlayIndex = String(index);
  row.draggable = true;
  if (overlay.id === selectedId) row.classList.add('is-active');

  const info = OVERLAY_ICONS[overlay.type];
  const fallbackLabel = info ? t(info.i18n) : overlay.type;
  const icon = info ? info.icon : '?';

  const iconEl = document.createElement('span');
  iconEl.className = 'overlay-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = icon;
  row.appendChild(iconEl);

  const label = document.createElement('span');
  label.className = 'overlay-label';
  label.textContent = labelFor(overlay, fallbackLabel);
  row.appendChild(label);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'overlay-delete';
  del.setAttribute('aria-label', t('overlayDelete'));
  del.title = t('overlayDeleteShort');
  del.textContent = '×';
  row.appendChild(del);

  row.addEventListener('click', (e) => {
    if (e.target === del) return; // delete handler wins
    update(s => { s.ui.selectedOverlayId = overlay.id; });
  });
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    const img = getActiveImage();
    if (!img) return;
    withOverlaysHistory(`Delete ${overlay.type}`, img.id, state => {
      const target = state.images[img.id];
      if (!target) return;
      removeOverlay(target, overlay.id);
      if (state.ui.selectedOverlayId === overlay.id) {
        state.ui.selectedOverlayId = null;
      }
    });
  });

  // Drag-and-drop reorder. HTML5 DnD works on desktop, but touch devices
  // generally don't fire dragstart — the textTool tests focus on desktop
  // and Phase 7B may revisit with pointer-based reorder if mobile UX needs
  // it. For v1 we accept the limitation.
  row.addEventListener('dragstart', (e) => {
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });
  row.addEventListener('dragenter', (e) => {
    e.preventDefault();
    row.classList.add('is-drop-target');
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('is-drop-target');
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('is-drop-target');
    const fromStr = e.dataTransfer && e.dataTransfer.getData('text/plain');
    const from = Number(fromStr);
    if (!Number.isInteger(from)) return;
    const to = index;
    if (from === to) return;
    const img = getActiveImage();
    if (!img) return;
    withOverlaysHistory('Reorder overlays', img.id, state => {
      const target = state.images[img.id];
      if (!target) return;
      try {
        reorderOverlays(target, from, to);
      } catch (err) {
        console.error('overlays panel: reorder failed', err);
      }
    });
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('is-dragging');
  });

  return row;
}

function labelFor(overlay, fallback) {
  if (overlay.type === 'text') {
    const text = String(overlay.text || '').replace(/\s+/g, ' ').trim();
    if (text.length === 0) return t('overlayEmptyText');
    return text.length > 24 ? text.slice(0, 24) + '…' : text;
  }
  return fallback;
}

// Expose a no-op initializer for symmetry — the panel is built inside
// buildShell so initEditor() already wires it up. We keep an export to
// match the spec wording ("initOverlaysPanel after initEditor") for any
// callers that want to verify the binding.
export function initOverlaysPanel() {
  // Idempotent: if the body is already populated, do nothing.
  if (!overlaysEls && overlaysPanelBody) buildOverlaysPanel();
}
