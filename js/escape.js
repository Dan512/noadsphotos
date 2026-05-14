// js/escape.js — string escaping + allowlist sanitizers used at every system boundary.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ESC[c]);
}

export function pickFromAllowlist(value, allowlist, fallback) {
  return allowlist.includes(value) ? value : fallback;
}
