// js/canvasProgress.js — centred translucent progress card overlaid on the
// editor canvas. Owns the lifecycle of `#canvas-progress-overlay` and exposes
// a tiny imperative API:
//
//   show({ title, stage, percent })  — fills the card and reveals it
//   update({ stage, percent })       — updates fields without re-flashing
//   hide()                           — hides + resets
//
// The element is created by editor.js inside `.canvas-frame` during shell
// build; this module only finds it by id and mutates content. The bg-remove
// op (js/ops/bgremove.js) is the only intended caller today — batch bg-remove
// from the queue view continues to use its own modal dialog because there's
// no canvas to overlay there.
//
// Why a separate module? Keeping the overlay logic out of editor.js (which
// is already large) and out of ops/bgremove.js (which is data-flow, not UI)
// makes it easy to add other long-running canvas-bound operations later.

let els = null; // { root, title, stageEl, bar, percentEl } | null

// Find the static elements injected by editor.js. Returns true if the
// overlay element is currently present in the DOM.
function findEls() {
  const root = typeof document !== 'undefined'
    ? document.getElementById('canvas-progress-overlay')
    : null;
  if (!root) {
    els = null;
    return false;
  }
  els = {
    root,
    title:     root.querySelector('.canvas-progress-title'),
    stageEl:   root.querySelector('.canvas-progress-stage'),
    bar:       root.querySelector('.canvas-progress-bar'),
    percentEl: root.querySelector('.canvas-progress-percent'),
  };
  return true;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Show the overlay with initial content. Safe to call multiple times; the
 * element is reused. The `percent` is a 0–100 number (or undefined for an
 * indeterminate state).
 */
export function show({ title = '', stage = '', percent } = {}) {
  if (!findEls()) return;
  if (els.title)   els.title.textContent = title;
  if (els.stageEl) els.stageEl.textContent = stage;
  applyProgress(percent);
  els.root.hidden = false;
  // Force a reflow before clearing aria-hidden so screen readers pick up the
  // text change. Browsers may otherwise ignore the live region on first show.
  void els.root.offsetWidth;
  els.root.setAttribute('aria-hidden', 'false');
}

/**
 * Update stage label and/or percent without changing visibility. If the
 * overlay isn't currently showing this is a no-op (the next show() call
 * will pick up the new state via its own arguments).
 */
export function update({ stage, percent } = {}) {
  if (!findEls()) return;
  if (els.root.hidden) return;
  if (typeof stage === 'string' && els.stageEl) {
    els.stageEl.textContent = stage;
  }
  applyProgress(percent);
}

/**
 * Hide the overlay and reset its content. Safe to call when already hidden.
 */
export function hide() {
  if (!findEls()) return;
  els.root.hidden = true;
  els.root.setAttribute('aria-hidden', 'true');
  if (els.title)     els.title.textContent = '';
  if (els.stageEl)   els.stageEl.textContent = '';
  if (els.percentEl) els.percentEl.textContent = '';
  if (els.bar) {
    els.bar.style.setProperty('--progress', '0%');
    els.bar.removeAttribute('aria-valuenow');
    els.bar.setAttribute('aria-valuetext', '');
  }
}

function applyProgress(percent) {
  if (!els || !els.bar) return;
  if (percent == null || !Number.isFinite(percent)) {
    // Indeterminate — set the bar to a small constant width and leave it.
    // We don't ship an indeterminate animation today; the bg-remove flow
    // always passes a numeric percent, so this is purely defensive.
    els.bar.style.setProperty('--progress', '0%');
    els.bar.removeAttribute('aria-valuenow');
    els.bar.setAttribute('aria-valuetext', '');
    if (els.percentEl) els.percentEl.textContent = '';
    return;
  }
  const clamped = clamp01(percent / 100);
  const pct = Math.round(clamped * 100);
  els.bar.style.setProperty('--progress', `${pct}%`);
  els.bar.setAttribute('aria-valuenow', String(pct));
  els.bar.setAttribute('aria-valuetext', `${pct}%`);
  if (els.percentEl) els.percentEl.textContent = `${pct}%`;
}

// Test-only reset hook so browser specs that rebuild the editor shell can
// drop our cached element handles.
export function _resetForTest() {
  els = null;
}
