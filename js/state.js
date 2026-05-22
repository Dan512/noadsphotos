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
  },
  queue:  [],
  images: Object.create(null),
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
