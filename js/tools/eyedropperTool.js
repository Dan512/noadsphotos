// js/tools/eyedropperTool.js — color-to-transparent tool.
//
// When state.ui.activeTool === 'eyedropper':
//   - Side panel ("Tool options") shows: heading, color swatch + readout,
//     manual hex input, tolerance slider, Apply, Cancel.
//   - Clicking the overlay canvas samples the base canvas pixel at that
//     screen position; the sampled color becomes the eyedropper's target.
//   - Changing the hex (via click or manual input) or the tolerance slider
//     rebuilds the chromakey mask at source resolution (debounced via rAF)
//     and writes it through setChromakeyMask → renderer rebuilds the masked
//     source canvas and the change is visible in the next preview frame.
//   - Apply commits the chromakey params to state.images[id].chromakey (the
//     mask is already up-to-date). Cancel calls applyChromakey(img, null)
//     and clears both fields.
//   - Switching to another tool does NOT auto-cancel; the chromakey state
//     persists, matching the rest of the editor where adjust/transforms
//     don't reset on tool change.
//
// Live-preview wiring is intentionally minimal: every input on the slider
// or color field bumps a "pending" flag, rAF flushes the latest values in
// a single update. This avoids running a full-image pixel scan per
// keystroke or per slider step.
//
// Mask is built on a hidden full-resolution canvas drawn from the decoded
// bitmap (via lifecycle.ensureBitmap) and read out via getImageData. The
// ImageData is reused across mask rebuilds via a per-bitmap cache so we
// only pay the GPU readback cost once per image while the tool is active.
import { getState, subscribe, update } from '../state.js';
import { attachPointer } from '../pointer.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import {
  applyChromakey,
  setChromakeyMask,
  buildChromakeyMask,
  pixelToHex,
  normalizeHex,
} from '../ops/chromakey.js';
import { recordOp } from '../history.js';
import { t } from '../i18n.js';

// --- Module-level state -----------------------------------------------------

let active = false;
let lifecycleRef = null;          // injected by initEyedropperTool(lifecycle)
let detach = null;                // attachPointer detach handle
let overlayCanvas = null;
let baseCanvas = null;

// Side-panel DOM refs.
let panelEls = null;              // { swatch, hexInput, tolInput, tolReadout, applyBtn, cancelBtn }

// Tool-local preview state. The mask/state on the image follows these but
// is debounced via rAF.
let currentHex = '';
let currentTol = 25;              // default per spec

// "There's an uncommitted pick in flight." Set by setColor() (manual hex
// input + canvas pixel pick), cleared by Apply (commit) and Cancel (revert)
// + tool deactivation. Used by cancelEyedropperTool() so undo / Ctrl+Z can
// roll back the live preview without invoking history.
//
// See v1.1.1 design §9 for the broader "undo cancels in-progress tool
// actions" pattern this implements.
let hasPendingPick = false;

// Per-image cache of source-resolution ImageData. Lets us skip re-reading
// pixels for each mask rebuild while the user drags the slider. Keyed by
// bitmap so the entry GCs when the lifecycle evicts a bitmap.
const imageDataCache = new WeakMap();

// rAF coalescer for mask rebuilds.
let pendingFlush = null;

// --- Init / activate / deactivate ------------------------------------------

/**
 * Initialise the eyedropper tool. Lifecycle is required so we can decode the
 * source bitmap on demand when reading pixels for mask rebuilds.
 *
 * @param {object} lifecycle — { ensureBitmap }
 */
export function initEyedropperTool(lifecycle) {
  lifecycleRef = lifecycle || null;
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'eyedropper';
  if (want && !active) activate();
  else if (!want && active) deactivate();
}

function activate() {
  overlayCanvas = document.getElementById('overlay-canvas');
  baseCanvas    = document.getElementById('base-canvas');
  if (!overlayCanvas || !baseCanvas) return;

  active = true;
  overlayCanvas.style.pointerEvents = 'auto';
  // Eye-drop cursor while active.
  overlayCanvas.style.cursor = 'crosshair';

  detach = attachPointer(overlayCanvas, { down: onDown, up: onUp });

  // Seed the tool-local state from the image's stored chromakey, if any —
  // re-entering the tool should show the user's last-chosen values.
  const img = getActiveImage();
  if (img && img.chromakey) {
    currentHex = normalizeHex(img.chromakey.hex);
    currentTol = Math.max(0, Math.min(100, Number(img.chromakey.tolerance) || 0));
  } else {
    currentHex = '';
    currentTol = 25;
  }

  renderPanel();
}

function deactivate() {
  active = false;
  // Pending pick state doesn't survive tool switches; if the user activates
  // the eyedropper again, they start fresh. (The chromakey on the image
  // itself persists per the long-standing design.)
  hasPendingPick = false;
  if (detach) {
    try { detach(); } catch { /* ignore */ }
    detach = null;
  }
  if (overlayCanvas) {
    overlayCanvas.style.pointerEvents = 'none';
    overlayCanvas.style.cursor = '';
  }
  if (pendingFlush != null) {
    cancelAnimationFrame(pendingFlush);
    pendingFlush = null;
  }
  panelEls = null;
  clearToolPanel({ owner: 'eyedropper' });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// --- Pointer handling: click → sample pixel from base canvas ---------------

let downPos = null;
const CLICK_SLOP = 4; // pixels — pointerup near pointerdown counts as a click

function onDown(e) {
  downPos = { x: e.x, y: e.y };
}

function onUp(e) {
  if (!downPos) return;
  const dx = e.x - downPos.x;
  const dy = e.y - downPos.y;
  downPos = null;
  if (Math.hypot(dx, dy) > CLICK_SLOP) return; // dragged, not clicked

  if (!baseCanvas) return;
  // Sample from the *displayed* base canvas at the click position. Click
  // coords are CSS pixels relative to the overlay canvas (same origin as
  // the base canvas, since they're stacked siblings). We map CSS pixels
  // into canvas-internal pixels via the canvas-width / CSS-width ratio.
  const cssW = parseFloat(baseCanvas.style.width) || baseCanvas.width;
  const cssH = parseFloat(baseCanvas.style.height) || baseCanvas.height;
  if (!cssW || !cssH) return;
  const px = Math.floor((e.x / cssW) * baseCanvas.width);
  const py = Math.floor((e.y / cssH) * baseCanvas.height);
  if (px < 0 || py < 0 || px >= baseCanvas.width || py >= baseCanvas.height) return;

  let pixel;
  try {
    const ctx = baseCanvas.getContext('2d');
    pixel = ctx.getImageData(px, py, 1, 1).data;
  } catch (err) {
    // Cross-origin tainted canvas would throw — shouldn't happen here since
    // all images come from a local Blob, but be defensive.
    console.error('eyedropperTool: failed to sample pixel', err);
    return;
  }
  // Fully-transparent pixel → don't update (sampling the canvas margin).
  if (pixel[3] === 0) return;
  const hex = pixelToHex(pixel[0], pixel[1], pixel[2]);
  setColor(hex);
}

// --- State changes (color/tolerance) — schedule debounced mask rebuild ----

function setColor(hex) {
  currentHex = normalizeHex(hex);
  // Any pick (whether from canvas click or manual hex input) makes the
  // tool's state "in flight" — Apply commits it, Cancel/undo reverts it.
  hasPendingPick = true;
  if (panelEls) {
    panelEls.hexInput.value = currentHex;
    panelEls.swatch.style.backgroundColor = currentHex;
  }
  schedulePreviewRebuild();
}

function setTolerance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  currentTol = Math.max(0, Math.min(100, n));
  if (panelEls) {
    panelEls.tolReadout.textContent = String(Math.round(currentTol));
  }
  schedulePreviewRebuild();
}

function schedulePreviewRebuild() {
  if (pendingFlush != null) return;
  pendingFlush = requestAnimationFrame(() => {
    pendingFlush = null;
    rebuildPreview();
  });
}

async function rebuildPreview() {
  if (!active) return;
  const img = getActiveImage();
  if (!img) return;
  if (!currentHex) return; // no color picked yet — nothing to preview

  let bitmap = img.source.bitmap;
  if (!bitmap) {
    if (!lifecycleRef) return;
    try {
      bitmap = await lifecycleRef.ensureBitmap(img.id);
    } catch (err) {
      console.error('eyedropperTool: ensureBitmap failed', err);
      return;
    }
    if (!active) return; // user switched tools while decoding
  }
  if (!bitmap) return;

  // Read (or reuse) source-resolution ImageData.
  let imageData = imageDataCache.get(bitmap);
  if (!imageData) {
    imageData = readSourceImageData(bitmap, img.source.width, img.source.height);
    if (imageData) imageDataCache.set(bitmap, imageData);
  }
  if (!imageData) return;

  const mask = buildChromakeyMask(imageData, currentHex, currentTol);
  update(s => {
    const target = s.images[img.id];
    if (!target) return;
    setChromakeyMask(target, mask);
  });
}

function readSourceImageData(bitmap, w, h) {
  if (!w || !h) return null;
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  } catch (err) {
    console.error('eyedropperTool: readSourceImageData failed', err);
    return null;
  }
}

// --- Side panel ------------------------------------------------------------

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'eyedropper-tool-panel';

  const heading = document.createElement('h2');
  heading.className = 'panel-heading';
  heading.textContent = t('eyedropperTitle');
  root.appendChild(heading);

  // Color row: swatch + hex input.
  const colorRow = document.createElement('div');
  colorRow.className = 'eyedropper-row eyedropper-color-row';

  const swatch = document.createElement('span');
  swatch.className = 'eyedropper-swatch';
  swatch.setAttribute('aria-label', t('eyedropperSwatchAria'));
  if (currentHex) swatch.style.backgroundColor = currentHex;
  colorRow.appendChild(swatch);

  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'eyedropper-hex';
  hexInput.placeholder = t('eyedropperHexPlaceholder');
  hexInput.value = currentHex || '';
  hexInput.setAttribute('aria-label', t('eyedropperHexAria'));
  colorRow.appendChild(hexInput);

  root.appendChild(colorRow);

  // Click-to-sample hint.
  const hint = document.createElement('p');
  hint.className = 'eyedropper-hint';
  hint.textContent = t('eyedropperClickHint');
  root.appendChild(hint);

  // Tolerance row.
  const tolRow = document.createElement('label');
  tolRow.className = 'eyedropper-row eyedropper-tol-row';
  const tolLabel = document.createElement('span');
  tolLabel.textContent = t('eyedropperTolerance');
  tolRow.appendChild(tolLabel);

  const tolInput = document.createElement('input');
  tolInput.type = 'range';
  tolInput.min = '0';
  tolInput.max = '100';
  tolInput.step = '1';
  tolInput.value = String(Math.round(currentTol));
  tolInput.className = 'eyedropper-tolerance';
  tolInput.setAttribute('aria-label', t('eyedropperToleranceAria'));
  tolRow.appendChild(tolInput);

  const tolReadout = document.createElement('span');
  tolReadout.className = 'eyedropper-tol-readout';
  tolReadout.setAttribute('aria-live', 'polite');
  tolReadout.textContent = String(Math.round(currentTol));
  tolRow.appendChild(tolReadout);

  root.appendChild(tolRow);

  // Actions.
  const actions = document.createElement('div');
  actions.className = 'eyedropper-actions';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'eyedropper-apply btn-primary';
  applyBtn.textContent = t('eyedropperApply');
  actions.appendChild(applyBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'eyedropper-cancel';
  cancelBtn.textContent = t('eyedropperCancel');
  actions.appendChild(cancelBtn);

  root.appendChild(actions);

  setToolPanel(root, { owner: 'eyedropper' });
  panelEls = { swatch, hexInput, tolInput, tolReadout, applyBtn, cancelBtn };

  // --- Listeners ---
  hexInput.addEventListener('input', () => {
    // Don't normalize while the user is mid-type (e.g. '#' alone is fine);
    // wait until they commit (blur / Enter) for canonical form.
    const raw = hexInput.value;
    // If the input parses as a valid hex, kick a preview; otherwise just
    // wait for further keystrokes.
    if (/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(raw.trim())) {
      const next = normalizeHex(raw);
      currentHex = next;
      swatch.style.backgroundColor = next;
      schedulePreviewRebuild();
    }
  });
  hexInput.addEventListener('change', () => {
    setColor(hexInput.value);
  });

  tolInput.addEventListener('input', () => {
    setTolerance(tolInput.value);
  });

  applyBtn.addEventListener('click', () => {
    const img = getActiveImage();
    if (!img || !currentHex) return;
    // After commit, there's no longer an uncommitted pick in flight.
    // (The chromakey now lives in state + history; Ctrl+Z should fall
    // through to history.undo() rather than the cancel path.)
    hasPendingPick = false;
    // Snapshot before the commit. applyChromakey writes only `chromakey`
    // (the mask is updated independently via the live preview rebuild path),
    // so the before/after snapshot only needs `chromakey` + `chromakeyMask`.
    const before = {
      chromakey:     img.chromakey ? { ...img.chromakey } : null,
      chromakeyMask: img.chromakeyMask,
    };
    // Commit the chromakey params. applyChromakey(non-null) preserves
    // chromakeyMask, so the live preview mask that the renderer's already
    // showing remains correct after this update.
    update(s => {
      applyChromakey(s.images[img.id], { hex: currentHex, tolerance: currentTol });
    });
    const afterImg = getState().images[img.id];
    if (afterImg) {
      const after = {
        chromakey:     afterImg.chromakey ? { ...afterImg.chromakey } : null,
        chromakeyMask: afterImg.chromakeyMask,
      };
      if (JSON.stringify(before.chromakey) !== JSON.stringify(after.chromakey)
          || before.chromakeyMask !== after.chromakeyMask) {
        recordOp({
          label: 'Apply chromakey',
          imageId: img.id,
          kind: 'chromakey',
          before, after,
        });
      }
    }
    // Return to the default select tool — matches crop tool's Apply UX.
    update(s => { s.ui.activeTool = 'select'; });
  });

  cancelBtn.addEventListener('click', () => {
    const img = getActiveImage();
    if (img) {
      update(s => { applyChromakey(s.images[img.id], null); });
    }
    currentHex = '';
    currentTol = 25;
    hasPendingPick = false;
    if (panelEls) {
      panelEls.hexInput.value = '';
      panelEls.swatch.style.backgroundColor = '';
      panelEls.tolInput.value = '25';
      panelEls.tolReadout.textContent = '25';
    }
    update(s => { s.ui.activeTool = 'select'; });
  });
}

// Cancel an in-flight pick (the eyedropper has been used to sample a color
// but Apply hasn't been clicked yet). Called by the global undo handler so
// Ctrl+Z reverts a tentative pick instead of being a no-op (the v1.1 bug
// Dan reported: "eyedropped → click a color → click undo, it does nothing").
//
// Returns `true` if there was an uncommitted pick to revert (caller should
// stop and NOT proceed to history.undo). Returns `false` if the tool was
// idle or all picks have already been Applied.
//
// Side effects on `true`: clears the chromakey/mask on the active image
// (mirrors the Cancel button), resets the panel's color + tolerance fields,
// keeps the eyedropper active so the user can pick again. We deliberately
// do NOT switch tools (unlike the Cancel button) — undo should feel like
// "step back," not "abandon this tool."
export function cancelEyedropperTool() {
  if (!active || !hasPendingPick) return false;
  const img = getActiveImage();
  if (img) {
    update(s => { applyChromakey(s.images[img.id], null); });
  }
  currentHex = '';
  currentTol = 25;
  hasPendingPick = false;
  if (panelEls) {
    panelEls.hexInput.value = '';
    panelEls.swatch.style.backgroundColor = '';
    panelEls.tolInput.value = '25';
    panelEls.tolReadout.textContent = '25';
  }
  return true;
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  baseCanvas = null;
  panelEls = null;
  currentHex = '';
  currentTol = 25;
  hasPendingPick = false;
  downPos = null;
  if (pendingFlush != null) {
    cancelAnimationFrame(pendingFlush);
    pendingFlush = null;
  }
}
