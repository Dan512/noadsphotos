// js/tools/panTool.js — the Pan tool.
//
// When state.ui.activeTool === 'pan' AND zoom > 1 (image overflows the
// canvas frame), drag on the canvas translates the canvas-frame scroll
// position so the user can move around inside the zoomed-in image.
//
// Behavior:
//   - pointerdown captures the current scroll position + pointer position
//   - pointermove translates scrollLeft/scrollTop by the delta
//   - pointerup releases (the scroll position is the new normal)
//
// Zoom <= 1: cursor stays default, drag does nothing (nothing to pan).
//
// The Pan tool can also be temporarily activated from any other tool by
// holding Space — see js/shortcuts.js for the global accelerator.
//
// The Tool-options panel for Pan is intentionally minimal: just a hint
// describing how to use the tool. Pan has no parameters to configure.
import { getState, subscribe } from '../state.js';
import { attachPointer } from '../pointer.js';
import { setToolPanel, clearToolPanel, getToolPanelBody } from '../editor.js';
import { t } from '../i18n.js';

let active = false;
let detach = null;
let panState = null;  // { startScrollLeft, startScrollTop, startClientX, startClientY }

export function initPanTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const wantActive = s.ui.view === 'editor' && s.ui.activeTool === 'pan';
  if (wantActive && !active) activate();
  else if (!wantActive && active) deactivate();
}

function activate() {
  const body = getToolPanelBody();
  if (!body) return; // editor not mounted yet — handleStateChange retries
  const frame = document.querySelector('.canvas-frame');
  if (!frame) return;
  active = true;
  frame.classList.add('is-pan-tool-active');
  attachPanHandlers(frame);
  renderPanel();
}

function deactivate() {
  active = false;
  const frame = document.querySelector('.canvas-frame');
  if (frame) frame.classList.remove('is-pan-tool-active', 'is-panning');
  detachPanHandlers();
  panState = null;
  clearToolPanel({ owner: 'pan' });
}

function attachPanHandlers(frame) {
  if (detach) return;
  detach = attachPointer(frame, {
    down(e) {
      // Only pan when the image actually overflows the frame. If everything
      // fits, there's nothing to pan and we shouldn't capture the gesture.
      const canPan = frame.scrollWidth > frame.clientWidth || frame.scrollHeight > frame.clientHeight;
      if (!canPan) return;
      panState = {
        startScrollLeft: frame.scrollLeft,
        startScrollTop:  frame.scrollTop,
        startClientX:    e.clientX,
        startClientY:    e.clientY,
      };
      frame.classList.add('is-panning');
    },
    move(e) {
      if (!panState) return;
      // Inverted delta: dragging right should reveal more to the right
      // (scroll content left), so subtract.
      frame.scrollLeft = panState.startScrollLeft - (e.clientX - panState.startClientX);
      frame.scrollTop  = panState.startScrollTop  - (e.clientY - panState.startClientY);
    },
    up() {
      panState = null;
      frame.classList.remove('is-panning');
    },
    cancel() {
      panState = null;
      frame.classList.remove('is-panning');
    },
  });
}

function detachPanHandlers() {
  if (detach) {
    try { detach(); } catch { /* ignore */ }
    detach = null;
  }
}

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'pan-tool-panel';

  const hint = document.createElement('p');
  hint.className = 'tool-hint';
  hint.textContent = t('editorToolPanTip');
  root.appendChild(hint);

  setToolPanel(root, { owner: 'pan', titleKey: 'editorToolPan' });
}

// No in-progress state worth cancelling — drag is committed on pointerup.
export function cancelPanTool() {
  return false;
}

// --- Spacebar accelerator helpers ----------------------------------------
//
// The global Space+drag accelerator (js/shortcuts.js) temporarily activates
// the Pan tool's pointer handlers without changing state.ui.activeTool, so
// the user can resume their previous tool when Space is released. These
// helpers expose the attach/detach machinery without changing the
// is-pan-tool-active CSS class (we use is-pan-temporarily-active instead,
// styled identically, so deactivation cleans up cleanly even if the user
// releases Space mid-drag).

let temporarilyActive = false;

export function activatePanTemporarily() {
  if (active || temporarilyActive) return;
  const frame = document.querySelector('.canvas-frame');
  if (!frame) return;
  temporarilyActive = true;
  frame.classList.add('is-pan-temporarily-active');
  attachPanHandlers(frame);
}

export function deactivatePanTemporarily() {
  if (!temporarilyActive) return;
  temporarilyActive = false;
  const frame = document.querySelector('.canvas-frame');
  if (frame) frame.classList.remove('is-pan-temporarily-active', 'is-panning');
  detachPanHandlers();
  panState = null;
}

// Reset hook for tests so state doesn't leak between cases.
export function _resetForTest() {
  detachPanHandlers();
  active = false;
  temporarilyActive = false;
  panState = null;
  const frame = document.querySelector('.canvas-frame');
  if (frame) frame.classList.remove('is-pan-tool-active', 'is-pan-temporarily-active', 'is-panning');
}
