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
import { getState, subscribe, update, persistTargetSize, persistUploadReady } from './state.js';
import { applyResize } from './ops/transforms.js';
import { applyAdjust, applyFilterPreset, resetAllAdjust, ADJUST_RANGES } from './ops/adjust.js';
import { computeTrimBake, applyTrimBakeToState } from './ops/trim.js';
import { effectiveImageSize } from './geometry.js';
import { removeOverlay, reorderOverlays } from './overlays.js';
import { undo, redo, getHistoryStats, subscribeHistory, recordOp } from './history.js';
import { cancelActiveToolInProgress } from './toolCancel.js';
import {
  withTransformsHistory,
  withAdjustHistory,
  withOverlaysHistory,
} from './historyOps.js';
import {
  exportSingle,
  exportSinglePdf,
  exportToTargetSize,
  applyUploadReadyPreset,
  pickSmallestFormat,
  formatBytes,
  setPredictCache,
  getExportContext,
  watermarkCacheKey,
} from './exporter.js';
import { TARGET_SIZE_PRESETS, getActiveTargetBytes } from './targetSizePresets.js';
import { getSmartDefaultFormat } from './ops/formatSmart.js';
import { renderForExport } from './render/exportRenderer.js';
import { showToast } from './errors.js';
import { hasMetadata } from './exif.js';
import { escapeHtml } from './escape.js';
import { t } from './i18n.js';

// Tool list. Labels go through t() at render time; the i18n key is stored
// alongside so render code can re-derive on language switch.
// Tool descriptors. `i18n` keys the short label (button aria-label + visible
// short title); optional `tipKey` keys a longer tooltip that explains what
// the tool does (used for tools whose label alone doesn't convey their
// purpose — eyedropper picks a chromakey color, pan only works when
// zoomed-in, etc.). If `tipKey` is absent, the button's title falls back
// to the short label.
const TOOLS = [
  { id: 'select',     icon: '↖', i18n: 'editorToolSelect',    tipKey: 'editorToolSelectTip' },
  { id: 'pan',        icon: '✋', i18n: 'editorToolPan',       tipKey: 'editorToolPanTip' },
  { id: 'crop',       icon: '▭', i18n: 'editorToolCrop' },
  { id: 'transform',  icon: '↻', i18n: 'editorToolTransform', tipKey: 'editorToolTransformTip' },
  { id: 'text',       icon: 'T',      i18n: 'editorToolText' },
  { id: 'brush',      icon: '✎', i18n: 'editorToolBrush' },
  { id: 'shape',      icon: '◯', i18n: 'editorToolShape' },
  { id: 'redact',     icon: '▦', i18n: 'editorToolRedact' },
  { id: 'transparent-png', icon: '◧', i18n: 'editorToolTransparentPng', tipKey: 'editorToolTransparentPngTip' },
  { id: 'watermark',  icon: '©', i18n: 'editorToolWatermark',  tipKey: 'editorToolWatermarkTip' },
  { id: 'eyedropper', icon: '⌖', i18n: 'editorToolEyedropper', tipKey: 'editorToolEyedropperTip' },
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
let compareBtnEl = null;
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
  // Visually-hidden landmark heading so the editor view satisfies the
  // page-has-heading-one a11y rule (the queue view's intro <h1> is removed
  // when the user opens an image). Title content lives in the toolbar
  // wordmark visually; this is for AT only.
  const srHeading = document.createElement('h1');
  srHeading.className = 'visually-hidden';
  srHeading.id = 'editor-view-title';
  srHeading.textContent = t('editorViewHeading');

  // Toolbar -----------------------------------------------------------------
  //
  // Layout: [← Queue] | [tool buttons] | [Undo] [Redo]
  //
  // v1.1.2: Undo/Redo grouped with the tool buttons on the left (was
  // pushed to the far-right edge of the toolbar via a flex spacer in
  // v1.1.1; that left too much empty space on wide screens and visually
  // disconnected history from the editing controls).
  // A short divider sits between the tools and the history pair so they
  // still feel like distinct groups without being light-years apart.
  const toolbar = document.createElement('div');
  toolbar.className = 'editor-toolbar';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.id = 'back-to-queue';
  backBtn.setAttribute('aria-label', t('editorBackToQueue'));
  backBtn.textContent = t('editorBackToQueueLabel');
  backBtn.addEventListener('click', () => {
    update(s => { s.ui.view = 'queue'; });
  });
  toolbar.appendChild(backBtn);

  const leftDivider = document.createElement('span');
  leftDivider.className = 'divider';
  leftDivider.setAttribute('aria-hidden', 'true');
  toolbar.appendChild(leftDivider);

  toolBtns = new Map();
  for (const tool of TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.tool = tool.id;
    const label = t(tool.i18n);
    btn.setAttribute('aria-label', label);
    // Title gets the longer explanation when one exists; otherwise the
    // short label. Stored as dataset so re-translating on language switch
    // can find the right key.
    btn.title = tool.tipKey ? t(tool.tipKey) : label;
    if (tool.tipKey) btn.dataset.tipKey = tool.tipKey;
    btn.textContent = tool.icon;
    btn.addEventListener('click', () => {
      update(s => { s.ui.activeTool = tool.id; });
    });
    toolbar.appendChild(btn);
    toolBtns.set(tool.id, btn);
  }

  const historyDivider = document.createElement('span');
  historyDivider.className = 'divider';
  historyDivider.setAttribute('aria-hidden', 'true');
  toolbar.appendChild(historyDivider);

  // Compare-with-original toggle (v1.2). Splits the canvas into two halves
  // showing the source bitmap on the left vs. the current edit on the right,
  // so the user can A/B their work at a glance. Doesn't change a "tool" —
  // it's a view mode — so it sits next to Undo/Redo rather than in the
  // tool buttons cluster.
  const compareBtn = document.createElement('button');
  compareBtn.type = 'button';
  compareBtn.id = 'compare-toggle';
  compareBtn.setAttribute('aria-label', t('compareToggle'));
  compareBtn.title = t('compareToggleTip');
  compareBtn.textContent = '◑';
  compareBtn.addEventListener('click', () => {
    update(s => { s.ui.compareMode = !s.ui.compareMode; });
  });
  toolbar.appendChild(compareBtn);
  compareBtnEl = compareBtn;

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.id = 'undo-btn';
  undoBtn.setAttribute('aria-label', t('editorUndo'));
  undoBtn.title = t('editorUndo');
  undoBtn.textContent = '↶';
  undoBtn.disabled = true;
  undoBtn.addEventListener('click', () => {
    // Mirror Ctrl+Z behavior: first try to cancel an in-progress tool
    // action (e.g. uncommitted eyedropper pick). Only fall through to
    // history.undo() when no tool has in-flight state. See toolCancel.js.
    if (cancelActiveToolInProgress()) return;
    undo();
  });
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

  // Canvas frame ------------------------------------------------------------
  //
  // Structure (v1.1.1):
  //   .canvas-area      ← non-scrolling, takes grid-area: canvas
  //     .canvas-frame   ← scrolling container; image overflows on zoom-in
  //       <canvases>
  //       <progress overlay>
  //     .zoom-controls  ← positioned absolute against .canvas-area, so it
  //                       stays glued to the bottom-center of the visible
  //                       frame even when the user pans a zoomed image
  //
  // Pre-v1.1.1 the zoom controls lived inside .canvas-frame, which meant
  // they scrolled along with the canvas content when the image was bigger
  // than the frame. See design doc §8.
  const area = document.createElement('div');
  area.className = 'canvas-area';

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
  // h2 (not h3) per a11y heading-order: the editor view has a visually-hidden
  // h1, and this progress card title is the next level in the outline.
  const progressTitle = document.createElement('h2');
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

  // Wrap the scrolling .canvas-frame + the non-scrolling .zoom-controls in a
  // single .canvas-area that takes grid-area: canvas. The pill stays put
  // when the user pans the zoomed canvas.
  area.appendChild(frame);
  area.appendChild(zoomControls);

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
  editorEl.replaceChildren(srHeading, toolbar, area, panel);

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

  // Compare-with-original toggle indicator.
  if (compareBtnEl) {
    compareBtnEl.classList.toggle('is-active', !!s.ui.compareMode);
    compareBtnEl.setAttribute('aria-pressed', s.ui.compareMode ? 'true' : 'false');
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

  // Apply button. Resize is "pending" in the DOM (mode/value/height inputs)
  // until the user clicks Apply — at which point we write transforms.resize
  // and refresh the preview canvas. The exception is "Revert to original"
  // mode, which is a one-click action and bypasses the button (see the
  // modeSel.change handler below). Disabled by default; enabled whenever the
  // pending DOM values would actually change state.
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'resize-apply';
  applyBtn.textContent = t('resizeApplyBtn');
  applyBtn.setAttribute('aria-label', t('resizeApplyAria'));
  applyBtn.disabled = true;
  root.appendChild(applyBtn);

  // --- Trim subsection (v1.1 Feature 3) -----------------------------------
  // Two buttons + a tolerance slider. The slider is only meaningful for the
  // "Trim background color" mode but we keep it always visible so the user
  // can see/change the value before clicking.
  const trimGroup = document.createElement('div');
  trimGroup.className = 'resize-trim-group';
  trimGroup.title = t('trimTooltip');

  const trimTransparentBtn = document.createElement('button');
  trimTransparentBtn.type = 'button';
  trimTransparentBtn.className = 'resize-trim-transparent';
  trimTransparentBtn.textContent = t('trimTransparentBtn');
  trimTransparentBtn.setAttribute('aria-label', t('trimTransparentAria'));
  trimTransparentBtn.title = t('trimTooltip');
  trimGroup.appendChild(trimTransparentBtn);

  const trimTolRow = document.createElement('label');
  trimTolRow.className = 'resize-row resize-trim-tol-row';
  const trimTolLabel = document.createElement('span');
  trimTolLabel.textContent = t('trimToleranceLabel');
  trimTolRow.appendChild(trimTolLabel);
  const trimTolInput = document.createElement('input');
  trimTolInput.type = 'range';
  trimTolInput.min = '0';
  trimTolInput.max = '50';
  trimTolInput.step = '1';
  trimTolInput.value = '8';
  trimTolInput.className = 'resize-trim-tol';
  trimTolInput.setAttribute('aria-label', t('trimToleranceAria'));
  trimTolRow.appendChild(trimTolInput);
  const trimTolReadout = document.createElement('span');
  trimTolReadout.className = 'resize-trim-tol-readout';
  trimTolReadout.textContent = '8';
  trimTolRow.appendChild(trimTolReadout);
  trimGroup.appendChild(trimTolRow);
  trimTolInput.addEventListener('input', () => {
    trimTolReadout.textContent = trimTolInput.value;
  });

  const trimColorBtn = document.createElement('button');
  trimColorBtn.type = 'button';
  trimColorBtn.className = 'resize-trim-color';
  trimColorBtn.textContent = t('trimColorBtn');
  trimColorBtn.setAttribute('aria-label', t('trimColorAria'));
  trimColorBtn.title = t('trimTooltip');
  trimGroup.appendChild(trimColorBtn);

  root.appendChild(trimGroup);

  trimTransparentBtn.addEventListener('click', () => {
    runEditorTrim('transparent', 0, trimTransparentBtn, trimColorBtn);
  });
  trimColorBtn.addEventListener('click', () => {
    const tol = Number(trimTolInput.value) || 0;
    runEditorTrim('color', tol, trimTransparentBtn, trimColorBtn);
  });

  resizePanelBody.replaceChildren(root);
  resizeEls = { modeSel, valueWrap, valueLabel, valueInput, heightWrap, heightInput, lockWrap, lockChk, readout, applyBtn };
  updateValueRowForMode(modeSel.value);

  // Pending-until-Apply model:
  //   - mode/value/height/lock changes only update the DOM + readout
  //     (computed against a temporary image clone — never writes state).
  //   - Apply button commits the pending resize, records one history entry,
  //     and marks the canvas dirty so the preview re-renders.
  //   - Exception: picking "Revert to original" (mode === 'free') is an
  //     instant action — it clears transforms.resize on the spot.
  modeSel.addEventListener('change', () => {
    const mode = modeSel.value;
    // Show/hide height + lock rows based on mode.
    heightWrap.hidden = mode !== 'exact';
    lockWrap.hidden = mode !== 'exact';
    // Relabel the value row to reflect what the number actually represents
    // (Long side / Width / Percent / …), and hide it entirely in 'free' mode
    // where there's no value to type.
    updateValueRowForMode(mode);
    if (mode === 'free') {
      // Instant action: clear any existing resize from state.
      const img = getActiveImage();
      if (img && img.transforms.resize) {
        const before = JSON.parse(JSON.stringify(img.transforms));
        update(s => { applyResize(s.images[img.id], null); });
        const after = JSON.parse(JSON.stringify(getState().images[img.id].transforms));
        recordOp({
          label: 'Resize mode',
          imageId: img.id,
          kind: 'transforms',
          before: { transforms: before },
          after:  { transforms: after  },
        });
      }
      // Clear the value input so the next non-free pick starts fresh.
      valueInput.value = '';
      heightInput.value = '';
    }
    refreshPendingResize();
  });
  lockChk.addEventListener('change', () => refreshPendingResize(valueInput));
  valueInput.addEventListener('input', () => refreshPendingResize(valueInput));
  heightInput.addEventListener('input', () => refreshPendingResize(heightInput));
  applyBtn.addEventListener('click', applyPendingResize);
}

// Map from the dropdown's `value` to the i18n key used for the Value-row
// label. Mirrors the dropdown options exactly — the row label re-uses the
// same translated text the user just picked. Exact mode collapses to "Width"
// because the Height field comes via heightWrap, which is shown separately.
const VALUE_ROW_LABEL_KEY_BY_MODE = Object.freeze({
  longestSide:  'resizeModeLongest',
  shortestSide: 'resizeModeShortest',
  width:        'resizeModeWidth',
  height:       'resizeModeHeightLabel',
  percent:      'resizeModePercent',
  exact:        'resizeModeWidth',
});

// Relabel (or hide) the value row based on the chosen mode. Called whenever
// the mode dropdown changes or state syncs in from elsewhere.
//   - 'free'  → hide the row entirely (no value to type when reverting).
//   - others  → label becomes the mode's own name ("Long side", "Percent",
//               "Width", …) so the input field clearly states which dimension
//               it controls. aria-label tracks the visible label.
function updateValueRowForMode(mode) {
  if (!resizeEls) return;
  if (mode === 'free') {
    resizeEls.valueWrap.hidden = true;
    return;
  }
  resizeEls.valueWrap.hidden = false;
  const key = VALUE_ROW_LABEL_KEY_BY_MODE[mode] || 'resizeValue';
  const label = t(key);
  resizeEls.valueLabel.textContent = label;
  resizeEls.valueInput.setAttribute('aria-label', label);
}

// Compute the resize payload encoded in the panel DOM (mode + value + optional
// height), applying the aspect-lock recompute pass. Returns:
//   - { mode, value, [height] }  → ready to send to applyResize()
//   - 'free'                     → user picked "Revert to original"
//   - null                       → mode picked but value missing/invalid
// `triggerEl` is the input element that just changed, used for which side
// drives the aspect-lock recompute in Exact mode.
function readPendingResize(triggerEl) {
  if (!resizeEls) return null;
  const mode = resizeEls.modeSel.value;
  if (mode === 'free') return 'free';
  const value = Number(resizeEls.valueInput.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const payload = { mode, value };
  if (mode === 'exact') {
    let heightVal = Number(resizeEls.heightInput.value);
    if (!Number.isFinite(heightVal) || heightVal <= 0) heightVal = value;
    payload.height = heightVal;
    if (resizeEls.lockChk && resizeEls.lockChk.checked) {
      const img = getActiveImage();
      const sw = img && img.source ? (img.source.width  || 0) : 0;
      const sh = img && img.source ? (img.source.height || 0) : 0;
      if (sw > 0 && sh > 0) {
        const aspect = sw / sh;
        if (triggerEl === resizeEls.heightInput) {
          payload.value = Math.max(1, Math.round(payload.height * aspect));
          if (document.activeElement !== resizeEls.valueInput) {
            resizeEls.valueInput.value = String(payload.value);
          }
        } else {
          payload.height = Math.max(1, Math.round(payload.value / aspect));
          if (document.activeElement !== resizeEls.heightInput) {
            resizeEls.heightInput.value = String(payload.height);
          }
        }
      }
    }
  }
  return payload;
}

// Update the Output readout to reflect what the pending DOM values would
// produce when applied — by cloning the active image's transforms and
// inserting the pending resize, then asking effectiveImageSize for dims.
// Also toggles the Apply button enabled-state based on whether the pending
// payload actually differs from the image's current transforms.resize.
function refreshPendingResize(triggerEl) {
  if (!resizeEls) return;
  const img = getActiveImage();
  const pending = readPendingResize(triggerEl);

  // Disable Apply when there's no image, an incomplete pending payload, or
  // when the pending payload matches the image's current resize (or matches
  // "no resize" for the free case).
  let enableApply = false;
  if (img && pending !== null) {
    const current = img.transforms.resize || null;
    if (pending === 'free') {
      enableApply = current !== null;
    } else if (!current) {
      enableApply = true;
    } else if (current.mode !== pending.mode || current.value !== pending.value) {
      enableApply = true;
    } else if (pending.mode === 'exact' && current.height !== pending.height) {
      enableApply = true;
    }
  }
  resizeEls.applyBtn.disabled = !enableApply;

  // Readout reflects what export will produce IF the user clicks Apply
  // (or what export will produce given current state if Apply is disabled).
  if (!img) {
    resizeEls.readout.textContent = t('resizeOutputEmpty');
    return;
  }
  let effectiveImg = img;
  if (pending && pending !== 'free') {
    effectiveImg = {
      ...img,
      transforms: { ...img.transforms, resize: pending },
    };
  } else if (pending === 'free') {
    effectiveImg = {
      ...img,
      transforms: { ...img.transforms, resize: null },
    };
  }
  const dims = effectiveImageSize(effectiveImg);
  if (dims.w > 0 && dims.h > 0) {
    resizeEls.readout.textContent = t('resizeOutput', { w: Math.round(dims.w), h: Math.round(dims.h) });
  } else {
    resizeEls.readout.textContent = t('resizeOutputEmpty');
  }
}

// Commit the pending resize to state. Snapshots transforms before/after so
// one history entry undoes the whole apply (mode + value + height in one go).
// After commit, force a preview re-render by marking the active image dirty.
function applyPendingResize() {
  if (!resizeEls) return;
  const img = getActiveImage();
  if (!img) return;
  const pending = readPendingResize();
  if (pending === null) return;

  const before = JSON.parse(JSON.stringify(img.transforms));
  update(s => {
    const target = s.images[img.id];
    if (!target) return;
    if (pending === 'free') {
      applyResize(target, null);
    } else {
      applyResize(target, pending);
    }
    // Force preview to re-render at the new output dimensions.
    target.baseDirty = true;
    target.overlaysDirty = true;
  });
  const after = JSON.parse(JSON.stringify(getState().images[img.id].transforms));

  // No-op guard: if the before and after match (e.g., the user clicked Apply
  // a second time with the same values), skip the history entry + toast.
  if (JSON.stringify(before) === JSON.stringify(after)) {
    resizeEls.applyBtn.disabled = true;
    return;
  }

  recordOp({
    label: 'Apply resize',
    imageId: img.id,
    kind: 'transforms',
    before: { transforms: before },
    after:  { transforms: after  },
  });

  showToast(t('editorToastResizeApplied'), { variant: 'info' });
  resizeEls.applyBtn.disabled = true;
}

// --- Trim (v1.1 Feature 3): bake current edits + crop to content bbox ---
//
// The trim flow:
//   1. Render the full effective image to a PNG blob, decode + scan pixels.
//   2. Find the bbox of "content" via the chosen predicate.
//   3. If empty, toast and stop.
//   4. Encode the cropped region as a fresh PNG, decode into an ImageBitmap.
//   5. Snapshot the before-state (source + transforms + chromakey + bgMask
//      + adjust + filterPreset + bgRemoved) and replace those wholesale on
//      the image: new source bitmap/blob/dims, cleared transforms,
//      cleared masks, cleared adjustments. Overlays stay intact.
//   6. Record ONE history op so a single Ctrl+Z restores everything.
//
// While the bake is running, both Trim buttons are disabled to avoid the
// user double-firing it.

// Top-level keys we snapshot before/after a trim bake. Includes `source`
// because the bitmap/blob/dims are replaced, and every other category that
// gets cleared on bake.
const KEYS_TRIM_BAKE = ['source', 'transforms', 'adjust', 'filterPreset', 'chromakey', 'chromakeyMask', 'bgRemoved', 'bgMask'];

async function runEditorTrim(mode, tolerance, btnA, btnB) {
  const img = getActiveImage();
  if (!img) return;
  const id = img.id;

  const { lifecycle, caps } = getExportContext();
  if (!lifecycle || !caps) {
    showToast(t('toastBootFailed'), { variant: 'error' });
    return;
  }

  // Lock buttons while baking. We re-enable in a finally so a thrown
  // promise still hands control back.
  const prevA = btnA ? btnA.disabled : false;
  const prevB = btnB ? btnB.disabled : false;
  if (btnA) btnA.disabled = true;
  if (btnB) btnB.disabled = true;

  try {
    const bake = await computeTrimBake({
      imageState: img,
      caps,
      lifecycle,
      renderForExport,
      mode,
      tolerance,
    });

    if (!bake) {
      showToast(t('trimEmpty'), { variant: 'warn' });
      return;
    }

    // If the bbox covers the entire rendered output, the trim found nothing
    // to remove. Don't bake — that would waste history budget on a no-op.
    if (bake.toW === bake.fromW && bake.toH === bake.fromH) {
      try { bake.bitmap.close(); } catch { /* ignore */ }
      showToast(t('trimNoChange'), { variant: 'info' });
      return;
    }

    // Snapshot the BEFORE state outside the update boundary so the history
    // entry captures the old typed arrays + nested objects by reference.
    const before = pickKeysForTrim(img);

    // Apply the bake. Replace source.bitmap (keeping the existing name +
    // thumbnail; the latter is regenerated by the queue auto-refresh path).
    update(s => {
      const target = s.images[id];
      if (!target) return;
      applyTrimBakeToState(target, bake);
    });

    const after = pickKeysForTrim(getState().images[id]);
    recordOp({
      label: mode === 'transparent' ? 'Trim transparent edges' : 'Trim background color',
      imageId: id,
      kind: 'transforms',
      before,
      after,
    });

    showToast(t('trimSuccess', {
      fromW: bake.fromW,
      fromH: bake.fromH,
      toW: bake.toW,
      toH: bake.toH,
    }), { variant: 'info' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trim failed:', err);
    showToast(t('trimRenderFailed'), { variant: 'error' });
  } finally {
    if (btnA) btnA.disabled = prevA;
    if (btnB) btnB.disabled = prevB;
  }
}

// Build a structuredClone-friendly snapshot of the keys we'll restore on
// undo. Typed arrays (chromakeyMask, bgMask) and ImageBitmap-like values
// pass through by reference — matches history.js's `pickKeys` behavior.
function pickKeysForTrim(img) {
  const out = Object.create(null);
  if (!img) return out;
  for (const k of KEYS_TRIM_BAKE) {
    out[k] = cloneTrimSnapshotValue(img[k]);
  }
  return out;
}

function cloneTrimSnapshotValue(v) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return v;
  if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) return v;
  // `source` holds an ImageBitmap inside; structuredClone would refuse it.
  // Shallow-clone the object so we keep the bitmap/blob/thumbnail refs but
  // get an independent container.
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); }
    catch { /* fall through */ }
  }
  // Fallback: shallow copy. Source contains primitives + Blob + ImageBitmap;
  // none need deep cloning to be undo-safe.
  if (Array.isArray(v)) return v.slice();
  const out = Object.create(null);
  for (const k of Object.keys(v)) out[k] = v[k];
  return out;
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// Pull state.transforms.resize into the panel DOM. Called whenever the active
// image changes, an undo/redo flips state, or another panel commits a change
// that effectively updates dimensions (crop, rotate). After syncing the DOM,
// we re-run refreshPendingResize so the Apply button reflects whether the
// DOM matches state (disabled when they're in sync, enabled otherwise).
function syncResizePanel() {
  if (!resizeEls) return;
  const img = getActiveImage();
  if (!img) {
    resizeEls.readout.textContent = t('resizeOutputEmpty');
    resizeEls.applyBtn.disabled = true;
    return;
  }

  const resize = img.transforms.resize;
  const focused = document.activeElement;

  // Only force-sync inputs the user isn't currently editing. We also bypass
  // the sync entirely while the user has any of the resize controls focused,
  // so undo/redo from elsewhere doesn't trample mid-edit values. (The Apply
  // button still re-evaluates below.)
  const userIsEditing =
    focused === resizeEls.modeSel ||
    focused === resizeEls.valueInput ||
    focused === resizeEls.heightInput;

  if (resize) {
    if (resizeEls.modeSel.value !== resize.mode && focused !== resizeEls.modeSel) {
      resizeEls.modeSel.value = resize.mode;
    }
    // Height + Lock are only meaningful in Exact mode (see readPendingResize
    // for the rationale).
    resizeEls.heightWrap.hidden = resize.mode !== 'exact';
    resizeEls.lockWrap.hidden = resize.mode !== 'exact';
    if (!userIsEditing && focused !== resizeEls.valueInput) {
      resizeEls.valueInput.value = String(resize.value ?? '');
    }
    if (!userIsEditing && focused !== resizeEls.heightInput && resize.mode === 'exact') {
      resizeEls.heightInput.value = String(resize.height ?? '');
    }
  } else if (!userIsEditing) {
    // No resize stored AND user isn't editing. Reset the panel to "free".
    // (If the user is mid-edit, leave their pending values alone — Apply
    // hasn't been clicked yet.)
    if (focused !== resizeEls.modeSel) resizeEls.modeSel.value = 'free';
    resizeEls.valueInput.value = '';
    resizeEls.heightInput.value = '';
    resizeEls.heightWrap.hidden = true;
    resizeEls.lockWrap.hidden = true;
  } else {
    // No resize in state, user is mid-edit — leave DOM alone. Just sync the
    // height/lock visibility against the dropdown so it stays consistent.
    const cur = resizeEls.modeSel.value;
    resizeEls.heightWrap.hidden = cur !== 'exact';
    resizeEls.lockWrap.hidden = cur !== 'exact';
  }

  // Make sure the Value row's label reflects whatever mode the dropdown ends
  // up on after the sync above ("Long side", "Width", "Percent", …).
  updateValueRowForMode(resizeEls.modeSel.value);

  refreshPendingResize();
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
  if (predictTimerId != null) {
    clearTimeout(predictTimerId);
    predictTimerId = null;
  }
  adjustPendingValues.clear();
  adjustPendingPreset = null;
  exportPendingQuality = null;
  predictRunSeq = 0;
  lastPredictKey = null;
  smallestInFlight = false;
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
  // PDF gets a dedicated aria label key (`exportFormatPdfAria`) rather than
  // the generic `exportFormatAria` interpolation so screen readers hear
  // "Export as PDF" instead of "Export as {label}".
  { id: 'pdf',  i18n: 'exportFormatPdf',  mime: 'application/pdf' },
];

// PDF page-size dropdown options. 'fit' is the default; named paper sizes
// follow the i18n keys. Order matches how Acrobat/Preview lists them.
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

let exportEls = null; // { root, formatBtns: Map<id, btn>, qualityRow, qualityInput, qualityReadout, filenameInput, filenameHelp, dimsReadout, predictedReadout, smallestBtn, downloadBtn }
let exportQualityRafHandle = null;
let exportPendingQuality = null;

// Predicted-encode debounce: 300ms after the last format/quality/state
// change before we run a real encode. Cancels in-flight encodes on new
// trigger so the user never sees stale values.
let predictTimerId = null;
let predictRunSeq = 0;
let lastPredictKey = null;
let smallestInFlight = false;
const PREDICT_DEBOUNCE_MS = 300;

// Track the active image we last applied the smart match-source default
// to. When the user switches to a different image AND hasn't explicitly
// locked a format chip this session, we recompute the smart default from
// the new image's source MIME so a PNG-imported picture gets PNG output
// while the JPEG sitting next to it gets JPEG. Sentinel undefined so the
// very first sync also fires (state.activeImageId starts at null).
let lastSmartFormatForId;

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
    // PDF gets a dedicated aria label (the generic interpolation reads odd
    // for an acronym format name); other formats reuse `exportFormatAria`.
    const ariaLabel = fmt.id === 'pdf' ? t('exportFormatPdfAria') : t('exportFormatAria', { label: fmtLabel });
    btn.setAttribute('aria-label', ariaLabel);
    btn.addEventListener('click', () => onFormatChange(fmt.id));
    formatRow.appendChild(btn);
    formatBtns.set(fmt.id, btn);
  }
  root.appendChild(formatRow);

  // --- WebP-over-PNG nudge ---
  // Appears only when PNG is the active format. Passive hint (no dismiss
  // button) — users who don't care can ignore it; the discovery moment is
  // when they're staring at the export panel anyway. Sits directly under
  // the chip row so the connection between "PNG" and "consider WebP" is
  // visually obvious.
  const formatHint = document.createElement('p');
  formatHint.className = 'export-format-hint';
  formatHint.textContent = t('exportFormatPngWebpHint');
  formatHint.hidden = true;
  root.appendChild(formatHint);

  // --- "Smallest size" preset button ---
  // Sits directly under the format chips so it reads as part of the same
  // group ("which format/quality should I pick?"). Clicking runs a small
  // format-comparison sweep and writes the winner into state.export.
  const smallestBtn = document.createElement('button');
  smallestBtn.type = 'button';
  smallestBtn.className = 'smallest-preset-btn';
  smallestBtn.textContent = t('exportSmallestPreset');
  smallestBtn.setAttribute('aria-label', t('exportSmallestPresetAria'));
  smallestBtn.addEventListener('click', onSmallestPreset);
  root.appendChild(smallestBtn);

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

  // --- PDF options block (visible only when format === 'pdf') ---
  // Wraps page size + orientation + margins + fit mode controls under a
  // single container so we can hide/show them together via the .hidden
  // attribute. Sits where the quality slider does — these are the controls
  // a PDF user actually needs to dial in.
  const pdfOptsRow = document.createElement('div');
  pdfOptsRow.className = 'pdf-opts-row';
  pdfOptsRow.hidden = true;

  // Page size dropdown.
  const pdfPageSizeLabel = document.createElement('label');
  pdfPageSizeLabel.className = 'pdf-pagesize-row';
  const pdfPageSizeSpan = document.createElement('span');
  pdfPageSizeSpan.textContent = t('pdfPageSize');
  pdfPageSizeLabel.appendChild(pdfPageSizeSpan);
  const pdfPageSizeSel = document.createElement('select');
  pdfPageSizeSel.className = 'pdf-pagesize-select';
  pdfPageSizeSel.setAttribute('aria-label', t('pdfPageSizeAria'));
  for (const ps of PDF_PAGE_SIZES) {
    const opt = document.createElement('option');
    opt.value = ps.id;
    opt.textContent = t(ps.i18n);
    pdfPageSizeSel.appendChild(opt);
  }
  pdfPageSizeLabel.appendChild(pdfPageSizeSel);
  pdfPageSizeSel.addEventListener('change', () => onPdfOptChange('pageSize', pdfPageSizeSel.value));
  pdfOptsRow.appendChild(pdfPageSizeLabel);

  // Orientation dropdown.
  const pdfOrientLabel = document.createElement('label');
  pdfOrientLabel.className = 'pdf-orientation-row';
  const pdfOrientSpan = document.createElement('span');
  pdfOrientSpan.textContent = t('pdfOrientation');
  pdfOrientLabel.appendChild(pdfOrientSpan);
  const pdfOrientSel = document.createElement('select');
  pdfOrientSel.className = 'pdf-orientation-select';
  pdfOrientSel.setAttribute('aria-label', t('pdfOrientationAria'));
  for (const o of PDF_ORIENTATIONS) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = t(o.i18n);
    pdfOrientSel.appendChild(opt);
  }
  pdfOrientLabel.appendChild(pdfOrientSel);
  pdfOrientSel.addEventListener('change', () => onPdfOptChange('orientation', pdfOrientSel.value));
  pdfOptsRow.appendChild(pdfOrientLabel);

  // Margins number input.
  const pdfMarginLabel = document.createElement('label');
  pdfMarginLabel.className = 'pdf-margin-row';
  const pdfMarginSpan = document.createElement('span');
  pdfMarginSpan.textContent = t('pdfMargins');
  pdfMarginLabel.appendChild(pdfMarginSpan);
  const pdfMarginInput = document.createElement('input');
  pdfMarginInput.type = 'number';
  pdfMarginInput.className = 'pdf-margin-input';
  pdfMarginInput.min = '0';
  pdfMarginInput.max = '72';
  pdfMarginInput.step = '1';
  pdfMarginInput.value = '0';
  pdfMarginInput.setAttribute('aria-label', t('pdfMarginsAria'));
  pdfMarginLabel.appendChild(pdfMarginInput);
  pdfMarginInput.addEventListener('input', () => {
    const v = Number(pdfMarginInput.value);
    if (Number.isFinite(v)) onPdfOptChange('margins', Math.max(0, Math.min(72, v)));
  });
  pdfOptsRow.appendChild(pdfMarginLabel);

  // Fit mode dropdown (only meaningful for non-'fit' page sizes).
  const pdfFitLabel = document.createElement('label');
  pdfFitLabel.className = 'pdf-fitmode-row';
  const pdfFitSpan = document.createElement('span');
  pdfFitSpan.textContent = t('pdfFitMode');
  pdfFitLabel.appendChild(pdfFitSpan);
  const pdfFitSel = document.createElement('select');
  pdfFitSel.className = 'pdf-fitmode-select';
  pdfFitSel.setAttribute('aria-label', t('pdfFitModeAria'));
  for (const f of PDF_FIT_MODES) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = t(f.i18n);
    pdfFitSel.appendChild(opt);
  }
  pdfFitLabel.appendChild(pdfFitSel);
  pdfFitSel.addEventListener('change', () => onPdfOptChange('fitMode', pdfFitSel.value));
  pdfOptsRow.appendChild(pdfFitLabel);

  root.appendChild(pdfOptsRow);

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

  // --- Predicted size readout (live, debounced 300ms) ---
  // Shows the actual bytes a Download would produce at the current settings.
  // Sits below the dims so the two readouts pair as "what" + "how big".
  const predictedReadout = document.createElement('div');
  predictedReadout.className = 'predicted-size';
  predictedReadout.setAttribute('aria-live', 'polite');
  predictedReadout.textContent = t('exportPredictedEstimating');
  root.appendChild(predictedReadout);

  // --- Download button ---
  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'download-btn';
  downloadBtn.textContent = t('exportDownload');
  downloadBtn.setAttribute('aria-label', t('exportDownloadAria'));
  downloadBtn.addEventListener('click', onDownload);
  root.appendChild(downloadBtn);

  // --- Metadata toggle ----------------------------------------------------
  // v1.1.2: opt-in metadata preservation. Default is "strip" (Canvas
  // re-encoding drops EXIF/XMP/GPS as a side-effect, matching the privacy-
  // forward stance the site is built on). Users who explicitly WANT to
  // keep GPS / camera info on family JPEGs can uncheck this box. When
  // unchecked AND source + output are both JPEG, the exporter splices the
  // source's APP1/Exif segment back into the Canvas-encoded blob (see
  // exporter.js#maybePreserveExif). For other combinations (PNG output,
  // HEIC source, etc.) the export still strips and we show a small hint.
  const stripRow = document.createElement('label');
  stripRow.className = 'exif-status';
  const stripInput = document.createElement('input');
  stripInput.type = 'checkbox';
  stripInput.className = 'strip-metadata';
  stripInput.checked = true;
  stripInput.addEventListener('change', () => {
    update(s => { s.export.stripMetadata = !!stripInput.checked; });
  });
  stripRow.appendChild(stripInput);
  const stripLabel = document.createElement('span');
  stripLabel.className = 'exif-label';
  stripLabel.textContent = t('stripMetadataLabel');
  stripLabel.setAttribute('title', t('exifTooltip'));
  stripRow.appendChild(stripLabel);
  root.appendChild(stripRow);

  // "View source metadata" button (v1.2). Opens a modal that lists the
  // EXIF/XMP/GPS blocks found in the source blob + whether each will be
  // stripped or kept based on the toggle above. Pure read-only audit —
  // the modal doesn't mutate state.
  const viewMetadataBtn = document.createElement('button');
  viewMetadataBtn.type = 'button';
  viewMetadataBtn.className = 'view-metadata-btn';
  viewMetadataBtn.textContent = t('viewMetadataBtn');
  viewMetadataBtn.setAttribute('aria-label', t('viewMetadataBtn'));
  viewMetadataBtn.addEventListener('click', onViewMetadata);
  root.appendChild(viewMetadataBtn);

  // Hint that appears when stripping is OFF — explains the JPEG-only
  // limitation honestly.
  const stripHint = document.createElement('p');
  stripHint.className = 'strip-metadata-hint';
  stripHint.textContent = t('stripMetadataHint');
  stripHint.hidden = true;
  root.appendChild(stripHint);

  // --- Target file size subsection (v1.3 Feature 11) --------------------
  // Collapsible <details> so the bisection UI doesn't crowd the panel for
  // users who only want the standard quality slider. State lives at
  // state.ui.targetSize and persists to localStorage on every change.
  const targetSizeEls = buildTargetSizeSection({
    apply: onApplyTargetSize,
    applyLabel: t('targetSizeApply'),
    rowClass: 'target-size-row',
    sectionClass: 'editor-target-size-section',
  });
  root.appendChild(targetSizeEls.section);

  // --- Upload-ready preset subsection (v1.3 Feature 9) ------------------
  // Same collapsible pattern as the target-size section. One-click "resize
  // + compress + strip EXIF + rename" for the common social/web prep flow.
  const uploadReadyEls = buildUploadReadySection({
    apply: onApplyUploadReady,
    applyLabel: t('uploadReadyApply'),
    sectionClass: 'editor-upload-ready-section',
  });
  root.appendChild(uploadReadyEls.section);

  exportPanelBody.replaceChildren(root);
  exportEls = {
    root, formatBtns, formatHint, smallestBtn, qualityRow, qualityInput, qualityReadout,
    filenameInput, filenameHelp, dimsReadout, predictedReadout, downloadBtn,
    stripRow, stripInput, stripLabel, stripHint,
    // PDF options
    pdfOptsRow, pdfPageSizeSel, pdfOrientSel, pdfMarginInput, pdfFitSel, pdfFitLabel,
    // Target file size (Feature 11)
    targetSize: targetSizeEls,
    // Upload-ready preset (Feature 9)
    uploadReady: uploadReadyEls,
  };
  syncExportPanel();
}

// --------------------------------------------------------------------------
// Target file size (Feature 11) — UI builder shared by the editor's export
// panel and the queue's batch panel. Same DOM shape both places: a section
// with mode chips, a preset chip row OR a custom number+unit row, an
// auto-resize checkbox, a format toggle, and an apply button.
//
// `apply` is the click handler for the Apply button. `applyLabelKey` lets
// the caller swap the singular/batch labels. `rowClass` is the CSS hook
// for layout (kept identical across both panels so style.css owns it).
//
// Returns an object holding the section root + every input ref so the
// caller can drive sync from state via `syncTargetSizeSection(els)`.
// --------------------------------------------------------------------------

export function buildTargetSizeSection({ apply, applyLabel, rowClass, sectionClass }) {
  const section = document.createElement('details');
  section.className = `target-size-section ${sectionClass}`;
  section.open = false;
  const summary = document.createElement('summary');
  summary.textContent = t('targetSizeTitle');
  section.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'target-size-body';
  section.appendChild(body);

  // Mode chips (Preset / Custom). Two-button radio group with
  // pressed + bold + underline styling so the active state isn't color-only.
  const modeRow = document.createElement('div');
  modeRow.className = 'target-size-mode-chips';
  modeRow.setAttribute('role', 'group');
  modeRow.setAttribute('aria-label', t('targetSizeTitle'));
  const presetModeBtn = makeChip(t('targetSizeModePreset'), 'target-size-mode-chip target-size-mode-preset');
  const customModeBtn = makeChip(t('targetSizeModeCustom'), 'target-size-mode-chip target-size-mode-custom');
  presetModeBtn.addEventListener('click', () => setTargetSize({ mode: 'preset' }));
  customModeBtn.addEventListener('click', () => setTargetSize({ mode: 'custom' }));
  modeRow.append(presetModeBtn, customModeBtn);
  body.appendChild(modeRow);

  // Preset chip row — populated from TARGET_SIZE_PRESETS.
  const presetRow = document.createElement('div');
  presetRow.className = `target-size-preset-chips ${rowClass}`;
  const presetBtns = new Map();
  for (const preset of TARGET_SIZE_PRESETS) {
    const btn = makeChip(t(preset.labelKey), 'target-size-preset-chip');
    btn.dataset.presetId = preset.id;
    btn.addEventListener('click', () => setTargetSize({ mode: 'preset', presetId: preset.id }));
    presetRow.appendChild(btn);
    presetBtns.set(preset.id, btn);
  }
  body.appendChild(presetRow);

  // Custom value + unit row.
  const customRow = document.createElement('div');
  customRow.className = `target-size-custom-row ${rowClass}`;
  const customLbl = document.createElement('span');
  customLbl.className = 'target-size-custom-label';
  customLbl.textContent = t('targetSizeCustomLabel');
  customRow.appendChild(customLbl);
  const customInput = document.createElement('input');
  customInput.type = 'number';
  customInput.min = '0.1';
  customInput.step = '0.1';
  customInput.className = 'target-size-custom-input';
  customInput.setAttribute('aria-label', t('targetSizeCustomLabel'));
  customRow.appendChild(customInput);
  const unitToggle = document.createElement('div');
  unitToggle.className = 'target-size-unit-toggle';
  unitToggle.setAttribute('role', 'group');
  const mbBtn = makeChip('MB', 'target-size-unit-chip target-size-unit-mb');
  const kbBtn = makeChip('KB', 'target-size-unit-chip target-size-unit-kb');
  mbBtn.addEventListener('click', () => setTargetSize({ customUnit: 'MB' }));
  kbBtn.addEventListener('click', () => setTargetSize({ customUnit: 'KB' }));
  unitToggle.append(mbBtn, kbBtn);
  customRow.appendChild(unitToggle);

  // Inline validation hint — shown only in custom mode when the typed value
  // doesn't resolve to a positive number. Sits beneath the input so it
  // doesn't shift layout when it appears.
  const customHint = document.createElement('p');
  customHint.className = 'target-size-custom-hint';
  customHint.textContent = t('targetSizeInvalidCustom');
  customHint.hidden = true;
  body.appendChild(customHint);

  customInput.addEventListener('input', () => {
    const num = Number(customInput.value);
    // Allow the field to be temporarily empty during typing — don't clobber
    // state with NaN. The apply button stays disabled until value > 0.
    if (Number.isFinite(num) && num > 0) {
      setTargetSize({ customValue: num });
    } else {
      // Still call setTargetSize so the apply button gets re-disabled.
      setTargetSize({ customValue: 0 });
    }
  });
  body.appendChild(customRow);

  // Auto-resize checkbox. Default ON.
  const autoRow = document.createElement('label');
  autoRow.className = 'target-size-auto-row';
  const autoInput = document.createElement('input');
  autoInput.type = 'checkbox';
  autoInput.className = 'target-size-auto';
  autoInput.addEventListener('change', () => {
    setTargetSize({ autoResize: !!autoInput.checked });
  });
  autoRow.appendChild(autoInput);
  const autoLbl = document.createElement('span');
  autoLbl.textContent = t('targetSizeAutoResize');
  autoRow.appendChild(autoLbl);
  body.appendChild(autoRow);

  // Format toggle (JPEG / WebP). PNG is excluded because the bisector has
  // no quality knob on a lossless format.
  const formatRow = document.createElement('div');
  formatRow.className = `target-size-format-row ${rowClass}`;
  const formatLbl = document.createElement('span');
  formatLbl.className = 'target-size-format-label';
  formatLbl.textContent = t('targetSizeFormatLabel');
  formatRow.appendChild(formatLbl);
  const formatGroup = document.createElement('div');
  formatGroup.className = 'target-size-format-group';
  formatGroup.setAttribute('role', 'group');
  const jpegBtn = makeChip('JPEG', 'target-size-format-chip target-size-format-jpeg');
  const webpBtn = makeChip('WebP', 'target-size-format-chip target-size-format-webp');
  jpegBtn.addEventListener('click', () => setTargetSize({ format: 'jpeg' }));
  webpBtn.addEventListener('click', () => setTargetSize({ format: 'webp' }));
  formatGroup.append(jpegBtn, webpBtn);
  formatRow.appendChild(formatGroup);
  body.appendChild(formatRow);

  // Apply button. Disabled until a valid byte target resolves AND (in the
  // editor case) there's an active image — sync below handles the disabled
  // state on every state change.
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'target-size-apply';
  applyBtn.textContent = applyLabel;
  applyBtn.addEventListener('click', () => {
    apply(applyBtn);
  });
  body.appendChild(applyBtn);

  return {
    section, body,
    presetModeBtn, customModeBtn,
    presetRow, presetBtns,
    customRow, customInput, customHint, mbBtn, kbBtn,
    autoInput,
    jpegBtn, webpBtn,
    applyBtn,
  };
}

function makeChip(label, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

// Centralized mutator + persist. Every input handler in the target-size
// section funnels through here so we have ONE place that bumps state and
// writes localStorage.
function setTargetSize(patch) {
  update(s => {
    if (!s.ui.targetSize) s.ui.targetSize = {};
    Object.assign(s.ui.targetSize, patch);
    // If the user typed into the custom field, snap mode to 'custom' so the
    // resolver picks it up. Same with picking a preset chip → mode 'preset'.
    if (Object.prototype.hasOwnProperty.call(patch, 'customValue')
        || Object.prototype.hasOwnProperty.call(patch, 'customUnit')) {
      s.ui.targetSize.mode = 'custom';
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'presetId')) {
      s.ui.targetSize.mode = 'preset';
    }
  });
  persistTargetSize();
}

/**
 * Apply the current state.ui.targetSize to the given UI bundle (the object
 * returned by buildTargetSizeSection). Drives chip active states, custom
 * row visibility, the autoResize/format inputs, and the Apply button's
 * disabled state.
 *
 * Pass `applyEnabledExtra` to AND-gate the Apply button against additional
 * UI-specific conditions (e.g. "active image exists" in the editor).
 */
export function syncTargetSizeSection(els, applyEnabledExtra = true) {
  if (!els) return;
  const ts = getState().ui.targetSize || {};
  const mode = ts.mode === 'custom' ? 'custom' : 'preset';

  // Mode chips
  setChipActive(els.presetModeBtn, mode === 'preset');
  setChipActive(els.customModeBtn, mode === 'custom');

  // Preset chips visible only in preset mode.
  els.presetRow.hidden = mode !== 'preset';
  for (const [id, btn] of els.presetBtns) {
    setChipActive(btn, mode === 'preset' && id === ts.presetId);
  }

  // Custom row visible only in custom mode.
  els.customRow.hidden = mode !== 'custom';
  if (mode === 'custom' && document.activeElement !== els.customInput) {
    const v = Number(ts.customValue);
    els.customInput.value = Number.isFinite(v) && v > 0 ? String(v) : '';
  }
  setChipActive(els.mbBtn, ts.customUnit !== 'KB');
  setChipActive(els.kbBtn, ts.customUnit === 'KB');
  // Inline hint visible when custom mode is selected AND the typed value
  // doesn't resolve to a positive number. We re-use the resolver below.
  if (els.customHint) {
    const cvNum = Number(ts.customValue);
    const cvBad = !Number.isFinite(cvNum) || cvNum <= 0;
    els.customHint.hidden = !(mode === 'custom' && cvBad);
  }

  // Auto-resize checkbox — default ON if unset.
  if (document.activeElement !== els.autoInput) {
    els.autoInput.checked = ts.autoResize !== false;
  }

  // Format chips
  setChipActive(els.jpegBtn, ts.format !== 'webp');
  setChipActive(els.webpBtn, ts.format === 'webp');

  // Apply button enabled iff a valid target resolves AND any extra gate
  // (e.g. activeImage) is true.
  const bytes = getActiveTargetBytes(ts);
  els.applyBtn.disabled = !(bytes && bytes > 0 && applyEnabledExtra);
}

// Chip active state uses BOTH a class and aria-pressed. The CSS pairs the
// active class with a stronger border + inset shadow so the cue isn't
// color-only (Dan is colorblind — see CLAUDE.md).
function setChipActive(btn, active) {
  if (!btn) return;
  btn.classList.toggle('is-active', !!active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

// Editor-side handler for the Apply button. Wraps exportToTargetSize with
// a sticky "Bisecting…" toast and translates the result into a success or
// "couldn't fit" toast. The exporter triggers the actual file download.
async function onApplyTargetSize(applyBtn) {
  const img = getActiveImage();
  if (!img) return;
  const ts = getState().ui.targetSize || {};
  const targetBytes = getActiveTargetBytes(ts);
  if (!targetBytes) return;

  const ctx = getExportContext();
  if (!ctx.lifecycle || !ctx.caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return;
  }

  // Disable the button + sticky progress toast for the (potentially
  // multi-second) bisection. We track inFlight via the button's disabled
  // state — exportToTargetSize is fully async-safe to invoke once at a time
  // per image, but double-firing produces duplicate downloads.
  applyBtn.disabled = true;
  const dismissProgress = showToast(t('targetSizeWorking'), { variant: 'info', duration: 0 });

  let result;
  try {
    result = await exportToTargetSize(img.id, {
      targetBytes,
      autoResize: ts.autoResize !== false,
      format: ts.format === 'webp' ? 'webp' : 'jpeg',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('onApplyTargetSize:', err);
    dismissProgress();
    showToast(t('exportGenericFailed'), { variant: 'error' });
    applyBtn.disabled = false;
    return;
  }
  dismissProgress();

  if (!result || !result.blob) {
    showToast(t('exportGenericFailed'), { variant: 'error' });
  } else if (result.fits) {
    showToast(t('targetSizeSuccess', {
      filename: result.filename,
      size: formatBytes(result.blob.size),
      quality: result.quality.toFixed(2),
    }), { variant: 'info' });
  } else {
    showToast(t('targetSizeUnreachable', { size: formatBytes(result.blob.size) }), { variant: 'warn' });
  }
  applyBtn.disabled = false;
}

// --------------------------------------------------------------------------
// Upload-ready preset (v1.3 Feature 9) — UI builder shared by the editor's
// export panel and the queue's batch panel. Same shape both places: a
// collapsible section with longEdge / format / quality / stripExif /
// filename inputs + an apply button.
//
// State lives at state.ui.uploadReady. Every mutation funnels through
// setUploadReady() which calls persistUploadReady() so the user's last-used
// config restores across reloads.
//
// Apply button label differs (singular vs. batch) and the click handler is
// caller-supplied so the editor wires to per-image download and the queue
// wires to ZIP build.
// --------------------------------------------------------------------------
export function buildUploadReadySection({ apply, applyLabel, sectionClass }) {
  const section = document.createElement('details');
  section.className = `upload-ready-section ${sectionClass || ''}`.trim();
  section.open = false;
  const summary = document.createElement('summary');
  summary.textContent = t('uploadReadyTitle');
  section.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'upload-ready-body';
  section.appendChild(body);

  // Long-edge input.
  const longEdgeRow = document.createElement('label');
  longEdgeRow.className = 'upload-ready-row upload-ready-longedge-row';
  const longEdgeLbl = document.createElement('span');
  longEdgeLbl.className = 'upload-ready-label';
  longEdgeLbl.textContent = t('uploadReadyLongEdge');
  longEdgeRow.appendChild(longEdgeLbl);
  const longEdgeInput = document.createElement('input');
  longEdgeInput.type = 'number';
  longEdgeInput.className = 'upload-ready-longedge';
  longEdgeInput.min = '64';
  longEdgeInput.max = '16384';
  longEdgeInput.step = '1';
  longEdgeInput.setAttribute('aria-label', t('uploadReadyLongEdge'));
  longEdgeRow.appendChild(longEdgeInput);
  longEdgeInput.addEventListener('input', () => {
    const v = Number(longEdgeInput.value);
    if (Number.isFinite(v) && v >= 64 && v <= 16384) {
      setUploadReady({ longEdge: Math.round(v) });
    }
  });
  body.appendChild(longEdgeRow);

  // Format chips (JPEG / WebP / PNG).
  const formatRow = document.createElement('div');
  formatRow.className = 'upload-ready-row upload-ready-format-row';
  const formatLbl = document.createElement('span');
  formatLbl.className = 'upload-ready-label';
  formatLbl.textContent = t('uploadReadyFormat');
  formatRow.appendChild(formatLbl);
  const formatGroup = document.createElement('div');
  formatGroup.className = 'upload-ready-format-group';
  formatGroup.setAttribute('role', 'group');
  const jpegBtn = makeUploadChip('JPEG', 'upload-ready-format-chip upload-ready-format-jpeg');
  const webpBtn = makeUploadChip('WebP', 'upload-ready-format-chip upload-ready-format-webp');
  const pngBtn = makeUploadChip('PNG', 'upload-ready-format-chip upload-ready-format-png');
  jpegBtn.addEventListener('click', () => setUploadReady({ format: 'jpeg' }));
  webpBtn.addEventListener('click', () => setUploadReady({ format: 'webp' }));
  pngBtn.addEventListener('click', () => setUploadReady({ format: 'png' }));
  formatGroup.append(jpegBtn, webpBtn, pngBtn);
  formatRow.appendChild(formatGroup);
  body.appendChild(formatRow);

  // Quality slider (hidden for PNG — lossless).
  const qualityRow = document.createElement('label');
  qualityRow.className = 'upload-ready-row upload-ready-quality-row';
  const qualityLbl = document.createElement('span');
  qualityLbl.className = 'upload-ready-label';
  qualityLbl.textContent = t('uploadReadyQuality');
  qualityRow.appendChild(qualityLbl);
  const qualityInput = document.createElement('input');
  qualityInput.type = 'range';
  qualityInput.className = 'upload-ready-quality';
  qualityInput.min = '0.20';
  qualityInput.max = '1.00';
  qualityInput.step = '0.01';
  qualityInput.setAttribute('aria-label', t('uploadReadyQuality'));
  qualityRow.appendChild(qualityInput);
  const qualityReadout = document.createElement('span');
  qualityReadout.className = 'upload-ready-quality-readout';
  qualityReadout.setAttribute('aria-live', 'polite');
  qualityRow.appendChild(qualityReadout);
  qualityInput.addEventListener('input', () => {
    const v = Number(qualityInput.value);
    if (Number.isFinite(v) && v >= 0.20 && v <= 1.00) {
      qualityReadout.textContent = String(Math.round(v * 100));
      setUploadReady({ quality: v });
    }
  });
  body.appendChild(qualityRow);

  // Strip-EXIF checkbox.
  const stripRow = document.createElement('label');
  stripRow.className = 'upload-ready-row upload-ready-strip-row';
  const stripInput = document.createElement('input');
  stripInput.type = 'checkbox';
  stripInput.className = 'upload-ready-strip';
  stripInput.addEventListener('change', () => {
    setUploadReady({ stripExif: !!stripInput.checked });
  });
  stripRow.appendChild(stripInput);
  const stripLbl = document.createElement('span');
  stripLbl.textContent = t('uploadReadyStripExif');
  stripRow.appendChild(stripLbl);
  body.appendChild(stripRow);

  // Filename template + tokens hint.
  const filenameRow = document.createElement('label');
  filenameRow.className = 'upload-ready-row upload-ready-filename-row';
  const filenameLbl = document.createElement('span');
  filenameLbl.className = 'upload-ready-label';
  filenameLbl.textContent = t('uploadReadyFilename');
  filenameRow.appendChild(filenameLbl);
  const filenameInput = document.createElement('input');
  filenameInput.type = 'text';
  filenameInput.className = 'upload-ready-filename';
  filenameInput.spellcheck = false;
  filenameInput.autocomplete = 'off';
  filenameInput.setAttribute('aria-label', t('uploadReadyFilename'));
  // Reuse the same tooltip-style hint so the user can hover the field to
  // see the supported tokens. The colorblind-friendly cue is the "?" label
  // appended after the title attr (also a tooltip on hover).
  filenameInput.setAttribute('title', t('uploadReadyFilenameHint'));
  filenameRow.appendChild(filenameInput);
  filenameInput.addEventListener('input', () => {
    const v = String(filenameInput.value || '');
    setUploadReady({ filenameTemplate: v.length > 0 ? v : '{base}-edited' });
  });
  body.appendChild(filenameRow);

  const filenameHelp = document.createElement('p');
  filenameHelp.className = 'upload-ready-filename-help';
  // t() without a vars object skips substitution so the literal {base} etc.
  // survive — these are template tokens, not i18n variables.
  filenameHelp.textContent = t('uploadReadyFilenameHint');
  body.appendChild(filenameHelp);

  // Apply button.
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'upload-ready-apply';
  applyBtn.textContent = applyLabel;
  applyBtn.addEventListener('click', () => apply(applyBtn));
  body.appendChild(applyBtn);

  return {
    section, body,
    longEdgeInput,
    formatGroup, jpegBtn, webpBtn, pngBtn,
    qualityRow, qualityInput, qualityReadout,
    stripInput,
    filenameInput,
    applyBtn,
  };
}

function makeUploadChip(label, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

// Centralized mutator + persist for the upload-ready slice. Every input
// handler funnels through here so we have ONE place that bumps state and
// writes localStorage.
function setUploadReady(patch) {
  update(s => {
    if (!s.ui.uploadReady) s.ui.uploadReady = {};
    Object.assign(s.ui.uploadReady, patch);
  });
  persistUploadReady();
}

/**
 * Apply state.ui.uploadReady to the given UI bundle (the object returned by
 * buildUploadReadySection). Drives chip active states, quality-row visibility,
 * and the Apply button's disabled state.
 *
 * Pass `applyEnabledExtra` to AND-gate the Apply button against UI-specific
 * conditions (e.g. "active image exists" in the editor, "queue has images"
 * in the batch panel). Pass false to keep the button disabled (in-flight).
 */
export function syncUploadReadySection(els, applyEnabledExtra = true) {
  if (!els) return;
  const ur = (getState().ui && getState().ui.uploadReady) || {};
  const longEdge = Number.isFinite(ur.longEdge) ? ur.longEdge : 1920;
  const format = (ur.format === 'png' || ur.format === 'webp') ? ur.format : 'jpeg';
  const quality = Number.isFinite(ur.quality) ? ur.quality : 0.85;
  const stripExif = ur.stripExif !== false;
  const filenameTemplate = (typeof ur.filenameTemplate === 'string' && ur.filenameTemplate.length > 0)
    ? ur.filenameTemplate
    : '{base}-edited';

  // Long-edge input — don't clobber while user is typing.
  if (document.activeElement !== els.longEdgeInput) {
    els.longEdgeInput.value = String(longEdge);
  }
  // Format chips.
  setChipActive(els.jpegBtn, format === 'jpeg');
  setChipActive(els.webpBtn, format === 'webp');
  setChipActive(els.pngBtn, format === 'png');
  // Quality slider — hidden when PNG (lossless).
  els.qualityRow.hidden = format === 'png';
  if (format !== 'png' && document.activeElement !== els.qualityInput) {
    els.qualityInput.value = String(quality);
    els.qualityReadout.textContent = String(Math.round(quality * 100));
  }
  // Strip-EXIF checkbox.
  if (document.activeElement !== els.stripInput) {
    els.stripInput.checked = stripExif;
  }
  // Filename template — don't clobber while typing.
  if (document.activeElement !== els.filenameInput) {
    els.filenameInput.value = filenameTemplate;
  }
  // Apply button.
  els.applyBtn.disabled = !applyEnabledExtra;
}

// Editor-side handler for "Apply preset & download". Wraps
// applyUploadReadyPreset with a sticky working toast and translates the
// result into a success or failure toast.
async function onApplyUploadReady(applyBtn) {
  const img = getActiveImage();
  if (!img) return;
  const ur = getState().ui.uploadReady || {};
  const ctx = getExportContext();
  if (!ctx.lifecycle || !ctx.caps) {
    showToast(t('exportNotReady'), { variant: 'error' });
    return;
  }
  applyBtn.disabled = true;
  // Sticky 1/1 progress toast — keeps UX consistent with batch progress
  // even though there's only one image.
  const dismiss = showToast(
    t('uploadReadyWorking', { done: 0, total: 1 }),
    { variant: 'info', duration: 0 },
  );
  let result;
  try {
    result = await applyUploadReadyPreset([img.id], {
      longEdge: ur.longEdge,
      format: ur.format,
      quality: ur.quality,
      stripExif: ur.stripExif !== false,
      filenameTemplate: ur.filenameTemplate,
    }, { lifecycle: ctx.lifecycle, caps: ctx.caps });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('onApplyUploadReady:', err);
    try { dismiss(); } catch { /* ignore */ }
    showToast(t('uploadReadyFailed', { reason: err && err.message ? err.message : String(err) }), { variant: 'error' });
    applyBtn.disabled = false;
    return;
  }
  try { dismiss(); } catch { /* ignore */ }
  if (!result || result.exported === 0) {
    showToast(t('uploadReadyFailed', { reason: t('exportGenericFailed') }), { variant: 'error' });
  } else {
    showToast(t('uploadReadySuccess', {
      filename: result.downloadedFilename || '',
      size: formatBytes(result.blobSize || 0),
    }), { variant: 'info' });
  }
  applyBtn.disabled = false;
}

function onFormatChange(format) {
  // Any explicit chip click locks the user's choice for the rest of the
  // session — subsequent active-image switches won't override it via the
  // smart default. The flag is NOT persisted (each new session is a fresh
  // chance for the smart default to do its thing).
  update(s => {
    s.export.format = format;
    s.export._userFormatLocked = true;
  });
}

function onPdfOptChange(key, value) {
  update(s => {
    if (!s.export.pdf) s.export.pdf = { pageSize: 'fit', orientation: 'auto', margins: undefined, fitMode: 'contain' };
    s.export.pdf[key] = value;
  });
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
  const s = getState();
  // PDF gets its own pipeline (jsPDF + image embed). The predict cache only
  // applies to the raw-format encoders, so we don't pass predictKey for PDF.
  if ((s.export && s.export.format) === 'pdf') {
    exportSinglePdf(img.id).catch(err => {
      // eslint-disable-next-line no-console
      console.error('Download button (PDF):', err);
    });
    return;
  }
  // Pass the current predict-cache key so exporter can reuse the encoded
  // bytes from the panel's predict pass (avoids re-encoding ~50-300ms on
  // typical photos).
  const predictKey = lastPredictKey;
  // Fire-and-forget; exporter shows toasts internally on success/failure.
  exportSingle(img.id, { predictKey }).catch(err => {
    // exportSingle catches its own errors, but guard against unexpected throws.
    // eslint-disable-next-line no-console
    console.error('Download button:', err);
  });
}

// (Pre-v1.1.2 this file housed onVerifyExif — a "Verify last export"
// button that inspected the most recent export for leaked EXIF/XMP/GPS
// and toasted the result. We removed it because the framing made the
// site appear to retain export bytes after the user had downloaded them,
// which read as a privacy contradiction. The privacy claim is now stated
// in the privacy panel + verifiable in DevTools → Network rather than
// surfaced as a one-click "verify what you just downloaded" affordance.)

// v1.2 Feature 2: source-metadata audit modal. Opens a <dialog> listing
// the EXIF / XMP / GPS blocks found in the source blob + per-tag indicator
// for "Will be stripped on export" / "Will be kept". Read-only — the modal
// does NOT mutate state; the user controls the strip toggle separately.
//
// We only show CATEGORIES (EXIF / XMP / GPS) here, not individual decoded
// tag values. Decoding TIFF entries to human-readable values (camera Make,
// GPSLatitude, etc.) is multi-day work for a full IFD walker; the v1.2
// minimum is the privacy-audit story ("this image has GPS — here's what
// will happen to it on export"). A richer "view by tag name" UI can land
// as a v1.3 follow-up if anyone asks.
async function onViewMetadata() {
  const img = getActiveImage();
  if (!img || !img.source || !img.source.blob) {
    showToast(t('exportNoImage'), { variant: 'warn' });
    return;
  }
  let report;
  try {
    report = await hasMetadata(img.source.blob);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('onViewMetadata: hasMetadata failed', err);
    showToast(t('exportGenericFailed'), { variant: 'error' });
    return;
  }
  openMetadataDialog(report);
}

function openMetadataDialog(report) {
  // Reuse-or-create a dialog. We don't cache across calls — each open
  // rebuilds the content so the report always reflects the current image
  // and the latest strip setting.
  const existing = document.getElementById('metadata-audit-dialog');
  if (existing) try { existing.close(); existing.remove(); } catch { /* ignore */ }

  const dialog = document.createElement('dialog');
  dialog.id = 'metadata-audit-dialog';
  dialog.className = 'metadata-audit-dialog';
  dialog.setAttribute('aria-label', t('viewMetadataTitle'));

  const stripActive = (getState().export || {}).stripMetadata !== false;
  const actionWord = stripActive ? t('metadataActionStripped') : t('metadataActionKept');

  // Build the audit row list. Each "category" present in the report gets a
  // row; tags array is shown as a small detail list under each.
  const rows = [];
  if (report.format && report.format !== 'unknown') {
    rows.push({ key: t('metadataFormat'), value: report.format.toUpperCase(), action: null });
  }
  if (report.exif) {
    rows.push({ key: t('metadataExifFound'), value: t('metadataExifFoundDesc'), action: actionWord });
  }
  if (report.gps) {
    // GPS is the most privacy-sensitive — make it visually distinct via
    // a class on the row.
    rows.push({ key: t('metadataGpsFound'), value: t('metadataGpsFoundDesc'), action: actionWord, severity: 'high' });
  }
  if (report.xmp) {
    rows.push({ key: t('metadataXmpFound'), value: t('metadataXmpFoundDesc'), action: actionWord });
  }
  if (report.tags && report.tags.length > 0) {
    rows.push({ key: t('metadataRawTags'), value: report.tags.join(', '), action: null });
  }
  if (rows.length === 1 && rows[0].key === t('metadataFormat')) {
    // Only the format row — no actual metadata.
    rows.push({ key: t('metadataNoneFound'), value: t('metadataNoneFoundDesc'), action: null });
  }

  // Render the dialog. Content is built from i18n-safe strings + the
  // report's tag names (which come from our own parser, never from user
  // input), so innerHTML is safe to use for the structured layout.
  const headerHtml = `
    <header class="metadata-audit-header">
      <h2>${escapeHtml(t('viewMetadataTitle'))}</h2>
      <button type="button" class="dialog-close" data-close aria-label="${escapeHtml(t('close'))}">×</button>
    </header>
    <p class="metadata-audit-lead">${escapeHtml(t('viewMetadataLead'))}</p>
  `;
  const rowsHtml = rows.map(r => `
    <tr${r.severity === 'high' ? ' class="severity-high"' : ''}>
      <th>${escapeHtml(r.key)}</th>
      <td>${escapeHtml(r.value)}</td>
      <td class="metadata-action">${r.action ? escapeHtml(r.action) : ''}</td>
    </tr>
  `).join('');
  const tableHtml = `
    <table class="metadata-audit-table">
      <thead>
        <tr>
          <th>${escapeHtml(t('metadataField'))}</th>
          <th>${escapeHtml(t('metadataValue'))}</th>
          <th>${escapeHtml(t('metadataOnExport'))}</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
  const footerHtml = `
    <footer class="metadata-audit-footer">
      <p class="metadata-audit-footnote">${escapeHtml(t('viewMetadataFootnote'))}</p>
    </footer>
  `;
  dialog.innerHTML = headerHtml + tableHtml + footerHtml;
  document.body.appendChild(dialog);

  // Close on backdrop or × click.
  dialog.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) { dialog.close(); return; }
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    try { dialog.remove(); } catch { /* ignore */ }
  });
  try { dialog.showModal(); }
  catch { dialog.setAttribute('open', ''); }
}

// "Smallest size" preset: run the format-comparison sweep, pick the winner,
// write into state.export, and show a toast summarizing the choice. We
// disable the button + show a spinner-ish label while the sweep runs (8+
// encodes can be ~1s on a large photo).
async function onSmallestPreset() {
  const img = getActiveImage();
  if (!img) return;
  if (smallestInFlight) return;
  const ctx = getExportContext();
  if (!ctx.lifecycle || !ctx.caps) return;
  smallestInFlight = true;
  const btn = exportEls && exportEls.smallestBtn;
  const origLabel = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-working');
    btn.textContent = t('exportSmallestWorking');
  }
  try {
    const result = await pickSmallestFormat(img, ctx.caps, ctx.lifecycle);
    update(s => {
      s.export.format = result.format;
      s.export.quality = result.quality;
    });
    // Cache the winning blob so the next Download click reuses it without
    // re-encoding. Use the same key shape syncExportPanel writes — including
    // the global watermark fingerprint so toggling/tweaking the watermark
    // invalidates the cache (Bug fix v1.2.08).
    const stateSig = stateSignature(getActiveImage());
    const wmKey = watermarkCacheKey(getState().ui && getState().ui.watermark);
    const newKey = `${img.id}::${result.format}::${result.quality}::${stateSig}::${wmKey}`;
    setPredictCache(newKey, result.blob);
    lastPredictKey = newKey;
    if (exportEls && exportEls.predictedReadout) {
      exportEls.predictedReadout.textContent = t('exportPredictedSize', { size: formatBytes(result.blob.size) });
    }
    // Compose the toast. If the winner is PNG (i.e., PNG beat every other
    // candidate), say so plainly — no "% smaller" claim makes sense.
    const fmtLabel = formatLabel(result.format);
    const qPct = Math.round((result.quality || 0) * 100);
    if (result.format === 'png') {
      showToast(t('exportSmallestNoSavings'), { variant: 'info' });
    } else {
      const sizeStr = formatBytes(result.blob.size);
      let line = t('exportSmallestToast', { format: fmtLabel, quality: qPct, size: sizeStr });
      if (result.pngSize && result.blob.size < result.pngSize) {
        const pct = Math.round(((result.pngSize - result.blob.size) / result.pngSize) * 100);
        line += ` — ${pct}% smaller than PNG`;
      }
      showToast(line, { variant: 'info' });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('onSmallestPreset:', err);
    showToast(t('exportGenericFailed'), { variant: 'error' });
  } finally {
    smallestInFlight = false;
    if (btn) {
      btn.disabled = !getActiveImage();
      btn.classList.remove('is-working');
      btn.textContent = origLabel || t('exportSmallestPreset');
    }
  }
}

function formatLabel(fmt) {
  if (fmt === 'jpeg') return 'JPG';
  if (fmt === 'webp') return 'WebP';
  if (fmt === 'png')  return 'PNG';
  return String(fmt).toUpperCase();
}

// Compose a string signature of the bits of an image that affect its
// rendered output. Used as a cache key for the predict-encode pass.
// We stringify subobjects defensively because some of them are mutated in
// place by ops modules — reference identity isn't enough.
function stateSignature(img) {
  if (!img) return '';
  const parts = [
    stringify(img.transforms),
    stringify(img.adjust),
    String(img.filterPreset || 'none'),
    img.chromakeyMask ? `cm:${img.chromakeyMask.length}` : 'cm:0',
    img.bgMask ? `bm:${img.bgMask.length}` : 'bm:0',
    stringify(img.chromakey),
    overlaysSig(img.overlays),
  ];
  return parts.join('|');
}

function stringify(v) {
  if (v == null) return '';
  try { return JSON.stringify(v); } catch { return ''; }
}

function overlaysSig(overlays) {
  if (!Array.isArray(overlays) || overlays.length === 0) return 'o:0';
  // We only need a string that changes when any overlay's payload changes,
  // not full equality. JSON.stringify is fine here — overlays are small.
  try {
    return `o:${JSON.stringify(overlays)}`;
  } catch {
    return `o:${overlays.length}`;
  }
}

// Schedule a predict encode (debounced). Cancels any in-flight predict by
// bumping the run sequence — only the latest call's result lands.
function schedulePredictEncode() {
  if (predictTimerId != null) {
    clearTimeout(predictTimerId);
    predictTimerId = null;
  }
  predictTimerId = setTimeout(() => {
    predictTimerId = null;
    runPredictEncode();
  }, PREDICT_DEBOUNCE_MS);
}

async function runPredictEncode() {
  const img = getActiveImage();
  if (!img) return;
  const ctx = getExportContext();
  if (!ctx.lifecycle || !ctx.caps) return;
  const s = getState();
  const fmt = (s.export && s.export.format) || 'png';
  const q = Number.isFinite(s.export && s.export.quality) ? s.export.quality : 0.92;
  const stateSig = stateSignature(img);
  const wmKey = watermarkCacheKey(s.ui && s.ui.watermark);
  const key = `${img.id}::${fmt}::${q}::${stateSig}::${wmKey}`;
  // If our cache already has this key (e.g., from a prior predict that's
  // still fresh), update the readout from the cached size.
  if (lastPredictKey === key && exportEls && exportEls.predictedReadout) {
    // No-op — readout already shows this value.
    return;
  }
  const mySeq = ++predictRunSeq;
  if (exportEls && exportEls.predictedReadout) {
    exportEls.predictedReadout.textContent = t('exportPredictedEstimating');
  }
  let blob;
  try {
    blob = await renderForExport(img, { format: fmt, quality: q }, ctx.caps, ctx.lifecycle);
  } catch (err) {
    // Don't toast — predict encodes are background; just show "—".
    if (mySeq === predictRunSeq && exportEls && exportEls.predictedReadout) {
      exportEls.predictedReadout.textContent = t('exportOutputEmpty');
    }
    return;
  }
  // Bail if a newer predict has been scheduled since.
  if (mySeq !== predictRunSeq) return;
  setPredictCache(key, blob);
  lastPredictKey = key;
  if (exportEls && exportEls.predictedReadout) {
    exportEls.predictedReadout.textContent = t('exportPredictedSize', { size: formatBytes(blob.size) });
  }
}

function syncExportPanel() {
  if (!exportEls) return;
  const s = getState();
  const exp = s.export || { format: 'jpeg', quality: 0.92, filenameTemplate: '{base}-edited' };
  const pdfOpts = exp.pdf || { pageSize: 'fit', orientation: 'auto', margins: undefined, fitMode: 'contain' };

  // Smart match-source default: when the user hasn't explicitly clicked
  // a format chip this session, fall back to whatever matches the active
  // image's source MIME. Re-runs whenever the active image changes so
  // switching from a PNG to a JPEG mid-session swaps the format chip too.
  // Once the user picks a chip, _userFormatLocked flips true and this is
  // skipped for the rest of the session.
  const activeId = s.ui && s.ui.activeImageId;
  if (!exp._userFormatLocked && activeId && activeId !== lastSmartFormatForId) {
    const activeImg = s.images && s.images[activeId];
    if (activeImg) {
      const smart = getSmartDefaultFormat(activeImg);
      if (smart && smart !== exp.format) {
        update(st => { st.export.format = smart; });
        // The update() above re-fires syncExportPanel() synchronously via the
        // subscriber chain — that re-entry will see the new format and the
        // updated lastSmartFormatForId, so we return early here to avoid
        // doing duplicate DOM work in this frame.
        lastSmartFormatForId = activeId;
        return;
      }
      lastSmartFormatForId = activeId;
    }
  }

  const isPdf = exp.format === 'pdf';

  // Sync the target-size subsection. Apply gated by "active image exists".
  if (exportEls.targetSize) {
    syncTargetSizeSection(exportEls.targetSize, !!getActiveImage());
  }
  // Sync the upload-ready subsection. Same enable gate (active image).
  if (exportEls.uploadReady) {
    syncUploadReadySection(exportEls.uploadReady, !!getActiveImage());
  }

  // Strip-metadata checkbox: sync from state and toggle the hint visibility
  // when the user opts out of stripping. The hint explains the JPEG-only
  // limitation so the user isn't surprised that picking PNG and unchecking
  // the box doesn't actually preserve metadata.
  if (exportEls.stripInput) {
    const strip = exp.stripMetadata !== false;
    if (document.activeElement !== exportEls.stripInput) {
      exportEls.stripInput.checked = strip;
    }
    if (exportEls.stripHint) {
      // Show the hint only when the user has opted to keep metadata. (When
      // strip is on, there's nothing to clarify.)
      exportEls.stripHint.hidden = strip;
    }
  }

  // Active format chip.
  for (const [id, btn] of exportEls.formatBtns) {
    btn.classList.toggle('is-active', id === exp.format);
    btn.setAttribute('aria-pressed', id === exp.format ? 'true' : 'false');
  }

  // WebP-over-PNG nudge — visible only when PNG is the active format.
  if (exportEls.formatHint) {
    exportEls.formatHint.hidden = exp.format !== 'png';
  }

  // Quality slider: visible for JPG/WebP, hidden for PNG (lossless) and PDF
  // (PDF embeds JPEG at a fixed 0.92 quality — the comparison doesn't apply).
  const showQuality = exp.format === 'jpeg' || exp.format === 'webp';
  exportEls.qualityRow.hidden = !showQuality;
  if (showQuality && document.activeElement !== exportEls.qualityInput) {
    const q = Number.isFinite(exp.quality) ? exp.quality : 0.92;
    exportEls.qualityInput.value = String(q);
    exportEls.qualityReadout.textContent = String(Math.round(q * 100));
  }

  // PDF options visible only when PDF is selected.
  if (exportEls.pdfOptsRow) exportEls.pdfOptsRow.hidden = !isPdf;
  if (exportEls.pdfPageSizeSel && document.activeElement !== exportEls.pdfPageSizeSel) {
    exportEls.pdfPageSizeSel.value = pdfOpts.pageSize || 'fit';
  }
  if (exportEls.pdfOrientSel && document.activeElement !== exportEls.pdfOrientSel) {
    exportEls.pdfOrientSel.value = pdfOpts.orientation || 'auto';
  }
  if (exportEls.pdfMarginInput && document.activeElement !== exportEls.pdfMarginInput) {
    const defaultMargin = (pdfOpts.pageSize === 'fit' || !pdfOpts.pageSize) ? 0 : 36;
    const m = Number.isFinite(pdfOpts.margins) ? pdfOpts.margins : defaultMargin;
    exportEls.pdfMarginInput.value = String(m);
  }
  if (exportEls.pdfFitSel && document.activeElement !== exportEls.pdfFitSel) {
    exportEls.pdfFitSel.value = pdfOpts.fitMode || 'contain';
  }
  // Fit-mode is only meaningful when the page size is fixed (not 'fit').
  if (exportEls.pdfFitLabel) {
    const fitRelevant = (pdfOpts.pageSize && pdfOpts.pageSize !== 'fit');
    exportEls.pdfFitLabel.hidden = !fitRelevant;
  }

  // "Smallest size" preset is meaningless for PDF — the JPG-vs-PNG-vs-WebP
  // sweep doesn't apply when the container is fixed.
  if (exportEls.smallestBtn) {
    exportEls.smallestBtn.hidden = isPdf;
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
    if (exportEls.smallestBtn) exportEls.smallestBtn.disabled = true;
    if (exportEls.predictedReadout) exportEls.predictedReadout.textContent = t('exportOutputEmpty');
    return;
  }
  exportEls.downloadBtn.disabled = false;
  if (exportEls.smallestBtn) exportEls.smallestBtn.disabled = smallestInFlight;
  const dims = effectiveImageSize(img);
  if (dims.w > 0 && dims.h > 0) {
    exportEls.dimsReadout.textContent = t('exportOutput', { w: Math.round(dims.w), h: Math.round(dims.h) });
  } else {
    exportEls.dimsReadout.textContent = t('exportOutputEmpty');
  }

  // Predicted-size readout: for raw formats we run a real encode and report
  // bytes. For PDF, the cost is dominated by jsPDF's container + the
  // embedded JPEG bake — a precise predict would mean running the full PDF
  // build, which is expensive enough that we skip it in v1.1 and show a
  // "approximate" note instead. The actual size shows up in the success
  // toast after the user clicks Download.
  if (isPdf) {
    if (exportEls.predictedReadout) {
      exportEls.predictedReadout.textContent = t('exportPredictedPdfNote');
    }
    return;
  }

  // Trigger a debounced predict encode if the relevant state signature has
  // changed since the last predict. We compute the key here so any state
  // change that affects the rendered output (transforms / adjust / overlays /
  // masks / format / quality / watermark) re-fires the predict.
  const sig = stateSignature(img);
  const q = Number.isFinite(exp.quality) ? exp.quality : 0.92;
  const wmKey = watermarkCacheKey(getState().ui && getState().ui.watermark);
  const key = `${img.id}::${exp.format || 'png'}::${q}::${sig}::${wmKey}`;
  if (key !== lastPredictKey) {
    schedulePredictEncode();
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

  // v1.1.1: the Overlays section is now contextual — it only appears in the
  // editor panel when the active image actually has overlays. When there are
  // none, the whole <details id="panel-overlays"> element is hidden so the
  // user isn't confused by an empty section taking up vertical space (was
  // showing a "No overlays yet" placeholder before). Saved real estate
  // matters more as v1.2 features start adding more sections to the panel.
  const overlaysSection = document.getElementById('panel-overlays');
  if (overlaysSection) overlaysSection.hidden = overlays.length === 0;

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
  // v1.1.2: shapes and redacts get more specific labels so the user can
  // tell them apart at a glance — "Circle" and "Arrow" instead of two
  // identical "Shape" rows; "Blur redact" vs "Pixelate redact" instead
  // of two "Redact" rows. Falls back to the generic type label for
  // overlay kinds we don't have specific keys for.
  if (overlay.type === 'shape') {
    const kindKey = {
      circle: 'shapeKindCircle',
      rect:   'shapeKindRect',
      line:   'shapeKindLine',
      arrow:  'shapeKindArrow',
    }[overlay.kind];
    if (kindKey) return t(kindKey);
  }
  if (overlay.type === 'redact') {
    const modeKey = {
      blur:     'redactModeBlur',
      pixelate: 'redactModePixelate',
    }[overlay.mode];
    if (modeKey) return `${t(modeKey)} ${fallback.toLowerCase()}`;
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
