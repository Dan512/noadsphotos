// js/tools/watermarkTool.js — v1.3 Feature 12 (Watermark preset).
//
// Side panel + drag-to-position interaction for the global watermark setting.
// The watermark itself isn't a per-image overlay — it's one config in
// state.ui.watermark that the preview and export renderers both consult at
// paint time. Modeling it as a "tool" gets us a clean home for the UI panel;
// the rest of the per-image state is untouched.
//
// Panel sections (top → bottom):
//   1. Enable checkbox (master toggle)
//   2. Type chips ('Text' | 'Image')
//   3. Text section (visible when type=text): text input, font, color
//   4. Image section (visible when type=image): file upload + preview + clear
//   5. 9-grid position chips + Tiled chip + drag hint
//   6. Opacity slider
//   7. Scale slider
//   8. Tiled angle slider (visible when position=tiled)
//
// Persistence: every state change calls persistWatermark() so a reload
// restores the same configuration including the uploaded logo (base64 in
// localStorage). The logo's ObjectURL is REBUILT at boot in state.js so the
// renderer never sees a stale URL.
//
// Drag: when the user grabs the rendered watermark on the canvas and moves
// it, position flips to 'custom' and customX/customY are written as 0..1
// fractions of canvas size. Hit-test uses the same forward-transform helper
// the renderer uses, so dragging works correctly through crop/rotate/flip.

import { attachPointer } from '../pointer.js';
import { getState, subscribe, update, persistWatermark } from '../state.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import { computeWatermarkRect, POSITION_PRESETS } from '../ops/watermark.js';
import { canvasToSource, applySourceTransform } from '../render/previewRenderer.js';
import { effectiveImageSize } from '../geometry.js';
import { showToast } from '../errors.js';
import { t } from '../i18n.js';

let active = false;
let detach = null;
let overlayCanvas = null;
// Editor's panel instance — returned by buildWatermarkSection() when the tool
// activates. Holds { root, els, sync, dispose }. The queue view's batch panel
// builds its own instance independently (see queueView.js).
let editorPanel = null;

// Drag tracking. We use canvas-CSS-pixel space for the hit test (matches the
// pointer event coordinates) and translate to fractional canvas coords on
// the way into state so the watermark sticks to a relative position even if
// the canvas dims change.
let dragging = false;
let dragOffsetCss = null;  // { dx, dy } — CSS pixel offset from wm top-left to pointer

const POSITION_LABEL_KEYS = Object.freeze({
  'top-left':     'watermarkPositionTopLeft',
  'top':          'watermarkPositionTop',
  'top-right':    'watermarkPositionTopRight',
  'left':         'watermarkPositionLeft',
  'center':       'watermarkPositionCenter',
  'right':        'watermarkPositionRight',
  'bottom-left':  'watermarkPositionBottomLeft',
  'bottom':       'watermarkPositionBottom',
  'bottom-right': 'watermarkPositionBottomRight',
  'tiled':        'watermarkPositionTiled',
  'custom':       'watermarkPositionCustom',
});

// Visual chips for the 3×3 grid; column-major order matches the on-screen
// layout (top-row first). The 'tiled' chip lives on its own row underneath.
const GRID_POSITIONS = [
  'top-left',    'top',    'top-right',
  'left',        'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
];

export function initWatermarkTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'watermark';
  if (want && !active) activate();
  else if (!want && active) deactivate();
  // Note: the editor panel auto-syncs from its own subscribe() call inside
  // buildWatermarkSection() — no need to drive it from here.
}

function activate() {
  overlayCanvas = document.getElementById('overlay-canvas');
  if (!overlayCanvas) return;
  active = true;
  overlayCanvas.style.pointerEvents = 'auto';
  // Default cursor is the canvas's normal cursor; hover/drag flips it via
  // CSS class toggles inside the pointer handlers.
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
    overlayCanvas.classList.remove('watermark-hover', 'watermark-dragging');
    overlayCanvas.style.cursor = '';
  }
  if (editorPanel) {
    try { editorPanel.dispose(); } catch { /* ignore */ }
    editorPanel = null;
  }
  dragging = false;
  dragOffsetCss = null;
  clearToolPanel({ owner: 'watermark' });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// --- pointer / drag --------------------------------------------------------
//
// Hit test: compute the watermark rect in OUTPUT-canvas-pixel space (same as
// the renderer), then convert the click's canvas-CSS coords into output
// pixels via the renderer's overlay canvas dims. This works for both default
// and custom positions; for tiled, we skip drag entirely (drag-a-tile is
// ambiguous, and "move all the tiles" isn't meaningful).

function computeOutputDims(img) {
  // Output canvas = post-crop/rotate dims (mirrors what the renderer paints).
  return effectiveImageSize(img);
}

// Convert a click in canvas-CSS-pixel space to output-canvas-pixel space.
// We use the overlay canvas's CSS size as the basis: the overlay canvas has
// the same CSS dims as the base canvas, and the same internal-pixel ratio.
function cssToOutputPixels(cssPoint, img) {
  if (!overlayCanvas) return null;
  const dims = computeOutputDims(img);
  const cssW = parseFloat(overlayCanvas.style.width) || overlayCanvas.clientWidth || overlayCanvas.width;
  const cssH = parseFloat(overlayCanvas.style.height) || overlayCanvas.clientHeight || overlayCanvas.height;
  if (!cssW || !cssH || !dims.w || !dims.h) return null;
  return {
    x: (cssPoint.x / cssW) * dims.w,
    y: (cssPoint.y / cssH) * dims.h,
  };
}

function computeWatermarkRectForActiveImage(img) {
  const wm = getState().ui.watermark;
  if (!wm || !wm.enabled) return null;
  const dims = computeOutputDims(img);
  if (!dims.w || !dims.h) return null;
  // imageBitmap: prefer the cached preview ImageBitmap (built by the
  // renderer) but fall back to image.width/height from the URL — for
  // hit-testing we only need width/height, not the pixels.
  const wmBitmap = getCachedWatermarkBitmap();
  const imageAspect = wmBitmap && wmBitmap.width && wmBitmap.height
    ? wmBitmap.width / wmBitmap.height
    : null;
  // For text measurement we need a 2D context — the overlay canvas is fine.
  const ctx = overlayCanvas && overlayCanvas.getContext('2d');
  const measureWidth = (text, fontSize) => {
    if (!ctx) return 0;
    ctx.save();
    ctx.font = `${fontSize}px ${wm.textFont || 'system-ui, sans-serif'}`;
    const m = ctx.measureText(String(text || ''));
    ctx.restore();
    return m && m.width ? m.width : 0;
  };
  return computeWatermarkRect({
    canvasWidth: dims.w,
    canvasHeight: dims.h,
    watermark: wm,
    measureWidth,
    imageAspect,
  });
}

function hitTestWatermark(cssPoint, img) {
  const wm = getState().ui.watermark;
  if (!wm || !wm.enabled) return null;
  if (wm.position === 'tiled') return null; // drag disabled in tiled mode
  const rect = computeWatermarkRectForActiveImage(img);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const outPoint = cssToOutputPixels(cssPoint, img);
  if (!outPoint) return null;
  if (outPoint.x >= rect.x && outPoint.x <= rect.x + rect.width &&
      outPoint.y >= rect.y && outPoint.y <= rect.y + rect.height) {
    // Compute the CSS offset from wm top-left so drag preserves the grab
    // point (avoids the watermark snapping under the cursor).
    const dims = computeOutputDims(img);
    const cssW = parseFloat(overlayCanvas.style.width) || overlayCanvas.clientWidth || overlayCanvas.width;
    const cssH = parseFloat(overlayCanvas.style.height) || overlayCanvas.clientHeight || overlayCanvas.height;
    if (!cssW || !cssH || !dims.w || !dims.h) return null;
    const wmCssX = (rect.x / dims.w) * cssW;
    const wmCssY = (rect.y / dims.h) * cssH;
    return { dx: cssPoint.x - wmCssX, dy: cssPoint.y - wmCssY };
  }
  return null;
}

function down(e) {
  const img = getActiveImage();
  if (!img) return;
  const hit = hitTestWatermark({ x: e.x, y: e.y }, img);
  if (!hit) return;
  dragging = true;
  dragOffsetCss = hit;
  if (overlayCanvas) overlayCanvas.classList.add('watermark-dragging');
}

function move(e) {
  const img = getActiveImage();
  if (!img) return;
  if (!dragging) {
    // Just hover — toggle the move cursor when the pointer is over the wm.
    const hit = hitTestWatermark({ x: e.x, y: e.y }, img);
    if (overlayCanvas) {
      overlayCanvas.classList.toggle('watermark-hover', !!hit);
    }
    return;
  }
  if (!dragOffsetCss) return;
  // Translate pointer position → watermark TOP-LEFT in CSS px, then to
  // output canvas px, then to fractional coords for state.
  const dims = computeOutputDims(img);
  const cssW = parseFloat(overlayCanvas.style.width) || overlayCanvas.clientWidth || overlayCanvas.width;
  const cssH = parseFloat(overlayCanvas.style.height) || overlayCanvas.clientHeight || overlayCanvas.height;
  if (!cssW || !cssH || !dims.w || !dims.h) return;

  const wmCssX = e.x - dragOffsetCss.dx;
  const wmCssY = e.y - dragOffsetCss.dy;
  // Convert to output pixel space.
  const wmOutX = (wmCssX / cssW) * dims.w;
  const wmOutY = (wmCssY / cssH) * dims.h;
  // The state stores the CENTER of the watermark, not the top-left.
  // Need the watermark rect to know its width/height.
  const rect = computeWatermarkRectForActiveImage(img);
  if (!rect) return;
  const centerOutX = wmOutX + rect.width / 2;
  const centerOutY = wmOutY + rect.height / 2;
  const fx = clamp01(centerOutX / dims.w);
  const fy = clamp01(centerOutY / dims.h);
  update(s => {
    s.ui.watermark.position = 'custom';
    s.ui.watermark.customX = fx;
    s.ui.watermark.customY = fy;
    // Force the preview to redraw with the new position.
    const id = s.ui.activeImageId;
    if (id && s.images[id]) s.images[id].overlaysDirty = true;
  });
}

function up(_e) {
  if (dragging) {
    dragging = false;
    dragOffsetCss = null;
    if (overlayCanvas) overlayCanvas.classList.remove('watermark-dragging');
    persistWatermark();
  }
}

// --- side panel ------------------------------------------------------------

function renderPanel() {
  // Build the editor instance — full controls including the drag hint.
  editorPanel = buildWatermarkSection({ omitDragHint: false });
  setToolPanel(editorPanel.root, { owner: 'watermark' });
}

// --------------------------------------------------------------------------
// Shared section builder — used by the editor tool panel AND the queue's
// batch panel. Each instance is fully self-contained: it builds its own DOM,
// subscribes to state, and exposes a dispose() to unwire when the host
// removes it. Both instances mutate the SAME state.ui.watermark slice, so
// edits in one panel reflect live in the other.
//
// Options:
//   - omitDragHint: when true, the "drag the watermark in the preview" hint
//     is omitted (batch panel has no canvas to drag on). Default false.
//   - omitHeading:  when true, the H2 title + tip paragraph are omitted
//     (queue panel uses its own <details>/<summary> heading). Default false.
//
// Returns { root, els, sync, dispose }.
// --------------------------------------------------------------------------

export function buildWatermarkSection({ omitDragHint = false, omitHeading = false } = {}) {
  const root = document.createElement('div');
  root.className = 'watermark-panel';

  if (!omitHeading) {
    const heading = document.createElement('h2');
    heading.className = 'panel-heading';
    heading.textContent = t('watermarkTitle');
    root.appendChild(heading);

    const tip = document.createElement('p');
    tip.className = 'watermark-tip';
    tip.textContent = t('watermarkTip');
    root.appendChild(tip);
  }

  // --- Enable toggle -----------------------------------------------------
  const enableRow = document.createElement('label');
  enableRow.className = 'watermark-row watermark-enable-row';
  const enableBox = document.createElement('input');
  enableBox.type = 'checkbox';
  enableBox.className = 'watermark-enable';
  enableBox.addEventListener('change', () => {
    update(s => { s.ui.watermark.enabled = enableBox.checked; markActiveImageDirty(s); });
    persistWatermark();
    syncEnabledClass();
  });
  enableRow.appendChild(enableBox);
  const enableLabel = document.createElement('span');
  enableLabel.textContent = t('watermarkEnable');
  enableRow.appendChild(enableLabel);
  root.appendChild(enableRow);

  // --- Sub-panel wrapper (dimmed when disabled) --------------------------
  const sub = document.createElement('div');
  sub.className = 'watermark-sub';

  // --- Type chips --------------------------------------------------------
  const typeRow = document.createElement('div');
  typeRow.className = 'watermark-row watermark-type-row';
  const typeLabel = document.createElement('span');
  typeLabel.textContent = t('watermarkType');
  typeRow.appendChild(typeLabel);
  const typeGroup = document.createElement('div');
  typeGroup.className = 'watermark-type-group';
  const typeChips = {};
  for (const t2 of ['text', 'image']) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `watermark-type-chip watermark-type-${t2}`;
    chip.dataset.type = t2;
    chip.textContent = t(t2 === 'text' ? 'watermarkTypeText' : 'watermarkTypeImage');
    chip.addEventListener('click', () => {
      update(s => { s.ui.watermark.type = t2; markActiveImageDirty(s); });
      persistWatermark();
      syncSections();
    });
    typeGroup.appendChild(chip);
    typeChips[t2] = chip;
  }
  typeRow.appendChild(typeGroup);
  sub.appendChild(typeRow);

  // --- Text section ------------------------------------------------------
  const textSection = document.createElement('div');
  textSection.className = 'watermark-section watermark-text-section';

  const textRow = document.createElement('label');
  textRow.className = 'watermark-row';
  const textLab = document.createElement('span');
  textLab.textContent = t('watermarkText');
  textRow.appendChild(textLab);
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'watermark-text-input';
  textInput.setAttribute('aria-label', t('watermarkText'));
  textInput.maxLength = 200;
  textInput.addEventListener('input', () => {
    update(s => { s.ui.watermark.text = textInput.value; markActiveImageDirty(s); });
  });
  textInput.addEventListener('blur', persistWatermark);
  textRow.appendChild(textInput);
  textSection.appendChild(textRow);

  const colorRow = document.createElement('label');
  colorRow.className = 'watermark-row';
  const colorLab = document.createElement('span');
  colorLab.textContent = t('watermarkColor');
  colorRow.appendChild(colorLab);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'watermark-text-color';
  colorInput.setAttribute('aria-label', t('watermarkColor'));
  colorInput.addEventListener('input', () => {
    update(s => { s.ui.watermark.textColor = colorInput.value; markActiveImageDirty(s); });
  });
  colorInput.addEventListener('change', persistWatermark);
  colorRow.appendChild(colorInput);
  textSection.appendChild(colorRow);

  sub.appendChild(textSection);

  // --- Image section -----------------------------------------------------
  const imgSection = document.createElement('div');
  imgSection.className = 'watermark-section watermark-image-section';

  const fileRow = document.createElement('div');
  fileRow.className = 'watermark-row watermark-file-row';
  const fileLabel = document.createElement('span');
  fileLabel.textContent = t('watermarkLogo');
  fileRow.appendChild(fileLabel);
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.className = 'watermark-file-input';
  fileInput.setAttribute('aria-label', t('watermarkLogoUpload'));
  fileInput.addEventListener('change', () => onLogoPicked(fileInput));
  fileRow.appendChild(fileInput);
  imgSection.appendChild(fileRow);

  const preview = document.createElement('div');
  preview.className = 'watermark-logo-preview';
  const previewImg = document.createElement('img');
  previewImg.className = 'watermark-logo-img';
  previewImg.alt = '';
  preview.appendChild(previewImg);
  const previewEmpty = document.createElement('span');
  previewEmpty.className = 'watermark-logo-empty';
  previewEmpty.textContent = t('watermarkLogoNone');
  preview.appendChild(previewEmpty);
  imgSection.appendChild(preview);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'watermark-logo-clear';
  clearBtn.textContent = t('watermarkLogoClear');
  clearBtn.addEventListener('click', onLogoCleared);
  imgSection.appendChild(clearBtn);

  sub.appendChild(imgSection);

  // --- Position grid -----------------------------------------------------
  const posSection = document.createElement('div');
  posSection.className = 'watermark-section watermark-position-section';
  const posLabel = document.createElement('div');
  posLabel.className = 'watermark-row watermark-position-label';
  posLabel.textContent = t('watermarkPosition');
  posSection.appendChild(posLabel);

  const grid = document.createElement('div');
  grid.className = 'watermark-position-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', t('watermarkPosition'));
  const posBtns = {};
  for (const pos of GRID_POSITIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `watermark-position-chip watermark-position-${pos}`;
    b.dataset.position = pos;
    const labelKey = POSITION_LABEL_KEYS[pos];
    const label = labelKey ? t(labelKey) : pos;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.textContent = '·'; // visual chip; aria-label conveys the meaning
    b.addEventListener('click', () => onPositionPicked(pos));
    grid.appendChild(b);
    posBtns[pos] = b;
  }
  posSection.appendChild(grid);

  // Tiled chip on its own row.
  const tiledRow = document.createElement('div');
  tiledRow.className = 'watermark-tiled-row';
  const tiledBtn = document.createElement('button');
  tiledBtn.type = 'button';
  tiledBtn.className = 'watermark-position-chip watermark-position-tiled';
  tiledBtn.dataset.position = 'tiled';
  tiledBtn.textContent = t('watermarkPositionTiled');
  tiledBtn.addEventListener('click', () => onPositionPicked('tiled'));
  tiledRow.appendChild(tiledBtn);
  posSection.appendChild(tiledRow);
  posBtns['tiled'] = tiledBtn;

  // Drag hint — editor only. The batch panel has no canvas to drag on, so
  // we omit it there entirely (showing "drag-not-available" felt noisier than
  // helpful).
  let dragHint = null;
  if (!omitDragHint) {
    dragHint = document.createElement('p');
    dragHint.className = 'watermark-drag-hint';
    dragHint.textContent = t('watermarkPositionDragHint');
    posSection.appendChild(dragHint);
  }

  sub.appendChild(posSection);

  // --- Opacity slider ----------------------------------------------------
  const opacityRow = document.createElement('label');
  opacityRow.className = 'watermark-row watermark-slider-row';
  const opacityLab = document.createElement('span');
  opacityLab.textContent = t('watermarkOpacity');
  opacityRow.appendChild(opacityLab);
  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.step = '1';
  opacityInput.className = 'watermark-opacity';
  opacityInput.setAttribute('aria-label', t('watermarkOpacity'));
  opacityRow.appendChild(opacityInput);
  const opacityReadout = document.createElement('span');
  opacityReadout.className = 'watermark-readout';
  opacityReadout.setAttribute('aria-live', 'polite');
  opacityRow.appendChild(opacityReadout);
  opacityInput.addEventListener('input', () => {
    const pct = Number(opacityInput.value) || 0;
    opacityReadout.textContent = `${pct}%`;
    update(s => { s.ui.watermark.opacity = pct / 100; markActiveImageDirty(s); });
  });
  opacityInput.addEventListener('change', persistWatermark);
  sub.appendChild(opacityRow);

  // --- Scale slider ------------------------------------------------------
  const scaleRow = document.createElement('label');
  scaleRow.className = 'watermark-row watermark-slider-row';
  const scaleLab = document.createElement('span');
  scaleLab.textContent = t('watermarkScale');
  scaleRow.appendChild(scaleLab);
  const scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = '5';
  scaleInput.max = '30';
  scaleInput.step = '1';
  scaleInput.className = 'watermark-scale';
  scaleInput.setAttribute('aria-label', t('watermarkScale'));
  scaleRow.appendChild(scaleInput);
  const scaleReadout = document.createElement('span');
  scaleReadout.className = 'watermark-readout';
  scaleReadout.setAttribute('aria-live', 'polite');
  scaleRow.appendChild(scaleReadout);
  scaleInput.addEventListener('input', () => {
    const pct = Number(scaleInput.value) || 5;
    scaleReadout.textContent = `${pct}%`;
    update(s => { s.ui.watermark.scale = pct / 100; markActiveImageDirty(s); });
  });
  scaleInput.addEventListener('change', persistWatermark);
  sub.appendChild(scaleRow);

  // --- Tiled angle slider (only meaningful when position=tiled) ---------
  const angleRow = document.createElement('label');
  angleRow.className = 'watermark-row watermark-slider-row watermark-angle-row';
  const angleLab = document.createElement('span');
  angleLab.textContent = t('watermarkTiledAngle');
  angleRow.appendChild(angleLab);
  const angleInput = document.createElement('input');
  angleInput.type = 'range';
  angleInput.min = '-90';
  angleInput.max = '90';
  angleInput.step = '1';
  angleInput.className = 'watermark-tiled-angle';
  angleInput.setAttribute('aria-label', t('watermarkTiledAngle'));
  angleRow.appendChild(angleInput);
  const angleReadout = document.createElement('span');
  angleReadout.className = 'watermark-readout';
  angleReadout.setAttribute('aria-live', 'polite');
  angleRow.appendChild(angleReadout);
  angleInput.addEventListener('input', () => {
    const deg = Number(angleInput.value) || 0;
    angleReadout.textContent = `${deg}°`;
    update(s => { s.ui.watermark.tiledAngle = deg; markActiveImageDirty(s); });
  });
  angleInput.addEventListener('change', persistWatermark);
  sub.appendChild(angleRow);

  root.appendChild(sub);

  const els = {
    root, sub,
    enableBox,
    typeChips,
    textSection, textInput, colorInput,
    imgSection, fileInput, previewImg, previewEmpty, clearBtn,
    posBtns, dragHint,
    opacityInput, opacityReadout,
    scaleInput, scaleReadout,
    angleRow, angleInput, angleReadout,
  };

  function syncSections() {
    const wm = getState().ui.watermark;
    if (!wm) return;
    textSection.hidden = wm.type !== 'text';
    imgSection.hidden  = wm.type !== 'image';
  }

  function syncEnabledClass() {
    const wm = getState().ui.watermark;
    if (!wm) return;
    sub.classList.toggle('is-disabled', !wm.enabled);
  }

  function sync() {
    const wm = getState().ui.watermark;
    if (!wm) return;
    if (enableBox.checked !== !!wm.enabled) enableBox.checked = !!wm.enabled;
    for (const t2 of ['text', 'image']) {
      const chip = typeChips[t2];
      if (!chip) continue;
      const isActive = wm.type === t2;
      chip.classList.toggle('is-active', isActive);
      chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
    syncSections();
    if (document.activeElement !== textInput && textInput.value !== (wm.text || '')) {
      textInput.value = wm.text || '';
    }
    if (document.activeElement !== colorInput) {
      colorInput.value = wm.textColor || '#ffffff';
    }
    // Logo preview.
    if (wm.imageBlobUrl) {
      previewImg.src = wm.imageBlobUrl;
      previewImg.hidden = false;
      previewEmpty.hidden = true;
    } else {
      previewImg.removeAttribute('src');
      previewImg.hidden = true;
      previewEmpty.hidden = false;
    }
    // Position chips.
    for (const [pos, btn] of Object.entries(posBtns)) {
      const isActive = wm.position === pos;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
    // Sliders.
    const opPct = Math.round((Number(wm.opacity) || 0) * 100);
    if (document.activeElement !== opacityInput) opacityInput.value = String(opPct);
    opacityReadout.textContent = `${opPct}%`;
    const scPct = Math.round((Number(wm.scale) || 0) * 100);
    if (document.activeElement !== scaleInput) scaleInput.value = String(scPct);
    scaleReadout.textContent = `${scPct}%`;
    const deg = Math.round(Number(wm.tiledAngle) || 0);
    if (document.activeElement !== angleInput) angleInput.value = String(deg);
    angleReadout.textContent = `${deg}°`;
    angleRow.hidden = wm.position !== 'tiled';
    syncEnabledClass();
  }

  // Subscribe to state so the panel auto-updates when state.ui.watermark
  // changes (including when the OTHER panel — editor or batch — mutates it).
  const unsub = subscribe(sync);
  // Prime the initial render.
  sync();

  function dispose() {
    if (typeof unsub === 'function') {
      try { unsub(); } catch { /* ignore */ }
    }
  }

  return { root, els, sync, dispose };
}

// --- logo upload / clear --------------------------------------------------

async function onLogoPicked(fileInput) {
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) return;
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const base64 = await fileToDataUrl(file);
    // Revoke any previous ObjectURL before swapping in a new one.
    const prev = getState().ui.watermark.imageBlobUrl;
    if (prev && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try { URL.revokeObjectURL(prev); } catch { /* ignore */ }
    }
    const objectUrl = URL.createObjectURL(file);
    update(s => {
      s.ui.watermark.imageBlobBase64 = base64;
      s.ui.watermark.imageBlobUrl = objectUrl;
      s.ui.watermark.type = 'image';
      markActiveImageDirty(s);
    });
    // Invalidate the cached bitmap so the renderer picks up the new logo.
    invalidateWatermarkBitmap();
    persistWatermark();
    showToast(t('watermarkSaved'), { variant: 'info' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('watermark: logo upload failed', err);
  } finally {
    // Reset the input so picking the same file again re-fires change.
    fileInput.value = '';
  }
}

function onLogoCleared() {
  const prev = getState().ui.watermark.imageBlobUrl;
  if (prev && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try { URL.revokeObjectURL(prev); } catch { /* ignore */ }
  }
  update(s => {
    s.ui.watermark.imageBlobUrl = null;
    s.ui.watermark.imageBlobBase64 = null;
    markActiveImageDirty(s);
  });
  invalidateWatermarkBitmap();
  persistWatermark();
}

function onPositionPicked(pos) {
  update(s => { s.ui.watermark.position = pos; markActiveImageDirty(s); });
  persistWatermark();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function markActiveImageDirty(s) {
  const id = s.ui.activeImageId;
  if (!id) return;
  const img = s.images[id];
  if (img) {
    img.baseDirty = true;
    img.overlaysDirty = true;
  }
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// --- ImageBitmap cache (shared between preview + this tool's hit-test) ----
//
// The renderers also need a watermark ImageBitmap; we centralize the cache
// here so a single decode serves both paths and they invalidate together
// when the logo changes.

let cachedBitmapUrl = null;
let cachedBitmap = null;
let bitmapPending = null;

export function getCachedWatermarkBitmap() {
  const url = getState().ui.watermark && getState().ui.watermark.imageBlobUrl;
  if (!url) return null;
  if (url !== cachedBitmapUrl) {
    cachedBitmapUrl = url;
    cachedBitmap = null;
    bitmapPending = null;
    // Kick off the decode; the renderer reads `cachedBitmap` once it
    // resolves on a future tick.
    if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
      bitmapPending = fetch(url)
        .then(r => r.blob())
        .then(b => createImageBitmap(b))
        .then(bm => {
          // Only commit if the URL hasn't changed mid-decode.
          if (cachedBitmapUrl === url) {
            cachedBitmap = bm;
            // Mark active image dirty so the next frame paints the logo.
            const s = getState();
            const id = s.ui.activeImageId;
            if (id && s.images[id]) {
              s.images[id].baseDirty = true;
              s.images[id].overlaysDirty = true;
            }
          }
          return bm;
        })
        .catch(err => {
          // eslint-disable-next-line no-console
          console.warn('watermark: decode failed', err && err.message);
          return null;
        });
    }
  }
  return cachedBitmap;
}

export function invalidateWatermarkBitmap() {
  if (cachedBitmap && typeof cachedBitmap.close === 'function') {
    try { cachedBitmap.close(); } catch { /* ignore */ }
  }
  cachedBitmap = null;
  cachedBitmapUrl = null;
  bitmapPending = null;
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  overlayCanvas = null;
  if (editorPanel) {
    try { editorPanel.dispose(); } catch { /* ignore */ }
    editorPanel = null;
  }
  dragging = false;
  dragOffsetCss = null;
  invalidateWatermarkBitmap();
}

// Silence unused-var lint while keeping the variable available for future
// "is the decode still in flight" UX (e.g. spinner on the preview).
void applySourceTransform;
void canvasToSource;
void POSITION_PRESETS;
void bitmapPending;
