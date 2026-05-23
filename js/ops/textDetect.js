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
// Per-sensitivity confidence thresholds for the shared "AI detection
// sensitivity" UI in the redact panel. Lower = more text regions
// (including noise / icons / textures); higher = fewer but cleaner.
const CONFIDENCE_THRESHOLDS = Object.freeze({
  strict: 70,
  normal: CONFIDENCE_THRESHOLD,
  loose:  30,
});

function confidenceForSensitivity(level) {
  if (level && Object.prototype.hasOwnProperty.call(CONFIDENCE_THRESHOLDS, level)) {
    return CONFIDENCE_THRESHOLDS[level];
  }
  return CONFIDENCE_THRESHOLD;
}
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
 * @param {{ progress?: (msg: object) => void, sensitivity?: 'strict' | 'normal' | 'loose' }} [opts]
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
  //
  // Tesseract.js v7 changed the recognize() default: only `data.text` is
  // populated unless we explicitly opt into other output formats. We need
  // `blocks` (structured JSON) so we can walk down to line bboxes. The
  // third argument is the output-options object.
  const canvas = bitmapToCanvas(bitmap);
  const result = await worker.recognize(canvas, {}, { blocks: true, text: true });
  const lines = extractLines(result && result.data);
  const threshold = confidenceForSensitivity(opts.sensitivity);
  return postProcess(lines, threshold);
}

// Walk Tesseract.js's recognized blocks → paragraphs → lines tree and
// return a flat list of line records. Defensive against both the v7
// shape (lines nested under blocks/paragraphs) AND the legacy v6 shape
// (lines on data directly) so a future Tesseract.js upgrade can change
// shape under us without breaking detection.
function extractLines(data) {
  if (!data) return [];
  if (Array.isArray(data.lines) && data.lines.length > 0) return data.lines;
  const out = [];
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  for (const block of blocks) {
    const paragraphs = Array.isArray(block && block.paragraphs) ? block.paragraphs : [];
    for (const para of paragraphs) {
      const lines = Array.isArray(para && para.lines) ? para.lines : [];
      for (const line of lines) {
        if (line) out.push(line);
      }
    }
  }
  return out;
}

/**
 * Batch text detection: iterate `imageIds`, lazy-decode each bitmap via the
 * supplied `getBitmap` function, run detectText, and pass per-image rects
 * to `onImageDone`. Mirror of detectFacesBatch in faceDetect.js — same
 * sequential decode-detect-discard loop, same one-time consent up front.
 *
 * Tesseract is slow (~1-5 s per image on CPU). For batches > 10 images
 * the user really wants the cancel button — `shouldAbort()` is polled
 * between images.
 *
 * @param {string[]} imageIds
 * @param {(id: string) => Promise<ImageBitmap | null>} getBitmap
 * @param {{
 *   sensitivity?: 'strict'|'normal'|'loose',
 *   onProgress?: (msg: {done: number, total: number, imageId: string, inner?: {status: string, progress: number}}) => void,
 *   shouldAbort?: () => boolean,
 *   onImageDone?: (imageId: string, rects: Array<object>) => void,
 * }} [opts]
 * @returns {Promise<{ totalLines: number, imagesScanned: number, aborted: boolean }>}
 */
export async function detectTextBatch(imageIds, getBitmap, opts = {}) {
  const ids = Array.isArray(imageIds) ? imageIds : [];
  const total = ids.length;
  if (total === 0) return { totalLines: 0, imagesScanned: 0, aborted: false };

  const granted = await ensureTextConsent();
  if (!granted) throw new Error('text_consent_declined');

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const onImageDone = typeof opts.onImageDone === 'function' ? opts.onImageDone : () => {};
  const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : () => false;

  let totalLines = 0;
  let scanned = 0;
  for (const id of ids) {
    if (shouldAbort()) {
      return { totalLines, imagesScanned: scanned, aborted: true };
    }
    onProgress({ done: scanned, total, imageId: id });
    let bitmap = null;
    try {
      bitmap = await getBitmap(id);
      if (!bitmap) { scanned++; continue; }
      const rects = await detectText(bitmap, {
        sensitivity: opts.sensitivity,
        progress: (inner) => onProgress({ done: scanned, total, imageId: id, inner }),
      });
      totalLines += rects.length;
      onImageDone(id, rects);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`detectTextBatch: image ${id} failed`, err);
    }
    scanned++;
  }
  onProgress({ done: total, total, imageId: '' });
  return { totalLines, imagesScanned: scanned, aborted: false };
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

// PII regex patterns — when ANY of these matches a recognized line's
// text, the line is flagged for auto-selection in the preview UI. Tuned
// to be conservative (false-positive avoidance) — better to miss a
// pattern than to mark unrelated lines.
const PII_PATTERNS = [
  // Email (RFC-light; covers common forms)
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,
  // US phone: 555-555-5555 / 555.555.5555 / 555 555 5555 / (555) 555-5555
  /\b(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]?\d{4}\b/,
  // Credit card-ish: 4 groups of 4 digits with optional separators
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,
  // SSN (US): xxx-xx-xxxx
  /\b\d{3}-\d{2}-\d{4}\b/,
  // IPv4
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
];

function lineMatchesPII(text) {
  if (!text || typeof text !== 'string') return false;
  for (const re of PII_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function postProcess(lines, threshold) {
  if (!Array.isArray(lines)) return [];
  const minConfidence = Number.isFinite(threshold) ? threshold : CONFIDENCE_THRESHOLD;
  const out = [];
  for (const line of lines) {
    if (!line || !line.bbox) continue;
    const confidence = Number.isFinite(line.confidence) ? line.confidence : 0;
    if (confidence < minConfidence) continue;
    const { x0, y0, x1, y1 } = line.bbox;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w <= 0 || h <= 0) continue;
    if (w * h < MIN_AREA_PX) continue;
    const text = typeof line.text === 'string' ? line.text.trim() : '';
    out.push({
      x, y, w, h,
      text,
      confidence,
      // Set if the recognized text matches any PII regex. Preview-select
      // mode pre-marks these lines for redaction so the user can accept-
      // all in one click for the common case.
      autoFlag: lineMatchesPII(text),
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
