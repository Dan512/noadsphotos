// js/ops/faceConsent.js — first-use consent modal for the BlazeFace
// auto-detect model. Mirrors heicConsent.js exactly: a one-shot <dialog>
// with Continue / Cancel actions. Persistence (one-time grant per
// VENDOR_HASH) lives in js/ops/faceDetect.js.
import { escapeHtml } from '../escape.js';
import { t } from '../i18n.js';

/**
 * Show the first-use face-detect consent modal. Resolves `true` on
 * Continue, `false` on Cancel / Esc / backdrop click.
 *
 * The body string is a translated paragraph with one {size} placeholder;
 * we substitute the bolded download-size label after the i18n lookup so
 * translators don't have to ship raw HTML.
 *
 * @param {{ sizeLabel?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export function showFaceConsentModal({ sizeLabel = '~600 KB' } = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    const dialog = document.createElement('dialog');
    dialog.className = 'face-consent-dialog';
    dialog.setAttribute('aria-label', t('faceConsentTitle'));
    const body = t('faceConsentBody', { size: 'PLACEHOLDER' })
      .replace('PLACEHOLDER', `<strong>${escapeHtml(sizeLabel)}</strong>`);
    dialog.innerHTML = `
      <h2>${escapeHtml(t('faceConsentTitle'))}</h2>
      <p>${body}</p>
      <div class="face-consent-actions">
        <button type="button" class="face-consent-cancel">${escapeHtml(t('faceConsentCancel'))}</button>
        <button type="button" class="face-consent-continue btn-primary">${escapeHtml(t('faceConsentContinue'))}</button>
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
    dialog.querySelector('.face-consent-continue').addEventListener('click', () => finish(true));
    dialog.querySelector('.face-consent-cancel').addEventListener('click',   () => finish(false));
    dialog.addEventListener('close', () => finish(false));
    dialog.addEventListener('click', (e) => { if (e.target === dialog) finish(false); });

    try {
      dialog.showModal();
    } catch {
      // Older browsers / headless: fall back to window.confirm().
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('faceConsentBody', { size: sizeLabel }))
        : true;
      finish(ok);
    }
  });
}
