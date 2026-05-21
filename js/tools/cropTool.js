// js/tools/cropTool.js — interactive crop overlay + side panel.
//
// Behavior summary:
//   - When state.ui.activeTool === 'crop' (and we're in the editor with an
//     active image): attach pointer listeners to #overlay-canvas, render an
//     8-handle crop rect with dimmed exterior, and inject a side-panel form
//     (aspect-lock dropdown + Apply + Cancel).
//   - The crop rect is held locally as a "preview" until the user clicks
//     Apply — only then does it become state.transforms.crop. Cancel discards
//     the preview.
//   - Drag from a handle → resize via geometry.aspectLockResize. Drag inside
//     the rect → move. Drag outside the rect → start a new rect.
//   - Deactivation (activeTool changes) detaches pointer listeners and clears
//     the panel + overlay so other tools can own them.
import { attachPointer } from '../pointer.js';
import { getState, subscribe, update } from '../state.js';
import {
  rectFromHandles,
  clampCropToImage,
  aspectLockResize,
} from '../geometry.js';
import { applyCrop } from '../ops/transforms.js';
import { setToolPanel, clearToolPanel } from '../editor.js';
import { setOverlayDrawer, clearOverlayDrawer } from '../render/previewRenderer.js';
import { withTransformsHistory } from '../historyOps.js';
import { t } from '../i18n.js';

// Handle hit-box radius (in CSS pixels relative to the overlay canvas).
const HANDLE_SIZE = 12;
const HANDLE_HALF = HANDLE_SIZE / 2;

// All 8 handle codes; order matters only for rendering iteration consistency.
const HANDLE_CODES = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'];

// Aspect-lock options shown in the dropdown. Labels resolve via t() at
// render time; numeric ratios stay locale-independent.
const ASPECTS = [
  { value: 'free',   i18n: 'cropAspectFree',   ratio: 0 },
  { value: '1:1',    i18n: 'cropAspect11',     ratio: 1 },
  { value: '4:3',    i18n: 'cropAspect43',     ratio: 4 / 3 },
  { value: '16:9',   i18n: 'cropAspect169',    ratio: 16 / 9 },
  { value: '3:2',    i18n: 'cropAspect32',     ratio: 3 / 2 },
  { value: 'custom', i18n: 'cropAspectCustom', ratio: 0 },
];

// Module-level state. Reset across activate/deactivate cycles.
let detach = null;
let active = false;
let previewRect = null; // {x,y,w,h} in SOURCE-IMAGE coords
let dragMode = null;    // 'move' | 'resize-<handle>' | 'new' | null
let dragStartScreen = null;
let dragStartRect = null;
let dragNewAnchorWorld = null; // for 'new' drag: the world point where the user pressed
let aspect = 'free';
let customAspect = '';
let overlayCanvas = null;
let overlayCtx = null;
let baseCanvas = null;

// References to side-panel controls so we can read their values without
// re-querying.
let panelEls = null; // { aspectSel, customInput, applyBtn, cancelBtn }

export function initCropTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const wantActive = s.ui.view === 'editor' && s.ui.activeTool === 'crop';
  if (wantActive && !active) activate();
  else if (!wantActive && active) deactivate();
  // The rAF loop redraws every frame while overlayDrawer is set — nothing
  // else to do here.
}

function activate() {
  overlayCanvas = document.getElementById('overlay-canvas');
  baseCanvas = document.getElementById('base-canvas');
  if (!overlayCanvas || !baseCanvas) return; // editor not mounted yet
  overlayCtx = overlayCanvas.getContext('2d');

  active = true;
  // Enable pointer events on the overlay so we can capture drags.
  overlayCanvas.style.pointerEvents = 'auto';
  detach = attachPointer(overlayCanvas, { down, move, up });

  // Initialise the preview rect.
  const img = getActiveImage();
  if (img) {
    const existing = img.transforms.crop;
    if (existing && existing.w > 0 && existing.h > 0) {
      previewRect = { ...existing };
    } else {
      previewRect = { x: 0, y: 0, w: img.source.width, h: img.source.height };
    }
  } else {
    previewRect = null;
  }

  renderToolPanel();
  // Register the drawer with the preview renderer so it gets called every
  // rAF tick AFTER the renderer clears the overlay. This avoids races where
  // the renderer would otherwise wipe the crop UI on the next frame.
  setOverlayDrawer(drawCropOverlay);
}

function deactivate() {
  active = false;
  previewRect = null;
  dragMode = null;
  if (detach) {
    detach();
    detach = null;
  }
  if (overlayCanvas) {
    overlayCanvas.style.pointerEvents = 'none';
    if (overlayCtx) {
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
  }
  clearOverlayDrawer();
  panelEls = null;
  clearToolPanel({ owner: 'crop' });
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

// --------------------------------------------------------------------------
// World ↔ overlay-canvas-CSS-pixel mapping
//
// previewRect is held in SOURCE-IMAGE coordinates (the same space as
// state.transforms.crop) so it round-trips cleanly through applyCrop.
//
// For Phase 4 v1 the mapping assumes the displayed-image area fills the
// canvas at its source dimensions. This is correct when the user enters
// the crop tool on an image that has no existing crop. If the image already
// has a crop or non-quarter rotation, the visible bitmap dims differ from
// source dims and the handles will be slightly off — Phase 6+ will refine
// crop-after-transform UX. The most common path (crop once, then apply) is
// fully supported.
// --------------------------------------------------------------------------

function getMapping() {
  const img = getActiveImage();
  if (!img || !baseCanvas || !overlayCanvas) return null;
  const cssW = parseFloat(baseCanvas.style.width) || baseCanvas.width;
  const cssH = parseFloat(baseCanvas.style.height) || baseCanvas.height;
  const srcW = img.source.width;
  const srcH = img.source.height;
  if (!srcW || !srcH || !cssW || !cssH) return null;
  // zoom converts SOURCE pixels → overlay CSS pixels.
  const zoom = Math.min(cssW / srcW, cssH / srcH);
  // Center the displayed image inside the overlay canvas (handles letterboxing
  // when source aspect != canvas aspect).
  const offsetX = (cssW - srcW * zoom) / 2;
  const offsetY = (cssH - srcH * zoom) / 2;
  return { zoom, offsetX, offsetY, cssW, cssH, srcW, srcH };
}

function worldToOverlay(p, m) {
  return { x: p.x * m.zoom + m.offsetX, y: p.y * m.zoom + m.offsetY };
}

function overlayToWorld(p, m) {
  return { x: (p.x - m.offsetX) / m.zoom, y: (p.y - m.offsetY) / m.zoom };
}

function getAspectRatio() {
  if (aspect === 'free') return 0;
  if (aspect === 'custom') {
    return parseCustomAspect(customAspect);
  }
  const found = ASPECTS.find(a => a.value === aspect);
  return found ? found.ratio : 0;
}

function parseCustomAspect(raw) {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  if (s.includes(':')) {
    const [a, b] = s.split(':').map(x => Number(x.trim()));
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
    return 0;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// --------------------------------------------------------------------------
// Pointer handlers
// --------------------------------------------------------------------------

function down(e) {
  const m = getMapping();
  if (!m || !previewRect) return;

  // Hit-test handles first.
  const handle = hitTestHandle(e, m);
  if (handle) {
    dragMode = 'resize-' + handle;
    dragStartScreen = { x: e.x, y: e.y };
    dragStartRect = { ...previewRect };
    return;
  }

  const world = overlayToWorld({ x: e.x, y: e.y }, m);

  // Hit-test the rect interior.
  if (pointInRect(world, previewRect)) {
    dragMode = 'move';
    dragStartScreen = { x: e.x, y: e.y };
    dragStartRect = { ...previewRect };
    return;
  }

  // Else: start a new rect from this point.
  dragMode = 'new';
  dragNewAnchorWorld = world;
  previewRect = { x: world.x, y: world.y, w: 0, h: 0 };
}

function move(e) {
  if (!dragMode) return;
  const m = getMapping();
  if (!m) return;
  const img = getActiveImage();
  if (!img) return;

  const world = overlayToWorld({ x: e.x, y: e.y }, m);
  const ratio = getAspectRatio();

  if (dragMode === 'move') {
    const dxScreen = e.x - dragStartScreen.x;
    const dyScreen = e.y - dragStartScreen.y;
    const dxWorld = dxScreen / m.zoom;
    const dyWorld = dyScreen / m.zoom;
    const next = {
      x: dragStartRect.x + dxWorld,
      y: dragStartRect.y + dyWorld,
      w: dragStartRect.w,
      h: dragStartRect.h,
    };
    previewRect = clampCropToImage(next, { w: img.source.width, h: img.source.height });
    return;
  }

  if (dragMode && dragMode.startsWith('resize-')) {
    const handle = dragMode.slice('resize-'.length);
    const next = aspectLockResize(dragStartRect, handle, world, ratio);
    // Don't clamp during drag — let it grow freely and clamp only at up.
    // But also don't allow negative w/h here; aspectLockResize already guards
    // for some cases but corner drags can produce negatives. We rely on
    // up-time normalisation via rectFromHandles.
    previewRect = next;
    return;
  }

  if (dragMode === 'new') {
    let rect = rectFromHandles(dragNewAnchorWorld, world);
    if (ratio > 0) {
      // Honour aspect lock for new rect: pick the larger dimension.
      const w = rect.w;
      const h = rect.h;
      const wFromH = h * ratio;
      let finalW, finalH;
      if (w > wFromH) {
        finalW = w;
        finalH = w / ratio;
      } else {
        finalW = wFromH;
        finalH = h;
      }
      // Place so anchor stays at one corner — keep the anchor stationary.
      const anchor = dragNewAnchorWorld;
      const targetXDir = world.x >= anchor.x ? 1 : -1;
      const targetYDir = world.y >= anchor.y ? 1 : -1;
      rect = {
        x: targetXDir > 0 ? anchor.x : anchor.x - finalW,
        y: targetYDir > 0 ? anchor.y : anchor.y - finalH,
        w: finalW,
        h: finalH,
      };
    }
    previewRect = rect;
  }
}

function up(_e) {
  if (!dragMode) return;
  const img = getActiveImage();
  // Normalise and clamp at the end of the drag so down-stream callers see a
  // well-formed rect.
  if (previewRect && img) {
    let normalised = previewRect;
    if (normalised.w < 0 || normalised.h < 0) {
      // Convert into a positive-extent rect via handle normalisation.
      const a = { x: normalised.x, y: normalised.y };
      const b = { x: normalised.x + normalised.w, y: normalised.y + normalised.h };
      normalised = rectFromHandles(a, b);
    }
    previewRect = clampCropToImage(normalised, {
      w: img.source.width,
      h: img.source.height,
    });
  }
  dragMode = null;
  dragStartScreen = null;
  dragStartRect = null;
  dragNewAnchorWorld = null;
}

// --------------------------------------------------------------------------
// Hit-testing
// --------------------------------------------------------------------------

function pointInRect(p, rect) {
  return p.x >= rect.x && p.x <= rect.x + rect.w &&
         p.y >= rect.y && p.y <= rect.y + rect.h;
}

function hitTestHandle(e, m) {
  if (!previewRect) return null;
  // Compute handle centers in overlay-CSS-pixel coords.
  for (const code of HANDLE_CODES) {
    const center = handleCenterScreen(code, m);
    if (Math.abs(e.x - center.x) <= HANDLE_HALF + 1 &&
        Math.abs(e.y - center.y) <= HANDLE_HALF + 1) {
      return code;
    }
  }
  return null;
}

function handleCenterScreen(code, m) {
  const r = previewRect;
  const tl = worldToOverlay({ x: r.x, y: r.y }, m);
  const br = worldToOverlay({ x: r.x + r.w, y: r.y + r.h }, m);
  const cx = (tl.x + br.x) / 2;
  const cy = (tl.y + br.y) / 2;
  switch (code) {
    case 'tl': return { x: tl.x, y: tl.y };
    case 't':  return { x: cx,   y: tl.y };
    case 'tr': return { x: br.x, y: tl.y };
    case 'l':  return { x: tl.x, y: cy   };
    case 'r':  return { x: br.x, y: cy   };
    case 'bl': return { x: tl.x, y: br.y };
    case 'b':  return { x: cx,   y: br.y };
    case 'br': return { x: br.x, y: br.y };
  }
  return { x: cx, y: cy };
}

// --------------------------------------------------------------------------
// Render: dim outside, outline rect, 8 handles
//
// Registered as the previewRenderer's overlay drawer; called every rAF tick
// AFTER the renderer clears the overlay canvas. The renderer passes its own
// 2d context. We re-derive the mapping each call (the canvas may have been
// resized since we last drew).
// --------------------------------------------------------------------------

function drawCropOverlay(ctx, canvas) {
  if (!active) return;
  const m = getMapping();
  if (!m) return;
  if (!previewRect || previewRect.w <= 0 || previewRect.h <= 0) return;

  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const tl = worldToOverlay({ x: previewRect.x, y: previewRect.y }, m);
  const br = worldToOverlay({
    x: previewRect.x + previewRect.w,
    y: previewRect.y + previewRect.h,
  }, m);
  const rectScreen = {
    x: tl.x,
    y: tl.y,
    w: br.x - tl.x,
    h: br.y - tl.y,
  };

  // Dim everything outside the rect.
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.rect(0, 0, m.cssW, m.cssH);
  ctx.rect(rectScreen.x, rectScreen.y, rectScreen.w, rectScreen.h);
  ctx.fill('evenodd');
  ctx.restore();

  // Rect outline.
  const accent = getAccent();
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(rectScreen.x, rectScreen.y, rectScreen.w, rectScreen.h);
  ctx.restore();

  // Handles.
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  for (const code of HANDLE_CODES) {
    const c = handleCenterScreen(code, m);
    const x = c.x - HANDLE_HALF;
    const y = c.y - HANDLE_HALF;
    ctx.fillRect(x, y, HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeRect(x, y, HANDLE_SIZE, HANDLE_SIZE);
  }
  ctx.restore();
}

function getAccent() {
  // Resolve --accent against the editor root. Falls back if unavailable.
  try {
    const styles = getComputedStyle(document.documentElement);
    const v = styles.getPropertyValue('--accent').trim();
    if (v) return v;
  } catch { /* ignore */ }
  return '#2a8c69';
}

// --------------------------------------------------------------------------
// Side panel
// --------------------------------------------------------------------------

function renderToolPanel() {
  const root = document.createElement('div');
  root.className = 'crop-tool-panel';

  const heading = document.createElement('h2');
  heading.textContent = t('cropTitle');
  heading.className = 'panel-heading';
  root.appendChild(heading);

  const aspectRow = document.createElement('label');
  aspectRow.className = 'crop-row';
  aspectRow.textContent = t('cropAspectLock');
  const aspectSel = document.createElement('select');
  aspectSel.className = 'crop-aspect';
  aspectSel.setAttribute('aria-label', t('cropAspectLockAria'));
  for (const a of ASPECTS) {
    const opt = document.createElement('option');
    opt.value = a.value;
    opt.textContent = t(a.i18n);
    aspectSel.appendChild(opt);
  }
  aspectSel.value = aspect;
  aspectRow.appendChild(aspectSel);
  root.appendChild(aspectRow);

  const customRow = document.createElement('label');
  customRow.className = 'crop-row crop-custom-row';
  customRow.textContent = t('cropCustomLabel');
  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.className = 'crop-custom-aspect';
  customInput.placeholder = t('cropCustomPlaceholder');
  customInput.value = customAspect;
  customInput.setAttribute('aria-label', t('cropCustomAria'));
  customRow.appendChild(customInput);
  customRow.hidden = aspect !== 'custom';
  root.appendChild(customRow);

  const actions = document.createElement('div');
  actions.className = 'crop-actions';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'crop-apply btn-primary';
  applyBtn.textContent = t('cropApply');
  actions.appendChild(applyBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'crop-cancel';
  cancelBtn.textContent = t('cropCancel');
  actions.appendChild(cancelBtn);

  root.appendChild(actions);

  setToolPanel(root, { owner: 'crop' });
  panelEls = { aspectSel, customInput, customRow, applyBtn, cancelBtn };

  aspectSel.addEventListener('change', () => {
    aspect = aspectSel.value;
    customRow.hidden = aspect !== 'custom';
  });
  customInput.addEventListener('input', () => {
    customAspect = customInput.value;
  });
  applyBtn.addEventListener('click', () => {
    const img = getActiveImage();
    if (!img || !previewRect) return;
    const rect = previewRect;
    if (rect.w <= 0 || rect.h <= 0) return;
    withTransformsHistory('Crop', img.id, state => {
      applyCrop(state.images[img.id], rect);
    });
    // Deactivate by switching back to select tool.
    update(s => { s.ui.activeTool = 'select'; });
  });
  cancelBtn.addEventListener('click', () => {
    // Discard preview; switch back to select.
    update(s => { s.ui.activeTool = 'select'; });
  });
}

// Test-only reset for browser specs.
export function _resetForTest() {
  if (detach) { try { detach(); } catch { /* ignore */ } detach = null; }
  active = false;
  previewRect = null;
  dragMode = null;
  aspect = 'free';
  customAspect = '';
  panelEls = null;
  overlayCanvas = null;
  overlayCtx = null;
  baseCanvas = null;
}
