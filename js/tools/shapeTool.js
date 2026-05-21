// js/tools/shapeTool.js — line / rect / arrow / circle drawing tool.
//
// Behavior summary:
//   - Activates when state.ui.activeTool === 'shape' (editor view + active
//     image).
//   - Side panel has kind chips (Line / Rect / Arrow / Circle), stroke
//     color, fill color + "no fill" checkbox (rect/circle only),
//     strokeWidth slider.
//   - pointerdown:  record drag start.
//   - pointermove:  update an in-progress shape via setOverlayDrawer
//                   (NOT in state — avoids dirty churn).
//   - pointerup:    commit a new shape overlay if the drag moved beyond
//                   click slop; discard otherwise (no zero-size shapes).
//
// Tool-local state (kind / colors / strokeWidth) persists across drags
// within an activation; resets to defaults on deactivate.

import { attachPointer } from '../pointer.js';
import { getState, subscribe, update } from '../state.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import { newShapeOverlay, drawShape, SHAPE_KINDS } from '../ops/shape.js';
import { addOverlay } from '../overlays.js';
import { withOverlaysHistory } from '../historyOps.js';
import { t } from '../i18n.js';
import {
  canvasToSource,
  setOverlayDrawer,
  clearOverlayDrawer,
  applySourceTransform,
} from '../render/previewRenderer.js';

let active = false;
let detach = null;
let overlayCanvas = null;

// Tool-local settings.
let toolKind = 'rect';
let toolStroke = '#000000';
let toolFill = '#ffffff';
let toolUseFill = false;          // checkbox state for rect/circle
let toolStrokeWidth = 2;

// In-progress drag.
let drawing = null; // { x1, y1, x2, y2 } in source-pixel space

let panelEls = null; // { kindChips, strokeInput, fillInput, fillToggle, fillRow, strokeWidthInput, strokeWidthReadout }

const CLICK_SLOP_SRC = 1; // require at least 1 source-pixel of drag to keep the shape

const MIN_STROKE_WIDTH = 1;
const MAX_STROKE_WIDTH = 20;

export function initShapeTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'shape';
  if (want && !active) activate();
  else if (!want && active) deactivate();
}

function activate() {
  overlayCanvas = document.getElementById('overlay-canvas');
  if (!overlayCanvas) return;
  active = true;
  overlayCanvas.style.pointerEvents = 'auto';
  overlayCanvas.style.cursor = 'crosshair';
  detach = attachPointer(overlayCanvas, { down, move, up, cancel: cancelDrag });
  renderPanel();
}

function deactivate() {
  active = false;
  if (detach) {
    try { detach(); } catch { /* ignore */ }
    detach = null;
  }
  if (overlayCanvas) {
    overlayCanvas.style.pointerEvents = 'none';
    overlayCanvas.style.cursor = '';
  }
  drawing = null;
  panelEls = null;
  clearOverlayDrawer();
  clearToolPanel({ owner: 'shape' });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// --- pointer handlers -----------------------------------------------------

function down(e) {
  const img = getActiveImage();
  if (!img) return;
  const src = canvasToSource({ x: e.x, y: e.y });
  if (!src) return;
  drawing = { x1: src.x, y1: src.y, x2: src.x, y2: src.y };
  setOverlayDrawer(drawInProgress);
}

function move(e) {
  if (!drawing) return;
  const src = canvasToSource({ x: e.x, y: e.y });
  if (!src) return;
  drawing.x2 = src.x;
  drawing.y2 = src.y;
}

function up(_e) {
  if (!drawing) {
    clearOverlayDrawer();
    return;
  }
  const d = drawing;
  drawing = null;
  clearOverlayDrawer();

  // Discard zero-size shapes (a tap).
  const dx = Math.abs(d.x2 - d.x1);
  const dy = Math.abs(d.y2 - d.y1);
  if (dx < CLICK_SLOP_SRC && dy < CLICK_SLOP_SRC) return;

  const img = getActiveImage();
  if (!img) return;
  const fill = (toolUseFill && (toolKind === 'rect' || toolKind === 'circle'))
    ? toolFill
    : null;
  const overlay = newShapeOverlay(toolKind, d.x1, d.y1, d.x2, d.y2, {
    stroke: toolStroke,
    fill,
    strokeWidth: toolStrokeWidth,
  });
  withOverlaysHistory(`Add ${toolKind}`, img.id, state => {
    const target = state.images[img.id];
    if (!target) return;
    addOverlay(target, overlay);
    state.ui.selectedOverlayId = overlay.id;
  });
}

function cancelDrag() {
  drawing = null;
  clearOverlayDrawer();
}

// --- preview drawer -------------------------------------------------------

function drawInProgress(ctx, _canvas) {
  if (!drawing) return;
  ctx.save();
  if (!applySourceTransform(ctx)) {
    ctx.restore();
    return;
  }
  const fill = (toolUseFill && (toolKind === 'rect' || toolKind === 'circle'))
    ? toolFill
    : null;
  drawShape(ctx, {
    kind: toolKind,
    x1: drawing.x1, y1: drawing.y1,
    x2: drawing.x2, y2: drawing.y2,
    stroke: toolStroke,
    fill,
    strokeWidth: toolStrokeWidth,
  });
  ctx.restore();
}

// --- side panel ----------------------------------------------------------

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'shape-tool-panel';

  const heading = document.createElement('h2');
  heading.className = 'panel-heading';
  heading.textContent = t('shapeTitle');
  root.appendChild(heading);

  // Kind chips.
  const kindRow = document.createElement('div');
  kindRow.className = 'shape-row shape-kind-row';
  const kindLabel = document.createElement('span');
  kindLabel.textContent = t('shapeKind');
  kindRow.appendChild(kindLabel);
  const kindGroup = document.createElement('div');
  kindGroup.className = 'shape-kind-group';
  const kindChips = {};
  for (const kind of SHAPE_KINDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `shape-kind shape-kind-${kind}`;
    btn.dataset.kind = kind;
    const lbl = kindLabel_(kind);
    btn.textContent = lbl;
    btn.title = lbl;
    btn.setAttribute('aria-label', t('shapeKindAria', { label: lbl }));
    btn.addEventListener('click', () => {
      toolKind = kind;
      syncKindChips();
      syncFillVisibility();
    });
    kindGroup.appendChild(btn);
    kindChips[kind] = btn;
  }
  kindRow.appendChild(kindGroup);
  root.appendChild(kindRow);

  // Stroke color.
  const strokeRow = document.createElement('label');
  strokeRow.className = 'shape-row';
  const strokeLabel = document.createElement('span');
  strokeLabel.textContent = t('shapeStroke');
  strokeRow.appendChild(strokeLabel);
  const strokeInput = document.createElement('input');
  strokeInput.type = 'color';
  strokeInput.className = 'shape-stroke';
  strokeInput.value = toolStroke;
  strokeInput.setAttribute('aria-label', t('shapeStrokeAria'));
  strokeRow.appendChild(strokeInput);
  root.appendChild(strokeRow);

  // Fill (rect/circle only).
  const fillRow = document.createElement('div');
  fillRow.className = 'shape-row shape-fill-row';
  const fillLabel = document.createElement('span');
  fillLabel.textContent = t('shapeFill');
  fillRow.appendChild(fillLabel);
  const fillGroup = document.createElement('div');
  fillGroup.className = 'shape-fill-group';
  const fillToggle = document.createElement('input');
  fillToggle.type = 'checkbox';
  fillToggle.className = 'shape-fill-toggle';
  fillToggle.checked = toolUseFill;
  fillToggle.setAttribute('aria-label', t('shapeFillToggleAria'));
  fillGroup.appendChild(fillToggle);
  const fillInput = document.createElement('input');
  fillInput.type = 'color';
  fillInput.className = 'shape-fill';
  fillInput.value = toolFill;
  fillInput.setAttribute('aria-label', t('shapeFillAria'));
  fillInput.disabled = !toolUseFill;
  fillGroup.appendChild(fillInput);
  fillRow.appendChild(fillGroup);
  root.appendChild(fillRow);

  // Stroke width.
  const strokeWidthRow = document.createElement('label');
  strokeWidthRow.className = 'shape-row shape-stroke-width-row';
  const swLabel = document.createElement('span');
  swLabel.textContent = t('shapeWidth');
  strokeWidthRow.appendChild(swLabel);
  const strokeWidthInput = document.createElement('input');
  strokeWidthInput.type = 'range';
  strokeWidthInput.min = String(MIN_STROKE_WIDTH);
  strokeWidthInput.max = String(MAX_STROKE_WIDTH);
  strokeWidthInput.step = '1';
  strokeWidthInput.value = String(toolStrokeWidth);
  strokeWidthInput.className = 'shape-stroke-width';
  strokeWidthInput.setAttribute('aria-label', t('shapeStrokeWidthAria'));
  strokeWidthRow.appendChild(strokeWidthInput);
  const strokeWidthReadout = document.createElement('span');
  strokeWidthReadout.className = 'shape-stroke-width-readout';
  strokeWidthReadout.setAttribute('aria-live', 'polite');
  strokeWidthReadout.textContent = String(toolStrokeWidth);
  strokeWidthRow.appendChild(strokeWidthReadout);
  root.appendChild(strokeWidthRow);

  // Hint.
  const hint = document.createElement('p');
  hint.className = 'shape-hint';
  hint.textContent = t('shapeHint');
  root.appendChild(hint);

  setToolPanel(root, { owner: 'shape' });
  panelEls = { kindChips, strokeInput, fillInput, fillToggle, fillRow, strokeWidthInput, strokeWidthReadout };

  // Listeners.
  strokeInput.addEventListener('input', () => {
    toolStroke = strokeInput.value || '#000000';
  });
  fillInput.addEventListener('input', () => {
    toolFill = fillInput.value || '#ffffff';
  });
  fillToggle.addEventListener('change', () => {
    toolUseFill = !!fillToggle.checked;
    fillInput.disabled = !toolUseFill;
  });
  strokeWidthInput.addEventListener('input', () => {
    const n = clampStrokeWidth(Number(strokeWidthInput.value));
    if (!Number.isFinite(n)) return;
    toolStrokeWidth = n;
    strokeWidthReadout.textContent = String(Math.round(n));
  });

  syncKindChips();
  syncFillVisibility();
}

function kindLabel_(kind) {
  switch (kind) {
    case 'line':   return t('shapeKindLine');
    case 'rect':   return t('shapeKindRect');
    case 'arrow':  return t('shapeKindArrow');
    case 'circle': return t('shapeKindCircle');
    default:       return kind;
  }
}

function syncKindChips() {
  if (!panelEls) return;
  for (const kind of SHAPE_KINDS) {
    const btn = panelEls.kindChips[kind];
    if (!btn) continue;
    btn.classList.toggle('is-active', kind === toolKind);
  }
}

function syncFillVisibility() {
  if (!panelEls) return;
  // Hide fill row for line + arrow.
  const showFill = (toolKind === 'rect' || toolKind === 'circle');
  panelEls.fillRow.hidden = !showFill;
}

function clampStrokeWidth(n) {
  if (!Number.isFinite(n)) return NaN;
  if (n < MIN_STROKE_WIDTH) return MIN_STROKE_WIDTH;
  if (n > MAX_STROKE_WIDTH) return MAX_STROKE_WIDTH;
  return n;
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  panelEls = null;
  drawing = null;
  toolKind = 'rect';
  toolStroke = '#000000';
  toolFill = '#ffffff';
  toolUseFill = false;
  toolStrokeWidth = 2;
}
