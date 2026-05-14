// js/languagePicker.js — language picker popover. Click the globe to open;
// click a flag to switch languages; a reload applies the new language to
// every dynamically rendered surface in the app (privacy panel, batch
// panel, editor side panels, etc.) without having to walk every JS render
// path.
//
// Positioning: anchored to the lang-toggle button's bottom-right corner.
// Closes on outside click or Escape.
import { escapeHtml } from './escape.js';
import { LANGS, LANG_NAMES, setLanguage, getLanguage, t } from './i18n.js';

export function initLanguagePicker() {
  const btn = document.getElementById('lang-toggle');
  if (!btn) return;
  // Update the flag image src to reflect the current language. We do this
  // once at boot — language changes trigger a full reload so the src is
  // re-derived on the next load.
  applyFlagToButton(btn);
  let popover = null;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover) { closePopover(); return; }
    popover = openPopover(btn);
  });

  document.addEventListener('click', e => {
    if (popover && !popover.contains(e.target) && e.target !== btn) closePopover();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && popover) closePopover();
  });

  // Reposition on resize/scroll so the popover stays anchored.
  window.addEventListener('resize', () => {
    if (popover) positionPopover(popover, btn);
  });

  function openPopover(anchor) {
    const el = document.createElement('div');
    el.className = 'language-popover';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', t('language'));
    const current = getLanguage();
    el.innerHTML = LANGS.map(code => {
      const isActive = code === current;
      // Note: flag PNGs live at /img/flags/<code>.png. The alt text is
      // intentionally empty — the <span> next to the flag carries the
      // accessible name.
      const flag = `<img src="/img/flags/${escapeHtml(code)}.png" alt="" width="20" height="14">`;
      const name = escapeHtml(LANG_NAMES[code] || code);
      const activeAttr = isActive ? 'aria-current="true"' : '';
      return `<button class="language-row${isActive ? ' is-active' : ''}" type="button" data-lang="${escapeHtml(code)}" role="menuitem" ${activeAttr}>${flag}<span>${name}</span></button>`;
    }).join('');
    document.body.appendChild(el);
    positionPopover(el, anchor);

    el.addEventListener('click', e => {
      const row = e.target.closest('[data-lang]');
      if (!row) return;
      const code = row.dataset.lang;
      // Persist + apply, then reload so every dynamically rendered DOM
      // surface picks up the new strings cleanly.
      setLanguage(code);
      window.location.reload();
    });

    return el;
  }

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
  }
}

// Position the popover under the anchor's bottom-right corner. Width is
// CSS-driven (min-width: 220px). We position by viewport coords (fixed).
function positionPopover(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const POP_WIDTH_FALLBACK = 220;
  const margin = 4;
  // Default: right-align under the button.
  let right = window.innerWidth - rect.right;
  let top = rect.bottom + margin;
  // Make sure we don't run off the left edge.
  if (right + POP_WIDTH_FALLBACK > window.innerWidth - 8) {
    right = 8;
  }
  el.style.top = `${Math.max(8, top)}px`;
  el.style.right = `${Math.max(8, right)}px`;
  el.style.left = 'auto';
}

// Update the lang-toggle button's flag <img> to the current language. If the
// language's flag PNG is missing (e.g. tr.png isn't shipped yet) we silently
// fall back to en.png and log a console warning. The button itself carries
// the accessible name via data-i18n="language" on aria-label.
function applyFlagToButton(btn) {
  const img = btn.querySelector('img.lang-flag');
  if (!img) return;
  const code = getLanguage();
  const src = `/img/flags/${code}.png`;
  // Pre-load and verify via an off-DOM Image. On error, swap to en.png and
  // warn. We don't block the initial render — if the load fails we'll
  // already have shown a broken image briefly, then swap.
  img.src = src;
  // Bind a one-shot error handler. If the path 404s, fall back to en.
  img.onerror = () => {
    img.onerror = null;
    if (!src.endsWith('/en.png')) {
      console.warn(`languagePicker: flag for "${code}" not found at ${src}; falling back to en.png`);
      img.src = '/img/flags/en.png';
    }
  };
}
