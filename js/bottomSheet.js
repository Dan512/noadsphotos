// js/bottomSheet.js — tabbed section selector for the editor side panel.
//
// Phase 14: the bottom-sheet dismissable dialog is gone. On mobile the
// .editor-panel is now anchored to the bottom 40 vh of the viewport at all
// times, no trigger button, no drag-to-close. What remains useful is the
// tab strip that swaps between the five panel sections (Tool / Resize /
// Adjust / Overlays / Export) — without it the five <details> stacks
// vertically and forces a lot of scrolling in 40 vh.
//
// We keep the module name and a few APIs (initBottomSheet, _resetForTest)
// so the boot order in main.js doesn't need to change. The historical
// trigger DOM node is no longer injected — CSS hides any stray copy
// unconditionally via `display: none !important;`.
import { t } from './i18n.js';

// References used by setActiveTab.
let panelEl = null;
let tabBarEl = null;
const tabToDetails = new Map(); // tab name -> HTMLDetailsElement

// Tabs in display order. Keep in sync with the five <details> sections built
// in editor.js (panelToolOptions, panelResize, panelAdjust, panelOverlays,
// panelExport). Each entry references its i18n label key — the tab labels
// re-translate when language changes via the i18n module's [data-i18n] walk.
const TABS = Object.freeze([
  { name: 'tool',     i18n: 'tab_tool',     panelId: 'panel-tool' },
  { name: 'resize',   i18n: 'tab_resize',   panelId: 'panel-resize' },
  { name: 'adjust',   i18n: 'tab_adjust',   panelId: 'panel-adjust' },
  { name: 'overlays', i18n: 'tab_overlays', panelId: 'panel-overlays' },
  { name: 'export',   i18n: 'tab_export',   panelId: 'panel-export' },
]);

export function initBottomSheet() {
  panelEl = document.querySelector('.editor-panel');
  if (!panelEl) return;
  // Idempotency: re-running boot shouldn't double up tabs.
  if (panelEl.dataset.bottomSheetReady === '1') return;
  panelEl.dataset.bottomSheetReady = '1';

  injectTabBar();
  mapDetails();

  // Mark the first tab active so the panel always has a visible section.
  // The class is a no-op on desktop because the desktop CSS shows every
  // <details> unconditionally (the `:not(.is-active-tab)` hide rule lives
  // inside the mobile media query).
  setActiveTab(TABS[0].name);

  wireTabClicks();

  // The panel needs a stable id for assistive tech. Set it idempotently.
  if (panelEl && !panelEl.id) panelEl.id = 'editor-panel';
}

// --- DOM injection --------------------------------------------------------

function injectTabBar() {
  tabBarEl = document.createElement('div');
  tabBarEl.className = 'editor-panel-tabs';
  tabBarEl.setAttribute('role', 'tablist');
  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'editor-panel-tab';
    btn.dataset.tab = tab.name;
    btn.dataset.i18n = tab.i18n;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = t(tab.i18n);
    tabBarEl.appendChild(btn);
  }
  // Insert as the FIRST child of the panel.
  panelEl.insertBefore(tabBarEl, panelEl.firstChild);
}

function mapDetails() {
  // Build the tab->details lookup by walking children. Don't rely on a
  // strict order — the editor mounts the details in TABS order today, but
  // if a future refactor reorders them we still want the mapping to work.
  const detailsList = panelEl.querySelectorAll('details');
  const byId = new Map();
  for (const d of detailsList) {
    if (d.id) byId.set(d.id, d);
  }
  tabToDetails.clear();
  for (const tab of TABS) {
    const d = byId.get(tab.panelId);
    if (d) tabToDetails.set(tab.name, d);
  }
}

// --- Public API used internally ------------------------------------------

function setActiveTab(name) {
  // Update tab chips.
  if (tabBarEl) {
    for (const btn of tabBarEl.querySelectorAll('.editor-panel-tab')) {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }
  // Update details visibility marker. We also force `open` so the body is
  // expanded — on mobile the <summary> is hidden via CSS, so without this
  // a collapsed <details> would just show its hidden summary and nothing
  // else.
  for (const [tab, d] of tabToDetails) {
    const active = tab === name;
    d.classList.toggle('is-active-tab', active);
    if (active && !d.open) d.open = true;
  }
}

// --- Event wiring --------------------------------------------------------

function wireTabClicks() {
  if (!tabBarEl) return;
  tabBarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.editor-panel-tab');
    if (!btn) return;
    const name = btn.dataset.tab;
    if (!name) return;
    setActiveTab(name);
  });
}

// --- Test helpers ---------------------------------------------------------

// Test-only reset hook so spec files can re-initialise after manipulating
// the editor shell. Mirrors editor.js _resetForTest pattern.
export function _resetForTest() {
  if (panelEl) {
    delete panelEl.dataset.bottomSheetReady;
  }
  if (tabBarEl && tabBarEl.parentNode) tabBarEl.parentNode.removeChild(tabBarEl);
  panelEl = null;
  tabBarEl = null;
  tabToDetails.clear();
}
