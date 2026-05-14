// js/ops/bgremove.js — ML background removal. Lazy import + first-use consent.
//
// Phase 11 of the v1 plan. The actual @imgly/background-removal module lives
// under `js/vendor/bgremove/`. It's heavyweight (~170 KB for the code surface
// alone, plus tens of MB of model + ONNX runtime WASM files that the deployer
// installs separately — see `js/vendor/bgremove/.notice`). We never pull any
// of that on initial page load — the dynamic `import()` is only fired the
// first time the user clicks Apply.
//
// Public surface:
//   ensureBgRemoveConsent()        → resolves true when user has consented
//                                    (now or previously); false on cancel.
//   runBgRemove(imageId)           → runs the model on one image and returns
//                                    the alpha mask as Uint8Array, or null
//                                    if the user cancelled consent.
//   applyBgRemove(imageId)         → runs runBgRemove and records history.
//   applyBgRemoveBatch(ids, onPg)  → iterates over IDs sequentially.
//   _setImplForTest(implOrNull)    → test escape hatch: inject a fake
//                                    `removeBackground` impl so browser specs
//                                    don't need to actually load the model.
//
// Consent is persisted in localStorage under a model-hash key so that a
// future model change forces a re-prompt (we don't want a user to suddenly
// trade ~40 MB more bandwidth because we silently bumped the variant).
import { getState } from '../state.js';
import { withBgMaskHistory } from '../historyOps.js';
import { showToast } from '../errors.js';
import { invalidate } from '../render/renderCache.js';
import { escapeHtml } from '../escape.js';
import { t } from '../i18n.js';
import { probeCapabilities } from '../capabilities.js';
import * as canvasProgress from '../canvasProgress.js';

// localStorage key + the hash that goes inside it. Bump MODEL_HASH whenever
// we change the model variant or revendor a different upstream release;
// users who had previously consented will be re-prompted because the stored
// hash no longer matches. Bumped to v2 when WebGPU support was added — the
// asset set users may download grew, so re-prompt is the right call.
export const CONSENT_KEY  = 'noadsimages_bgremove_consent';
export const MODEL_HASH   = 'imgly-isnet-fp16-v2-webgpu';
// Display label only — kept in sync with privacy.html. Read by the consent
// modal copy. The size we surface is the conservative "everything if you
// happen to need it" number. In practice a CPU-only browser pulls the CPU
// kernels (~12 MB wasm + ~88 MB model = ~100 MB on first use) and a WebGPU
// browser pulls the JSEP kernels (~23 MB + ~88 MB model = ~111 MB). We
// quote the WebGPU number because it's the larger of the two; honest first.
export const MODEL_SIZE_LABEL = '~110 MB';

// Cached lazy-import promise so multiple Apply clicks don't double-fetch.
let implPromise = null;
// Test override hook. When set, `loadImpl()` returns this instead of doing
// the dynamic import. Tests inject a stub that returns a predictable mask.
let implForTest = null;

/**
 * Test escape hatch. Pass an object with a `removeBackground(blob, config)`
 * function to short-circuit the real lazy-import. Pass `null` to clear.
 */
export function _setImplForTest(mod) {
  implForTest = mod || null;
  // Also clear any prior cached real import so the test isn't shadowed by it.
  implPromise = null;
}

/**
 * Check localStorage for a prior consent record matching the current model
 * hash. Returns true synchronously when a prior grant is found (no modal),
 * else opens the consent modal and resolves with the user's choice.
 */
export async function ensureBgRemoveConsent() {
  if (hasStoredConsent()) return true;
  const granted = await showConsentModal();
  if (granted) {
    try {
      localStorage.setItem(CONSENT_KEY, MODEL_HASH);
    } catch (err) {
      // Storage may be unavailable (privacy mode, full quota). Don't throw —
      // the user has consented for this session at minimum.
      // eslint-disable-next-line no-console
      console.warn('bgremove: failed to persist consent', err);
    }
  }
  return granted;
}

/**
 * Read-only check: do we have a stored consent matching the current hash?
 * Exported so the editor side panel can show the right helper copy.
 */
export function hasStoredConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === MODEL_HASH;
  } catch {
    return false;
  }
}

/**
 * Lazy-load the vendored @imgly module. The vendored bundle imports
 * `onnxruntime-web` internally; if the deployer hasn't installed the
 * accompanying data assets, that import will reject and we propagate the
 * error to the caller so applyBgRemove can surface a friendly toast.
 *
 * @returns {Promise<{removeBackground: Function, preload?: Function}>}
 */
async function loadImpl() {
  if (implForTest) return implForTest;
  if (implPromise) return implPromise;
  implPromise = (async () => {
    // Vite/no-bundler ESM: the dynamic import path is resolved relative to
    // this module. The /* @vite-ignore */ comment is harmless for us (we
    // don't use Vite) but is a useful breadcrumb if anyone later adds it.
    const mod = await import(/* @vite-ignore */ '../vendor/bgremove/index.mjs');
    return mod;
  })();
  // If the import fails, allow a future retry — don't permanently poison the
  // cached promise with a rejection.
  implPromise.catch(() => { implPromise = null; });
  return implPromise;
}

/**
 * Run the model on one image. Returns the alpha mask as a Uint8Array sized
 * `source.width * source.height` (one byte per pixel, 0 = transparent,
 * 255 = opaque). Returns null if the user cancelled consent.
 *
 * Throws if the model isn't available (e.g. deploy-time assets missing) so
 * the caller can show a friendly toast. The error has a `code` of
 * `bgremove_load_failed` for callers that want to disambiguate.
 *
 * Output-format choice:
 *   We request `image/x-rgba8` so the bundle SKIPS the PNG encode → decode
 *   round trip and just hands us the raw RGBA bytes of the result tensor
 *   inside a Blob. We then pluck the alpha byte from each pixel into a
 *   compact Uint8Array. This avoids ~one canvas allocation and ~one
 *   browser-side PNG decode per image.
 *
 *   We chose `image/x-rgba8` over `image/x-alpha8` after inspecting the
 *   vendored bundle: when output format is `image/x-alpha8`, the bundle
 *   still encodes the FULL RGBA tensor into the blob (the only effect of
 *   choosing alpha8 is a different MIME label on the blob — the byte
 *   payload is identical to rgba8). Using rgba8 is at least HONEST about
 *   what we're getting back; we then strip RGB and keep alpha here. The
 *   vendored bundle is at `js/vendor/bgremove/index.mjs`, see imageEncode().
 *
 * Device choice:
 *   When `caps.webGPU` is true we ask for `device: 'gpu'` and let the
 *   bundle import `onnxruntime-web/webgpu`. Otherwise we fall back to
 *   `device: 'cpu'`. The bundle re-verifies the WebGPU adapter is actually
 *   usable; if requestAdapter() returns null at runtime it silently falls
 *   back to wasm internally.
 *
 * Worker proxy:
 *   `proxyToWorker: true` lets ORT-Web spin up its own dedicated worker so
 *   the heavy ONNX inference doesn't block the main thread. Note: looking
 *   at the bundle source, this flag is only honored when WebGPU is in use
 *   (it's gated by `useWebGPU && config.proxyToWorker`). For CPU mode the
 *   bundle relies on the WASM kernel's internal pthread pool instead.
 *
 * @param {string} imageId
 * @param {(stage:string, current:number, total:number)=>void} [onProgress]
 */
export async function runBgRemove(imageId, onProgress) {
  const s = getState();
  const img = s.images[imageId];
  if (!img) throw new Error(`bgremove: no image ${imageId}`);
  const consented = await ensureBgRemoveConsent();
  if (!consented) return null;

  let mod;
  try {
    mod = await loadImpl();
  } catch (err) {
    const e = new Error('bgremove_load_failed');
    e.cause = err;
    throw e;
  }

  const fn = mod && (mod.removeBackground || mod.default);
  if (typeof fn !== 'function') {
    throw new Error('bgremove_load_failed');
  }

  // Read capabilities. probeCapabilities() is memoized so the second-and-
  // beyond calls are O(1). If for any reason the probe fails we conservatively
  // assume CPU-only.
  let caps;
  try {
    caps = await probeCapabilities();
  } catch {
    caps = { webGPU: false };
  }
  const useGpu = !!caps.webGPU;

  // The bundle wraps `config.progress` in a Zod-validated `z.function()...
  // .returns(z.void())` schema, which rejects ANY non-undefined return value
  // from the callback. Callers' progress handlers might legitimately return
  // values (e.g. `.add()` on a Set returns the set, `.push()` returns the
  // new length). To shield us from that papercut, wrap the user's callback
  // and swallow its return value before handing it to the bundle.
  const safeProgress = onProgress
    ? (stage, current, total) => {
        try { onProgress(stage, current, total); }
        catch (err) {
          // eslint-disable-next-line no-console
          console.warn('bgremove: progress callback threw', err);
        }
        // Explicit void return so the Zod-wrapped function sees `undefined`.
      }
    : undefined;

  const config = {
    publicPath: new URL('../vendor/bgremove/', import.meta.url).toString(),
    model: 'isnet_fp16',
    // Raw RGBA bytes. The blob payload is exactly W*H*4 bytes with no
    // PNG envelope, which lets us skip createImageBitmap entirely.
    output: { format: 'image/x-rgba8', quality: 1 },
    // Device + worker. proxyToWorker only takes effect for GPU paths (see
    // bundle source). We pass it unconditionally because the flag is
    // ignored on CPU paths anyway.
    device: useGpu ? 'gpu' : 'cpu',
    proxyToWorker: true,
    progress: safeProgress,
  };

  // Hand the raw source blob to the model. @imgly handles the resize/normalise
  // internally; with rescale=true (the default), the alpha mask is upsampled
  // back to source dimensions before being baked into the RGBA tensor.
  const blob = img.source && img.source.blob;
  if (!blob) {
    throw new Error('bgremove: missing source blob');
  }

  let resultBlob;
  try {
    resultBlob = await fn(blob, config);
  } catch (err) {
    const e = new Error('bgremove_run_failed');
    e.cause = err;
    throw e;
  }

  // Raw RGBA byte path. The blob payload is `width * height * 4` bytes with
  // a MIME type of `image/x-rgba8;width=W;height=H`. Pluck alpha from each
  // pixel's 4th byte; allocate exactly the destination size up front.
  let rgbaBytes;
  try {
    rgbaBytes = new Uint8Array(await resultBlob.arrayBuffer());
  } catch (err) {
    const e = new Error('bgremove_decode_failed');
    e.cause = err;
    throw e;
  }
  const srcW = img.source && img.source.width;
  const srcH = img.source && img.source.height;
  const expectedRgba = (srcW || 0) * (srcH || 0) * 4;
  if (expectedRgba === 0 || rgbaBytes.length === 0) {
    const e = new Error('bgremove_decode_failed');
    e.cause = new Error(`empty result blob (got ${rgbaBytes.length} bytes; source ${srcW}x${srcH})`);
    throw e;
  }

  // Best case: bundle returned RGBA at source dims. Pluck alpha directly.
  if (rgbaBytes.length === expectedRgba) {
    return pluckAlphaFromRgba(rgbaBytes, srcW * srcH);
  }

  // The bundle ran with rescale=false (or a future variant skipped resampling
  // and handed us a 1024×1024 RGBA tensor). Pluck alpha at the model's
  // native resolution and resample with nearest-neighbour back to source.
  const totalPx = Math.floor(rgbaBytes.length / 4);
  const sideGuess = Math.round(Math.sqrt(totalPx));
  if (sideGuess * sideGuess === totalPx) {
    // eslint-disable-next-line no-console
    console.warn(
      `bgremove: result size ${rgbaBytes.length} bytes (${sideGuess}x${sideGuess}) `
      + `differs from source ${srcW}x${srcH}. Resampling alpha back to source dims.`,
    );
    const alphaAtModel = pluckAlphaFromRgba(rgbaBytes, totalPx);
    return resampleNearest(alphaAtModel, sideGuess, sideGuess, srcW, srcH);
  }
  const e = new Error('bgremove_decode_failed');
  e.cause = new Error(
    `result size ${rgbaBytes.length} bytes doesn't match expected ${expectedRgba} `
    + `(source ${srcW}x${srcH}) and isn't a square model output either`,
  );
  throw e;
}

// Pluck alpha bytes from a packed RGBA buffer. `pxCount` MUST equal the
// number of pixels; the caller is responsible for verifying that.
function pluckAlphaFromRgba(rgba, pxCount) {
  const mask = new Uint8Array(pxCount);
  for (let i = 0; i < pxCount; i++) {
    mask[i] = rgba[i * 4 + 3];
  }
  return mask;
}

// Cheap nearest-neighbour rescale for a single-channel byte mask. We
// deliberately don't use a canvas here — that would round-trip through
// 4-channel RGBA and pay an alloc we just avoided. Loop body is ~3 ops
// per pixel; fine for a 1024² -> arbitrary upscale.
function resampleNearest(src, srcW, srcH, dstW, dstH) {
  const dst = new Uint8Array(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y * yRatio));
    const dstRow = y * dstW;
    const srcRow = sy * srcW;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * xRatio));
      dst[dstRow + x] = src[srcRow + sx];
    }
  }
  return dst;
}

/**
 * Apply bg-removal to a single image and record one history entry. Surfaces
 * toasts on success and failure. Returns true on success, false otherwise.
 *
 * Drives the canvas progress overlay (js/canvasProgress.js) so the user sees
 * a prominent indicator on the canvas itself, not just in the side panel.
 * If a caller passes their own `onProgress`, it gets called too — wired by
 * the bg-remove tool to keep the side-panel readout in sync.
 */
export async function applyBgRemove(imageId, onProgress) {
  // Show overlay immediately so the user sees something is happening even
  // before the first progress event fires (model load can take a moment).
  canvasProgress.show({
    title:   t('bgRemoveOverlayTitle'),
    stage:   t('bgRemoveStageLoadingModel'),
    percent: 0,
  });
  const wrappedProgress = (stage, current, total) => {
    // Map the bundle's stage names ("fetch:KEY", "compute:decode", ...) to
    // user-friendly labels. Fall back to the raw stage string for anything
    // we don't recognise so we never silently swallow novel events.
    const label = mapStageLabel(stage);
    let percent;
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      percent = Math.round((current / total) * 100);
    }
    canvasProgress.update({ stage: label, percent });
    if (typeof onProgress === 'function') {
      try { onProgress(stage, current, total); }
      catch { /* don't let a panel listener break the canvas overlay */ }
    }
  };

  let mask;
  try {
    mask = await runBgRemove(imageId, wrappedProgress);
  } catch (err) {
    canvasProgress.hide();
    handleBgRemoveError(err);
    return false;
  }
  if (!mask) {
    // User cancelled consent.
    canvasProgress.hide();
    return false;
  }

  withBgMaskHistory('Remove background', imageId, state => {
    const img = state.images[imageId];
    if (!img) return;
    img.bgMask = mask;
    img.bgRemoved = true;
    invalidate(img, 'BGMASK');
  });
  canvasProgress.hide();
  showToast(t('bgRemoveDone'));
  return true;
}

// Translate the bundle's `compute:foo` / `fetch:KEY` progress keys to a
// human-friendly label. The exact set of keys was inspected in
// `js/vendor/bgremove/index.mjs` (search for `config.progress(`):
//   - "fetch:/models/isnet_fp16" + "fetch:/onnxruntime-web/..." during load
//   - "compute:decode"   when the source blob is being read into a tensor
//   - "compute:inference" while ONNX session runs
//   - "compute:mask"     while alpha is being baked back into the tensor
//   - "compute:encode"   while the output blob is being assembled
function mapStageLabel(stage) {
  if (typeof stage !== 'string') return t('bgRemoveOverlayTitle');
  if (stage.startsWith('fetch:'))     return t('bgRemoveStageFetchingChunks');
  if (stage === 'compute:decode')     return t('bgRemoveStageDecode');
  if (stage === 'compute:inference')  return t('bgRemoveStageInference');
  if (stage === 'compute:mask')       return t('bgRemoveStageMask');
  if (stage === 'compute:encode')     return t('bgRemoveStageEncode');
  return stage;
}

/**
 * Sequentially apply bg-removal to a list of images. `onProgress(i, total,
 * label)` is called once per image and once on a final 'done' tick. Returns
 * `{ count, failed, cancelled }`. Honours a `cancelRef.value === true`
 * sentinel for cancellation, settable by the caller.
 *
 * @param {string[]} imageIds
 * @param {(index:number, total:number, label:string)=>void} [onProgress]
 * @param {{value:boolean}} [cancelRef]
 */
export async function applyBgRemoveBatch(imageIds, onProgress, cancelRef) {
  const consented = await ensureBgRemoveConsent();
  if (!consented) return { count: 0, failed: 0, cancelled: true };

  // Warm the impl cache once so the per-image runs reuse it.
  try {
    await loadImpl();
  } catch (err) {
    handleBgRemoveError(err);
    return { count: 0, failed: 0, cancelled: false };
  }

  let count = 0;
  let failed = 0;
  for (let i = 0; i < imageIds.length; i++) {
    if (cancelRef && cancelRef.value) {
      return { count, failed, cancelled: true };
    }
    const id = imageIds[i];
    if (typeof onProgress === 'function') onProgress(i, imageIds.length, 'encoding');
    try {
      const mask = await runBgRemove(id);
      if (!mask) {
        if (typeof onProgress === 'function') onProgress(i, imageIds.length, 'skipped');
        failed += 1;
        continue;
      }
      withBgMaskHistory('Remove background', id, state => {
        const t = state.images[id];
        if (!t) return;
        t.bgMask = mask;
        t.bgRemoved = true;
        invalidate(t, 'BGMASK');
      });
      count += 1;
      if (typeof onProgress === 'function') onProgress(i, imageIds.length, 'done');
    } catch (err) {
      failed += 1;
      if (typeof onProgress === 'function') onProgress(i, imageIds.length, 'failed');
      // Surface only the first error as a toast; per-image rows will show
      // status via the progress modal.
      if (failed === 1) handleBgRemoveError(err);
    }
  }
  return { count, failed, cancelled: false };
}

// -- Consent modal ----------------------------------------------------------

/**
 * Show a native <dialog> asking the user to confirm the model download.
 * Resolves with true on Continue, false on Cancel / Esc / backdrop click.
 * Exposed for browser tests to await directly.
 */
export function showConsentModal() {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'bgremove-consent-dialog';
    dialog.setAttribute('aria-label', t('bgRemoveConsentLabel'));
    // Build the body via t() with the {size} variable wrapped in <strong>.
    // The placeholder is replaced post-translation so the markup stays out
    // of every translation string.
    const body = t('bgRemoveConsentBody', { size: 'PLACEHOLDER' })
      .replace('PLACEHOLDER', `<strong>${escapeHtml(MODEL_SIZE_LABEL)}</strong>`);
    dialog.innerHTML = `
      <h2>${escapeHtml(t('bgRemoveConsentTitle'))}</h2>
      <p>${body}</p>
      <p>${escapeHtml(t('bgRemoveConsentReassure'))}</p>
      <p class="bgremove-consent-license">${t('bgRemoveConsentLicense')}</p>
      <div class="bgremove-consent-actions">
        <button type="button" class="bgremove-consent-cancel">${escapeHtml(t('bgRemoveConsentCancel'))}</button>
        <button type="button" class="bgremove-consent-continue btn-primary">${escapeHtml(t('bgRemoveConsentContinue'))}</button>
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

    dialog.querySelector('.bgremove-consent-continue').addEventListener('click', () => finish(true));
    dialog.querySelector('.bgremove-consent-cancel').addEventListener('click',   () => finish(false));
    dialog.addEventListener('close', () => finish(false));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) finish(false);
    });

    try {
      dialog.showModal();
    } catch {
      // Headless test environments without native <dialog> support — fall
      // back to confirm(). Returns false on cancel; matches the modal UX.
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('bgRemoveConfirmFallback'))
        : true;
      finish(ok);
    }
  });
}

// -- Error handling --------------------------------------------------------

function handleBgRemoveError(err) {
  // eslint-disable-next-line no-console
  console.error('bgremove:', err);
  if (err && err.message === 'bgremove_load_failed') {
    showToast(t('bgRemoveErrLoad'), { variant: 'error' });
    return;
  }
  if (err && err.message === 'bgremove_decode_failed') {
    showToast(t('bgRemoveErrDecode'), { variant: 'error' });
    return;
  }
  if (err && err.message === 'bgremove_run_failed') {
    showToast(t('bgRemoveErrRun'), { variant: 'error' });
    return;
  }
  showToast(t('bgRemoveErrGeneric'), { variant: 'error' });
}

// Test-only reset. Clears the impl cache and removes any lingering consent.
export function _resetForTest() {
  implPromise = null;
  implForTest = null;
  try { localStorage.removeItem(CONSENT_KEY); } catch { /* ignore */ }
}
