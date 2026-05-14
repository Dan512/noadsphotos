// js/errors.js — non-blocking user-visible notification toasts.
import { escapeHtml } from './escape.js';
import { t } from './i18n.js';

const DEFAULT_VARIANT = 'info';
const DEFAULT_DURATION_MS = 6000;
const VARIANTS = ['info', 'warn', 'error'];

let rootEl = null;

function ensureRoot() {
  if (rootEl && rootEl.isConnected) return rootEl;
  rootEl = document.getElementById('toast-root');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'toast-root';
    document.body.appendChild(rootEl);
  }
  return rootEl;
}

export function showToast(message, opts = {}) {
  const variant = VARIANTS.includes(opts.variant) ? opts.variant : DEFAULT_VARIANT;
  const duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION_MS;
  const role = (variant === 'warn' || variant === 'error') ? 'alert' : 'status';

  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.setAttribute('role', role);
  toast.innerHTML = escapeHtml(message);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', t('toastDismiss'));
  closeBtn.textContent = '×';

  toast.appendChild(closeBtn);

  const dismiss = () => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
    clearTimeout(timer);
  };

  closeBtn.addEventListener('click', dismiss);

  const timer = duration > 0 ? setTimeout(dismiss, duration) : null;

  ensureRoot().appendChild(toast);
  return dismiss; // caller can dismiss programmatically
}
