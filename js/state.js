// js/state.js — central app state + tiny pub/sub. Mutations go through update().
const state = {
  ui:     { view: 'queue', activeImageId: null, activeTool: 'select', selectedOverlayId: null, theme: 'auto', language: 'en', settings: {}, zoom: 'fit' },
  queue:  [],
  images: Object.create(null),
  export: { format: 'png', quality: 0.92, filenameTemplate: '{base}-edited' },
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
