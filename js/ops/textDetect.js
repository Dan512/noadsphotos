// js/ops/textDetect.js — OCR-based text detection via vendored Tesseract.js.
//
// Used by the redact tool's "Detect text" button to seed the canvas with
// one mask redact per detected text line. Pure local inference — Tesseract
// runs in a web worker entirely inside the browser (no network round trip).
//
// Pipeline:
//   1. Lazy-load tesseract.min.js (UMD bundle injected as a <script> tag
//      on first call). First call also asks for one-time consent (mirrors
//      HEIC + bg-remove + face-detect patterns).
//   2. Create a Tesseract worker pointed at the vendored corePath +
//      langPath. The worker downloads the WASM kernel of the variant
//      Tesseract auto-selects based on browser SIMD support, then loads
//      eng.traineddata.gz. All from this origin, no third-party CDN.
//   3. Run `recognize(canvas)`. Tesseract returns word + line + paragraph
//      bboxes plus the recognized text.
//   4. Post-process: keep `data.lines` (right granularity — one rect per
//      visual text row), filter by confidence threshold, drop tiny boxes.
//
// Returns an array of source-pixel-space rectangles ready to wrap in
// redact overlays. Caller is responsible for batching them into a single
// history transaction.
//
// NOTE: v1.2 ships with auto-mask-all-detected — the same flow as
// faceDetect. The interactive preview-select mode described in the
// design doc is deferred to v1.2.1 (see TODOs in
// docs/plans/2026-05-22-ocr-redact-design.md).

import { showTextConsentModal } from './textConsent.js';

// --- Consent + load gating ------------------------------------------------

export const CONSENT_KEY = 'noadsimages_text_detect_consent_v1';
// Bump when re-vendoring the engine OR the language data so previously-
// consented users get re-prompted with the new download-size disclosure.
export const VENDOR_HASH = 'tesseract-js-7.0.0-eng';
const VENDOR_SIZE_LABEL = '~6 MB';

// Engine + worker resources, lazy-initialized on first detect.
let consentOverrideForTest = null;          // 'grant' | 'deny' | null
let workerPromise = null;                   // Promise<TesseractWorker>
let testWorkerForTest = null;               // injected by _setWorkerForTest

const TESSERACT_SCRIPT_URL = '/js/vendor/tesseract/tesseract.min.js';
const WORKER_PATH          = '/js/vendor/tesseract/worker.min.js';
const CORE_PATH            = '/js/vendor/tesseract/core/';
const LANG_PATH            = '/js/vendor/tesseract/lang/';

const CONFIDENCE_THRESHOLD = 50;            // Tesseract scale 0..100; below ⇒ probably-noise
const MIN_AREA_PX          = 16;            // drop sub-4×4 specks

// --- Public API ------------------------------------------------------------

/**
 * Read-only check: do we already have stored consent for this engine
 * version? Used by the redact tool to skip the modal on repeat clicks.
 */
export function hasStoredConsent() {
  if (consentOverrideForTest === 'grant') return true;
  if (consentOverrideForTest === 'deny')  return false;
  try {
    return localStorage.getItem(CONSENT_KEY) === VENDOR_HASH;
  } catch {
    return false;
  }
}

/**
 * Show the consent modal if needed, return true on grant. Persists the
 * grant in localStorage (keyed by VENDOR_HASH so a future re-vendoring
 * re-prompts).
 */
export async function ensureTextConsent() {
  if (consentOverrideForTest === 'grant') return true;
  if (consentOverrideForTest === 'deny')  return false;
  if (hasStoredConsent()) return true;
  const granted = await showTextConsentModal({ sizeLabel: VENDOR_SIZE_LABEL });
  if (granted) {
    try { localStorage.setItem(CONSENT_KEY, VENDOR_HASH); }
    catch { /* private mode etc. — best-effort */ }
  }
  return granted;
}

/**
 * Detect text lines in `bitmap`. Resolves to an array of axis-aligned rects
 * in SOURCE-PIXEL space — { x, y, w, h, text, confidence } — sorted top-
 * to-bottom by `y` (i.e. reading order from the top of the image).
 *
 * Throws 'text_consent_declined' if the user cancels the consent modal.
 *
 * The optional `progress` callback receives Tesseract's internal status
 * messages: `{ status, progress, jobId }` — useful for piping into a UI
 * progress indicator.
 *
 * @param {ImageBitmap | HTMLCanvasElement | OffscreenCanvas} bitmap
 * @param {{ progress?: (msg: object) => void }} [opts]
 * @returns {Promise<Array<{x: number, y: number, w: number, h: number, text: string, confidence: number}>>}
 */
export async function detectText(bitmap, opts = {}) {
  if (!bitmap || !bitmap.width || !bitmap.height) return [];
  const granted = await ensureTextConsent();
  if (!granted) throw new Error('text_consent_declined');

  const worker = await loadWorker(opts.progress);
  // Tesseract.recognize accepts canvas/image/blob; ImageBitmap isn't
  // directly in the supported set, so we wrap it in a canvas first. This
  // also lets us pass a stable source even if the caller's bitmap gets
  // closed/decoded later.
  const canvas = bitmapToCanvas(bitmap);
  const result = await worker.recognize(canvas);
  return postProcess(result && result.data ? result.data.lines : []);
}

// --- Worker lifecycle -----------------------------------------------------

async function loadWorker(progress) {
  if (testWorkerForTest) return testWorkerForTest;
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    let Tesseract;
    try {
      Tesseract = await loadTesseractGlobal();
    } catch (err) {
      workerPromise = null;
      throw new Error('text_lib_load_failed: ' + (err && err.message ? err.message : err));
    }
    try {
      // OEM = 1 → LSTM-only (Tesseract 5+ default). Our vendored core
      // builds are LSTM-only, so this is also the only OEM that works.
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: WORKER_PATH,
        corePath:   CORE_PATH,
        langPath:   LANG_PATH,
        gzip:       true,
        // Don't cache to IndexedDB by default — Tesseract.js caches lang
        // data there to skip re-downloads, but our consent flow already
        // gates the download AND the browser HTTP cache covers the
        // .traineddata.gz file. Two layers of caching is just confusion.
        cacheMethod: 'none',
        logger: (msg) => {
          if (typeof progress === 'function') {
            try { progress(msg); } catch { /* logger errors are non-fatal */ }
          }
        },
      });
      return worker;
    } catch (err) {
      workerPromise = null;
      throw new Error('text_worker_create_failed: ' + (err && err.message ? err.message : err));
    }
  })();
  return workerPromise;
}

/**
 * Inject the Tesseract.js UMD bundle as a <script> on first use. The
 * bundle attaches a `Tesseract` global on the window. Subsequent calls
 * resolve immediately.
 */
function loadTesseractGlobal() {
  if (typeof window !== 'undefined' && window.Tesseract) {
    return Promise.resolve(window.Tesseract);
  }
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('no_document'));
      return;
    }
    // Avoid double-injecting if a previous attempt left a <script> behind.
    const existing = [...document.scripts].find(s => s.src && s.src.endsWith(TESSERACT_SCRIPT_URL));
    if (existing) {
      // If the script is already loaded but window.Tesseract hasn't
      // appeared yet, wait one tick — it parses synchronously on load.
      setTimeout(() => {
        if (window.Tesseract) resolve(window.Tesseract);
        else reject(new Error('tesseract_global_missing'));
      }, 0);
      return;
    }
    const el = document.createElement('script');
    el.src = TESSERACT_SCRIPT_URL;
    el.async = true;
    el.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('tesseract_global_missing'));
    };
    el.onerror = () => reject(new Error('tesseract_script_failed'));
    document.head.appendChild(el);
  });
}

// --- Preprocess -----------------------------------------------------------

function bitmapToCanvas(bitmap) {
  // Don't re-encode if the caller already gave us a canvas — Tesseract
  // can consume it directly.
  if (typeof HTMLCanvasElement !== 'undefined' && bitmap instanceof HTMLCanvasElement) {
    return bitmap;
  }
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? (() => { try { return new OffscreenCanvas(bitmap.width, bitmap.height); } catch { return null; } })()
    : null;
  if (c) {
    c.getContext('2d').drawImage(bitmap, 0, 0);
    return c;
  }
  const dom = document.createElement('canvas');
  dom.width  = bitmap.width;
  dom.height = bitmap.height;
  dom.getContext('2d').drawImage(bitmap, 0, 0);
  return dom;
}

// --- Post-process ---------------------------------------------------------

function postProcess(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const line of lines) {
    if (!line || !line.bbox) continue;
    const confidence = Number.isFinite(line.confidence) ? line.confidence : 0;
    if (confidence < CONFIDENCE_THRESHOLD) continue;
    const { x0, y0, x1, y1 } = line.bbox;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w <= 0 || h <= 0) continue;
    if (w * h < MIN_AREA_PX) continue;
    out.push({
      x, y, w, h,
      text: typeof line.text === 'string' ? line.text.trim() : '',
      confidence,
    });
  }
  // Reading-order sort: top-to-bottom, then left-to-right within a row.
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return out;
}

// --- Test escape hatches --------------------------------------------------

export function _setConsentForTest(mode) {
  consentOverrideForTest = mode || null;
}

export function _setWorkerForTest(w) {
  testWorkerForTest = w || null;
}

export function _resetForTest() {
  consentOverrideForTest = null;
  workerPromise = null;
  testWorkerForTest = null;
  try { localStorage.removeItem(CONSENT_KEY); } catch { /* ignore */ }
}

// Exposed for unit tests of the threshold + bbox math.
export const _internals = { postProcess, CONFIDENCE_THRESHOLD, MIN_AREA_PX };
