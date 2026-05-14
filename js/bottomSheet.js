// js/bottomSheet.js — present the editor side panel as a bottom sheet on mobile.
//
// On desktop the .editor-panel sits in a fixed-width grid column on the
// right; the user sees all five <details> sections at once and can collapse
// them individually. On a phone-sized viewport the same panel is no longer
// in flow — CSS moves it to `position: fixed` and hides it off-screen via
// `transform: translateY(100%)`. This module wires:
//
//   1. A floating "Panel" trigger button (CSS keeps it hidden outside the
//      mobile media query) that toggles the sheet open/closed.
//   2. A tab strip injected into the panel that swaps between the five
//      sections. We don't move the <details> elements around — instead we
//      tag exactly one of them with `.is-active-tab` and a CSS rule hides
//      the rest. The desktop layout is untouched (those CSS rules live
//      inside `@media (max-width: 768px)`).
//   3. Outside-click and Escape close handlers.
//   4. A pointer drag-down gesture on the drag-handle area (top 40 px of
//      the sheet) that dismisses if the user pulls it down more than 80 px.
//
// The module is a no-op when the editor has no .editor-panel — keeps the
// boot order trivial: main.js can call initBottomSheet() unconditionally
// after initEditor() even on test pages that build a stub DOM.
import { t } from './i18n.js';

// Track open state at module scope so the document-level outside-click and
// keydown handlers can short-circuit when the sheet is closed (the cheapest
// way to ignore events without churning add/removeEventListener).
let isOpen = false;

// References used by setActiveTab / open / close.
let panelEl = null;
let triggerEl = null;
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

// Drag-to-close threshold. 80 px feels right after manual testing: a real
// drag must travel further than a typo / accidental finger slip, but doesn't
// require an awkward arm motion. Drags shorter than this snap back to open.
const DRAG_DISMISS_PX = 80;

// Drag-handle region: top N px of the panel count as the handle for the
// drag-to-close gesture. The visual drag-handle bar (::before pseudo) sits
// at roughly y=8..12px inside the panel — we extend the hit area a few
// more pixels so a less-precise finger placement still grabs the handle
// instead of falling through to a tab. CRUCIAL: this must NOT overlap the
// tab strip below, or `setPointerCapture` will swallow tab clicks.
const DRAG_HANDLE_HEIGHT = 20;

export function initBottomSheet() {
  panelEl = document.querySelector('.editor-panel');
  if (!panelEl) return;
  // Idempotency: re-running boot shouldn't double up tabs or triggers.
  if (panelEl.dataset.bottomSheetReady === '1') return;
  panelEl.dataset.bottomSheetReady = '1';

  injectTrigger();
  injectTabBar();
  mapDetails();

  // Mark the first tab active so opening the sheet shows something. We do
  // this even on desktop — the class is a no-op there because the desktop
  // CSS shows every <details> unconditionally (the `:not(.is-active-tab)`
  // hide rule lives inside the mobile media query).
  setActiveTab(TABS[0].name);

  wireTriggerClick();
  wireTabClicks();
  wireOutsideClick();
  wireEscape();
  enableDragToClose();
}

// --- DOM injection --------------------------------------------------------

function injectTrigger() {
  triggerEl = document.createElement('button');
  triggerEl.type = 'button';
  triggerEl.className = 'editor-panel-trigger';
  triggerEl.setAttribute('aria-label', t('bottomSheetTrigger'));
  triggerEl.setAttribute('aria-expanded', 'false');
  triggerEl.setAttribute('aria-controls', 'editor-panel');
  // Use innerHTML so the data-i18n attribute on the label span propagates
  // when language is switched — applyDomTranslations() walks every
  // [data-i18n] in the DOM and we want this button's label to update too.
  triggerEl.innerHTML = `<span aria-hidden="true">&#9776;</span> <span data-i18n="bottomSheetTrigger">Panel</span>`;
  document.body.appendChild(triggerEl);

  // The .editor-panel needs a stable id so the trigger's aria-controls can
  // reference it. We set it idempotently — desktop tests may have already
  // queried this element by class, but id is incremental.
  if (panelEl && !panelEl.id) panelEl.id = 'editor-panel';
}

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
  // Insert as the FIRST child of the panel. The drag-handle bar is a
  // ::before pseudo on .editor-panel, so it sits visually above the tabs
  // without needing its own DOM node.
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

function open() {
  if (!panelEl) return;
  panelEl.classList.add('is-open');
  if (triggerEl) triggerEl.setAttribute('aria-expanded', 'true');
  isOpen = true;
}

function close() {
  if (!panelEl) return;
  panelEl.classList.remove('is-open');
  if (triggerEl) triggerEl.setAttribute('aria-expanded', 'false');
  // Reset any inline transform set by an aborted drag so the next open
  // animates cleanly from the CSS-driven baseline.
  panelEl.style.transform = '';
  isOpen = false;
}

// --- Event wiring --------------------------------------------------------

function wireTriggerClick() {
  if (!triggerEl) return;
  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen) close(); else open();
  });
}

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

function wireOutsideClick() {
  document.addEventListener('click', (e) => {
    if (!isOpen) return;
    if (!panelEl) return;
    // Clicks on the panel itself, the trigger, or inside a dialog (e.g.
    // export progress) shouldn't dismiss. The Document-level handler runs
    // AFTER per-target handlers thanks to bubble order — our trigger
    // handler stops propagation, so we'll never see those here.
    if (panelEl.contains(e.target)) return;
    if (triggerEl && triggerEl.contains(e.target)) return;
    if (e.target.closest('dialog')) return;
    close();
  });
}

function wireEscape() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!isOpen) return;
    close();
  });
}

// --- Drag-to-close gesture ------------------------------------------------
//
// Pointer drag on the top DRAG_HANDLE_HEIGHT pixels of the panel — usually
// the drag-handle bar zone — translates the sheet down. Releasing past
// DRAG_DISMISS_PX dismisses; anything shorter snaps back via the CSS
// transition. We use PointerEvents (not just touch) so trackpad-emulating-
// touch on a desktop debug session also works.

function enableDragToClose() {
  if (!panelEl) return;
  let startY = null;
  let dragging = false;

  panelEl.addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    // Only the top handle area initiates a drag. This prevents a stray
    // pointerdown on a slider inside the panel from being interpreted as
    // a dismiss gesture.
    const rect = panelEl.getBoundingClientRect();
    if (e.clientY - rect.top > DRAG_HANDLE_HEIGHT) return;
    startY = e.clientY;
    dragging = true;
    try { panelEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Suppress the CSS transition while dragging so the panel follows the
    // pointer 1:1 without easing out behind the finger.
    panelEl.style.transition = 'none';
  });

  panelEl.addEventListener('pointermove', (e) => {
    if (!dragging || startY == null) return;
    const dy = e.clientY - startY;
    if (dy > 0) {
      panelEl.style.transform = `translateY(${dy}px)`;
    } else {
      panelEl.style.transform = '';
    }
  });

  panelEl.addEventListener('pointerup', (e) => {
    if (!dragging || startY == null) return;
    const dy = e.clientY - startY;
    startY = null;
    dragging = false;
    // Restore the CSS-driven transition so the snap-back / close animates.
    panelEl.style.transition = '';
    // Clear inline transform — either open() (which already has translate(0)
    // via the .is-open class) or close() will set the right value.
    panelEl.style.transform = '';
    try { panelEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (dy > DRAG_DISMISS_PX) {
      close();
    }
  });

  panelEl.addEventListener('pointercancel', () => {
    if (!dragging) return;
    startY = null;
    dragging = false;
    panelEl.style.transition = '';
    panelEl.style.transform = '';
  });
}

// --- Test helpers ---------------------------------------------------------

// Test-only reset hook so spec files can re-initialise after manipulating
// the editor shell. Mirrors editor.js _resetForTest pattern.
export function _resetForTest() {
  if (panelEl) {
    panelEl.classList.remove('is-open');
    delete panelEl.dataset.bottomSheetReady;
    panelEl.style.transform = '';
    panelEl.style.transition = '';
  }
  if (triggerEl && triggerEl.parentNode) triggerEl.parentNode.removeChild(triggerEl);
  if (tabBarEl && tabBarEl.parentNode) tabBarEl.parentNode.removeChild(tabBarEl);
  panelEl = null;
  triggerEl = null;
  tabBarEl = null;
  tabToDetails.clear();
  isOpen = false;
}
