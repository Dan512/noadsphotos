// js/queue.js — pure data-model module for the import queue.
// Backed entirely by state.js (no internal state). Callers construct
// fully-formed ImageState objects and hand them in; this module manages
// only the ordered `state.queue` and the keyed `state.images` map, plus
// `state.ui.activeImageId`. Every mutation is performed through
// `update()` so subscribers fire.
import { getState, update } from './state.js';

// Canonical ID generator. Available in Node 19+ and modern browsers.
export function createId() {
  return crypto.randomUUID();
}

// Push an image into the queue + images map. Deduplicated by ID — calling
// twice with the same image is idempotent. Always notifies via update().
export function addImage(imageState) {
  if (!imageState || typeof imageState.id !== 'string') {
    throw new TypeError('addImage: imageState must have a string id');
  }
  update(s => {
    if (!s.queue.includes(imageState.id)) {
      s.queue.push(imageState.id);
    }
    s.images[imageState.id] = imageState;
  });
}

// Remove from queue + images. If the removed image was active, advance to
// the next image in the queue (or null if empty). Removing an unknown ID
// is a no-op (does NOT throw).
export function removeImage(id) {
  const s = getState();
  if (!s.queue.includes(id) && !(id in s.images)) {
    return; // no-op
  }
  update(state => {
    const idx = state.queue.indexOf(id);
    if (idx !== -1) state.queue.splice(idx, 1);
    delete state.images[id];
    if (state.ui.activeImageId === id) {
      // Advance to the entry now at `idx` (the one that took its place),
      // or the previous entry if we removed the tail, or null if empty.
      if (state.queue.length === 0) {
        state.ui.activeImageId = null;
      } else if (idx < state.queue.length) {
        state.ui.activeImageId = state.queue[idx];
      } else {
        state.ui.activeImageId = state.queue[state.queue.length - 1];
      }
    }
  });
}

// Move queue[fromIndex] to position toIndex. Both indices must be valid.
export function reorder(fromIndex, toIndex) {
  const s = getState();
  const n = s.queue.length;
  if (
    !Number.isInteger(fromIndex) || !Number.isInteger(toIndex) ||
    fromIndex < 0 || fromIndex >= n ||
    toIndex   < 0 || toIndex   >= n
  ) {
    throw new RangeError(`reorder: indices out of range (from=${fromIndex}, to=${toIndex}, length=${n})`);
  }
  if (fromIndex === toIndex) {
    update(() => {}); // notify subscribers for consistency
    return;
  }
  update(state => {
    const [moved] = state.queue.splice(fromIndex, 1);
    state.queue.splice(toIndex, 0, moved);
  });
}

// Set the active image. Pass null to clear. Throws if id is non-null and
// not present in state.images.
export function setActive(id) {
  const s = getState();
  if (id !== null && !(id in s.images)) {
    throw new Error(`setActive: unknown image id ${id}`);
  }
  update(state => {
    state.ui.activeImageId = id;
  });
}

export function getActiveId() {
  return getState().ui.activeImageId;
}

export function getActive() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (id === null) return null;
  return s.images[id] ?? null;
}

// Returns a SHALLOW COPY of the queue array. Mutating the result does not
// affect state.
export function getQueue() {
  return [...getState().queue];
}

export function getImage(id) {
  const s = getState();
  return s.images[id] ?? null;
}
