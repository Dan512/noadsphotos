// js/tools/transformTool.js — Rotate + Flip side-panel tool.
//
// v1.1.2: rotate/flip moved out of the Select tool's panel and into a
// dedicated 'transform' tool. Select is now strictly the pointer / overlay
// editor (see selectTool.js). The image-level transforms — rotate ±90°,
// rotate slider 0–360°, flip horizontal/vertical — used to live in Select
// because there was nowhere else for them; v1.1.2 gives them a real home
// behind a toolbar button.
//
// Mutations go through ops/transforms.js so the export pipeline shares
// the same logic.
import { getState, subscribe, update } from '../state.js';
import { applyRotate, applyFlip } from '../ops/transforms.js';
import { setToolPanel, clearToolPanel, getToolPanelBody } from '../editor.js';
import { withTransformsHistory } from '../historyOps.js';
import { recordOp } from '../history.js';
import { t } from '../i18n.js';

let active = false;
let els = null; // { minus90, plus90, slider, readout, flipH, flipV }

export function initTransformTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const wantActive = s.ui.view === 'editor' && s.ui.activeTool === 'transform';
  if (wantActive && !active) activate();
  else if (!wantActive && active) deactivate();
  if (active) syncFromState();
}

function activate() {
  const body = getToolPanelBody();
  if (!body) return;
  active = true;
  renderPanel();
}

function deactivate() {
  active = false;
  els = null;
  clearToolPanel({ owner: 'transform' });
}

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'transform-tool-panel';

  const heading = document.createElement('h2');
  heading.textContent = t('selectTransform');
  heading.className = 'panel-heading';
  root.appendChild(heading);

  // Rotate row -----------------------------------------------------------
  const rotateGroup = document.createElement('div');
  rotateGroup.className = 'rotate-group';

  const minus90 = document.createElement('button');
  minus90.type = 'button';
  minus90.className = 'rotate-minus-90';
  minus90.setAttribute('aria-label', t('selectRotateMinus90'));
  minus90.title = t('selectRotateMinus90Short');
  minus90.textContent = t('selectRotateMinus90Label');
  rotateGroup.appendChild(minus90);

  const plus90 = document.createElement('button');
  plus90.type = 'button';
  plus90.className = 'rotate-plus-90';
  plus90.setAttribute('aria-label', t('selectRotatePlus90'));
  plus90.title = t('selectRotatePlus90Short');
  plus90.textContent = t('selectRotatePlus90Label');
  rotateGroup.appendChild(plus90);

  root.appendChild(rotateGroup);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '360';
  slider.step = '1';
  slider.className = 'rotate-slider';
  slider.setAttribute('aria-label', t('selectRotateSliderAria'));
  root.appendChild(slider);

  const readout = document.createElement('div');
  readout.className = 'rotate-readout';
  readout.setAttribute('aria-live', 'polite');
  readout.textContent = t('selectRotateReadout', { deg: 0 });
  root.appendChild(readout);

  // Flip row -------------------------------------------------------------
  const flipHeading = document.createElement('h2');
  flipHeading.textContent = t('selectFlip');
  flipHeading.className = 'panel-heading';
  root.appendChild(flipHeading);

  const flipGroup = document.createElement('div');
  flipGroup.className = 'flip-group';

  const flipH = document.createElement('button');
  flipH.type = 'button';
  flipH.className = 'flip-h-btn';
  flipH.setAttribute('aria-label', t('selectFlipH'));
  flipH.title = t('selectFlipH');
  flipH.textContent = t('selectFlipH');
  flipGroup.appendChild(flipH);

  const flipV = document.createElement('button');
  flipV.type = 'button';
  flipV.className = 'flip-v-btn';
  flipV.setAttribute('aria-label', t('selectFlipV'));
  flipV.title = t('selectFlipV');
  flipV.textContent = t('selectFlipV');
  flipGroup.appendChild(flipV);

  root.appendChild(flipGroup);

  setToolPanel(root, { owner: 'transform' });
  els = { minus90, plus90, slider, readout, flipH, flipV };

  // Listeners -----------------------------------------------------------
  minus90.addEventListener('click', () => {
    const img = getActiveImage();
    if (!img) return;
    withTransformsHistory('Rotate -90°', img.id, state => {
      const target = state.images[img.id];
      if (target) applyRotate(target, target.transforms.rotate - 90);
    });
  });
  plus90.addEventListener('click', () => {
    const img = getActiveImage();
    if (!img) return;
    withTransformsHistory('Rotate +90°', img.id, state => {
      const target = state.images[img.id];
      if (target) applyRotate(target, target.transforms.rotate + 90);
    });
  });
  // Slider history capture: one entry per drag session — same model as the
  // legacy selectTool. Snapshot on focus, apply live on input, record on
  // change/blur.
  slider.addEventListener('focus', captureRotateBefore);
  slider.addEventListener('input', () => {
    const img = getActiveImage();
    if (!img) return;
    ensureRotateCaptured(img.id);
    const deg = Number(slider.value);
    update(s => { applyRotate(s.images[img.id], deg); });
  });
  slider.addEventListener('change', () => commitRotateHistory('Rotate'));
  slider.addEventListener('blur',   () => commitRotateHistory('Rotate'));

  flipH.addEventListener('click', () => {
    const img = getActiveImage();
    if (!img) return;
    withTransformsHistory('Flip horizontal', img.id, state => {
      applyFlip(state.images[img.id], 'h');
    });
  });
  flipV.addEventListener('click', () => {
    const img = getActiveImage();
    if (!img) return;
    withTransformsHistory('Flip vertical', img.id, state => {
      applyFlip(state.images[img.id], 'v');
    });
  });

  syncFromState();
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// Rotate-slider history capture — one entry per drag session.
let rotateHistoryImageId = null;
let rotateHistoryBefore = null;

function captureRotateBefore() {
  const img = getActiveImage();
  if (!img) { rotateHistoryImageId = null; rotateHistoryBefore = null; return; }
  rotateHistoryImageId = img.id;
  rotateHistoryBefore = JSON.parse(JSON.stringify(img.transforms));
}

function ensureRotateCaptured(id) {
  if (rotateHistoryImageId === id && rotateHistoryBefore) return;
  const img = getState().images[id];
  if (!img) return;
  rotateHistoryImageId = id;
  rotateHistoryBefore = JSON.parse(JSON.stringify(img.transforms));
}

function commitRotateHistory(label) {
  if (!rotateHistoryImageId || !rotateHistoryBefore) return;
  const id = rotateHistoryImageId;
  const before = rotateHistoryBefore;
  rotateHistoryImageId = null;
  rotateHistoryBefore = null;
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

function syncFromState() {
  if (!els) return;
  const img = getActiveImage();
  if (!img) {
    els.readout.textContent = t('selectRotateReadout', { deg: 0 });
    if (document.activeElement !== els.slider) els.slider.value = '0';
    els.flipH.classList.remove('is-active');
    els.flipV.classList.remove('is-active');
    return;
  }
  const rot = Math.round(img.transforms.rotate || 0);
  els.readout.textContent = t('selectRotateReadout', { deg: rot });
  if (document.activeElement !== els.slider) {
    els.slider.value = String(rot);
  }
  els.flipH.classList.toggle('is-active', !!img.transforms.flipH);
  els.flipV.classList.toggle('is-active', !!img.transforms.flipV);
}

// No in-progress drag state worth cancelling for Undo — the rotate slider
// records via focus/blur, not an in-flight gesture.
export function cancelTransformTool() { return false; }

// Test-only reset.
export function _resetForTest() {
  active = false;
  els = null;
  rotateHistoryImageId = null;
  rotateHistoryBefore = null;
}
