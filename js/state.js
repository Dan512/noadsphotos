// js/state.js — central app state + tiny pub/sub. Mutations go through update().
const state = {
  ui:     { view: 'queue', activeImageId: null, activeTool: 'select', selectedOverlayId: null, theme: 'auto', language: 'en', settings: {}, zoom: 'fit' },
  queue:  [],
  images: Object.create(null),
  // export.pdf holds PDF-specific options surfaced when format === 'pdf'.
  // Margins are undefined by default — the renderer picks 0 for "fit" and
  // 36 for named paper sizes so the image isn't pressed against the edge.
  export: {
    format: 'png',
    quality: 0.92,
    filenameTemplate: '{base}-edited',
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
