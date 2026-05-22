// js/ops/textConsent.js — first-use consent modal for the Tesseract.js
// OCR engine used by the "Detect text" feature in the redact tool.
// Mirrors faceConsent.js / heicConsent.js: a one-shot <dialog> with
// Continue / Cancel. Persistence (one-time grant per VENDOR_HASH) lives
// in js/ops/textDetect.js.
//
// NOTE: this is the third near-duplicate of the consent-modal pattern in
// the codebase (HEIC, face, text). v1.3 should consolidate them into a
// single helper. See follow-ups in 2026-05-22-ocr-redact-design.md.
import { escapeHtml } from '../escape.js';
import { t } from '../i18n.js';

/**
 * Show the first-use text-detect consent modal. Resolves `true` on
 * Continue, `false` on Cancel / Esc / backdrop click.
 *
 * The body string is a translated paragraph with one {size} placeholder
 * for the bolded download-size label.
 *
 * @param {{ sizeLabel?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export function showTextConsentModal({ sizeLabel = '~6 MB' } = {}) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    const dialog = document.createElement('dialog');
    dialog.className = 'text-consent-dialog';
    dialog.setAttribute('aria-label', t('textConsentTitle'));
    const body = t('textConsentBody', { size: 'PLACEHOLDER' })
      .replace('PLACEHOLDER', `<strong>${escapeHtml(sizeLabel)}</strong>`);
    dialog.innerHTML = `
      <h2>${escapeHtml(t('textConsentTitle'))}</h2>
      <p>${body}</p>
      <div class="text-consent-actions">
        <button type="button" class="text-consent-cancel">${escapeHtml(t('textConsentCancel'))}</button>
        <button type="button" class="text-consent-continue btn-primary">${escapeHtml(t('textConsentContinue'))}</button>
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
    dialog.querySelector('.text-consent-continue').addEventListener('click', () => finish(true));
    dialog.querySelector('.text-consent-cancel').addEventListener('click',   () => finish(false));
    dialog.addEventListener('close', () => finish(false));
    dialog.addEventListener('click', (e) => { if (e.target === dialog) finish(false); });

    try {
      dialog.showModal();
    } catch {
      // Older browsers / headless: fall back to window.confirm().
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('textConsentBody', { size: sizeLabel }))
        : true;
      finish(ok);
    }
  });
}
