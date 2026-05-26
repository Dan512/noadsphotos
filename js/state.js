// js/state.js — central app state + tiny pub/sub. Mutations go through update().
const state = {
  ui:     {
    view: 'queue', activeImageId: null, activeTool: 'select', selectedOverlayId: null,
    theme: 'auto', language: 'en', settings: {}, zoom: 'fit',
    // v1.2 compare-with-original split view. compareMode toggles the
    // split; compareSplit (0–1) is the horizontal divider position
    // (0 = all original, 1 = all edited, 0.5 = 50/50). The renderer
    // reads both each frame.
    compareMode: false,
    compareSplit: 0.5,
    // v1.2 Feature 1 + 4: shared sensitivity preset for the redact tool's
    // AI-detect buttons (Auto-detect faces + Detect text). 'strict' →
    // fewer, more-confident detections; 'loose' → catches more at the cost
    // of false positives. Maps to per-model thresholds inside
    // js/ops/faceDetect.js and js/ops/textDetect.js.
    aiDetectSensitivity: 'normal',
    // Redact-tool defaults. Hoisted from module-local state in
    // js/tools/redactTool.js so the editor's side-panel controls AND the
    // queue's batch-panel controls share one source of truth. Changing
    // any of these in either UI updates the other.
    redact: {
      mode: 'mask',          // 'mask' | 'pixelate' | 'blur'
      strength: 12,          // blur radius / pixel block size (px in source space)
      color: '#000000',      // hex string, used by mask mode
    },
    // v1.2.x OCR preview-select mode. When `active` is true, the redact
    // tool's "Detect text" populates this slice with detected lines (in
    // source-pixel coords) instead of immediately creating redact
    // overlays. The renderer draws yellow boxes for unselected lines
    // and red for selected; clicks on a box toggle its selection.
    // PII-matching lines (email/phone/CC/SSN/IP) start pre-selected via
    // the autoFlag set in textDetect.js.
    //
    // lines: [{ rect:{x,y,w,h}, text:string, selected:bool, autoFlag:bool }]
    ocrPreview: {
      active: false,
      imageId: null,
      lines: [],
    },
    // v1.3 Feature 16: transparent-PNG tools. Per-image (not batch) tool
    // panel state for pad-canvas + replace-transparency + checkerboard
    // preview toggle. Transient per-session — no localStorage persistence
    // (the values are workflow-specific; what made sense for one image
    // rarely makes sense for the next).
    //
    // padColor: null = transparent (the default — pad-then-export is the
    // canonical "make room for cropping" workflow). A hex string means
    // fill the new margin with that color.
    transparentPng: {
      padTop: 0,
      padRight: 0,
      padBottom: 0,
      padLeft: 0,
      padColor: null,
      replaceColor: '#ffffff',
      replaceThreshold: 0.01,
      checkerboardOn: false,
    },
    // v1.3 Feature 11: exact-file-size export. Tracks the user's choice in
    // the "Target file size" subsection of both the editor and the batch
    // panel. Persisted to localStorage under `noadsimages_target_size` and
    // restored on init (see initTargetSizeFromStorage below).
    //
    //   mode        'preset' | 'custom'
    //   presetId    id from TARGET_SIZE_PRESETS (null when custom)
    //   customValue numeric value, units below
    //   customUnit  'MB' | 'KB' — what customValue means
    //   autoResize  true → exporter is allowed to halve dimensions when
    //               quality alone can't fit the target
    //   format      'jpeg' | 'webp' — PNG is lossless so it has no role here
    targetSize: {
      mode: 'preset',
      presetId: 'discord-25',
      customValue: 2,
      customUnit: 'MB',
      autoResize: true,
      format: 'jpeg',
    },
    // v1.3 Feature 9: upload-ready preset. One-click "resize + compress +
    // strip EXIF + rename + ZIP for batch" — the most common social/web prep
    // flow. Persists to localStorage under `noadsimages_upload_ready` so a
    // reload restores the user's last-used config (see
    // initUploadReadyFromStorage below).
    //
    //   longEdge         px target for the long edge; resize is skipped when
    //                    the source long edge is already ≤ this value
    //   format           'jpeg' | 'webp' | 'png'
    //   quality          0.20 – 1.00 (ignored for png)
    //   stripExif        true → drop EXIF/XMP/GPS on export (privacy default)
    //   filenameTemplate filename template, same tokens as the export panel
    uploadReady: {
      longEdge: 1920,
      format: 'jpeg',
      quality: 0.85,
      stripExif: true,
      filenameTemplate: '{base}-edited',
    },
    // v1.3 Feature 12: watermark preset. Text + image watermark, with a
    // 9-point grid + tiled-diagonal + drag-to-position. Settings persist to
    // localStorage under `noadsimages_watermark` (text bits + the logo
    // image as base64). The logo is decoded at boot into a transient
    // ObjectURL — that URL is NOT persisted (the base64 is the source of
    // truth across reloads).
    //
    // Modeled as a global SETTING in state.ui (not a per-instance overlay
    // in image.overlays), because a watermark is a one-knob preference that
    // applies to every export — distinct from text/brush/shape overlays the
    // user places per image. Baked into export, drawn live in preview.
    watermark: {
      enabled: false,
      type: 'text',                                  // 'text' | 'image'
      text: '© ',
      textFont: 'Onest, system-ui, sans-serif',
      textSize: 0.04,                                // unused for v1 (scale drives size)
      textColor: '#ffffff',
      imageBlobUrl: null,                            // transient ObjectURL (not persisted)
      imageBlobBase64: null,                         // base64 logo, persisted
      position: 'bottom-right',                      // 9-grid + 'tiled' + 'custom'
      customX: 0.5,                                  // 0..1 of canvas width
      customY: 0.5,                                  // 0..1 of canvas height
      opacity: 0.6,
      scale: 0.15,                                   // fraction of canvas long edge
      tiledAngle: -30,                               // degrees, used when position === 'tiled'
    },
  },
  queue:  [],
  images: Object.create(null),
  // v1.2 Feature 7: find-duplicates mode. `active` toggles the find-mode
  // UI (reordered queue + dark overlay on marked items + Remove button).
  // Hashes themselves are cached on each image (image._hashes) so re-runs
  // at a different sensitivity skip the worker step.
  //
  // sensitivity ∈ {'strict','normal','loose'} maps to a Hamming-distance
  // threshold (see js/ops/dedupe.js SENSITIVITY_THRESHOLDS).
  //
  // clusters: [{ id, memberIds, keeperIds }, ...]
  // markedIds: image IDs currently flagged for removal (subset of all
  // memberIds across clusters; user can click thumbs to toggle).
  // preFindOrder: snapshot of state.queue at the moment find-mode was
  // entered; Ctrl+Z restores this to revert find-mode.
  dedupe: {
    active: false,
    sensitivity: 'normal',
    clusters: [],
    markedIds: [],
    preFindOrder: null,
  },
  // export.pdf holds PDF-specific options surfaced when format === 'pdf'.
  // Margins are undefined by default — the renderer picks 0 for "fit" and
  // 36 for named paper sizes so the image isn't pressed against the edge.
  //
  // _userFormatLocked: false at session start so the smart match-source
  // default (see js/ops/formatSmart.js) is free to set the format from the
  // active image's source MIME. Flips to true the first time the user clicks
  // a format chip; once locked, switching active images leaves their choice
  // alone. NOT persisted to localStorage — every new session starts unlocked
  // so smart defaults stay responsive to whatever the user just imported.
  export: {
    format: 'jpeg',
    _userFormatLocked: false,
    quality: 0.92,
    filenameTemplate: '{base}-edited',
    // v1.1.2: opt-in metadata preservation. Default = strip (the privacy-
    // forward stance the site is built around). Users who want to keep
    // GPS / camera info — e.g., resizing family JPEGs — can uncheck this
    // in the export panel. EXIF preservation only actually fires when the
    // source AND the output are both JPEG (see exporter.js).
    stripMetadata: true,
    pdf: { pageSize: 'fit', orientation: 'auto', margins: undefined, fitMode: 'contain' },
  },
};

const subs = new Set();

export function getState() {
  return state;
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function update(mutator) {
  mutator(state);
  for (const fn of subs) fn(state);
}

// --- targetSize persistence (Feature 11) ----------------------------------
//
// Keep the user's exact-file-size choice across reloads. We don't trust the
// stored blob — any field may be missing, mistyped, or hostile (a renamed
// preset ID, a string masquerading as a number, a negative MB count). Each
// field is sanitized against an allowlist before merging into state. If the
// JSON is corrupt or unparseable, we silently drop it and keep the defaults.
const TARGET_SIZE_KEY = 'noadsimages_target_size';

const TARGET_SIZE_DEFAULTS = Object.freeze({
  mode: 'preset',
  presetId: 'discord-25',
  customValue: 2,
  customUnit: 'MB',
  autoResize: true,
  format: 'jpeg',
});

function sanitizeTargetSize(raw) {
  const out = { ...TARGET_SIZE_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.mode === 'preset' || raw.mode === 'custom') out.mode = raw.mode;
  // Preset ID is a free string; we keep whatever the user picked. If the
  // catalog has since dropped that id, getPresetById() will return null at
  // resolve time and the UI will fall back gracefully.
  if (typeof raw.presetId === 'string' && raw.presetId.length > 0 && raw.presetId.length <= 64) {
    out.presetId = raw.presetId;
  } else if (raw.presetId === null) {
    out.presetId = null;
  }
  const cv = Number(raw.customValue);
  if (Number.isFinite(cv) && cv > 0 && cv < 1e6) out.customValue = cv;
  if (raw.customUnit === 'KB' || raw.customUnit === 'MB') out.customUnit = raw.customUnit;
  if (typeof raw.autoResize === 'boolean') out.autoResize = raw.autoResize;
  if (raw.format === 'jpeg' || raw.format === 'webp') out.format = raw.format;
  return out;
}

/**
 * Read the persisted target-size slice from localStorage and merge into
 * state.ui.targetSize. Safe to call at boot — corrupt / missing data leaves
 * the defaults in place. Wrapped in try/catch because Safari private mode +
 * disabled storage both throw on `localStorage.getItem`.
 */
export function initTargetSizeFromStorage() {
  let raw = null;
  try { raw = localStorage.getItem(TARGET_SIZE_KEY); } catch { return; }
  if (!raw) return;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return; }
  const safe = sanitizeTargetSize(parsed);
  update(s => { s.ui.targetSize = safe; });
}

/**
 * Persist the current target-size slice. Called by the UI after every
 * mutation so a reload restores the same chip, custom value, format, etc.
 * Failures are swallowed (same posture as settings.js).
 */
export function persistTargetSize() {
  try {
    const safe = sanitizeTargetSize(state.ui.targetSize);
    localStorage.setItem(TARGET_SIZE_KEY, JSON.stringify(safe));
  } catch { /* ignore — Safari private mode, quota exceeded, etc. */ }
}

// --- uploadReady persistence (Feature 9) ----------------------------------
//
// Same sanitize-on-read posture as targetSize: every field is range-checked
// against an allowlist before merging into state. Corrupt blobs fall back
// silently to defaults. Wrapped in try/catch because Safari private mode
// and disabled storage both throw on `localStorage.getItem`.
const UPLOAD_READY_KEY = 'noadsimages_upload_ready';

const UPLOAD_READY_DEFAULTS = Object.freeze({
  longEdge: 1920,
  format: 'jpeg',
  quality: 0.85,
  stripExif: true,
  filenameTemplate: '{base}-edited',
});

/**
 * Coerce an arbitrary blob into a known-good upload-ready config. Exported
 * for unit tests; the runtime only needs the init + persist helpers.
 *
 * Rules:
 *   - longEdge: positive integer between 64 and 16384 px (covers anything
 *     from a tiny avatar to a print-quality 16K source). Out-of-range
 *     values fall back to the default rather than clamping silently — a
 *     stored 0 or NaN almost certainly came from a UI bug, not a real
 *     user choice.
 *   - format: 'jpeg' | 'webp' | 'png' only.
 *   - quality: number in [0.20, 1.00].
 *   - stripExif: boolean.
 *   - filenameTemplate: non-empty string ≤ 200 chars.
 */
export function sanitizeUploadReady(raw) {
  const out = { ...UPLOAD_READY_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  const le = Number(raw.longEdge);
  if (Number.isFinite(le) && le >= 64 && le <= 16384) {
    out.longEdge = Math.round(le);
  }
  if (raw.format === 'jpeg' || raw.format === 'webp' || raw.format === 'png') {
    out.format = raw.format;
  }
  const q = Number(raw.quality);
  if (Number.isFinite(q) && q >= 0.20 && q <= 1.00) {
    out.quality = q;
  }
  if (typeof raw.stripExif === 'boolean') out.stripExif = raw.stripExif;
  if (typeof raw.filenameTemplate === 'string'
      && raw.filenameTemplate.length > 0
      && raw.filenameTemplate.length <= 200) {
    out.filenameTemplate = raw.filenameTemplate;
  }
  return out;
}

/**
 * Read the persisted upload-ready slice from localStorage and merge into
 * state.ui.uploadReady. Safe to call at boot — corrupt / missing data leaves
 * the defaults in place.
 */
export function initUploadReadyFromStorage() {
  let raw = null;
  try { raw = localStorage.getItem(UPLOAD_READY_KEY); } catch { return; }
  if (!raw) return;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return; }
  const safe = sanitizeUploadReady(parsed);
  update(s => { s.ui.uploadReady = safe; });
}

/**
 * Persist the current upload-ready slice. Called by the UI after every
 * mutation so a reload restores the same config. Failures are swallowed
 * (same posture as persistTargetSize).
 */
export function persistUploadReady() {
  try {
    const safe = sanitizeUploadReady(state.ui.uploadReady);
    localStorage.setItem(UPLOAD_READY_KEY, JSON.stringify(safe));
  } catch { /* ignore — Safari private mode, quota exceeded, etc. */ }
}

// --- watermark persistence (Feature 12) -----------------------------------
//
// Same sanitize-on-read posture as the other slices. The notable difference
// is the logo: we persist it as base64 (the ObjectURL would be invalid in a
// new tab even if we did stash it). Base64 inflates ~33% — a typical 50–200
// KB logo becomes 70–280 KB, comfortably within the 5–10 MB localStorage
// quota that browsers offer.
//
// On init, we decode the base64 back into a Blob → ObjectURL so the runtime
// has a paintable image source. The base64 stays in state too so subsequent
// persists don't have to re-encode the blob.
const WATERMARK_KEY = 'noadsimages_watermark';

const WATERMARK_DEFAULTS = Object.freeze({
  enabled: false,
  type: 'text',
  text: '© ',
  textFont: 'Onest, system-ui, sans-serif',
  textSize: 0.04,
  textColor: '#ffffff',
  imageBlobUrl: null,
  imageBlobBase64: null,
  position: 'bottom-right',
  customX: 0.5,
  customY: 0.5,
  opacity: 0.6,
  scale: 0.15,
  tiledAngle: -30,
});

// Hex color predicate — accepts #rgb / #rrggbb / #rrggbbaa.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// Position allowlist — exact match required.
const WATERMARK_POSITIONS = new Set([
  'top-left', 'top', 'top-right',
  'left', 'center', 'right',
  'bottom-left', 'bottom', 'bottom-right',
  'tiled', 'custom',
]);

/**
 * Coerce an arbitrary blob into a known-good watermark config. Same posture
 * as sanitizeUploadReady — every field gets allowlisted/range-checked, and
 * anything off falls back to the default rather than clamping silently.
 */
export function sanitizeWatermark(raw) {
  const out = { ...WATERMARK_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (raw.type === 'text' || raw.type === 'image') out.type = raw.type;
  if (typeof raw.text === 'string' && raw.text.length <= 200) out.text = raw.text;
  if (typeof raw.textFont === 'string' && raw.textFont.length > 0 && raw.textFont.length <= 200) {
    out.textFont = raw.textFont;
  }
  const tsz = Number(raw.textSize);
  if (Number.isFinite(tsz) && tsz > 0 && tsz <= 1) out.textSize = tsz;
  if (typeof raw.textColor === 'string' && HEX_COLOR_RE.test(raw.textColor)) {
    out.textColor = raw.textColor;
  }
  // imageBlobUrl is transient (revoked across reloads); never trust the
  // stored value. We rebuild it from base64 in initWatermarkFromStorage.
  if (typeof raw.imageBlobBase64 === 'string'
      && raw.imageBlobBase64.length > 0
      && raw.imageBlobBase64.length <= 8 * 1024 * 1024 /* hard 8 MB cap */) {
    out.imageBlobBase64 = raw.imageBlobBase64;
  }
  if (WATERMARK_POSITIONS.has(raw.position)) out.position = raw.position;
  const cx = Number(raw.customX);
  if (Number.isFinite(cx) && cx >= 0 && cx <= 1) out.customX = cx;
  const cy = Number(raw.customY);
  if (Number.isFinite(cy) && cy >= 0 && cy <= 1) out.customY = cy;
  const op = Number(raw.opacity);
  if (Number.isFinite(op) && op >= 0 && op <= 1) out.opacity = op;
  const sc = Number(raw.scale);
  if (Number.isFinite(sc) && sc > 0 && sc <= 1) out.scale = sc;
  const ta = Number(raw.tiledAngle);
  if (Number.isFinite(ta) && ta >= -90 && ta <= 90) out.tiledAngle = ta;
  return out;
}

/**
 * Read the persisted watermark slice from localStorage and merge into
 * state.ui.watermark. If a logo base64 is present, decode it into a Blob +
 * ObjectURL so the renderer can paint it immediately. Failures are swallowed.
 */
export function initWatermarkFromStorage() {
  let raw = null;
  try { raw = localStorage.getItem(WATERMARK_KEY); } catch { return; }
  if (!raw) return;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return; }
  const safe = sanitizeWatermark(parsed);

  // Decode the base64 logo (if any) into a Blob → ObjectURL. Anything goes
  // wrong (data: prefix missing, malformed base64, no URL.createObjectURL)
  // and we silently drop the logo — the user can re-upload.
  if (safe.imageBlobBase64) {
    try {
      const blob = base64ToBlob(safe.imageBlobBase64);
      if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        safe.imageBlobUrl = URL.createObjectURL(blob);
      }
    } catch { /* ignore — leave imageBlobUrl null, drop the base64 */
      safe.imageBlobBase64 = null;
    }
  }

  update(s => { s.ui.watermark = safe; });
}

/**
 * Persist the current watermark slice. Called by the UI after every
 * mutation. Failures swallowed (Safari private mode, quota exceeded).
 */
export function persistWatermark() {
  try {
    // Strip the transient ObjectURL before persisting — it's only valid in
    // the current tab. sanitizeWatermark will rebuild it on next boot from
    // the base64 if present.
    const safe = sanitizeWatermark(state.ui.watermark);
    safe.imageBlobUrl = null;
    localStorage.setItem(WATERMARK_KEY, JSON.stringify(safe));
  } catch { /* ignore */ }
}

// Decode a data: URL or raw base64 string to a Blob. Accepts both forms
// (we always store the full data: URL ourselves, but be tolerant of
// older / hand-pasted values).
function base64ToBlob(base64) {
  let mime = 'image/png';
  let payload = base64;
  if (base64.startsWith('data:')) {
    const comma = base64.indexOf(',');
    if (comma === -1) return null;
    const header = base64.slice(5, comma);
    const semi = header.indexOf(';');
    mime = semi === -1 ? header : header.slice(0, semi);
    payload = base64.slice(comma + 1);
  }
  if (typeof atob !== 'function') return null;
  const binary = atob(payload);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
