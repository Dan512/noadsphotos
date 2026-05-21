// js/ops/heicConsent.js — first-use consent modal for the lazy HEIC decoder.
//
// Mirrors the bg-remove consent pattern (see js/ops/bgremove.js#showConsentModal):
// a one-shot <dialog> with Continue / Cancel actions. Persistence + the
// VENDOR_HASH bump live in js/vendor/heic-loader.js — this file only owns the
// modal UX.
//
// Kept separate from heic-loader.js so the loader module stays focused on the
// decoder lifecycle (and so it can be unit-tested without dragging in i18n /
// escape helpers).
import { escapeHtml } from '../escape.js';
import { t } from '../i18n.js';

/**
 * Show the first-use HEIC consent modal. Resolves with `true` on Continue,
 * `false` on Cancel / Esc / backdrop click.
 *
 * @param {{ vendorHash?: string, sizeLabel?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export function showConsentModalImpl({ sizeLabel = '~1.1 MB' } = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      // Headless environments: default to denying so callers don't hang.
      resolve(false);
      return;
    }
    const dialog = document.createElement('dialog');
    dialog.className = 'heic-consent-dialog';
    dialog.setAttribute('aria-label', t('heicConsentTitle'));
    // Body: replace {size} placeholder with bolded label after i18n lookup
    // so the markup stays out of every translated string.
    const body = t('heicConsentBody', { size: 'PLACEHOLDER' })
      .replace('PLACEHOLDER', `<strong>${escapeHtml(sizeLabel)}</strong>`);
    dialog.innerHTML = `
      <h2>${escapeHtml(t('heicConsentTitle'))}</h2>
      <p>${body}</p>
      <div class="heic-consent-actions">
        <button type="button" class="heic-consent-cancel">${escapeHtml(t('heicConsentCancel'))}</button>
        <button type="button" class="heic-consent-continue btn-primary">${escapeHtml(t('heicConsentContinue'))}</button>
      </div>
    `;
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (granted) => {
      if (settled) return;
      settled = true;
      try { if (dialog.open) dialog.close(); } catch { /* ignore */ }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      resolve(granted);
    };
    dialog.querySelector('.heic-consent-continue').addEventListener('click', () => finish(true));
    dialog.querySelector('.heic-consent-cancel').addEventListener('click',   () => finish(false));
    dialog.addEventListener('close', () => finish(false));
    dialog.addEventListener('click', (e) => { if (e.target === dialog) finish(false); });

    try {
      dialog.showModal();
    } catch {
      // Older browsers / headless environments without <dialog>: fall back to
      // window.confirm() to match the bg-remove pattern.
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('heicConsentBody', { size: sizeLabel }))
        : true;
      finish(ok);
    }
  });
}
