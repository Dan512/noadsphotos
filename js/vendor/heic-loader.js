// js/vendor/heic-loader.js — lazy ES-module wrapper for the vendored
// libheif-js (LGPL-3.0) HEIC/HEIF decoder. The actual ~1.1 MB load (81 KB
// JS glue + 1.03 MB WASM) happens only the first time a .heic file is
// imported, gated behind a one-time consent modal.
//
// Why we vendor `libheif-wasm/libheif.js` + `libheif-wasm/libheif.wasm`
// (split) rather than the pre-bundled `.mjs`:
//   - The bundle inlines the WASM as base64 (+30% size, slower boot).
//   - The split JS glue calls `locateFile()` to find the .wasm, which we
//     override here to point at the same vendored directory. That keeps
//     all traffic on this origin — no jsdelivr, no CDN.
//
// The vendored `libheif.js` is a Universal-Module-Definition module that
// (when loaded as a <script>) sets `window.libheif` to a *factory*: calling
// `libheif()` returns a thenable-ish Module instance that fires `onRuntimeInitialized`
// once the WASM is ready. We wrap that into a regular Promise so callers
// can `await loadHeicDecoder()`.
//
// Public surface mirrors `js/vendor/jspdf-loader.js` and `js/ops/bgremove.js`:
//   loadHeicDecoder()         → returns the resolved `{ decode }` decoder
//                               after consent is granted; throws on cancel
//                               or load failure.
//   ensureHeicConsent()       → exposed for tests + the privacy panel UI.
//   hasStoredConsent()        → read-only consent check.
//   _setHeicDecoderForTest()  → test escape hatch.
//   _resetForTest()           → wipes the cached promise + consent.
//
// Consent + load are intentionally bundled together: the disclosure (~1.1 MB
// download) is the entire point of the modal, so it would be wrong to fetch
// the bytes before the user has acknowledged.

import { showConsentModalImpl } from '../ops/heicConsent.js';

export const CONSENT_KEY = 'noadsimages_heic_consent';
// Bump this when re-vendoring libheif so previously-consented users get
// re-prompted to acknowledge the new payload size.
export const VENDOR_HASH = 'libheif-1.19.8';
export const VENDOR_SIZE_LABEL = '~1.1 MB';

let cached = null;          // Promise<{ decode }>
let testDecoder = null;     // injected by _setHeicDecoderForTest
let consentOverrideForTest = null;  // 'grant' | 'deny' | null

/**
 * Lazy-load the vendored HEIC decoder. Resolves to an object with a `decode`
 * function. The first call:
 *   1. Checks/asks for one-time consent. Throws `heic_consent_declined` on
 *      cancel.
 *   2. Injects `<script src="/js/vendor/heic/libheif.js">` (sets
 *      `window.libheif` to the factory).
 *   3. Calls the factory with a `locateFile` override that points at
 *      `/js/vendor/heic/libheif.wasm`, plus an explicit `onRuntimeInitialized`
 *      to know when the wasm is ready.
 *   4. Builds a `decode(arrayBuffer)` wrapper that returns an ImageData-like
 *      `{ data, width, height }` for the first image in the file.
 *
 * @returns {Promise<{ decode: (ab: ArrayBuffer) => Promise<{data: Uint8ClampedArray, width: number, height: number}> }>}
 */
export async function loadHeicDecoder() {
  if (cached) return cached;

  // 1. Consent first. We DON'T cache until consent is granted, so a cancel
  //    leaves the next call free to re-prompt. This applies to the
  //    test-decoder path too — the consent modal is a user-visible
  //    feature we want browser specs to exercise. Tests that don't care
  //    about consent can pre-grant via `_setConsentForTest('grant')`.
  const granted = await ensureHeicConsent();
  if (!granted) throw new Error('heic_consent_declined');

  // 2. If a test decoder is installed, return it now (after consent has been
  //    handled). Real wasm load is short-circuited.
  if (testDecoder) return testDecoder;

  // 3. & 4. Actually load.
  cached = (async () => {
    // Use a single <script> injection (UMD assigns to window.libheif). The
    // split build does NOT load the wasm itself — we tell it where the wasm
    // lives via `locateFile`. The library calls `locateFile('libheif.wasm')`
    // exactly once during boot.
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('heic_loader_no_dom');
    }
    if (!window.libheif) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/js/vendor/heic/libheif.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('heic_script_failed'));
        document.head.appendChild(s);
      });
      if (!window.libheif) throw new Error('heic_global_missing');
    }
    // Pre-fetch the wasm bytes ourselves and hand them to emscripten as
    // `wasmBinary`. This avoids emscripten's "sync fetching of the wasm
    // failed" path that fires when the module is loaded in a browser context
    // (the upstream JS glue tries an XHR which we'd otherwise have to
    // sidestep with `instantiateWasm`). One round-trip; no streaming-compile
    // edge cases.
    const wasmResp = await fetch('/js/vendor/heic/libheif.wasm');
    if (!wasmResp.ok) throw new Error('heic_wasm_fetch_failed');
    const wasmBinary = new Uint8Array(await wasmResp.arrayBuffer());

    // Instantiate. The factory returns the same config object we passed in
    // (mutated to be the Module instance). We wait for `onRuntimeInitialized`
    // which fires once the WASM is fully compiled and the runtime is ready.
    //
    // Subtle: `onRuntimeInitialized` can fire SYNCHRONOUSLY inside the call
    // to `window.libheif(config)` (when the wasm finishes compiling fast
    // enough), at which point our captured-by-closure handler runs BEFORE
    // we get a chance to read the returned `inst`. We work around this by
    // referencing the config object directly — emscripten mutates the
    // passed config into the Module instance, so `config` IS the module.
    const module = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok, m) => {
        if (settled) return;
        settled = true;
        ok ? resolve(m) : reject(m);
      };
      const config = {
        wasmBinary,
        locateFile: (name) => `/js/vendor/heic/${name}`,
        onRuntimeInitialized() { finish(true, config); },
        onAbort(reason) { finish(false, new Error('heic_wasm_abort: ' + reason)); },
      };
      try {
        const inst = window.libheif(config);
        // Some emscripten outputs also resolve a `ready` promise on the
        // returned instance. Honor it as a belt-and-braces backstop in case
        // `onRuntimeInitialized` doesn't fire (it does for libheif 1.19.8
        // — verified by reading the vendored bundle — but bumping versions
        // could change that).
        if (inst && typeof inst.then === 'function') {
          inst.then(m => finish(true, m), e => finish(false, e));
        }
      } catch (err) {
        finish(false, err);
      }
    });
    if (!module || typeof module.HeifDecoder !== 'function') {
      throw new Error('heic_module_missing_decoder');
    }
    // 4. Wrap into a friendly `decode()` returning ImageData-like.
    return { decode: (ab) => decodeOne(module, ab) };
  })();

  // Don't poison the cache on failure — allow retry.
  cached.catch(() => { cached = null; });
  return cached;
}

/**
 * Decode the first image in a HEIC/HEIF ArrayBuffer. Resolves to an
 * `{ data: Uint8ClampedArray, width, height }` shaped object compatible with
 * `ctx.putImageData()`.
 *
 * libheif applies EXIF/`irot`/`imir` orientation transforms during decode
 * (the decoder reports post-rotation dimensions via get_width/get_height
 * and emits the pixels rotated). We rely on that here — no manual rotation
 * step is needed in importer.js.
 */
async function decodeOne(module, arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array
    ? arrayBuffer
    : new Uint8Array(arrayBuffer);
  const decoder = new module.HeifDecoder();
  // `decode` returns an array of HeifImage objects (HEIC files can be image
  // sequences — most camera HEICs hold a single primary image).
  const images = decoder.decode(bytes);
  if (!images || images.length === 0) {
    throw new Error('heic_no_images');
  }
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('heic_invalid_dimensions');
  }
  const imageData = {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
  await new Promise((resolve, reject) => {
    image.display(imageData, (dd) => {
      if (!dd) reject(new Error('heic_display_failed'));
      else resolve();
    });
  });
  return imageData;
}

// ---------- Consent ---------------------------------------------------------

/**
 * Returns true synchronously when a prior grant matching VENDOR_HASH exists,
 * else opens the consent modal and resolves with the user's choice.
 */
export async function ensureHeicConsent() {
  if (consentOverrideForTest === 'grant') return true;
  if (consentOverrideForTest === 'deny')  return false;
  if (hasStoredConsent()) return true;
  const granted = await showConsentModalImpl({ vendorHash: VENDOR_HASH, sizeLabel: VENDOR_SIZE_LABEL });
  if (granted) {
    try {
      localStorage.setItem(CONSENT_KEY, VENDOR_HASH);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('heic-loader: failed to persist consent', err);
    }
  }
  return granted;
}

/**
 * Read-only check: do we have a stored consent matching the current hash?
 */
export function hasStoredConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === VENDOR_HASH;
  } catch {
    return false;
  }
}

// ---------- Test escape hatches --------------------------------------------

/**
 * Test escape hatch — inject a fake decoder so specs don't need to load the
 * real wasm. Pass `null` to clear.
 * @param {{ decode: (ab: ArrayBuffer) => Promise<{data:Uint8ClampedArray,width:number,height:number}|Blob|ImageBitmap> } | null} dec
 */
export function _setHeicDecoderForTest(dec) {
  testDecoder = dec ? Promise.resolve(dec) : null;
}

/**
 * Test escape hatch — force consent to a particular outcome without
 * spawning a real dialog. Pass `null` to clear.
 * @param {'grant'|'deny'|null} mode
 */
export function _setConsentForTest(mode) {
  consentOverrideForTest = mode || null;
}

/**
 * Test-only reset. Clears the cached load + stored consent + overrides.
 */
export function _resetForTest() {
  cached = null;
  testDecoder = null;
  consentOverrideForTest = null;
  try { localStorage.removeItem(CONSENT_KEY); } catch { /* ignore */ }
}
