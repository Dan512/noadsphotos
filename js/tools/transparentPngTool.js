// js/tools/transparentPngTool.js — v1.3 Feature 16 (Transparent PNG tools).
//
// One panel, three actions:
//   1) Pad canvas — add empty margin (with optional fill color) around the
//      image. Default color is transparent (the canonical workflow is "make
//      room before a crop").
//   2) Replace transparency — turn every pixel below an alpha threshold into
//      a solid color. Mirror of #1: where pad ADDS transparent area, this one
//      REMOVES it.
//   3) Checkerboard preview toggle — paint a transparency-pattern background
//      behind the canvas frame so the user can SEE transparency. Defaults
//      ON when the image already has transparency (heuristic via the
//      exporter's hasTransparency), OFF otherwise.
//
// Both #1 and #2 are baked operations — they replace the source bitmap and
// clear every category that's now baked in, following exactly the same
// pattern as ops/trim.js (see that module's "Bake semantics" header). One
// Ctrl+Z reverts the whole thing because we record a single history op with
// the same `KEYS_TRIM_BAKE`-equivalent snapshot.
//
// Per-image only in v1. Batch flavor (run pad/replace on every queued image
// at once) is a deliberate v2 cut — the most common use case is "open one
// image, fix it, export," and adding a batch panel would more than double
// the surface area for a feature whose UI we want to keep small.

import { getState, subscribe, update } from '../state.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import { padCanvas, replaceTransparent } from '../ops/transparentPng.js';
import { recordOp } from '../history.js';
import { hasTransparency, getExportContext } from '../exporter.js';
import { renderForExport } from '../render/exportRenderer.js';
import { showToast } from '../errors.js';
import { t } from '../i18n.js';

let active = false;
let els = null; // { padTop, padRight, padBottom, padLeft, padColor, padColorTransparent, padApply, replaceColor, replaceThreshold, replaceThresholdReadout, replaceApply, checkerbox }
let processing = false;

// Top-level keys we snapshot before/after a bake — matches trim.js so undo
// restores everything that pad/replace touch. Both ops replace `source` and
// clear transforms + adjust + filterPreset + chromakey + bgMask.
const KEYS_BAKE = ['source', 'transforms', 'adjust', 'filterPreset', 'chromakey', 'chromakeyMask', 'bgRemoved', 'bgMask'];

export function initTransparentPngTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'transparent-png';
  if (want && !active) activate();
  else if (!want && active) deactivate();
  // Keep the canvas-frame's checkerboard class in sync regardless of whether
  // the tool is active. If the user toggled it on, then switched tools, the
  // backdrop should persist — it's a view preference, not a tool mode.
  syncCheckerboardClass();
  if (active) syncPanelFromState();
}

function activate() {
  active = true;
  // Smart default for the checkerboard: ON if the active image already has
  // alpha (so transparent areas are immediately visible). Set ONCE per
  // activation; subsequent toggles by the user stick until they activate the
  // tool again on a fresh image. This matches the pattern of "pick a sane
  // default, then let the user override."
  const img = getActiveImage();
  if (img && hasTransparency(img)) {
    update(s => { s.ui.transparentPng.checkerboardOn = true; });
  }
  renderPanel();
}

function deactivate() {
  active = false;
  els = null;
  clearToolPanel({ owner: 'transparent-png' });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// --- side panel ----------------------------------------------------------

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'transparent-png-panel';

  const heading = document.createElement('h2');
  heading.className = 'panel-heading';
  heading.textContent = t('transparentPngTitle');
  root.appendChild(heading);

  // Checkerboard preview toggle — at the top because it's a view setting
  // that affects how the user perceives the other two tools' results.
  const checkerRow = document.createElement('label');
  checkerRow.className = 'transparent-png-row transparent-png-checker-row';
  const checkerbox = document.createElement('input');
  checkerbox.type = 'checkbox';
  checkerbox.className = 'transparent-png-checker';
  checkerbox.setAttribute('aria-label', t('transparentPngCheckerboardAria'));
  checkerbox.addEventListener('change', () => {
    const on = checkerbox.checked;
    update(s => { s.ui.transparentPng.checkerboardOn = on; });
  });
  checkerRow.appendChild(checkerbox);
  const checkerLabel = document.createElement('span');
  checkerLabel.textContent = t('transparentPngCheckerboard');
  checkerRow.appendChild(checkerLabel);
  root.appendChild(checkerRow);

  // --- Pad canvas section ------------------------------------------------
  const padSection = document.createElement('section');
  padSection.className = 'transparent-png-section';
  const padHeading = document.createElement('h3');
  padHeading.className = 'transparent-png-subheading';
  padHeading.textContent = t('transparentPngPadHeading');
  padSection.appendChild(padHeading);

  const padHelp = document.createElement('p');
  padHelp.className = 'transparent-png-help';
  padHelp.textContent = t('transparentPngPadHelp');
  padSection.appendChild(padHelp);

  const padGrid = document.createElement('div');
  padGrid.className = 'transparent-png-pad-grid';
  const padTop    = buildNumberInput('top',    t('transparentPngPadTop'));
  const padRight  = buildNumberInput('right',  t('transparentPngPadRight'));
  const padBottom = buildNumberInput('bottom', t('transparentPngPadBottom'));
  const padLeft   = buildNumberInput('left',   t('transparentPngPadLeft'));
  padGrid.appendChild(padTop.row);
  padGrid.appendChild(padRight.row);
  padGrid.appendChild(padBottom.row);
  padGrid.appendChild(padLeft.row);
  padSection.appendChild(padGrid);

  // "All sides" — copies Top to all four. Useful shortcut; the link styling
  // keeps it visually subordinate to the four inputs so it doesn't look like
  // another control row competing for attention.
  const allSidesBtn = document.createElement('button');
  allSidesBtn.type = 'button';
  allSidesBtn.className = 'transparent-png-all-sides';
  allSidesBtn.textContent = t('transparentPngPadAllSides');
  allSidesBtn.setAttribute('aria-label', t('transparentPngPadAllSidesAria'));
  allSidesBtn.addEventListener('click', () => {
    const v = clampPad(Number(padTop.input.value));
    padRight.input.value  = String(v);
    padBottom.input.value = String(v);
    padLeft.input.value   = String(v);
    update(s => {
      s.ui.transparentPng.padTop    = v;
      s.ui.transparentPng.padRight  = v;
      s.ui.transparentPng.padBottom = v;
      s.ui.transparentPng.padLeft   = v;
    });
  });
  padSection.appendChild(allSidesBtn);

  // Background color row — checkbox "Transparent" gates the actual color
  // input so the user can express "no fill" without picking magenta and
  // hoping for the best.
  const padColorRow = document.createElement('div');
  padColorRow.className = 'transparent-png-row transparent-png-color-row';
  const padColorLabel = document.createElement('span');
  padColorLabel.textContent = t('transparentPngPadColor');
  padColorRow.appendChild(padColorLabel);

  const padColorTransparent = document.createElement('label');
  padColorTransparent.className = 'transparent-png-transparent-toggle';
  const padColorTransparentBox = document.createElement('input');
  padColorTransparentBox.type = 'checkbox';
  padColorTransparentBox.className = 'transparent-png-pad-transparent';
  padColorTransparentBox.checked = true;
  padColorTransparent.appendChild(padColorTransparentBox);
  const padColorTransparentLabel = document.createElement('span');
  padColorTransparentLabel.textContent = t('transparentPngPadColorTransparent');
  padColorTransparent.appendChild(padColorTransparentLabel);
  padColorRow.appendChild(padColorTransparent);

  const padColorInput = document.createElement('input');
  padColorInput.type = 'color';
  padColorInput.value = '#ffffff';
  padColorInput.className = 'transparent-png-pad-color';
  padColorInput.disabled = true;
  padColorInput.setAttribute('aria-label', t('transparentPngPadColor'));
  padColorRow.appendChild(padColorInput);
  padSection.appendChild(padColorRow);

  padColorTransparentBox.addEventListener('change', () => {
    const transparentMode = padColorTransparentBox.checked;
    padColorInput.disabled = transparentMode;
    update(s => {
      s.ui.transparentPng.padColor = transparentMode ? null : padColorInput.value;
    });
  });
  padColorInput.addEventListener('input', () => {
    if (padColorTransparentBox.checked) return;
    update(s => { s.ui.transparentPng.padColor = padColorInput.value; });
  });

  // Apply button.
  const padApply = document.createElement('button');
  padApply.type = 'button';
  padApply.className = 'transparent-png-pad-apply btn-primary';
  padApply.textContent = t('transparentPngPadApply');
  padApply.addEventListener('click', onApplyPad);
  padSection.appendChild(padApply);

  root.appendChild(padSection);

  // --- Replace transparency section -------------------------------------
  const replaceSection = document.createElement('section');
  replaceSection.className = 'transparent-png-section';
  const replaceHeading = document.createElement('h3');
  replaceHeading.className = 'transparent-png-subheading';
  replaceHeading.textContent = t('transparentPngReplaceHeading');
  replaceSection.appendChild(replaceHeading);

  const replaceHelp = document.createElement('p');
  replaceHelp.className = 'transparent-png-help';
  replaceHelp.textContent = t('transparentPngReplaceHelp');
  replaceSection.appendChild(replaceHelp);

  const replaceColorRow = document.createElement('label');
  replaceColorRow.className = 'transparent-png-row transparent-png-color-row';
  const replaceColorLabel = document.createElement('span');
  replaceColorLabel.textContent = t('transparentPngReplaceColor');
  replaceColorRow.appendChild(replaceColorLabel);
  const replaceColor = document.createElement('input');
  replaceColor.type = 'color';
  replaceColor.value = getState().ui.transparentPng.replaceColor || '#ffffff';
  replaceColor.className = 'transparent-png-replace-color';
  replaceColor.setAttribute('aria-label', t('transparentPngReplaceColor'));
  replaceColor.addEventListener('input', () => {
    update(s => { s.ui.transparentPng.replaceColor = replaceColor.value; });
  });
  replaceColorRow.appendChild(replaceColor);
  replaceSection.appendChild(replaceColorRow);

  const replaceThresholdRow = document.createElement('label');
  replaceThresholdRow.className = 'transparent-png-row transparent-png-threshold-row';
  const replaceThresholdLabel = document.createElement('span');
  replaceThresholdLabel.textContent = t('transparentPngReplaceThreshold');
  replaceThresholdRow.appendChild(replaceThresholdLabel);
  const replaceThreshold = document.createElement('input');
  replaceThreshold.type = 'range';
  replaceThreshold.min = '0';
  replaceThreshold.max = '100';
  replaceThreshold.step = '1';
  // Stored as 0..1; UI is integer percent.
  const initialPct = Math.round((Number(getState().ui.transparentPng.replaceThreshold) || 0.01) * 100);
  replaceThreshold.value = String(initialPct);
  replaceThreshold.className = 'transparent-png-replace-threshold';
  replaceThreshold.setAttribute('aria-label', t('transparentPngReplaceThresholdAria'));
  replaceThresholdRow.appendChild(replaceThreshold);
  const replaceThresholdReadout = document.createElement('span');
  replaceThresholdReadout.className = 'transparent-png-threshold-readout';
  replaceThresholdReadout.setAttribute('aria-live', 'polite');
  replaceThresholdReadout.textContent = String(initialPct);
  replaceThresholdRow.appendChild(replaceThresholdReadout);
  replaceSection.appendChild(replaceThresholdRow);
  replaceThreshold.addEventListener('input', () => {
    const pct = Math.max(0, Math.min(100, Number(replaceThreshold.value) || 0));
    replaceThresholdReadout.textContent = String(pct);
    update(s => { s.ui.transparentPng.replaceThreshold = pct / 100; });
  });

  const replaceApply = document.createElement('button');
  replaceApply.type = 'button';
  replaceApply.className = 'transparent-png-replace-apply btn-primary';
  replaceApply.textContent = t('transparentPngReplaceApply');
  replaceApply.addEventListener('click', onApplyReplace);
  replaceSection.appendChild(replaceApply);

  root.appendChild(replaceSection);

  setToolPanel(root, { owner: 'transparent-png' });
  els = {
    padTop: padTop.input,
    padRight: padRight.input,
    padBottom: padBottom.input,
    padLeft: padLeft.input,
    padColorInput,
    padColorTransparentBox,
    padApply,
    replaceColor,
    replaceThreshold,
    replaceThresholdReadout,
    replaceApply,
    checkerbox,
  };

  // Sync inputs to any pre-existing state (e.g. user re-entered the tool).
  syncPanelFromState();
}

function buildNumberInput(side, labelText) {
  const row = document.createElement('label');
  row.className = `transparent-png-row transparent-png-pad-${side}`;
  const label = document.createElement('span');
  label.textContent = labelText;
  row.appendChild(label);
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = '10000';
  input.step = '1';
  input.value = '0';
  input.className = 'transparent-png-pad-input';
  input.setAttribute('aria-label', labelText);
  row.appendChild(input);
  input.addEventListener('input', () => {
    const v = clampPad(Number(input.value));
    update(s => {
      const key = 'pad' + side[0].toUpperCase() + side.slice(1);
      s.ui.transparentPng[key] = v;
    });
  });
  return { row, input };
}

function syncPanelFromState() {
  if (!els) return;
  const tp = getState().ui.transparentPng;
  if (document.activeElement !== els.padTop)    els.padTop.value    = String(tp.padTop ?? 0);
  if (document.activeElement !== els.padRight)  els.padRight.value  = String(tp.padRight ?? 0);
  if (document.activeElement !== els.padBottom) els.padBottom.value = String(tp.padBottom ?? 0);
  if (document.activeElement !== els.padLeft)   els.padLeft.value   = String(tp.padLeft ?? 0);
  const transparentMode = tp.padColor == null;
  els.padColorTransparentBox.checked = transparentMode;
  els.padColorInput.disabled = transparentMode;
  if (!transparentMode && document.activeElement !== els.padColorInput) {
    els.padColorInput.value = tp.padColor;
  }
  if (document.activeElement !== els.replaceColor) {
    els.replaceColor.value = tp.replaceColor || '#ffffff';
  }
  if (document.activeElement !== els.replaceThreshold) {
    const pct = Math.round((Number(tp.replaceThreshold) || 0.01) * 100);
    els.replaceThreshold.value = String(pct);
    els.replaceThresholdReadout.textContent = String(pct);
  }
  els.checkerbox.checked = !!tp.checkerboardOn;
}

function clampPad(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 10000) return 10000;
  return Math.round(n);
}

// --- checkerboard wrapper class -------------------------------------------

// Idempotent — toggles the class on the .canvas-frame based on current state.
// Called from handleStateChange so the wrapper class follows the toggle
// regardless of whether the tool panel is open.
function syncCheckerboardClass() {
  const frame = document.querySelector('.canvas-frame');
  if (!frame) return;
  const want = !!(getState().ui.transparentPng && getState().ui.transparentPng.checkerboardOn);
  frame.classList.toggle('is-checkerboard', want);
}

// --- Apply: pad canvas ----------------------------------------------------

async function onApplyPad() {
  if (processing) return;
  const img = getActiveImage();
  if (!img) return;
  const tp = getState().ui.transparentPng;
  const top    = clampPad(tp.padTop);
  const right  = clampPad(tp.padRight);
  const bottom = clampPad(tp.padBottom);
  const left   = clampPad(tp.padLeft);
  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    showToast(t('transparentPngPadEmpty'), { variant: 'warn' });
    return;
  }

  processing = true;
  if (els && els.padApply) els.padApply.disabled = true;
  try {
    await applyBakedOp(img, async (renderedCanvas) => {
      return padCanvas(renderedCanvas, { top, right, bottom, left, color: tp.padColor });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('transparentPng: padCanvas failed', err);
    showToast(t('transparentPngApplyFailed'), { variant: 'error' });
  } finally {
    processing = false;
    if (els && els.padApply) els.padApply.disabled = false;
  }
}

// --- Apply: replace transparency ------------------------------------------

async function onApplyReplace() {
  if (processing) return;
  const img = getActiveImage();
  if (!img) return;
  // If the source has no transparency at all, warn — the op would be a no-op
  // but we'd still burn through one history entry baking an identical bitmap.
  if (!hasTransparency(img)) {
    showToast(t('transparentPngReplaceNoAlpha'), { variant: 'warn' });
    return;
  }
  const tp = getState().ui.transparentPng;
  const color = tp.replaceColor || '#ffffff';
  const threshold = Number.isFinite(tp.replaceThreshold) ? tp.replaceThreshold : 0.01;

  processing = true;
  if (els && els.replaceApply) els.replaceApply.disabled = true;
  try {
    await applyBakedOp(img, async (renderedCanvas) => {
      return replaceTransparent(renderedCanvas, { color, threshold });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('transparentPng: replaceTransparent failed', err);
    showToast(t('transparentPngApplyFailed'), { variant: 'error' });
  } finally {
    processing = false;
    if (els && els.replaceApply) els.replaceApply.disabled = false;
  }
}

// Shared bake helper. Renders the image's effective output to a canvas via
// renderForExport (so transforms + adjustments + overlays are committed),
// hands it to the supplied transform function, encodes a PNG blob, decodes a
// fresh ImageBitmap, and installs it as the new source — clearing every
// downstream category so the bake's effect isn't double-applied on next
// render. One history op so Ctrl+Z reverts the whole thing.
async function applyBakedOp(img, transformFn) {
  const { lifecycle, caps } = getExportContext();
  if (!lifecycle || !caps) {
    throw new Error('export context unavailable');
  }
  // Render the current effective output as a PNG blob (alpha-preserving).
  const renderedBlob = await renderForExport(img, { format: 'png', quality: 1 }, caps, lifecycle);
  if (!renderedBlob) throw new Error('render returned no blob');

  const renderedBitmap = await createImageBitmap(renderedBlob);
  const fromW = renderedBitmap.width;
  const fromH = renderedBitmap.height;

  // Copy the rendered output onto a fresh canvas so the transform fn can
  // mutate it freely (replaceTransparent mutates in place; padCanvas returns
  // a new canvas — both shapes are OK because we re-read whatever it
  // returns below).
  const stage = makeCanvas(fromW, fromH);
  const stageCtx = stage.getContext('2d');
  if (!stageCtx) {
    try { renderedBitmap.close(); } catch { /* ignore */ }
    throw new Error('2d context unavailable');
  }
  stageCtx.drawImage(renderedBitmap, 0, 0);
  try { renderedBitmap.close(); } catch { /* ignore */ }

  const out = await transformFn(stage);
  if (!out) throw new Error('transform returned nothing');
  const blob = await canvasToBlob(out, 'image/png');
  if (!blob) throw new Error('encode failed');
  const newBitmap = await createImageBitmap(blob);

  // Snapshot BEFORE state outside the update boundary so the typed arrays /
  // bitmap refs are captured by reference, not stale.
  const id = img.id;
  const before = pickKeysForBake(img);

  update(s => {
    const target = s.images[id];
    if (!target) return;
    applyBakeToState(target, {
      bitmap: newBitmap,
      blob,
      width: newBitmap.width,
      height: newBitmap.height,
      type: 'image/png',
    });
  });

  const after = pickKeysForBake(getState().images[id]);
  recordOp({
    label: 'Transparent PNG bake',
    imageId: id,
    kind: 'transforms',
    before,
    after,
  });

  showToast(t('transparentPngApplied', { w: newBitmap.width, h: newBitmap.height }), { variant: 'info' });
}

// Mirror of applyTrimBakeToState in ops/trim.js. Replaces source with the
// new bitmap/blob/dims, clears every category that's now baked in. Overlays
// stay intact — vector overlays render on top at export time.
function applyBakeToState(imageState, bake) {
  if (!imageState || !bake) return;
  const prevName = imageState.source && imageState.source.name;
  const prevThumb = imageState.source && imageState.source.thumbnail;
  imageState.source = {
    blob: bake.blob,
    name: prevName || 'transparent-png.png',
    type: bake.type || 'image/png',
    width: bake.width,
    height: bake.height,
    thumbnail: prevThumb || null,
    bitmap: bake.bitmap,
  };
  imageState.transforms = { crop: null, rotate: 0, flipH: false, flipV: false, resize: null };
  imageState.adjust = { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
  imageState.filterPreset = 'none';
  imageState.chromakey = null;
  imageState.chromakeyMask = null;
  imageState.bgRemoved = false;
  imageState.bgMask = null;
  imageState.baseDirty = true;
  imageState.overlaysDirty = true;
}

function pickKeysForBake(img) {
  const out = Object.create(null);
  if (!img) return out;
  for (const k of KEYS_BAKE) {
    out[k] = cloneBakeSnapshotValue(img[k]);
  }
  return out;
}

function cloneBakeSnapshotValue(v) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return v;
  if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) return v;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); }
    catch { /* fall through */ }
  }
  if (Array.isArray(v)) return v.slice();
  const out = Object.create(null);
  for (const k of Object.keys(v)) out[k] = v[k];
  return out;
}

// --- canvas helpers -------------------------------------------------------

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, mime) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mime });
  }
  return new Promise(resolve => {
    canvas.toBlob(b => resolve(b), mime);
  });
}

// Test-only reset hook for browser specs.
export function _resetForTest() {
  active = false;
  els = null;
  processing = false;
}
