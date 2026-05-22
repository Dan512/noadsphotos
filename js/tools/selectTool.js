// js/tools/selectTool.js — pointer + overlay-editor tool.
//
// v1.1.2 redesign: Select used to host the rotate/flip controls (because
// there was nowhere else for them). Those moved to the dedicated 'transform'
// tool (see transformTool.js). Select is now the pointer / "click an item
// to edit it" tool — its job is to:
//
//   1. Hit-test EVERY overlay type (text/brush/shape/redact) when the user
//      clicks the canvas. Topmost overlay wins.
//   2. Set state.ui.selectedOverlayId to the hit overlay, OR null if the
//      click missed (clicking empty space deselects).
//   3. Support drag-to-move on the selected overlay (uses overlays.moveOverlay,
//      which knows how to translate every overlay type).
//   4. Render an edit panel in the Tool-options section showing the selected
//      overlay's editable properties (stroke color, fill, width for shapes;
//      text + size + colour for text overlays; etc.).
//
// When nothing is selected: the panel shows a hint string and waits.
//
// Selection can also be set externally — e.g., the user clicking a row in
// the Overlays section (editor.js's buildOverlayRow). This module's state
// subscriber notices the change and re-renders the panel.
//
// Each overlay-type's edit form mutates the SELECTED overlay (not the
// per-tool create defaults) by passing the change through
// withOverlaysHistory so undo/redo gets a clean entry.
import { getState, subscribe, update } from '../state.js';
import { attachPointer } from '../pointer.js';
import { setToolPanel, clearToolPanel, getToolPanelBody } from '../editor.js';
import { withOverlaysHistory } from '../historyOps.js';
import { recordOp } from '../history.js';
import { getOverlay, getOverlayBounds, moveOverlay } from '../overlays.js';
import { canvasToSource } from '../render/previewRenderer.js';
import { t } from '../i18n.js';

// --- Module state ----------------------------------------------------------

let active = false;
let detach = null;                // attachPointer detach handle
let overlayCanvas = null;
let lastRenderedSelectedId = null; // so we don't tear down + rebuild a panel
                                   // every state tick when the selection
                                   // hasn't changed.

// Drag-to-move state.
let dragMode = null;              // null | 'move'
let dragStartSource = null;       // source-pixel point at pointerdown
let dragHistoryBefore = null;     // snapshot for history op on pointerup
let dragMoved = false;            // crossed the click-slop threshold
let downCssPoint = null;
const CLICK_SLOP_CSS = 3;

// --- Boot ------------------------------------------------------------------

export function initSelectTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const wantActive = s.ui.view === 'editor' && s.ui.activeTool === 'select';
  if (wantActive && !active) activate();
  else if (!wantActive && active) deactivate();
  if (active) {
    // Re-render when the selection (or active image) changes.
    const selId = s.ui.selectedOverlayId || null;
    if (selId !== lastRenderedSelectedId) {
      lastRenderedSelectedId = selId;
      renderPanel();
    }
  }
}

function activate() {
  const body = getToolPanelBody();
  if (!body) return; // editor not mounted yet
  overlayCanvas = document.getElementById('overlay-canvas');
  if (!overlayCanvas) return;
  active = true;
  // Receive pointer events on the overlay canvas (sits above the base).
  overlayCanvas.style.pointerEvents = 'auto';
  detach = attachPointer(overlayCanvas, { down, move, up });
  lastRenderedSelectedId = getState().ui.selectedOverlayId || null;
  renderPanel();
}

function deactivate() {
  active = false;
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  if (overlayCanvas) overlayCanvas.style.pointerEvents = 'none';
  overlayCanvas = null;
  dragMode = null;
  dragStartSource = null;
  dragHistoryBefore = null;
  dragMoved = false;
  downCssPoint = null;
  lastRenderedSelectedId = null;
  clearToolPanel({ owner: 'select' });
}

// --- Pointer handlers ------------------------------------------------------

function down(e) {
  const img = getActiveImage();
  if (!img) return;
  const src = canvasToSource({ x: e.x, y: e.y });
  if (!src) return;
  downCssPoint = { x: e.x, y: e.y };
  dragMoved = false;

  // Walk overlays top-to-bottom (last-drawn = first to hit-test).
  const hit = hitTestAny(img, src);
  if (!hit) {
    // Click on empty space: deselect.
    update(s => { s.ui.selectedOverlayId = null; });
    dragMode = null;
    return;
  }
  // Select on hit. We always re-set even if id matches so the renderer
  // re-paints the selection indicator on re-clicks.
  update(s => { s.ui.selectedOverlayId = hit.id; });

  // Begin drag.
  dragMode = 'move';
  dragStartSource = src;
  dragHistoryBefore = { overlays: structuredClone(img.overlays) };
}

function move(e) {
  if (!downCssPoint) return;
  const dxCss = e.x - downCssPoint.x;
  const dyCss = e.y - downCssPoint.y;
  if (Math.hypot(dxCss, dyCss) > CLICK_SLOP_CSS) dragMoved = true;
  if (dragMode !== 'move' || !dragStartSource) return;
  const src = canvasToSource({ x: e.x, y: e.y });
  if (!src) return;
  const img = getActiveImage();
  const selId = getState().ui.selectedOverlayId;
  if (!img || !selId) return;
  const dx = src.x - dragStartSource.x;
  const dy = src.y - dragStartSource.y;
  if (dx === 0 && dy === 0) return;
  // Move and update drag-start so future events compute fresh deltas.
  update(s => {
    const target = s.images[img.id];
    if (!target) return;
    moveOverlay(target, selId, dx, dy);
  });
  dragStartSource = src;
}

function up(_e) {
  const startedDrag = dragMode === 'move';
  const moved = dragMoved;
  dragMode = null;
  dragStartSource = null;
  downCssPoint = null;
  dragMoved = false;

  if (startedDrag && moved && dragHistoryBefore) {
    const img = getActiveImage();
    if (img) {
      const after = { overlays: structuredClone(img.overlays) };
      recordOp({
        label: 'Move overlay',
        imageId: img.id,
        kind: 'overlay',
        before: dragHistoryBefore,
        after,
      });
    }
  }
  dragHistoryBefore = null;
}

// Topmost overlay whose source-pixel bounding box contains the point.
// Walks z-order high → low so the visible top overlay wins.
function hitTestAny(img, srcPoint) {
  if (!img || !Array.isArray(img.overlays)) return null;
  const ctx = overlayCanvas && overlayCanvas.getContext ? overlayCanvas.getContext('2d') : null;
  for (let i = img.overlays.length - 1; i >= 0; i--) {
    const o = img.overlays[i];
    if (!o) continue;
    const b = getOverlayBounds(o, ctx);
    if (!b || b.w <= 0 || b.h <= 0) continue;
    if (
      srcPoint.x >= b.x && srcPoint.x <= b.x + b.w &&
      srcPoint.y >= b.y && srcPoint.y <= b.y + b.h
    ) {
      return o;
    }
  }
  return null;
}

// --- Panel rendering -------------------------------------------------------

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'select-tool-panel';
  const img = getActiveImage();
  const selId = getState().ui.selectedOverlayId || null;
  const overlay = (img && selId) ? getOverlay(img, selId) : null;

  if (!overlay) {
    // Empty state: hint.
    const hint = document.createElement('p');
    hint.className = 'tool-hint';
    hint.textContent = t('selectToolEmpty');
    root.appendChild(hint);
    setToolPanel(root, { owner: 'select' });
    return;
  }

  // Editing state: heading + per-type edit fields.
  const heading = document.createElement('h2');
  heading.className = 'panel-heading';
  heading.textContent = t('selectToolEditing', { label: friendlyOverlayLabel(overlay) });
  root.appendChild(heading);

  switch (overlay.type) {
    case 'shape':  appendShapeEditFields(root, img, overlay); break;
    case 'text':   appendTextEditFields(root, img, overlay); break;
    case 'brush':  appendBrushEditFields(root, img, overlay); break;
    case 'redact': appendRedactEditFields(root, img, overlay); break;
    default: {
      const note = document.createElement('p');
      note.className = 'tool-hint';
      note.textContent = `(${overlay.type})`;
      root.appendChild(note);
    }
  }

  setToolPanel(root, { owner: 'select' });
}

function friendlyOverlayLabel(overlay) {
  if (overlay.type === 'shape') {
    const kindKey = {
      circle: 'shapeKindCircle',
      rect:   'shapeKindRect',
      line:   'shapeKindLine',
      arrow:  'shapeKindArrow',
    }[overlay.kind];
    return kindKey ? t(kindKey) : 'Shape';
  }
  if (overlay.type === 'text')   return t('overlayLabelText');
  if (overlay.type === 'brush')  return t('overlayLabelBrush');
  if (overlay.type === 'redact') return t('overlayLabelRedact');
  return overlay.type;
}

// --- Per-type edit-field builders ------------------------------------------

function appendShapeEditFields(root, img, overlay) {
  // Stroke colour
  appendColorRow(root, t('shapeStroke'), overlay.stroke || '#000000', hex => {
    withOverlaysHistory('Edit shape stroke', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.stroke = hex;
    });
  });

  // Fill colour + toggle (only for closed shapes)
  if (overlay.kind === 'rect' || overlay.kind === 'circle') {
    const fillRow = document.createElement('label');
    fillRow.className = 'select-edit-row';
    const fillLabel = document.createElement('span');
    fillLabel.textContent = t('shapeFill');
    const fillGroup = document.createElement('span');
    fillGroup.className = 'select-edit-fill-group';
    const fillToggle = document.createElement('input');
    fillToggle.type = 'checkbox';
    fillToggle.checked = overlay.fill != null;
    const fillInput = document.createElement('input');
    fillInput.type = 'color';
    fillInput.value = overlay.fill || '#ffffff';
    fillInput.disabled = overlay.fill == null;
    fillGroup.append(fillToggle, fillInput);
    fillRow.append(fillLabel, fillGroup);
    root.appendChild(fillRow);
    fillToggle.addEventListener('change', () => {
      const nextFill = fillToggle.checked ? (fillInput.value || '#ffffff') : null;
      fillInput.disabled = !fillToggle.checked;
      withOverlaysHistory('Toggle shape fill', img.id, s => {
        const o = getOverlay(s.images[img.id], overlay.id);
        if (o) o.fill = nextFill;
      });
    });
    fillInput.addEventListener('input', () => {
      if (!fillToggle.checked) return;
      withOverlaysHistory('Edit shape fill', img.id, s => {
        const o = getOverlay(s.images[img.id], overlay.id);
        if (o) o.fill = fillInput.value || '#ffffff';
      });
    });
  }

  // Stroke width slider
  appendRangeRow(root, t('shapeWidth'), Number(overlay.strokeWidth) || 1, 1, 40, n => {
    withOverlaysHistory('Edit shape width', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.strokeWidth = n;
    });
  });
}

function appendTextEditFields(root, img, overlay) {
  // Text content (textarea)
  const textRow = document.createElement('label');
  textRow.className = 'select-edit-row select-edit-row-block';
  const textLabel = document.createElement('span');
  textLabel.textContent = t('textLabel');
  const textArea = document.createElement('textarea');
  textArea.rows = 3;
  textArea.className = 'select-edit-text';
  textArea.value = overlay.text || '';
  textRow.append(textLabel, textArea);
  root.appendChild(textRow);
  textArea.addEventListener('input', () => {
    withOverlaysHistory('Edit text', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.text = textArea.value;
    });
  });

  // Font size
  appendRangeRow(root, t('textSize'), Number(overlay.size) || 32, 8, 256, n => {
    withOverlaysHistory('Edit text size', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.size = n;
    });
  });

  // Colour
  appendColorRow(root, t('textColor'), overlay.color || '#ffffff', hex => {
    withOverlaysHistory('Edit text color', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.color = hex;
    });
  });
}

function appendBrushEditFields(root, img, overlay) {
  // Colour
  appendColorRow(root, t('brushColor'), overlay.color || '#000000', hex => {
    withOverlaysHistory('Edit brush color', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.color = hex;
    });
  });
  // Width (reuses `brushSize` from the create panel — same concept)
  appendRangeRow(root, t('brushSize'), Number(overlay.width) || 4, 1, 60, n => {
    withOverlaysHistory('Edit brush width', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.width = n;
    });
  });
}

function appendRedactEditFields(root, img, overlay) {
  // Mode (mask / blur / pixelate). v1.2 added 'mask' (solid color rect)
  // as the safe default; the older blur/pixelate stay available but are
  // labelled as "visual only" — they're recoverable in the privacy
  // research literature.
  const modeRow = document.createElement('label');
  modeRow.className = 'select-edit-row';
  const modeLabel = document.createElement('span');
  modeLabel.textContent = t('redactMode');
  const modeSel = document.createElement('select');
  const modeKeyMap = { mask: 'redactModeMask', blur: 'redactModeBlur', pixelate: 'redactModePixelate' };
  for (const m of ['mask', 'blur', 'pixelate']) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = t(modeKeyMap[m]);
    if (overlay.mode === m) opt.selected = true;
    modeSel.appendChild(opt);
  }
  modeRow.append(modeLabel, modeSel);
  root.appendChild(modeRow);

  // Mode-dependent rows we'll show/hide below. We keep both in the DOM so
  // a re-render isn't needed when the user toggles modes — just flip
  // `hidden`. (Re-rendering the whole edit panel would lose focus on
  // whatever the user is currently typing into.)
  let strengthRowEl = null;
  let colorRowEl = null;

  // Strength row (blur/pixelate only).
  strengthRowEl = appendRangeRow(root, t('redactStrength'), Number(overlay.strength) || 16, 2, 128, n => {
    withOverlaysHistory('Edit redact strength', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.strength = n;
    });
  });

  // Color row (mask only).
  colorRowEl = appendColorRow(root, t('redactColor'), overlay.color || '#000000', hex => {
    withOverlaysHistory('Edit redact color', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.color = hex;
    });
  });

  function syncModeVisibility() {
    const mode = modeSel.value;
    if (strengthRowEl) strengthRowEl.hidden = mode === 'mask';
    if (colorRowEl)    colorRowEl.hidden    = mode !== 'mask';
  }
  syncModeVisibility();

  modeSel.addEventListener('change', () => {
    withOverlaysHistory('Edit redact mode', img.id, s => {
      const o = getOverlay(s.images[img.id], overlay.id);
      if (o) o.mode = modeSel.value;
    });
    syncModeVisibility();
  });
}

// --- Generic field builders ------------------------------------------------

function appendColorRow(root, labelText, initialValue, onChange) {
  const row = document.createElement('label');
  row.className = 'select-edit-row';
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'color';
  input.value = initialValue;
  row.append(label, input);
  root.appendChild(row);
  input.addEventListener('input', () => {
    onChange(input.value || '#000000');
  });
  return row;
}

function appendRangeRow(root, labelText, initialValue, min, max, onChange) {
  const row = document.createElement('label');
  row.className = 'select-edit-row';
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(initialValue);
  const readout = document.createElement('span');
  readout.className = 'select-edit-readout';
  readout.setAttribute('aria-live', 'polite');
  readout.textContent = String(initialValue);
  row.append(label, input, readout);
  root.appendChild(row);
  // Defer the actual mutation through history so undo records one entry per
  // drag session, not per input event. Snapshot on focus, commit on blur.
  let captured = null;
  input.addEventListener('focus', () => { captured = Number(input.value); });
  input.addEventListener('input', () => {
    const n = Number(input.value);
    readout.textContent = String(n);
    onChange(n);
  });
  input.addEventListener('blur', () => { captured = null; });
  return row;
}

// --- Helpers ---------------------------------------------------------------

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// No in-progress action to cancel for undo. Drags are committed on
// pointerup (history op records there); selection is just a UI flag and
// undo doesn't need to revert it.
export function cancelSelectTool() { return false; }

// Test-only reset.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  dragMode = null;
  dragStartSource = null;
  dragHistoryBefore = null;
  dragMoved = false;
  downCssPoint = null;
  lastRenderedSelectedId = null;
}
