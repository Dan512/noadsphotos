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
import { detectFaces } from '../ops/faceDetect.js';
import { detectText } from '../ops/textDetect.js';
import { showToast } from '../errors.js';
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

// v1.2: 'mask' is the privacy-safe default (blur is reversible at low
// strength — see redact.js for the full rationale).
//
// Tool state used to live in module-locals here. As of the v1.2 batch-detect
// feature it's hoisted to state.ui.redact so the queue's batch panel and
// the editor's side panel both read/write the same source of truth.
// These tiny accessors keep the surrounding code readable.
function toolMode()     { return (getState().ui.redact && getState().ui.redact.mode)     || 'mask'; }
function toolStrength() { return (getState().ui.redact && getState().ui.redact.strength) || 12; }
function toolColor()    { return (getState().ui.redact && getState().ui.redact.color)    || '#000000'; }
function setToolMode(v)     { update(s => { s.ui.redact.mode     = v; }); }
function setToolStrength(v) { update(s => { s.ui.redact.strength = v; }); }
function setToolColor(v)    { update(s => { s.ui.redact.color    = v; }); }

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
  else if (want && active) {
    syncPanelFromSelection();
    // When the batch panel mutates state.ui.redact (or selection sync
    // changed it), reflect that in the editor-side controls.
    syncModeBtns();
    syncSensitivityBtns();
    syncOcrPreviewSection();
  }
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
  if (o.mode && o.mode !== toolMode()) {
    setToolMode(o.mode);
    syncModeBtns();
  }
  const sNum = Number(o.strength);
  if (Number.isFinite(sNum) && sNum !== toolStrength()) {
    setToolStrength(sNum);
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
    mode: toolMode(),
    strength: toolStrength(),
    color: toolColor(),
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
    mode: toolMode(),
    strength: toolStrength(),
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
    btn.textContent = mode === 'mask'     ? t('redactModeMask')
                    : mode === 'pixelate' ? t('redactModePixelate')
                    : t('redactModeBlur');
    btn.setAttribute('aria-label', btn.textContent);
    btn.addEventListener('click', () => {
      setToolMode(mode);
      syncModeBtns();
      patchSelectedRedact({ mode });
    });
    modeGroup.appendChild(btn);
    modeBtns[mode] = btn;
  }
  modeRow.appendChild(modeGroup);
  root.appendChild(modeRow);

  // Strength slider. Only meaningful for blur + pixelate — mask is a solid
  // color rectangle so "strength" doesn't apply. Hidden when mode === 'mask'.
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
  strengthInput.value = String(toolStrength());
  strengthInput.className = 'redact-strength';
  strengthInput.setAttribute('aria-label', t('redactStrengthAria'));
  strengthRow.appendChild(strengthInput);
  const strengthReadout = document.createElement('span');
  strengthReadout.className = 'redact-strength-readout';
  strengthReadout.setAttribute('aria-live', 'polite');
  strengthReadout.textContent = String(toolStrength());
  strengthRow.appendChild(strengthReadout);
  root.appendChild(strengthRow);

  // Color picker for mask mode. Hidden for blur/pixelate.
  const colorRow = document.createElement('label');
  colorRow.className = 'redact-row redact-color-row';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = t('redactColor');
  colorRow.appendChild(colorLabel);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = toolColor();
  colorInput.className = 'redact-color';
  colorInput.setAttribute('aria-label', t('redactColor'));
  colorInput.addEventListener('input', () => {
    const next = colorInput.value || '#000000';
    setToolColor(next);
    patchSelectedRedact({ color: next });
  });
  colorRow.appendChild(colorInput);
  root.appendChild(colorRow);

  // Sensitivity row for the AI-detect buttons below. Three preset chips
  // (Strict / Normal / Loose) controlling state.ui.aiDetectSensitivity.
  // Shared between Auto-detect faces and Detect text — they're both AI
  // detections of "things on the canvas," and one global knob keeps the
  // panel from getting overwhelmed. Mapping to per-model thresholds lives
  // in js/ops/faceDetect.js + js/ops/textDetect.js.
  const sensitivityRow = document.createElement('div');
  sensitivityRow.className = 'redact-row redact-sensitivity-row';
  const sensitivityLabel = document.createElement('span');
  sensitivityLabel.textContent = t('redactDetectSensitivity');
  sensitivityRow.appendChild(sensitivityLabel);
  const sensitivityGroup = document.createElement('div');
  sensitivityGroup.className = 'redact-sensitivity-group';
  const sensitivityBtns = {};
  for (const level of ['strict', 'normal', 'loose']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `redact-sensitivity redact-sensitivity-${level}`;
    btn.dataset.level = level;
    const labelKey = 'redactDetectSensitivity' + level[0].toUpperCase() + level.slice(1);
    btn.textContent = t(labelKey);
    btn.setAttribute('aria-label', btn.textContent);
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      update(s => { s.ui.aiDetectSensitivity = level; });
      syncSensitivityBtns();
    });
    sensitivityGroup.appendChild(btn);
    sensitivityBtns[level] = btn;
  }
  sensitivityRow.appendChild(sensitivityGroup);
  root.appendChild(sensitivityRow);

  // Auto-detect faces button (v1.2 Feature 1). Runs the vendored BlazeFace
  // ONNX against the source bitmap, one mask redact overlay per detected
  // face. Lazy-loaded model — first click prompts the one-time consent
  // modal disclosing the ~600 KB download.
  const detectFacesBtn = document.createElement('button');
  detectFacesBtn.type = 'button';
  detectFacesBtn.className = 'redact-detect-faces';
  detectFacesBtn.textContent = t('redactDetectFaces');
  detectFacesBtn.setAttribute('aria-label', t('redactDetectFaces'));
  detectFacesBtn.addEventListener('click', () => onDetectFaces(detectFacesBtn));
  root.appendChild(detectFacesBtn);

  // Auto-detect text button (v1.2 Feature 4). Runs the vendored Tesseract.js
  // OCR engine against the source bitmap, one mask redact overlay per
  // detected text LINE (not word — line-level granularity matches the
  // privacy redact use case). Lazy-loaded engine — first click prompts the
  // one-time consent modal disclosing the ~6 MB download. Subsequent
  // clicks reuse the worker.
  const detectTextBtn = document.createElement('button');
  detectTextBtn.type = 'button';
  detectTextBtn.className = 'redact-detect-text';
  detectTextBtn.textContent = t('redactDetectText');
  detectTextBtn.setAttribute('aria-label', t('redactDetectText'));
  detectTextBtn.addEventListener('click', () => onDetectText(detectTextBtn));
  root.appendChild(detectTextBtn);

  // OCR preview-mode controls. Hidden by default; revealed when state.ui.
  // ocrPreview.active flips on (after "Detect text" populates the preview).
  // Status line shows count + selected count. The three buttons commit /
  // commit-all / cancel respectively.
  const ocrPreviewSection = document.createElement('div');
  ocrPreviewSection.className = 'redact-ocr-preview';
  ocrPreviewSection.hidden = true;
  const ocrPreviewStatus = document.createElement('p');
  ocrPreviewStatus.className = 'redact-ocr-preview-status';
  ocrPreviewStatus.setAttribute('aria-live', 'polite');
  ocrPreviewSection.appendChild(ocrPreviewStatus);
  const ocrApplySelectedBtn = document.createElement('button');
  ocrApplySelectedBtn.type = 'button';
  ocrApplySelectedBtn.className = 'redact-ocr-apply-selected btn-primary';
  ocrApplySelectedBtn.textContent = t('ocrPreviewApplySelected');
  ocrApplySelectedBtn.addEventListener('click', () => applyOcrSelected());
  ocrPreviewSection.appendChild(ocrApplySelectedBtn);
  const ocrApplyAllBtn = document.createElement('button');
  ocrApplyAllBtn.type = 'button';
  ocrApplyAllBtn.className = 'redact-ocr-apply-all';
  ocrApplyAllBtn.textContent = t('ocrPreviewApplyAll');
  ocrApplyAllBtn.addEventListener('click', () => applyOcrAll());
  ocrPreviewSection.appendChild(ocrApplyAllBtn);
  const ocrCancelBtn = document.createElement('button');
  ocrCancelBtn.type = 'button';
  ocrCancelBtn.className = 'redact-ocr-cancel';
  ocrCancelBtn.textContent = t('ocrPreviewCancel');
  ocrCancelBtn.addEventListener('click', () => cancelOcrPreview());
  ocrPreviewSection.appendChild(ocrCancelBtn);
  root.appendChild(ocrPreviewSection);

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
  panelEls = {
    modeBtns, strengthInput, strengthReadout, applyBtn,
    strengthRow, colorRow, colorInput,
    sensitivityBtns,
    ocrPreviewSection, ocrPreviewStatus,
    ocrApplySelectedBtn,
  };
  // Apply initial show/hide for the new color/strength rows.
  syncModeBtns();
  syncSensitivityBtns();
  syncOcrPreviewSection();

  strengthInput.addEventListener('input', () => {
    const n = clampStrength(Number(strengthInput.value));
    if (!Number.isFinite(n)) return;
    setToolStrength(n);
    strengthReadout.textContent = String(Math.round(n));
    patchSelectedRedact({ strength: n });
  });

  syncModeBtns();
}

// Sync the OCR preview section's visibility + status label from
// state.ui.ocrPreview. Hidden when inactive; shows count + selected
// count when active. Also toggles the regular Apply/Detect buttons'
// emphasis so it's obvious the user is in a different mode.
function syncOcrPreviewSection() {
  if (!panelEls || !panelEls.ocrPreviewSection) return;
  const p = getState().ui.ocrPreview || { active: false, lines: [] };
  panelEls.ocrPreviewSection.hidden = !p.active;
  if (!p.active) return;
  const total = p.lines.length;
  const selected = p.lines.filter(l => l.selected).length;
  panelEls.ocrPreviewStatus.textContent = t('ocrPreviewStatus', { selected, total });
  // Disable the Apply Selected button when nothing's marked.
  panelEls.ocrApplySelectedBtn.disabled = selected === 0;
}

// Sync the active state on the three sensitivity preset chips from
// state.ui.aiDetectSensitivity.
function syncSensitivityBtns() {
  if (!panelEls || !panelEls.sensitivityBtns) return;
  const level = (getState().ui && getState().ui.aiDetectSensitivity) || 'normal';
  for (const k of ['strict', 'normal', 'loose']) {
    const btn = panelEls.sensitivityBtns[k];
    if (!btn) continue;
    const active = k === level;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
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
  const mode = toolMode();
  for (const m of REDACT_MODES) {
    const btn = panelEls.modeBtns[m];
    if (!btn) continue;
    btn.classList.toggle('is-active', m === mode);
  }
  // Strength is for blur/pixelate only; color is for mask only.
  if (panelEls.strengthRow) panelEls.strengthRow.hidden = mode === 'mask';
  if (panelEls.colorRow)    panelEls.colorRow.hidden    = mode !== 'mask';
  // Keep input values in sync with state (e.g. when batch panel changed them).
  if (panelEls.strengthInput && document.activeElement !== panelEls.strengthInput) {
    const s = toolStrength();
    panelEls.strengthInput.value = String(s);
    if (panelEls.strengthReadout) panelEls.strengthReadout.textContent = String(Math.round(s));
  }
  if (panelEls.colorInput && document.activeElement !== panelEls.colorInput) {
    panelEls.colorInput.value = toolColor();
  }
}

function clampStrength(n) {
  if (!Number.isFinite(n)) return NaN;
  if (n < MIN_STRENGTH) return MIN_STRENGTH;
  if (n > MAX_STRENGTH) return MAX_STRENGTH;
  return n;
}

// v1.2 Feature 1: run BlazeFace against the source bitmap and seed the
// canvas with one mask-mode redact overlay per detected face. The model
// + ORT session are lazy-loaded on first click (one-time ~600 KB
// download, gated by a consent modal). Errors are non-fatal toasts so a
// missing model file or a no-faces image doesn't break the editor.
async function onDetectFaces(btn) {
  const img = getActiveImage();
  if (!img || !img.source) {
    showToast(t('redactDetectNoImage'), { variant: 'warn' });
    return;
  }
  const bitmap = img.source.bitmap;
  if (!bitmap) {
    showToast(t('redactDetectNoBitmap'), { variant: 'warn' });
    return;
  }
  const prevLabel = btn.textContent;
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = t('redactDetectRunning');
  const sensitivity = (getState().ui && getState().ui.aiDetectSensitivity) || 'normal';
  let rects;
  try {
    rects = await detectFaces(bitmap, { sensitivity });
  } catch (err) {
    btn.disabled = prevDisabled;
    btn.textContent = prevLabel;
    if (err && err.message === 'face_consent_declined') {
      // User cancelled the consent modal — nothing to do; no toast needed.
      return;
    }
    // eslint-disable-next-line no-console
    console.error('redactTool: detectFaces failed', err);
    showToast(t('redactDetectFailed'), { variant: 'error' });
    return;
  }
  btn.disabled = prevDisabled;
  btn.textContent = prevLabel;

  if (!rects || rects.length === 0) {
    showToast(t('redactDetectNoFaces'), { variant: 'info' });
    return;
  }

  // Add one redact overlay per detected face. All under a SINGLE history
  // transaction so a Ctrl+Z reverts the whole batch in one step.
  //
  // We pass the user's CURRENT tool settings (mode + color + strength) so
  // detection produces redacts that match what they were about to draw by
  // hand. So a user in pixelate mode at strength 24 gets pixelated faces,
  // not always-black masks. The color setting only matters for mask mode
  // (newRedactOverlay stores it regardless, the renderer ignores it for
  // blur/pixelate).
  const mode = toolMode();
  const color = toolColor();
  const strength = toolStrength();
  withOverlaysHistory(`Auto-redact ${rects.length} face${rects.length === 1 ? '' : 's'}`, img.id, state => {
    const target = state.images[img.id];
    if (!target) return;
    for (const r of rects) {
      if (r.w < 4 || r.h < 4) continue; // skip degenerate detections
      const overlay = newRedactOverlay(r.x, r.y, r.w, r.h, {
        mode, color, strength,
      });
      addOverlay(target, overlay);
    }
    // Deselect: the user just got N overlays at once, don't pin the
    // selection to one of them.
    state.ui.selectedOverlayId = null;
  });

  showToast(t('redactDetectSuccess', { count: rects.length }), { variant: 'info' });
}

// v1.2 Feature 4: run Tesseract.js OCR against the source bitmap and seed
// the canvas with one mask-mode redact overlay per detected text LINE. The
// engine + worker are lazy-loaded on first click (one-time ~6 MB download,
// gated by a consent modal). Errors are non-fatal toasts so a missing model
// file, an empty image, or worker init failure doesn't break the editor.
//
// v1.2 ship: auto-mask every detected line. The interactive preview-select
// mode described in the design doc is deferred to v1.2.1 — users for now
// can Ctrl+Z to revert the whole batch, or click an individual overlay and
// press Delete to drop just that one.
async function onDetectText(btn) {
  const img = getActiveImage();
  if (!img || !img.source) {
    showToast(t('redactDetectNoImage'), { variant: 'warn' });
    return;
  }
  const bitmap = img.source.bitmap;
  if (!bitmap) {
    showToast(t('redactDetectNoBitmap'), { variant: 'warn' });
    return;
  }
  const prevLabel = btn.textContent;
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = t('redactDetectRunning');

  // Surface Tesseract's recognize-progress messages on the button label so
  // users see progress during the multi-second OCR pass (especially on
  // phones, where it can take 5–15 s on a busy screenshot).
  const onProgress = (msg) => {
    if (!msg || msg.status !== 'recognizing text') return;
    const pct = Math.max(0, Math.min(100, Math.round((msg.progress || 0) * 100)));
    btn.textContent = t('redactDetectTextProgress', { progress: pct });
  };

  const sensitivity = (getState().ui && getState().ui.aiDetectSensitivity) || 'normal';
  let rects;
  try {
    rects = await detectText(bitmap, { progress: onProgress, sensitivity });
  } catch (err) {
    btn.disabled = prevDisabled;
    btn.textContent = prevLabel;
    if (err && err.message === 'text_consent_declined') {
      // User cancelled the consent modal — nothing to do; no toast needed.
      return;
    }
    // eslint-disable-next-line no-console
    console.error('redactTool: detectText failed', err);
    showToast(t('redactDetectTextFailed'), { variant: 'error' });
    return;
  }
  btn.disabled = prevDisabled;
  btn.textContent = prevLabel;

  if (!rects || rects.length === 0) {
    showToast(t('redactDetectTextNoText'), { variant: 'info' });
    return;
  }

  // v1.2.x: enter OCR preview-select mode instead of immediately
  // committing. The renderer paints yellow boxes per detected line + red
  // for any line whose recognized text matched a PII regex (autoFlag).
  // The user reviews, toggles selection by clicking thumbnails, then
  // clicks "Apply selected" / "Apply all" / "Cancel" from the redact
  // tool's panel.
  update(state => {
    state.ui.ocrPreview.active = true;
    state.ui.ocrPreview.imageId = img.id;
    state.ui.ocrPreview.lines = rects.map(r => ({
      rect: { x: r.x, y: r.y, w: r.w, h: r.h },
      text: r.text || '',
      selected: !!r.autoFlag,
      autoFlag: !!r.autoFlag,
    }));
    // Deselect any overlay since the preview UI takes over the canvas.
    state.ui.selectedOverlayId = null;
  });

  const preselected = rects.filter(r => r.autoFlag).length;
  showToast(t('ocrPreviewEntered', { total: rects.length, preselected }), { variant: 'info' });
}

// --- OCR preview-mode actions --------------------------------------------

// Commit currently-selected lines as redact overlays. Single history
// transaction → Ctrl+Z reverts the whole batch.
function applyOcrSelected() {
  const s = getState();
  if (!s.ui.ocrPreview.active) return;
  const imgId = s.ui.ocrPreview.imageId;
  const target = imgId ? s.images[imgId] : null;
  if (!target) {
    cancelOcrPreview();
    return;
  }
  const selectedLines = s.ui.ocrPreview.lines.filter(l => l.selected);
  if (selectedLines.length === 0) {
    showToast(t('ocrPreviewNoneSelected'), { variant: 'warn' });
    return;
  }
  const mode = toolMode();
  const color = toolColor();
  const strength = toolStrength();
  withOverlaysHistory(
    `Auto-redact ${selectedLines.length} text line${selectedLines.length === 1 ? '' : 's'}`,
    imgId,
    state => {
      const img2 = state.images[imgId];
      if (!img2) return;
      for (const line of selectedLines) {
        const r = line.rect;
        if (!r || r.w < 4 || r.h < 4) continue;
        addOverlay(img2, newRedactOverlay(r.x, r.y, r.w, r.h, { mode, color, strength }));
      }
      state.ui.selectedOverlayId = null;
    },
  );
  // Exit preview mode after commit.
  update(state => {
    state.ui.ocrPreview.active  = false;
    state.ui.ocrPreview.imageId = null;
    state.ui.ocrPreview.lines   = [];
  });
  showToast(t('redactDetectTextSuccess', { count: selectedLines.length }), { variant: 'info' });
}

// Select all lines, then apply.
function applyOcrAll() {
  update(state => {
    if (!state.ui.ocrPreview.active) return;
    for (const l of state.ui.ocrPreview.lines) l.selected = true;
  });
  applyOcrSelected();
}

// Discard preview without committing.
function cancelOcrPreview() {
  update(state => {
    state.ui.ocrPreview.active  = false;
    state.ui.ocrPreview.imageId = null;
    state.ui.ocrPreview.lines   = [];
  });
}

// Toggle a single line's selected state. Called from the renderer's
// pointer handler when the user clicks within a preview rect.
function toggleOcrLine(index) {
  update(state => {
    const lines = state.ui.ocrPreview.lines;
    if (index < 0 || index >= lines.length) return;
    lines[index].selected = !lines[index].selected;
  });
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  panelEls = null;
  drawing = null;
  // Reset hoisted state to defaults so the next test starts clean.
  try {
    update(s => {
      s.ui.redact.mode = 'mask';
      s.ui.redact.strength = 12;
      s.ui.redact.color = '#000000';
    });
  } catch { /* ignore — test envs may have stubbed update */ }
}
