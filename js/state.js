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
  export: {
    format: 'png',
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
