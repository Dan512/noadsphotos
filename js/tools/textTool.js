// js/tools/textTool.js — text overlay tool: create, select, drag, edit.
//
// Behavior summary:
//   - When state.ui.activeTool === 'text' (and we're in the editor view with
//     an active image), the overlay canvas listens for pointer events.
//   - Click on empty area: create a new text overlay at the click's
//     source-pixel position (via previewRenderer.canvasToSource), select it.
//   - Click on an existing text overlay: select it.
//   - Drag a selected overlay: translate it.
//   - Side panel shows editing controls for the selected text overlay
//     (textarea, font, size, color, weight, align, delete).
//   - Switching to another tool deselects and clears the panel.
//
// Coordinates: overlay.x/y are in SOURCE-IMAGE pixel space, same as the rest
// of the per-image geometry.

import { attachPointer } from '../pointer.js';
import { getState, subscribe, update } from '../state.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import { newTextOverlay, measureText } from '../ops/text.js';
import {
  addOverlay,
  removeOverlay,
  getOverlay,
  moveOverlay,
  updateOverlay,
} from '../overlays.js';
import { canvasToSource, getDisplayZoom } from '../render/previewRenderer.js';
import { withOverlaysHistory } from '../historyOps.js';
import { recordOp } from '../history.js';
import { t } from '../i18n.js';

// Module-level state, reset across activate/deactivate.
let active = false;
let detach = null;
let overlayCanvas = null;
let lastRenderedSelectedId = null; // so we only rebuild the panel on selection change

// Drag tracking.
let dragMode = null; // 'move' | null
let dragStartSource = null;
let dragStartOverlayPos = null;
let downSourcePoint = null;
let downCssPoint = null;
let dragMoved = false;
// History capture for drag-move: the overlays list snapshot at pointerdown.
let dragHistoryBefore = null;

const CLICK_SLOP_CSS = 4; // px in CSS space — pointerup within this counts as a click

// Font options exposed in the side panel. v1 only ships Onest + system.
// Labels resolve via t() at render time so they re-translate.
const FONT_OPTIONS = [
  { value: 'Onest, system-ui, sans-serif', i18n: 'textFontOnest' },
  { value: 'system-ui, sans-serif',        i18n: 'textFontSystem' },
];

const WEIGHT_OPTIONS = [400, 500, 600, 700];

const ALIGN_OPTIONS = [
  { value: 'left',   i18n: 'textAlignLeft',   symbol: '⇤' },
  { value: 'center', i18n: 'textAlignCenter', symbol: '⇔' },
  { value: 'right',  i18n: 'textAlignRight',  symbol: '⇥' },
];

// Cached DOM refs while the panel is open.
let panelEls = null;

export function initTextTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'text';
  if (want && !active) activate();
  else if (!want && active) deactivate();
  else if (active) syncPanelFromState();
}

function activate() {
  overlayCanvas = document.getElementById('overlay-canvas');
  if (!overlayCanvas) return; // editor not yet mounted
  active = true;
  overlayCanvas.style.pointerEvents = 'auto';
  overlayCanvas.style.cursor = 'text';
  detach = attachPointer(overlayCanvas, { down, move, up });
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
  dragMode = null;
  dragStartSource = null;
  dragStartOverlayPos = null;
  downSourcePoint = null;
  dragMoved = false;
  panelEls = null;
  lastRenderedSelectedId = null;
  clearToolPanel({ owner: 'text' });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// --- pointer handlers ------------------------------------------------------

function down(e) {
  const img = getActiveImage();
  if (!img) return;
  const src = canvasToSource({ x: e.x, y: e.y });
  if (!src) return;
  downSourcePoint = src;
  downCssPoint = { x: e.x, y: e.y };
  dragMoved = false;

  // Find a text overlay under this point (topmost = last-drawn).
  const hit = hitTestText(img, src);
  const selId = getState().ui.selectedOverlayId;

  if (hit) {
    // Select it (if not already), and start a drag.
    if (hit.id !== selId) {
      update(s => { s.ui.selectedOverlayId = hit.id; });
    }
    dragMode = 'move';
    dragStartSource = src;
    dragStartOverlayPos = { x: hit.x, y: hit.y };
    // Snapshot the overlays list so pointerup can record a single move op.
    dragHistoryBefore = { overlays: structuredClone(img.overlays) };
    return;
  }
  // No hit — defer until pointerup so we don't create on a missed drag
  // (the create happens at click time only).
  dragMode = null;
}

function move(e) {
  if (!overlayCanvas || !downCssPoint) return;
  // Track movement regardless of whether we hit an overlay on pointerdown.
  // If the user drags in empty space we still want to know "did the cursor
  // move beyond click slop?" so we don't auto-create on accidental drags.
  const dxCss = e.x - downCssPoint.x;
  const dyCss = e.y - downCssPoint.y;
  if (Math.hypot(dxCss, dyCss) > CLICK_SLOP_CSS) dragMoved = true;
  if (!dragMode) return;
  const src = canvasToSource({ x: e.x, y: e.y });
  if (!src || !dragStartSource || !dragStartOverlayPos) return;

  if (dragMode === 'move') {
    const dx = src.x - dragStartSource.x;
    const dy = src.y - dragStartSource.y;
    const img = getActiveImage();
    const selId = getState().ui.selectedOverlayId;
    if (!img || !selId) return;
    const o = getOverlay(img, selId);
    if (!o) return;
    const targetX = dragStartOverlayPos.x + dx;
    const targetY = dragStartOverlayPos.y + dy;
    update(s => {
      const target = s.images[img.id];
      if (!target) return;
      moveOverlay(target, selId, targetX - o.x, targetY - o.y);
    });
  }
}

function up(_e) {
  const startedDrag = dragMode === 'move';
  const moved = dragMoved;
  dragMode = null;
  dragStartSource = null;
  dragStartOverlayPos = null;

  if (startedDrag) {
    // Drag on an existing overlay. If the cursor actually moved beyond the
    // click slop, record one history op for the whole drag. Drag-without-
    // movement (a click on an existing overlay) doesn't record.
    if (moved && dragHistoryBefore) {
      const img = getActiveImage();
      if (img) {
        const after = { overlays: structuredClone(img.overlays) };
        recordOp({
          label: 'Move text',
          imageId: img.id,
          kind: 'overlay',
          before: dragHistoryBefore,
          after,
        });
      }
    }
    dragHistoryBefore = null;
    downSourcePoint = null;
    downCssPoint = null;
    dragMoved = false;
    return;
  }

  // No drag started (no overlay was hit on pointerdown). Create a new
  // overlay only if this was a real click (cursor stayed near the down
  // position).
  if (!moved && downSourcePoint) {
    const img = getActiveImage();
    if (img) {
      // Pick a default font size so the text is roughly TARGET_CSS_PX tall
      // on screen at the current zoom — invisibly tiny defaults on huge
      // images and giant defaults on tiny ones both hurt usability. Falls
      // back to 5% of the source image height when the display zoom isn't
      // yet known (renderer hasn't produced a frame).
      const size = computeDefaultTextSize(img);
      const o = newTextOverlay(downSourcePoint.x, downSourcePoint.y, { size });
      withOverlaysHistory('Add text', img.id, state => {
        const target = state.images[img.id];
        if (!target) return;
        addOverlay(target, o);
        state.ui.selectedOverlayId = o.id;
      });
    }
  }

  downSourcePoint = null;
  downCssPoint = null;
  dragMoved = false;
}

// Topmost text overlay containing the source-pixel point, else null.
function hitTestText(img, srcPoint) {
  if (!img || !img.overlays) return null;
  const ctx = overlayCanvas && overlayCanvas.getContext('2d');
  for (let i = img.overlays.length - 1; i >= 0; i--) {
    const o = img.overlays[i];
    if (!o || o.type !== 'text') continue;
    if (!ctx) {
      // No context — fall back to a single-line guess.
      const w = String(o.text || '').length * (o.size || 32) * 0.6;
      const h = (o.size || 32) * 1.2;
      if (srcPoint.x >= o.x && srcPoint.x <= o.x + w &&
          srcPoint.y >= o.y && srcPoint.y <= o.y + h) {
        return o;
      }
      continue;
    }
    const m = measureText(ctx, o);
    if (m.w <= 0 || m.h <= 0) continue;
    if (srcPoint.x >= o.x && srcPoint.x <= o.x + m.w &&
        srcPoint.y >= o.y && srcPoint.y <= o.y + m.h) {
      return o;
    }
  }
  return null;
}

// --- side panel ------------------------------------------------------------

function renderPanel() {
  // Build the panel root once on activate. syncPanelFromState updates inputs
  // when state changes; full rebuild only happens on switch-overlay so we
  // don't lose focus on every keystroke.
  buildPanel();
}

function buildPanel() {
  const root = document.createElement('div');
  root.className = 'text-tool-panel';

  // h2 (not h3) per a11y heading-order: the editor view has a visually-hidden
  // h1, and the next level should be h2. Class controls the visual size; the
  // tag determines the AT outline level.
  const heading = document.createElement('h2');
  heading.className = 'panel-heading';
  heading.textContent = t('textTitle');
  root.appendChild(heading);

  // Empty-state hint (shown when no overlay is selected).
  const empty = document.createElement('p');
  empty.className = 'text-empty';
  empty.textContent = t('textEmpty');
  root.appendChild(empty);

  // Form (shown when an overlay is selected).
  const form = document.createElement('div');
  form.className = 'text-form';

  // Textarea.
  const textRow = document.createElement('label');
  textRow.className = 'text-row text-text-row';
  const textLabel = document.createElement('span');
  textLabel.textContent = t('textLabel');
  textRow.appendChild(textLabel);
  const textArea = document.createElement('textarea');
  textArea.className = 'text-input';
  textArea.rows = 3;
  textArea.setAttribute('aria-label', t('textAria'));
  textRow.appendChild(textArea);
  form.appendChild(textRow);

  // Font select.
  const fontRow = document.createElement('label');
  fontRow.className = 'text-row';
  const fontLabel = document.createElement('span');
  fontLabel.textContent = t('textFont');
  fontRow.appendChild(fontLabel);
  const fontSel = document.createElement('select');
  fontSel.className = 'text-font';
  fontSel.setAttribute('aria-label', t('textFontAria'));
  for (const f of FONT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = f.value;
    opt.textContent = t(f.i18n);
    fontSel.appendChild(opt);
  }
  fontRow.appendChild(fontSel);
  form.appendChild(fontRow);

  // Size input.
  const sizeRow = document.createElement('label');
  sizeRow.className = 'text-row';
  const sizeLabel = document.createElement('span');
  sizeLabel.textContent = t('textSize');
  sizeRow.appendChild(sizeLabel);
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.min = '8';
  sizeInput.max = '256';
  sizeInput.step = '1';
  sizeInput.className = 'text-size';
  sizeInput.setAttribute('aria-label', t('textSizeAria'));
  sizeRow.appendChild(sizeInput);
  form.appendChild(sizeRow);

  // Weight select.
  const weightRow = document.createElement('label');
  weightRow.className = 'text-row';
  const weightLabel = document.createElement('span');
  weightLabel.textContent = t('textWeight');
  weightRow.appendChild(weightLabel);
  const weightSel = document.createElement('select');
  weightSel.className = 'text-weight';
  weightSel.setAttribute('aria-label', t('textWeightAria'));
  for (const w of WEIGHT_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = String(w);
    weightSel.appendChild(opt);
  }
  weightRow.appendChild(weightSel);
  form.appendChild(weightRow);

  // Color input.
  const colorRow = document.createElement('label');
  colorRow.className = 'text-row';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = t('textColor');
  colorRow.appendChild(colorLabel);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'text-color';
  colorInput.setAttribute('aria-label', t('textColorAria'));
  colorRow.appendChild(colorInput);
  form.appendChild(colorRow);

  // Align buttons (3-up).
  const alignRow = document.createElement('div');
  alignRow.className = 'text-row text-align-row';
  const alignLabel = document.createElement('span');
  alignLabel.textContent = t('textAlign');
  alignRow.appendChild(alignLabel);
  const alignGroup = document.createElement('div');
  alignGroup.className = 'text-align-group';
  const alignBtns = {};
  for (const a of ALIGN_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `text-align-${a.value}`;
    btn.dataset.align = a.value;
    btn.textContent = a.symbol;
    const alignName = t(a.i18n);
    btn.title = alignName;
    btn.setAttribute('aria-label', t('textAlignAria', { label: alignName }));
    alignGroup.appendChild(btn);
    alignBtns[a.value] = btn;
  }
  alignRow.appendChild(alignGroup);
  form.appendChild(alignRow);

  // Delete button.
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'text-delete';
  deleteBtn.textContent = t('textDelete');
  form.appendChild(deleteBtn);

  root.appendChild(form);
  setToolPanel(root, { owner: 'text' });

  panelEls = {
    root, empty, form, textArea, fontSel, sizeInput,
    weightSel, colorInput, alignBtns, deleteBtn,
  };

  // Listeners. All commits go through update() so subscribers fire and the
  // renderer marks overlaysDirty.
  //
  // Text-area edits fire `input` per keystroke. We apply live (so the
  // preview is responsive) but only RECORD on blur, so one history entry
  // covers an entire typing session. The same applies to the size number
  // input (which can be held down on the spinner).
  textArea.addEventListener('focus', captureTextSessionBefore);
  textArea.addEventListener('input', () => {
    ensureTextSessionCaptured();
    withSelected(o => updateOverlay(getActiveImage(), o.id, { text: textArea.value }));
  });
  textArea.addEventListener('blur', () => commitTextSessionHistory('Edit text'));

  fontSel.addEventListener('change', () => {
    recordOverlayPatch('Set font', o => updateOverlay(getActiveImage(), o.id, { font: fontSel.value }));
  });
  sizeInput.addEventListener('focus', captureTextSessionBefore);
  sizeInput.addEventListener('input', () => {
    const n = clampSize(Number(sizeInput.value));
    if (!Number.isFinite(n)) return;
    ensureTextSessionCaptured();
    withSelected(o => updateOverlay(getActiveImage(), o.id, { size: n }));
  });
  sizeInput.addEventListener('change', () => commitTextSessionHistory('Set size'));
  sizeInput.addEventListener('blur',   () => commitTextSessionHistory('Set size'));

  weightSel.addEventListener('change', () => {
    recordOverlayPatch('Set weight', o => updateOverlay(getActiveImage(), o.id, { weight: Number(weightSel.value) }));
  });
  // <input type="color"> fires `input` while the picker is open and `change`
  // when closed; record on change so we get one entry per pick.
  colorInput.addEventListener('input', () => {
    withSelected(o => updateOverlay(getActiveImage(), o.id, { color: colorInput.value }));
  });
  colorInput.addEventListener('change', () => {
    // Caught by capture-before would over-record — use a simpler path:
    // snapshot manually using the post-input value already in state.
  });
  colorInput.addEventListener('focus', captureTextSessionBefore);
  colorInput.addEventListener('blur',  () => commitTextSessionHistory('Set color'));
  for (const a of ALIGN_OPTIONS) {
    alignBtns[a.value].addEventListener('click', () => {
      recordOverlayPatch(`Align ${a.value}`, o => updateOverlay(getActiveImage(), o.id, { align: a.value }));
    });
  }
  deleteBtn.addEventListener('click', () => {
    withSelected(o => {
      const img = getActiveImage();
      if (!img) return;
      withOverlaysHistory('Delete text', img.id, state => {
        const target = state.images[img.id];
        if (!target) return;
        removeOverlay(target, o.id);
        if (state.ui.selectedOverlayId === o.id) {
          state.ui.selectedOverlayId = null;
        }
      });
    });
  });

  syncPanelFromState();
}

function withSelected(fn) {
  const img = getActiveImage();
  if (!img) return;
  const selId = getState().ui.selectedOverlayId;
  if (!selId) return;
  const o = getOverlay(img, selId);
  if (!o || o.type !== 'text') return;
  // Wrap in update() so subscribers fire.
  update(_s => { fn(o); });
}

// History capture for textarea / size / color "sessions": apply live, but
// only record one entry per session boundary (focus → blur).
let textSessionImageId = null;
let textSessionBefore  = null;

function captureTextSessionBefore() {
  const img = getActiveImage();
  if (!img) { textSessionImageId = null; textSessionBefore = null; return; }
  textSessionImageId = img.id;
  textSessionBefore = { overlays: structuredClone(img.overlays) };
}

function ensureTextSessionCaptured() {
  if (textSessionBefore) return;
  captureTextSessionBefore();
}

function commitTextSessionHistory(label) {
  if (!textSessionImageId || !textSessionBefore) return;
  const id = textSessionImageId;
  const before = textSessionBefore;
  textSessionImageId = null;
  textSessionBefore = null;
  const img = getState().images[id];
  if (!img) return;
  const after = { overlays: structuredClone(img.overlays) };
  if (JSON.stringify(before.overlays) === JSON.stringify(after.overlays)) return;
  recordOp({ label, imageId: id, kind: 'overlay', before, after });
}

// Discrete-action helper for single-shot property changes (font, weight,
// align). Snapshots before, applies via `withSelected`, records after.
function recordOverlayPatch(label, applyFn) {
  const img = getActiveImage();
  if (!img) return;
  const selId = getState().ui.selectedOverlayId;
  if (!selId) return;
  const before = { overlays: structuredClone(img.overlays) };
  withSelected(applyFn);
  const after = { overlays: structuredClone(getState().images[img.id].overlays) };
  if (JSON.stringify(before.overlays) === JSON.stringify(after.overlays)) return;
  recordOp({ label, imageId: img.id, kind: 'overlay', before, after });
}

function clampSize(n) {
  if (!Number.isFinite(n)) return NaN;
  if (n < 8)   return 8;
  if (n > 256) return 256;
  return n;
}

function syncPanelFromState() {
  if (!panelEls) return;
  const img = getActiveImage();
  const selId = getState().ui.selectedOverlayId;
  const o = (img && selId) ? getOverlay(img, selId) : null;
  const isText = o && o.type === 'text';

  if (!isText) {
    panelEls.empty.hidden = false;
    panelEls.form.hidden = true;
    lastRenderedSelectedId = null;
    return;
  }
  panelEls.empty.hidden = true;
  panelEls.form.hidden = false;

  const focused = document.activeElement;

  if (focused !== panelEls.textArea && panelEls.textArea.value !== String(o.text ?? '')) {
    panelEls.textArea.value = String(o.text ?? '');
  }
  if (focused !== panelEls.fontSel) {
    panelEls.fontSel.value = o.font || FONT_OPTIONS[0].value;
  }
  if (focused !== panelEls.sizeInput && Number(panelEls.sizeInput.value) !== o.size) {
    panelEls.sizeInput.value = String(o.size ?? 32);
  }
  if (focused !== panelEls.weightSel) {
    panelEls.weightSel.value = String(o.weight ?? 500);
  }
  if (focused !== panelEls.colorInput) {
    panelEls.colorInput.value = o.color || '#000000';
  }
  for (const a of ALIGN_OPTIONS) {
    const btn = panelEls.alignBtns[a.value];
    if (!btn) continue;
    btn.classList.toggle('is-active', (o.align || 'left') === a.value);
  }

  lastRenderedSelectedId = selId;
}

// Pick a default font size for a new text overlay so the rendered glyphs
// are visibly readable at the current zoom — about TARGET_CSS_PX tall on
// screen. The source-pixel size is `target / displayZoom`; clamped to a
// sane band so users can still tweak via the slider.
const TARGET_CSS_PX = 24;
const MIN_SOURCE_PX = 16;
const MAX_SOURCE_PX = 512;

function computeDefaultTextSize(img) {
  const zoom = getDisplayZoom();
  if (zoom && Number.isFinite(zoom) && zoom > 0) {
    const px = Math.round(TARGET_CSS_PX / zoom);
    return Math.max(MIN_SOURCE_PX, Math.min(MAX_SOURCE_PX, px));
  }
  // No display zoom available — fall back to ~5% of source image height,
  // which renders at a reasonable size for the common 100–4000 px range.
  const h = img && img.source ? img.source.height : 0;
  if (h && Number.isFinite(h)) {
    const fallback = Math.round(h * 0.05);
    return Math.max(16, Math.min(256, fallback));
  }
  return 32; // last-resort default
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  panelEls = null;
  dragMode = null;
  dragStartSource = null;
  dragStartOverlayPos = null;
  downSourcePoint = null;
  downCssPoint = null;
  dragMoved = false;
  dragHistoryBefore = null;
  textSessionImageId = null;
  textSessionBefore = null;
  lastRenderedSelectedId = null;
}
