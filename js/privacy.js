// js/privacy.js — in-app privacy panel modal.
//
// The footer Privacy link opens a <dialog> mirroring privacy.html's
// content. The static /privacy.html page remains as a stable URL for
// external references (the bg-remove consent dialog links there, and
// other NoAds-suite pages can deep-link to it too).
//
// Content comes from i18n keys (privacyTitle, privacyLead, …). A subset
// of those keys legitimately contains raw HTML — they're inserted via
// `innerHTML` so anchor tags inside the lists work. The HTML in those
// strings is authored by us (translators get a TODO note in i18n.js),
// not derived from user input, so the innerHTML use is safe.
import { t } from './i18n.js';

let dialogEl = null;

export function initPrivacy() {
  // Two privacy triggers as of v1.1.1: the footer button (always present,
  // visible on mobile) AND a new header link (visible on desktop, hidden
  // on mobile via .header-only-desktop). Both open the same modal.
  for (const id of ['privacy-toggle', 'privacy-toggle-header']) {
    const link = document.getElementById(id);
    if (!link) continue;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openPanel();
    });
  }
}

function openPanel() {
  // Re-use the dialog if it's already in the DOM (e.g. user dismissed
  // then re-opened) so we don't pile up multiple instances.
  if (dialogEl && dialogEl.isConnected) {
    try { dialogEl.showModal(); }
    catch { dialogEl.setAttribute('open', ''); }
    return;
  }

  const dialog = document.createElement('dialog');
  dialog.id = 'privacy-panel';
  dialog.className = 'privacy-panel-dialog';
  dialog.setAttribute('aria-label', t('privacyTitle'));
  dialog.innerHTML = `
    <button type="button" class="dialog-close" data-close aria-label="${escapeAttr(t('close'))}">×</button>
    <article class="prose">
      ${buildPrivacyHtml()}
    </article>
  `;
  document.body.appendChild(dialog);

  // Click handler for explicit close button + click-on-backdrop. The
  // browser fires a click event on the <dialog> itself when the user
  // clicks the backdrop (because the backdrop is part of the dialog's
  // box but the inner content has its own bounds).
  dialog.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) {
      dialog.close();
      return;
    }
    if (e.target === dialog) {
      // Backdrop click: the e.target is the dialog element itself, not a
      // descendant. Verify with a getBoundingClientRect hit-test so an
      // accidental click on the dialog padding doesn't dismiss it.
      const rect = dialog.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right
                  && e.clientY >= rect.top  && e.clientY <= rect.bottom;
      if (!inside) dialog.close();
    }
  });
  dialog.addEventListener('close', () => {
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    if (dialogEl === dialog) dialogEl = null;
  });

  dialogEl = dialog;
  try { dialog.showModal(); }
  catch { dialog.setAttribute('open', ''); }
}

function buildPrivacyHtml() {
  // Each key gets ONE call to t() — list bodies are single keys so a
  // translator can rewrite the whole <li>…</li> block per locale. We don't
  // pass `vars` so no escaping happens (the keys themselves are trusted
  // copy authored by us).
  // SAFETY: privacy*List keys contain author-controlled HTML inserted via
  // innerHTML. Future translations must NOT interpolate user data and must
  // be reviewed for unescaped tags.
  return `
    <h1>${t('privacyTitle')}</h1>
    <p class="lead">${t('privacyLead')}</p>
    <h2>${t('privacyFetchesHeading')}</h2>
    <ul>${t('privacyFetchesList')}</ul>
    <h2>${t('privacyNotHeading')}</h2>
    <ul>${t('privacyNotList')}</ul>
    <h2>${t('privacyExternalHeading')}</h2>
    <ul>${t('privacyExternalList')}</ul>
    <h2>${t('privacyStorageHeading')}</h2>
    <p>${t('privacyStorageBody')}</p>
    <h2>${t('privacyAIHeading')}</h2>
    <p>${t('privacyAIBody')}</p>
    <h2>${t('privacyOpenSourceHeading')}</h2>
    <p>${t('privacyOpenSourceBody')}</p>
    <h2>${t('privacyTipHeading')}</h2>
    <p>${t('privacyTipBody')}</p>
    <p class="privacy-static-link"><a href="/privacy.html" target="_blank" rel="noopener">${t('privacyStaticLink')}</a></p>
  `;
}

// Local escape for attribute values where we don't want to pull escape.js
// into this module (it's already used by t() through interpolation for
// vars, but we use the bare-string keys here).
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Test-only reset.
export function _resetForTest() {
  if (dialogEl) {
    try { if (dialogEl.open) dialogEl.close(); } catch { /* ignore */ }
    if (dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    dialogEl = null;
  }
}
