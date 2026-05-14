// js/settings.js — settings popover + persistence + reactive subscribers.
//
// The popover follows the same anchored-to-trigger pattern as
// languagePicker.js — click the gear, the popover opens beneath it; click
// outside or press Escape to close. Settings live in a SINGLE JSON blob
// under localStorage key `noadsimages_settings`, validated against
// SETTINGS_SCHEMA on every load so a tampered blob can't smuggle a
// `javascript:hack` theme into the DOM.
//
// Consumers (queueView, brush, previewRenderer, exporter, editor) read the
// current value via `getSetting(key)` — they never reach into state
// directly. Setting changes notify subscribers via state.update() so any
// reactive UI rebuilds automatically.
//
// Theme override is the only setting that paints synchronously: we apply
// the stored theme BEFORE wiring subscribers so the first paint of the
// editor uses the user's preferred theme (no flash of wrong theme).
import { getState, update, subscribe } from './state.js';
import { t, applyDomTranslations } from './i18n.js';
import { escapeHtml, pickFromAllowlist } from './escape.js';

const STORAGE_KEY = 'noadsimages_settings';

// Schema is the single source of truth for which keys exist, their kinds,
// allowed values, and defaults. New settings go here first; consumers add
// a getSetting() call separately.
//
// Defaults rationale:
//   - theme: 'auto' so the OS preference wins on first visit.
//   - defaultExportFormat: 'png' — the lossless default; users opt into JPG.
//   - defaultQuality: 0.92 — matches state.export.quality default in state.js.
//   - confirmBeforeRemove: false — would be friction on first launch.
//   - showOverlayOutlines: false — clutters the canvas by default.
//   - smoothBrushStrokes:  true — current behavior; opt-out for raw lines.
export const SETTINGS_SCHEMA = Object.freeze({
  theme:                  { kind: 'enum',   options: ['auto', 'light', 'dark'], default: 'auto' },
  defaultExportFormat:    { kind: 'enum',   options: ['png', 'jpeg', 'webp'],   default: 'png' },
  defaultQuality:         { kind: 'number', min: 0.5, max: 1.0,                 default: 0.92 },
  confirmBeforeRemove:    { kind: 'bool',                                       default: false },
  showOverlayOutlines:    { kind: 'bool',                                       default: false },
  smoothBrushStrokes:     { kind: 'bool',                                       default: true  },
  autoRefreshThumbnails:  { kind: 'bool',                                       default: true  },
  showThemeButton:        { kind: 'bool',                                       default: true  },
  showLanguagePicker:     { kind: 'bool',                                       default: true  },
});

// --- Public API -----------------------------------------------------------

export function initSettings() {
  // Read+validate BEFORE the first paint. applyThemeFromState writes
  // <html data-theme="…"> which the CSS reads to override the OS theme,
  // and we want that decision in place before the editor's first render.
  loadFromStorage();
  applyThemeFromState();
  // Seed state.export with the user's defaults BEFORE the editor renders
  // its panels. v1 spec: defaults kick in for NEW state, not retroactively
  // — so we apply once at boot and let further per-image choices override.
  seedExportDefaults();
  bindGear();
  bindThemeToggle();
  applyTopbarVisibility();
  applyThemeButtonIcon();
  // Subscribe so a programmatic settings change (e.g. via the popover or
  // setSetting() from tests) reflects in the DOM without manual plumbing.
  subscribe(applyThemeFromState);
  subscribe(applyTopbarVisibility);
  subscribe(applyThemeButtonIcon);
  // Watch for OS-level color scheme changes so the topbar toggle icon
  // tracks the system preference when theme === 'auto'.
  if (typeof window !== 'undefined' && window.matchMedia) {
    try {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyThemeButtonIcon();
      if (mql.addEventListener) mql.addEventListener('change', handler);
      else if (mql.addListener) mql.addListener(handler);
    } catch { /* ignore — older browsers */ }
  }
}

function seedExportDefaults() {
  const fmt = getSetting('defaultExportFormat');
  const q = getSetting('defaultQuality');
  update(s => {
    if (!s.export) return;
    s.export.format = fmt;
    s.export.quality = q;
  });
}

export function getSetting(key) {
  const s = getState().ui.settings;
  if (s && key in s) return s[key];
  return SETTINGS_SCHEMA[key]?.default;
}

export function setSetting(key, value) {
  const schema = SETTINGS_SCHEMA[key];
  if (!schema) return;
  const clean = sanitize(key, value);
  update(s => {
    if (!s.ui.settings || typeof s.ui.settings !== 'object') s.ui.settings = {};
    s.ui.settings[key] = clean;
  });
  persist();
}

export function restoreDefaults() {
  update(s => {
    if (!s.ui.settings || typeof s.ui.settings !== 'object') s.ui.settings = {};
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
      s.ui.settings[key] = SETTINGS_SCHEMA[key].default;
    }
  });
  persist();
}

// --- Validation -----------------------------------------------------------

function sanitize(key, value) {
  const schema = SETTINGS_SCHEMA[key];
  if (!schema) return undefined;
  if (schema.kind === 'enum') {
    return pickFromAllowlist(value, schema.options, schema.default);
  }
  if (schema.kind === 'bool') {
    return !!value;
  }
  if (schema.kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return schema.default;
    return Math.max(schema.min, Math.min(schema.max, n));
  }
  return schema.default;
}

// --- Theme bridge ---------------------------------------------------------

function applyThemeFromState() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const theme = getSetting('theme');
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

// --- Topbar toggles -------------------------------------------------------

// Determine the theme currently being DISPLAYED (light or dark), considering
// the html[data-theme] attribute first and the OS preference second.
function getDisplayedTheme() {
  if (typeof document === 'undefined' || !document.documentElement) return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  if (typeof window !== 'undefined' && window.matchMedia) {
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch { /* ignore */ }
  }
  return 'light';
}

// Wire the topbar theme-toggle button. Clicking always sets an EXPLICIT
// theme (light or dark) — never auto. The settings popover stays the only
// path back to auto.
function bindThemeToggle() {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const displayed = getDisplayedTheme();
    const next = displayed === 'dark' ? 'light' : 'dark';
    setSetting('theme', next);
  });
}

// Hide/show #theme-toggle and #lang-toggle based on user preference.
function applyTopbarVisibility() {
  if (typeof document === 'undefined') return;
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.hidden = !getSetting('showThemeButton');
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) langBtn.hidden = !getSetting('showLanguagePicker');
}

// Sync the topbar theme-toggle button's emoji to the displayed theme.
//   light → ☀️  (means "we're showing light right now")
//   dark  → 🌙  (means "we're showing dark right now")
function applyThemeButtonIcon() {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const displayed = getDisplayedTheme();
  btn.textContent = displayed === 'dark' ? '🌙' : '☀️';
}

// --- Persistence ----------------------------------------------------------

function loadFromStorage() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch { /* Safari private mode / disabled storage — fall through */ }

  let parsed = null;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { /* corrupted JSON — drop */ }
  }

  const cleaned = {};
  for (const key of Object.keys(SETTINGS_SCHEMA)) {
    const incoming = parsed && typeof parsed === 'object' && key in parsed
      ? parsed[key]
      : SETTINGS_SCHEMA[key].default;
    cleaned[key] = sanitize(key, incoming);
  }

  update(s => {
    if (!s.ui.settings || typeof s.ui.settings !== 'object') s.ui.settings = {};
    Object.assign(s.ui.settings, cleaned);
  });
}

function persist() {
  try {
    const s = getState().ui.settings || {};
    // Re-sanitize each value before persisting so the blob on disk is
    // always known-safe, even if a caller bypassed setSetting().
    const safe = {};
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
      safe[key] = sanitize(key, s[key] ?? SETTINGS_SCHEMA[key].default);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch { /* ignore — same as i18n.js */ }
}

// --- Gear button + popover ------------------------------------------------

function bindGear() {
  const btn = document.getElementById('settings-toggle');
  if (!btn) return;
  let popover = null;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover) { closePopover(); return; }
    popover = openPopover(btn);
  });

  document.addEventListener('click', (e) => {
    if (popover && !popover.contains(e.target) && e.target !== btn) {
      closePopover();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover) closePopover();
  });
  window.addEventListener('resize', () => {
    if (popover) positionPopover(popover, btn);
  });

  function openPopover(anchor) {
    const el = document.createElement('div');
    el.className = 'settings-popover';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('settings'));
    el.innerHTML = buildPopoverHtml();
    document.body.appendChild(el);
    positionPopover(el, anchor);
    // The popover content includes data-i18n nodes inside option elements
    // (e.g. format names). applyDomTranslations() catches them.
    applyDomTranslations();
    bindRows(el);
    return el;
  }

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
  }
}

// Build the popover's HTML. Every row uses data-setting="keyName" so
// bindRows() can wire generic listeners. Labels go through t() at build
// time so the strings reflect the current language.
function buildPopoverHtml() {
  const theme = getSetting('theme');
  const fmt = getSetting('defaultExportFormat');
  const quality = getSetting('defaultQuality');
  const confirmRemove = getSetting('confirmBeforeRemove');
  const overlayOutlines = getSetting('showOverlayOutlines');
  const smoothBrush = getSetting('smoothBrushStrokes');
  const autoRefreshThumbs = getSetting('autoRefreshThumbnails');
  const showTheme = getSetting('showThemeButton');
  const showLang = getSetting('showLanguagePicker');

  // Each row carries data-setting so bindRows() can iterate generically.
  // Selects/inputs inside a row are uniquely identified by their type +
  // the row's data-setting.
  return `
    <div class="settings-row" data-setting="theme">
      <label for="settings-theme">${escapeHtml(t('settingsTheme'))}</label>
      <select id="settings-theme" aria-label="${escapeHtml(t('settingsThemeAria'))}">
        <option value="auto"${theme === 'auto' ? ' selected' : ''}>${escapeHtml(t('settingsThemeAuto'))}</option>
        <option value="light"${theme === 'light' ? ' selected' : ''}>${escapeHtml(t('settingsThemeLight'))}</option>
        <option value="dark"${theme === 'dark' ? ' selected' : ''}>${escapeHtml(t('settingsThemeDark'))}</option>
      </select>
    </div>
    <div class="settings-row" data-setting="defaultExportFormat">
      <label for="settings-default-format">${escapeHtml(t('settingsDefaultFormat'))}</label>
      <select id="settings-default-format" aria-label="${escapeHtml(t('settingsDefaultFormatAria'))}">
        <option value="png"${fmt === 'png' ? ' selected' : ''}>${escapeHtml(t('exportFormatPng'))}</option>
        <option value="jpeg"${fmt === 'jpeg' ? ' selected' : ''}>${escapeHtml(t('exportFormatJpg'))}</option>
        <option value="webp"${fmt === 'webp' ? ' selected' : ''}>${escapeHtml(t('exportFormatWebp'))}</option>
      </select>
    </div>
    <div class="settings-row" data-setting="defaultQuality">
      <label for="settings-default-quality">${escapeHtml(t('settingsDefaultQuality'))}</label>
      <input type="range" id="settings-default-quality"
             min="0.5" max="1" step="0.01"
             value="${escapeHtml(String(quality))}"
             aria-label="${escapeHtml(t('settingsDefaultQualityAria'))}">
    </div>
    <div class="settings-row" data-setting="confirmBeforeRemove">
      <label for="settings-confirm-remove">${escapeHtml(t('settingsConfirmRemove'))}</label>
      <input type="checkbox" id="settings-confirm-remove"
             ${confirmRemove ? 'checked' : ''}
             aria-label="${escapeHtml(t('settingsConfirmRemoveAria'))}">
    </div>
    <div class="settings-row" data-setting="showOverlayOutlines">
      <label for="settings-overlay-outlines">${escapeHtml(t('settingsOverlayOutlines'))}</label>
      <input type="checkbox" id="settings-overlay-outlines"
             ${overlayOutlines ? 'checked' : ''}
             aria-label="${escapeHtml(t('settingsOverlayOutlinesAria'))}">
    </div>
    <div class="settings-row" data-setting="smoothBrushStrokes">
      <label for="settings-smooth-brush">${escapeHtml(t('settingsSmoothBrush'))}</label>
      <input type="checkbox" id="settings-smooth-brush"
             ${smoothBrush ? 'checked' : ''}
             aria-label="${escapeHtml(t('settingsSmoothBrushAria'))}">
    </div>
    <div class="settings-row" data-setting="autoRefreshThumbnails">
      <label for="settings-auto-refresh-thumbs">${escapeHtml(t('settingsAutoRefreshThumbs'))}</label>
      <input type="checkbox" id="settings-auto-refresh-thumbs"
             ${autoRefreshThumbs ? 'checked' : ''}
             aria-label="${escapeHtml(t('settingsAutoRefreshThumbsAria'))}">
    </div>
    <div class="settings-row" data-setting="showThemeButton">
      <label for="settings-show-theme">${escapeHtml(t('settingsShowTheme'))}</label>
      <input type="checkbox" id="settings-show-theme"
             ${showTheme ? 'checked' : ''}
             aria-label="${escapeHtml(t('settingsShowThemeAria'))}">
    </div>
    <div class="settings-row" data-setting="showLanguagePicker">
      <label for="settings-show-language">${escapeHtml(t('settingsShowLanguage'))}</label>
      <input type="checkbox" id="settings-show-language"
             ${showLang ? 'checked' : ''}
             aria-label="${escapeHtml(t('settingsShowLanguageAria'))}">
    </div>
    <div class="settings-divider" aria-hidden="true"></div>
    <button type="button" class="settings-revert-btn"
            aria-label="${escapeHtml(t('settingsRestoreDefaultsAria'))}">
      ${escapeHtml(t('settingsRestoreDefaults'))}
    </button>
  `;
}

// Wire generic listeners on each settings row. Each row has a single
// control whose value gets piped to setSetting(key, value). The revert
// button resets everything and rebuilds the popover content.
function bindRows(popover) {
  for (const row of popover.querySelectorAll('[data-setting]')) {
    const key = row.dataset.setting;
    const control = row.querySelector('select, input');
    if (!control) continue;
    const evt = control.type === 'checkbox' ? 'change' : 'input';
    control.addEventListener(evt, () => {
      const value = control.type === 'checkbox' ? control.checked : control.value;
      setSetting(key, value);
    });
  }

  const revert = popover.querySelector('.settings-revert-btn');
  if (revert) {
    revert.addEventListener('click', (e) => {
      // Stop propagation so the document-level click handler that closes
      // popovers doesn't fire AFTER we've replaced the popover's innerHTML
      // — by then the clicked button isn't a descendant anymore and the
      // "click outside" check would close the popover.
      e.stopPropagation();
      restoreDefaults();
      // Rebuild the popover content so every control reflects the new
      // defaults without us walking each one.
      popover.innerHTML = buildPopoverHtml();
      applyDomTranslations();
      bindRows(popover);
    });
  }
}

// Position the popover under the gear button's bottom-right corner.
// Mirrors languagePicker.js so the two popovers feel consistent.
function positionPopover(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const POP_WIDTH_FALLBACK = 320;
  const margin = 4;
  let right = window.innerWidth - rect.right;
  let top = rect.bottom + margin;
  if (right + POP_WIDTH_FALLBACK > window.innerWidth - 8) {
    right = 8;
  }
  el.style.top = `${Math.max(8, top)}px`;
  el.style.right = `${Math.max(8, right)}px`;
  el.style.left = 'auto';
}
