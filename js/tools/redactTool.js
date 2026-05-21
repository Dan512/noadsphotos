// js/tools/redactTool.js — selective blur/pixelate redaction tool.
//
// Behavior summary:
//   - Activates when state.ui.activeTool === 'redact' (editor view + active
//     image).
//   - Side panel has mode toggle (Blur / Pixelate), strength slider 2..40,
//     and an Apply button.
//   - pointerdown:  record drag start.
//   - pointermove:  update an in-progress rect via setOverlayDrawer (NOT in
//                   state).
//   - pointerup:    commit a new redact overlay if the drag moved beyond
//                   click slop; discard otherwise. The new overlay is
//                   selected so the panel can keep editing it.
//   - mode/strength changes:  patch the SELECTED redact overlay (live).
//   - Apply: deselect — returns the tool to "ready to draw a new rect"
//            without removing the committed overlay.
//
// The actual blur/pixelate is applied LIVE to the base canvas by the
// preview renderer (see js/render/previewRenderer.js) and to the export
// canvas by the export renderer. See ops/redact.js for the effect impl.

import { attachPointer } from '../pointer.js';
import { getState, subscribe, update } from '../state.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import { newRedactOverlay, drawRedact, REDACT_MODES } from '../ops/redact.js';
import { addOverlay, getOverlay, updateOverlay } from '../overlays.js';
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

let toolMode = 'blur';
let toolStrength = 12;

let drawing = null; // { x1, y1, x2, y2 } in source-pixel space

let panelEls = null; // { modeBtns, strengthInput, strengthReadout, applyBtn }

const CLICK_SLOP_SRC = 1;
const MIN_STRENGTH = 2;
const MAX_STRENGTH = 40;

export function initRedactTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'redact';
  if (want && !active) activate();
  else if (!want && active) deactivate();
  else if (want && active) syncPanelFromSelection();
}

// When the user selects an existing redact overlay (via the Overlays panel
// or by clicking on it), sync the tool's mode/strength state + the panel
// inputs so subsequent edits land on that overlay's existing values rather
// than the tool's stale toolbar defaults.
function syncPanelFromSelection() {
  if (!panelEls) return;
  const img = getActiveImage();
  if (!img) return;
  const s = getState();
  const id = s.ui && s.ui.selectedOverlayId;
  if (!id) return;
  const o = getOverlay(img, id);
  if (!o || o.type !== 'redact') return;
  if (o.mode && o.mode !== toolMode) {
    toolMode = o.mode;
    syncModeBtns();
  }
  const sNum = Number(o.strength);
  if (Number.isFinite(sNum) && sNum !== toolStrength) {
    toolStrength = sNum;
    panelEls.strengthInput.value = String(sNum);
    panelEls.strengthReadout.textContent = String(Math.round(sNum));
  }
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
  clearToolPanel({ owner: 'redact' });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// --- pointer handlers ----------------------------------------------------

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

  const dx = Math.abs(d.x2 - d.x1);
  const dy = Math.abs(d.y2 - d.y1);
  if (dx < CLICK_SLOP_SRC && dy < CLICK_SLOP_SRC) return;

  // Normalise to positive width/height.
  const x = Math.min(d.x1, d.x2);
  const y = Math.min(d.y1, d.y2);
  const w = dx;
  const h = dy;

  const img = getActiveImage();
  if (!img) return;
  const overlay = newRedactOverlay(x, y, w, h, {
    mode: toolMode,
    strength: toolStrength,
  });
  withOverlaysHistory('Redact region', img.id, state => {
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

// --- preview drawer ------------------------------------------------------

function drawInProgress(ctx, _canvas) {
  if (!drawing) return;
  const x = Math.min(drawing.x1, drawing.x2);
  const y = Math.min(drawing.y1, drawing.y2);
  const w = Math.abs(drawing.x2 - drawing.x1);
  const h = Math.abs(drawing.y2 - drawing.y1);
  if (w <= 0 || h <= 0) return;

  ctx.save();
  if (!applySourceTransform(ctx)) {
    ctx.restore();
    return;
  }
  drawRedact(ctx, {
    x, y, w, h,
    mode: toolMode,
    strength: toolStrength,
  });
  ctx.restore();
}

// --- side panel ----------------------------------------------------------

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'redact-tool-panel';

  const heading = document.createElement('h2');
  heading.className = 'panel-heading';
  heading.textContent = t('redactTitle');
  root.appendChild(heading);

  // Mode toggle.
  const modeRow = document.createElement('div');
  modeRow.className = 'redact-row redact-mode-row';
  const modeLabel = document.createElement('span');
  modeLabel.textContent = t('redactMode');
  modeRow.appendChild(modeLabel);
  const modeGroup = document.createElement('div');
  modeGroup.className = 'redact-mode-group';
  const modeBtns = {};
  for (const mode of REDACT_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `redact-mode redact-mode-${mode}`;
    btn.dataset.mode = mode;
    btn.textContent = mode === 'pixelate' ? t('redactModePixelate') : t('redactModeBlur');
    btn.setAttribute('aria-label', btn.textContent);
    btn.addEventListener('click', () => {
      toolMode = mode;
      syncModeBtns();
      patchSelectedRedact({ mode });
    });
    modeGroup.appendChild(btn);
    modeBtns[mode] = btn;
  }
  modeRow.appendChild(modeGroup);
  root.appendChild(modeRow);

  // Strength slider.
  const strengthRow = document.createElement('label');
  strengthRow.className = 'redact-row redact-strength-row';
  const strengthLabel = document.createElement('span');
  strengthLabel.textContent = t('redactStrength');
  strengthRow.appendChild(strengthLabel);
  const strengthInput = document.createElement('input');
  strengthInput.type = 'range';
  strengthInput.min = String(MIN_STRENGTH);
  strengthInput.max = String(MAX_STRENGTH);
  strengthInput.step = '1';
  strengthInput.value = String(toolStrength);
  strengthInput.className = 'redact-strength';
  strengthInput.setAttribute('aria-label', t('redactStrengthAria'));
  strengthRow.appendChild(strengthInput);
  const strengthReadout = document.createElement('span');
  strengthReadout.className = 'redact-strength-readout';
  strengthReadout.setAttribute('aria-live', 'polite');
  strengthReadout.textContent = String(toolStrength);
  strengthRow.appendChild(strengthReadout);
  root.appendChild(strengthRow);

  // Apply button — "done editing this redact." Deselects so a subsequent
  // drag starts a fresh redact instead of editing the previous one.
  const actions = document.createElement('div');
  actions.className = 'redact-actions';
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'redact-apply btn-primary';
  applyBtn.textContent = t('redactApply');
  applyBtn.addEventListener('click', () => {
    update(s => { s.ui.selectedOverlayId = null; });
  });
  actions.appendChild(applyBtn);
  root.appendChild(actions);

  // Hint.
  const hint = document.createElement('p');
  hint.className = 'redact-hint';
  hint.textContent = t('redactHint');
  root.appendChild(hint);

  setToolPanel(root, { owner: 'redact' });
  panelEls = { modeBtns, strengthInput, strengthReadout, applyBtn };

  strengthInput.addEventListener('input', () => {
    const n = clampStrength(Number(strengthInput.value));
    if (!Number.isFinite(n)) return;
    toolStrength = n;
    strengthReadout.textContent = String(Math.round(n));
    patchSelectedRedact({ strength: n });
  });

  syncModeBtns();
}

// Apply a patch to the currently-selected overlay IF it's a redact owned by
// the active image. Live (no history transaction) so the slider drag updates
// preview without spamming undo entries. The drag-end could in principle
// snapshot history, but matching textTool's approach: the initial creation
// records history; subsequent edits are "live" and can be re-tuned freely.
function patchSelectedRedact(patch) {
  const img = getActiveImage();
  if (!img) return;
  const s = getState();
  const id = s.ui && s.ui.selectedOverlayId;
  if (!id) return;
  const o = getOverlay(img, id);
  if (!o || o.type !== 'redact') return;
  update(state => {
    const target = state.images[img.id];
    if (!target) return;
    updateOverlay(target, id, patch);
  });
}

function syncModeBtns() {
  if (!panelEls) return;
  for (const mode of REDACT_MODES) {
    const btn = panelEls.modeBtns[mode];
    if (!btn) continue;
    btn.classList.toggle('is-active', mode === toolMode);
  }
}

function clampStrength(n) {
  if (!Number.isFinite(n)) return NaN;
  if (n < MIN_STRENGTH) return MIN_STRENGTH;
  if (n > MAX_STRENGTH) return MAX_STRENGTH;
  return n;
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  panelEls = null;
  drawing = null;
  toolMode = 'blur';
  toolStrength = 12;
}
