// js/shareTarget.js — Android PWA share-target intake.
//
// Two flows depending on browser capability (see Feature #14 design):
//
//   (a) launchQueue API (modern Chrome / Android 12+) — files arrive as
//       FileSystemFileHandle objects via window.launchQueue.setConsumer().
//       We resolve each to a File, filter out empties, and hand off to the
//       standard importFiles() entry point. Purely additive — no change to
//       the regular drag/drop/paste/file-input importer.
//
//   (b) URL fallback — older Android Chrome navigates to /?share-target
//       with a multipart/form-data POST. The static GH Pages host can't
//       read POST bodies, so we can only detect the *intent* by the query
//       string and surface an honest explanatory toast.
//
// iOS Safari does not implement Web Share Target API at all (as of 2026-05);
// users on iOS fall through both paths and never see anything.

import { importFiles } from './importer.js';
import { showToast } from './errors.js';
import { t } from './i18n.js';

/**
 * Pure helper — true iff the URL fallback hint should be shown.
 *
 *   - The user landed on /?share-target (so they DID intend to share), AND
 *   - launchQueue is NOT available (so the modern path can't fire).
 *
 * Extracted so it can be unit-tested without DOM mocks.
 *
 * @param {string} search - the document.location.search string (with or without leading '?')
 * @param {boolean} hasLaunchQueue - whether window.launchQueue exists
 * @returns {boolean}
 */
export function shouldShowUnsupportedHint(search, hasLaunchQueue) {
  if (hasLaunchQueue) return false;
  if (typeof search !== 'string' || search.length === 0) return false;
  try {
    const params = new URLSearchParams(search);
    return params.has('share-target');
  } catch {
    return false;
  }
}

/**
 * Wire the Android PWA share-target handlers. Idempotent at the call site
 * (boot calls once); safe to no-op on browsers that lack launchQueue and
 * weren't navigated to ?share-target.
 *
 * @param {object} caps - capability probe result (from probeCapabilities)
 * @param {object} lifecycle - lifecycle manager (from createLifecycle)
 */
export function initShareTarget(caps, lifecycle) {
  // (a) launchQueue path — modern Chrome on Android.
  if (typeof window !== 'undefined'
      && 'launchQueue' in window
      && window.launchQueue
      && typeof window.launchQueue.setConsumer === 'function') {
    window.launchQueue.setConsumer(async (launchParams) => {
      try {
        const handles = launchParams && launchParams.files;
        if (!handles || handles.length === 0) return;
        const files = await Promise.all(
          Array.from(handles).map(async (handle) => {
            // FileSystemFileHandle → File. Defensive: some implementations
            // might already pass File objects directly.
            return (handle && typeof handle.getFile === 'function')
              ? await handle.getFile()
              : handle;
          }),
        );
        const acceptable = files.filter(f => f && typeof f.size === 'number' && f.size > 0);
        if (acceptable.length === 0) return;
        await importFiles(acceptable, caps, lifecycle);
        showToast(
          t('shareTargetReceived', { count: acceptable.length }),
          { variant: 'info' },
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('shareTarget: import failed', err);
        showToast(t('shareTargetFailed'), { variant: 'error' });
      }
    });
  }

  // (b) URL fallback — surface an honest explanation if the user landed
  // here via a share intent but launchQueue isn't wired up.
  try {
    const search = (typeof window !== 'undefined' && window.location && window.location.search) || '';
    const hasLQ = typeof window !== 'undefined' && 'launchQueue' in window;
    if (shouldShowUnsupportedHint(search, hasLQ)) {
      showToast(t('shareTargetUnsupported'), { variant: 'warn', duration: 8000 });
    }
  } catch { /* ignore — never block boot on share-target hint */ }
}
