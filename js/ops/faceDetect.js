// js/ops/faceDetect.js — auto face detection via vendored BlazeFace ONNX.
//
// Used by the redact tool's "Detect faces" button to seed the canvas with
// one mask redact per detected face. Pure local inference — the model
// weights are vendored under js/vendor/blazeface/ (one-time download via
// scripts/install-blazeface.mjs); after install nothing leaves the browser.
//
// Pipeline:
//   1. Lazy-load onnxruntime-web (already vendored for bg-remove). First
//      call also asks for one-time consent (mirrors HEIC + bg-remove
//      patterns); subsequent calls reuse the cached session.
//   2. Preprocess: letterbox the source bitmap into 256×256, normalize
//      pixels to [0, 1], pack into NCHW float32. Letterboxing (not
//      stretching) is critical — faces in landscape photos get distorted
//      under a naive stretch-fit, which kills detection scores.
//   3. Run inference. Two output tensor pairs (coords + scores), split by
//      anchor stride: 512 anchors at stride 16, 384 anchors at stride 32,
//      896 total. Full-range BlazeFace — covers faces up to ~5 m away,
//      which suits the common use cases (family group photos, screenshots
//      with webcam thumbnails).
//   4. Decode each anchor's prediction into a bbox + score, applying
//      sigmoid to the raw logit scores. Filter by score threshold.
//   5. NMS by IoU to dedupe overlapping detections.
//   6. Un-letterbox: convert from 256×256 input space back to source
//      pixel space.
//
// Returns an array of source-pixel-space rectangles ready to wrap in
// redact overlays.

import { showFaceConsentModal } from './faceConsent.js';
import { probeCapabilities } from '../capabilities.js';

// --- Consent + load gating ------------------------------------------------

export const CONSENT_KEY = 'noadsimages_face_detect_consent';
// Bump when re-vendoring the model so previously-consented users get
// re-prompted with the new download-size disclosure.
export const VENDOR_HASH = 'qualcomm-mediapipe-face-0.54.0';
const VENDOR_SIZE_LABEL = '~600 KB';

let consentOverrideForTest = null;          // 'grant' | 'deny' | null
let sessionPromise = null;                  // Promise<{ run, decode }>
let testSessionForTest = null;              // injected by _setSessionForTest

const MODEL_URL = '/js/vendor/blazeface/face_detector.onnx';
// The .onnx references its weight tensor data via the standard ONNX
// external-data mechanism (a side file living in the same directory).
// When we hand ORT a URL for the .onnx, it does NOT auto-fetch the
// companion .data file — that produces:
//   "Failed to load external data file 'face_detector.data',
//    error: Module.MountedFiles is not available."
// Fix: pre-fetch both files as bytes and pass the .data explicitly via
// the SessionOptions.externalData option. The path string MUST match
// what's stored inside the .onnx (basename, no leading slash).
const MODEL_DATA_URL  = '/js/vendor/blazeface/face_detector.data';
const MODEL_DATA_NAME = 'face_detector.data';
// We vendor TWO ORT bundles (see index.html import map):
//   - 'onnxruntime-web'        → CPU bundle, WASM embedded, no external fetch.
//   - 'onnxruntime-web/webgpu' → WebGPU bundle, also self-contained.
//
// The CPU bundle does NOT include the JSEP WASM that ORT needs when you
// ask for the WebGPU executionProvider — it will 404 trying to fetch
// `/ort-wasm-simd-threaded.jsep.wasm`, and the subsequent CPU-only retry
// inherits the broken initWasm() state. The fix: pick the bundle
// up-front based on caps.webGPU, and ONLY request the executionProviders
// the chosen bundle actually supports.
const ORT_CPU_SPECIFIER    = 'onnxruntime-web';
const ORT_WEBGPU_SPECIFIER = 'onnxruntime-web/webgpu';

const INPUT_SIZE = 256;
const SCORE_THRESHOLD = 0.5;                // sigmoid space — empirical default
const IOU_THRESHOLD   = 0.3;
const MAX_DETECTIONS  = 50;

// --- Anchor grid ----------------------------------------------------------
//
// Full-range BlazeFace for 256×256 input has two prediction heads:
//   - stride 16 → 16×16 grid × 2 anchors/cell = 512 anchors → box_coords_1 / box_scores_1
//   - stride 32 →  8×8 grid × 6 anchors/cell = 384 anchors → box_coords_2 / box_scores_2
// All anchors at a given cell share the same center; the model learns to
// emit different bboxes per anchor index. We precompute once.
const ANCHORS_HEAD_1 = buildAnchors(16, 16, 2);
const ANCHORS_HEAD_2 = buildAnchors(8,  32, 6);

function buildAnchors(gridSize, stride, anchorsPerCell) {
  const out = new Float32Array(gridSize * gridSize * anchorsPerCell * 2);
  let i = 0;
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const cx = (x + 0.5) * stride;
      const cy = (y + 0.5) * stride;
      for (let a = 0; a < anchorsPerCell; a++) {
        out[i++] = cx;
        out[i++] = cy;
      }
    }
  }
  return out; // [cx0, cy0, cx1, cy1, ...] in pixel-space of the 256×256 input
}

// --- Public API ------------------------------------------------------------

/**
 * Read-only check: do we already have stored consent for this model
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
export async function ensureFaceConsent() {
  if (consentOverrideForTest === 'grant') return true;
  if (consentOverrideForTest === 'deny')  return false;
  if (hasStoredConsent()) return true;
  const granted = await showFaceConsentModal({ sizeLabel: VENDOR_SIZE_LABEL });
  if (granted) {
    try { localStorage.setItem(CONSENT_KEY, VENDOR_HASH); }
    catch { /* private mode etc. — best-effort */ }
  }
  return granted;
}

/**
 * Detect faces in `bitmap`. Resolves to an array of axis-aligned rects in
 * SOURCE-PIXEL space — { x, y, w, h, score } — sorted by descending score
 * after NMS.
 *
 * Throws 'face_consent_declined' if the user cancels the consent modal.
 *
 * @param {ImageBitmap | HTMLCanvasElement | OffscreenCanvas} bitmap
 * @returns {Promise<Array<{x: number, y: number, w: number, h: number, score: number}>>}
 */
export async function detectFaces(bitmap) {
  if (!bitmap || !bitmap.width || !bitmap.height) return [];
  const granted = await ensureFaceConsent();
  if (!granted) throw new Error('face_consent_declined');

  const session = await loadSession();
  const { tensor, scale, dx, dy } = preprocess(bitmap);

  const outputs = await session.run(tensor);
  const detections = decode(outputs);
  const merged = nms(detections, IOU_THRESHOLD).slice(0, MAX_DETECTIONS);
  return merged.map(d => unLetterbox(d, bitmap.width, bitmap.height, scale, dx, dy));
}

// --- Session lifecycle ----------------------------------------------------

async function loadSession() {
  if (testSessionForTest) return testSessionForTest;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    // Probe WebGPU support before choosing a bundle. If the device has
    // navigator.gpu we load the WebGPU bundle (faster inference); else we
    // load the CPU bundle (still ~200 ms for BlazeFace — plenty fast).
    //
    // CRITICAL: the CPU bundle does NOT include the JSEP WASM. Requesting
    // executionProviders: ['webgpu', ...] against the CPU bundle triggers
    // an external WASM fetch for /ort-wasm-simd-threaded.jsep.wasm that
    // 404s, and the CPU-only retry inside ORT fails because initWasm()
    // is already in a broken state. So we ONLY pass executionProviders
    // the loaded bundle can actually serve.
    let caps;
    try { caps = await probeCapabilities(); }
    catch { caps = { webGPU: false }; }
    const useGpu = !!caps.webGPU;
    const specifier = useGpu ? ORT_WEBGPU_SPECIFIER : ORT_CPU_SPECIFIER;
    const providers = useGpu ? ['webgpu', 'cpu'] : ['cpu'];

    let ort;
    try {
      ort = await import(/* @vite-ignore */ specifier);
    } catch (err) {
      sessionPromise = null;
      throw new Error('face_ort_load_failed: ' + (err && err.message ? err.message : err));
    }

    // Pre-fetch both the .onnx and its companion .data file as bytes.
    // Doing this here (instead of letting ORT's URL loader try) lets us
    // pass the external-data buffer explicitly via the externalData
    // option, which is the only way ORT-Web supports external weights.
    let modelBytes, dataBytes;
    try {
      const [modelRes, dataRes] = await Promise.all([
        fetch(MODEL_URL),
        fetch(MODEL_DATA_URL),
      ]);
      if (!modelRes.ok) throw new Error(`model fetch ${modelRes.status}`);
      if (!dataRes.ok)  throw new Error(`weights fetch ${dataRes.status}`);
      [modelBytes, dataBytes] = await Promise.all([
        modelRes.arrayBuffer(),
        dataRes.arrayBuffer(),
      ]);
    } catch (err) {
      sessionPromise = null;
      throw new Error('face_model_fetch_failed: ' + (err && err.message ? err.message : err));
    }

    const sessionOptions = {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
      externalData: [
        { data: new Uint8Array(dataBytes), path: MODEL_DATA_NAME },
      ],
    };

    let inferenceSession;
    try {
      inferenceSession = await ort.InferenceSession.create(new Uint8Array(modelBytes), sessionOptions);
    } catch (err) {
      // If we requested WebGPU and it failed (e.g. adapter disappeared
      // post-probe), we CAN'T just retry against the same module — once
      // ORT's WASM init is broken there's no recovery. Re-import the CPU
      // bundle fresh and try again with the bytes we already fetched.
      if (useGpu) {
        try {
          const cpuOrt = await import(/* @vite-ignore */ ORT_CPU_SPECIFIER);
          inferenceSession = await cpuOrt.InferenceSession.create(new Uint8Array(modelBytes), {
            ...sessionOptions,
            executionProviders: ['cpu'],
            // externalData buffers were consumed by the first try; rebuild a fresh view.
            externalData: [{ data: new Uint8Array(dataBytes), path: MODEL_DATA_NAME }],
          });
          ort = cpuOrt;
        } catch (cpuErr) {
          sessionPromise = null;
          throw new Error('face_session_create_failed: ' + (cpuErr && cpuErr.message ? cpuErr.message : cpuErr));
        }
      } else {
        sessionPromise = null;
        throw new Error('face_session_create_failed: ' + (err && err.message ? err.message : err));
      }
    }
    return {
      async run(tensor) {
        const inputTensor = new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
        const result = await inferenceSession.run({ image: inputTensor });
        return result;
      },
    };
  })();
  return sessionPromise;
}

// --- Preprocess -----------------------------------------------------------
//
// Letterbox the source bitmap into 256×256 with black padding so the
// aspect ratio is preserved (a stretched landscape photo squashes faces
// vertically and drops detection scores). Pixels normalized to [0, 1] and
// packed CHW (matches the model's NCHW input layout).
function preprocess(bitmap) {
  const W = bitmap.width;
  const H = bitmap.height;
  const scale = Math.min(INPUT_SIZE / W, INPUT_SIZE / H);
  const sw = Math.round(W * scale);
  const sh = Math.round(H * scale);
  const dx = Math.floor((INPUT_SIZE - sw) / 2);
  const dy = Math.floor((INPUT_SIZE - sh) / 2);

  const c = createCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = c.getContext('2d');
  // Black letterbox bars — match MediaPipe's default behavior.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, dx, dy, sw, sh);
  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixels = imageData.data;
  const plane = INPUT_SIZE * INPUT_SIZE;
  const tensor = new Float32Array(3 * plane);
  // RGBA → NCHW float [0, 1]. Skipping alpha.
  for (let i = 0; i < plane; i++) {
    tensor[0 * plane + i] = pixels[i * 4 + 0] / 255; // R
    tensor[1 * plane + i] = pixels[i * 4 + 1] / 255; // G
    tensor[2 * plane + i] = pixels[i * 4 + 2] / 255; // B
  }
  return { tensor, scale, dx, dy };
}

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// --- Decode ----------------------------------------------------------------
//
// Walk both prediction heads, sigmoid-activate the score logits, filter
// against SCORE_THRESHOLD, and turn each surviving anchor's regressor into
// a normalized [0, 1] bbox in the 256×256 input space. The regressor
// encoding is pixel-space-relative-to-anchor — i.e. cx = anchor.cx + dx —
// which matches MediaPipe's original BlazeFace decoder.
function decode(outputs) {
  const detections = [];
  decodeHead(outputs.box_coords_1.data, outputs.box_scores_1.data, ANCHORS_HEAD_1, detections);
  decodeHead(outputs.box_coords_2.data, outputs.box_scores_2.data, ANCHORS_HEAD_2, detections);
  return detections;
}

function decodeHead(coords, scores, anchors, out) {
  const n = scores.length;
  for (let i = 0; i < n; i++) {
    const score = sigmoid(scores[i]);
    if (score < SCORE_THRESHOLD) continue;
    const c = i * 16;
    const ax = anchors[i * 2 + 0];
    const ay = anchors[i * 2 + 1];
    const dxRaw = coords[c + 0];
    const dyRaw = coords[c + 1];
    const dw    = coords[c + 2];
    const dh    = coords[c + 3];
    const cx = ax + dxRaw;
    const cy = ay + dyRaw;
    const w  = Math.abs(dw);
    const h  = Math.abs(dh);
    if (w <= 0 || h <= 0) continue;
    out.push({
      // Normalized [0, 1] coords against the 256×256 letterboxed input.
      x_min: (cx - w / 2) / INPUT_SIZE,
      y_min: (cy - h / 2) / INPUT_SIZE,
      x_max: (cx + w / 2) / INPUT_SIZE,
      y_max: (cy + h / 2) / INPUT_SIZE,
      score,
    });
  }
}

function sigmoid(x) {
  // Numerically stable form — avoids overflow on large positive logits.
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  } else {
    const z = Math.exp(x);
    return z / (1 + z);
  }
}

// --- NMS -------------------------------------------------------------------
//
// Greedy NMS: sort by descending score, keep boxes that don't overlap any
// already-kept box by more than IOU_THRESHOLD. ~30 lines, no fancy data
// structures — at most ~50 candidates after thresholding so O(N²) is fine.
function nms(detections, iouThreshold) {
  detections.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const det of detections) {
    let overlap = false;
    for (const k of kept) {
      if (iou(det, k) > iouThreshold) { overlap = true; break; }
    }
    if (!overlap) kept.push(det);
  }
  return kept;
}

function iou(a, b) {
  const xMin = Math.max(a.x_min, b.x_min);
  const yMin = Math.max(a.y_min, b.y_min);
  const xMax = Math.min(a.x_max, b.x_max);
  const yMax = Math.min(a.y_max, b.y_max);
  if (xMax <= xMin || yMax <= yMin) return 0;
  const inter = (xMax - xMin) * (yMax - yMin);
  const aArea = (a.x_max - a.x_min) * (a.y_max - a.y_min);
  const bArea = (b.x_max - b.x_min) * (b.y_max - b.y_min);
  return inter / (aArea + bArea - inter);
}

// --- Un-letterbox ----------------------------------------------------------
//
// Map a detection from 256×256-normalized [0, 1] coords back into the
// source bitmap's pixel space, accounting for the letterbox offset + scale
// applied during preprocess. Output rect is {x, y, w, h} suitable for
// wrapping in a redact overlay.
function unLetterbox(det, srcW, srcH, scale, dx, dy) {
  // Step 1: normalized [0, 1] of 256×256 → pixel coords in 256×256 space.
  const ix_min = det.x_min * INPUT_SIZE;
  const iy_min = det.y_min * INPUT_SIZE;
  const ix_max = det.x_max * INPUT_SIZE;
  const iy_max = det.y_max * INPUT_SIZE;
  // Step 2: subtract letterbox offsets, scale back to source.
  const sx_min = (ix_min - dx) / scale;
  const sy_min = (iy_min - dy) / scale;
  const sx_max = (ix_max - dx) / scale;
  const sy_max = (iy_max - dy) / scale;
  // Step 3: clamp to source bounds (a bbox that extends slightly past the
  // image edge isn't useful for a redact, and the renderer would clip it
  // anyway).
  const x = Math.max(0, Math.min(srcW, sx_min));
  const y = Math.max(0, Math.min(srcH, sy_min));
  const w = Math.max(0, Math.min(srcW, sx_max) - x);
  const h = Math.max(0, Math.min(srcH, sy_max) - y);
  return { x, y, w, h, score: det.score };
}

// --- Test escape hatches --------------------------------------------------

export function _setConsentForTest(mode) {
  consentOverrideForTest = mode || null;
}

export function _setSessionForTest(sess) {
  testSessionForTest = sess || null;
}

export function _resetForTest() {
  consentOverrideForTest = null;
  sessionPromise = null;
  testSessionForTest = null;
  try { localStorage.removeItem(CONSENT_KEY); } catch { /* ignore */ }
}
