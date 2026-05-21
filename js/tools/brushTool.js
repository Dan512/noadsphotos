// js/tools/brushTool.js — freehand brush tool.
//
// Behavior summary:
//   - When state.ui.activeTool === 'brush' (and we're in the editor with an
//     active image), the overlay canvas listens for pointer events.
//   - pointerdown:   start a new in-progress stroke (tool-local, NOT in
//                    state yet — so we don't dirty the renderer's overlay
//                    cache on every pointermove).
//   - pointermove:   append (x, y, pressure) in source-pixel coords. The
//                    in-progress stroke is rendered by a tool-overlay
//                    drawer registered with the previewRenderer (drawn on
//                    top of the committed overlay layer every rAF tick).
//   - pointerup:     commit the stroke to state via addOverlay; clear the
//                    tool-overlay drawer.
//   - Tap (no drag): discard (no zero-length stroke).
//
// Side panel:
//   - Heading "Brush"
//   - Color picker (default #000000)
//   - Size slider 1..50 px (default 8)
//   - Live preview swatch showing color + line at the current size
//   - Hint text
//
// Tool-local choices (color/size) persist across strokes for the duration
// of the tool's activation. They are NOT stored on the image — different
// strokes can have different colors and sizes.
//
// History is deferred to Phase 8 — for v1 the commit-on-up path simply
// adds the overlay; undo/redo will hook into the commit timing later.

import { attachPointer } from '../pointer.js';
import { getState, subscribe, update } from '../state.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import { newBrushOverlay, appendPoint, drawBrush } from '../ops/brush.js';
import { addOverlay } from '../overlays.js';
import { withOverlaysHistory } from '../historyOps.js';
import { t } from '../i18n.js';
import { getSetting } from '../settings.js';
import {
  canvasToSource,
  setOverlayDrawer,
  clearOverlayDrawer,
  applySourceTransform,
} from '../render/previewRenderer.js';

let active = false;
let detach = null;
let overlayCanvas = null;

// Module-level brush settings. Reset to defaults across activate/deactivate
// so each session starts predictably; they persist across strokes within
// one activation.
let toolColor = '#000000';
let toolSize  = 8;

// In-progress stroke (only present between pointerdown and pointerup).
let drawing = null; // { points: Float32Array }

let panelEls = null; // { colorInput, sizeInput, sizeReadout, swatch }

const MIN_SIZE = 1;
const MAX_SIZE = 50;

export function initBrushTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'brush';
  if (want && !active) activate();
  else if (!want && active) deactivate();
}

function activate() {
  overlayCanvas = document.getElementById('overlay-canvas');
  if (!overlayCanvas) return;
  active = true;
  overlayCanvas.style.pointerEvents = 'auto';
  overlayCanvas.style.cursor = 'crosshair';
  detach = attachPointer(overlayCanvas, { down, move, up, cancel: cancelStroke });
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
  clearToolPanel({ owner: 'brush' });
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
  // Start a fresh in-progress stroke.
  drawing = {
    points: appendPoint(new Float32Array(0), src.x, src.y, normalizePressure(e.pressure)),
  };
  // Hook the tool-overlay drawer so the in-progress stroke is painted on
  // top of committed overlays every rAF tick. Hold a closure over the
  // current color/size so the renderer sees the user's current choices.
  setOverlayDrawer(drawInProgress);
}

function move(e) {
  if (!drawing) return;
  const src = canvasToSource({ x: e.x, y: e.y });
  if (!src) return;
  drawing.points = appendPoint(drawing.points, src.x, src.y, normalizePressure(e.pressure));
  // No state mutation — the renderer's overlay tick will call drawInProgress
  // on the next frame (overlayDrawer is set, so the loop redraws every
  // frame even without an overlaysDirty flag).
}

function up(_e) {
  if (!drawing) {
    clearOverlayDrawer();
    return;
  }
  const points = drawing.points;
  drawing = null;
  clearOverlayDrawer();

  // Discard zero-length strokes (single tap with no movement is fine for
  // text, but pointless for the brush — produces an invisible single dot).
  if (!points || points.length < 6) {
    // 6 = two stride-3 entries = one segment minimum.
    // A single point still draws (round cap) — but in practice a quick
    // tap usually means "I meant to select something" so dropping it
    // matches the shape tool's tap-discards behavior.
    return;
  }

  const img = getActiveImage();
  if (!img) return;
  const overlay = newBrushOverlay({ color: toolColor, size: toolSize });
  overlay.points = points;

  withOverlaysHistory('Brush stroke', img.id, state => {
    const target = state.images[img.id];
    if (!target) return;
    addOverlay(target, overlay);
    state.ui.selectedOverlayId = overlay.id;
  });
}

function cancelStroke() {
  drawing = null;
  clearOverlayDrawer();
}

function normalizePressure(p) {
  if (!Number.isFinite(p) || p <= 0) return 0.5;
  if (p > 1) return 1;
  return p;
}

// --- preview drawer -------------------------------------------------------

// Draw the in-progress stroke onto the overlay canvas. The renderer
// invokes our overlayDrawer AFTER its own draw + restore, so the context
// is back at the identity transform. We re-apply the same source →
// canvas-internal forward transform via the renderer's helper so source
// coordinates land where the matching image pixels land.
function drawInProgress(ctx, _canvas) {
  if (!drawing || !drawing.points || drawing.points.length === 0) return;
  ctx.save();
  if (!applySourceTransform(ctx)) {
    ctx.restore();
    return;
  }
  // Reuse drawBrush so the smoothing behavior is identical to the
  // committed-overlay render. Respect the smoothBrushStrokes setting so
  // the in-progress stroke matches the final committed overlay.
  drawBrush(
    ctx,
    { points: drawing.points, color: toolColor, size: toolSize },
    { smooth: getSetting('smoothBrushStrokes') !== false },
  );
  ctx.restore();
}

// --- side panel ----------------------------------------------------------

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'brush-tool-panel';

  const heading = document.createElement('h2');
  heading.className = 'panel-heading';
  heading.textContent = t('brushTitle');
  root.appendChild(heading);

  // Color row.
  const colorRow = document.createElement('label');
  colorRow.className = 'brush-row';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = t('brushColor');
  colorRow.appendChild(colorLabel);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'brush-color';
  colorInput.value = toolColor;
  colorInput.setAttribute('aria-label', t('brushColorAria'));
  colorRow.appendChild(colorInput);
  root.appendChild(colorRow);

  // Size row (slider + readout).
  const sizeRow = document.createElement('label');
  sizeRow.className = 'brush-row brush-size-row';
  const sizeLabel = document.createElement('span');
  sizeLabel.textContent = t('brushSize');
  sizeRow.appendChild(sizeLabel);
  const sizeInput = document.createElement('input');
  sizeInput.type = 'range';
  sizeInput.min = String(MIN_SIZE);
  sizeInput.max = String(MAX_SIZE);
  sizeInput.step = '1';
  sizeInput.value = String(toolSize);
  sizeInput.className = 'brush-size';
  sizeInput.setAttribute('aria-label', t('brushSizeAria'));
  sizeRow.appendChild(sizeInput);
  const sizeReadout = document.createElement('span');
  sizeReadout.className = 'brush-size-readout';
  sizeReadout.setAttribute('aria-live', 'polite');
  sizeReadout.textContent = String(toolSize);
  sizeRow.appendChild(sizeReadout);
  root.appendChild(sizeRow);

  // Preview swatch — a small canvas showing the current color + size.
  const swatchRow = document.createElement('div');
  swatchRow.className = 'brush-row brush-swatch-row';
  const swatchLabel = document.createElement('span');
  swatchLabel.textContent = t('brushPreview');
  swatchRow.appendChild(swatchLabel);
  const swatch = document.createElement('canvas');
  swatch.className = 'brush-swatch';
  swatch.width = 80;
  swatch.height = 32;
  swatch.style.width = '80px';
  swatch.style.height = '32px';
  swatch.setAttribute('aria-label', t('brushPreviewAria'));
  swatchRow.appendChild(swatch);
  root.appendChild(swatchRow);

  // Hint.
  const hint = document.createElement('p');
  hint.className = 'brush-hint';
  hint.textContent = t('brushHint');
  root.appendChild(hint);

  setToolPanel(root, { owner: 'brush' });
  panelEls = { colorInput, sizeInput, sizeReadout, swatch };

  // Listeners.
  colorInput.addEventListener('input', () => {
    toolColor = colorInput.value || '#000000';
    drawSwatch();
  });
  sizeInput.addEventListener('input', () => {
    const n = clampSize(Number(sizeInput.value));
    if (!Number.isFinite(n)) return;
    toolSize = n;
    sizeReadout.textContent = String(Math.round(n));
    drawSwatch();
  });

  drawSwatch();
}

function clampSize(n) {
  if (!Number.isFinite(n)) return NaN;
  if (n < MIN_SIZE) return MIN_SIZE;
  if (n > MAX_SIZE) return MAX_SIZE;
  return n;
}

function drawSwatch() {
  if (!panelEls || !panelEls.swatch) return;
  const c = panelEls.swatch;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.strokeStyle = toolColor;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Cap displayed stroke at swatch height so a 50px brush doesn't overflow
  // the 32px canvas.
  ctx.lineWidth = Math.min(toolSize, c.height - 4);
  ctx.beginPath();
  ctx.moveTo(8, c.height / 2);
  ctx.lineTo(c.width - 8, c.height / 2);
  ctx.stroke();
  ctx.restore();
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  panelEls = null;
  drawing = null;
  toolColor = '#000000';
  toolSize = 8;
}
