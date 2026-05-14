import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../../js/state.js';
import { addImage } from '../../js/queue.js';
import { createLifecycle } from '../../js/lifecycle.js';

// Per-test counters reset in beforeEach.
let decodeCalls;
let closeCalls;
let decodeIds;          // ids passed to decoder, in call order
let pendingResolvers;   // for tests that want to control decode timing

function makeDecoder() {
  return (blob) => {
    decodeCalls++;
    decodeIds.push(blob && blob._id);
    return Promise.resolve({ width: 10, height: 10, _blob: blob, _closed: false });
  };
}

function makeAsyncDecoder() {
  // Returns a decoder where each call's resolution is deferred until the
  // test releases it. Lets us assert dedupe of concurrent setWindow calls.
  return (blob) => {
    decodeCalls++;
    decodeIds.push(blob && blob._id);
    return new Promise(resolve => {
      pendingResolvers.push(() => resolve({ width: 10, height: 10, _blob: blob, _closed: false }));
    });
  };
}

function makeCloser() {
  return (bitmap) => {
    closeCalls++;
    bitmap._closed = true;
  };
}

function makeImageState(id) {
  return {
    id,
    source: {
      blob: { _id: id },          // sentinel — decoder reads ._id to track
      name: `${id}.png`,
      type: 'image/png',
      width: 10, height: 10,
      thumbnail: null,
      bitmap: null,
    },
    transforms: { crop: null, rotate: 0, flipH: false, flipV: false, resize: null },
    adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filterPreset: null, chromakey: null, bgRemoved: false, bgMask: null,
    overlays: [],
    baseDirty: true, overlaysDirty: true,
  };
}

function seedQueue(ids) {
  for (const id of ids) addImage(makeImageState(id));
}

beforeEach(() => {
  const s = getState();
  s.ui.view = 'queue';
  s.ui.activeImageId = null;
  s.ui.activeTool = 'select';
  s.ui.selectedOverlayId = null;
  s.ui.theme = 'auto';
  s.ui.language = 'en';
  s.ui.settings = {};
  s.ui.zoom = 'fit';
  s.queue.length = 0;
  for (const k of Object.keys(s.images)) delete s.images[k];
  s.export.format = 'png';
  s.export.quality = 0.92;
  s.export.filenameTemplate = '{base}-edited';
  decodeCalls = 0;
  closeCalls  = 0;
  decodeIds   = [];
  pendingResolvers = [];
});

// -- decode set ------------------------------------------------------------

test('setWindow on middle image decodes active + 1 prev + 1 next; skips outside', async () => {
  seedQueue(['A', 'B', 'C', 'D', 'E']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('B');
  const s = getState();
  assert.ok(s.images['A'].source.bitmap, 'A decoded');
  assert.ok(s.images['B'].source.bitmap, 'B decoded');
  assert.ok(s.images['C'].source.bitmap, 'C decoded');
  assert.equal(s.images['D'].source.bitmap, null, 'D not decoded');
  assert.equal(s.images['E'].source.bitmap, null, 'E not decoded');
  assert.equal(decodeCalls, 3);
});

test('setWindow does NOT decode images outside the window', async () => {
  seedQueue(['A', 'B', 'C', 'D', 'E']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('A');
  // Only A and B should decode (no -1 neighbor).
  assert.equal(decodeCalls, 2);
  assert.deepEqual(new Set(decodeIds), new Set(['A', 'B']));
});

// -- eviction --------------------------------------------------------------

test('switching window from B to D evicts A; D and new neighbors decode', async () => {
  seedQueue(['A', 'B', 'C', 'D', 'E']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });

  await lc.setWindow('B');
  // Bitmaps: A, B, C
  assert.equal(decodeCalls, 3);
  assert.equal(closeCalls, 0);

  await lc.setWindow('D');
  // Want set for D: C, D, E. A and B were decoded but now out of window
  // → both evicted. D and E newly decoded (C was already decoded).
  const s = getState();
  assert.equal(s.images['A'].source.bitmap, null, 'A evicted');
  assert.equal(s.images['B'].source.bitmap, null, 'B evicted');
  assert.ok(s.images['C'].source.bitmap, 'C still decoded');
  assert.ok(s.images['D'].source.bitmap, 'D decoded');
  assert.ok(s.images['E'].source.bitmap, 'E decoded');
  assert.equal(closeCalls, 2, 'A and B closed');
  assert.equal(decodeCalls, 5, '3 from first window + D and E');
});

// -- ensureBitmap ----------------------------------------------------------

test('ensureBitmap returns cached bitmap if present; does not re-decode', async () => {
  seedQueue(['A', 'B']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('A');
  const before = decodeCalls;
  const bmp = await lc.ensureBitmap('A');
  assert.ok(bmp);
  assert.equal(decodeCalls, before, 'no extra decode');
});

test('ensureBitmap decodes and stores if not cached', async () => {
  seedQueue(['A', 'B', 'C', 'D']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  // No setWindow yet — nothing decoded.
  assert.equal(decodeCalls, 0);
  const bmp = await lc.ensureBitmap('C');
  assert.ok(bmp);
  assert.equal(decodeCalls, 1);
  assert.strictEqual(getState().images['C'].source.bitmap, bmp);
});

test('ensureBitmap for an unknown image throws', async () => {
  seedQueue(['A']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await assert.rejects(() => lc.ensureBitmap('nope'), /unknown image id/);
});

// -- concurrency -----------------------------------------------------------

test('concurrent setWindow calls do not double-decode the same id', async () => {
  seedQueue(['A', 'B', 'C']);
  const decoder = makeAsyncDecoder();
  const closer  = makeCloser();
  const lc = createLifecycle({ decoder, closer });

  // Fire two setWindow calls for the same active id without awaiting.
  const p1 = lc.setWindow('B');
  const p2 = lc.setWindow('B');
  // Both calls should have queued the same 3 decodes — once each.
  assert.equal(decodeCalls, 3, 'three pending decodes, no duplicates');

  // Release all pending decodes.
  for (const r of pendingResolvers) r();
  await Promise.all([p1, p2]);
  assert.equal(decodeCalls, 3, 'still three after completion');
  const s = getState();
  assert.ok(s.images['A'].source.bitmap);
  assert.ok(s.images['B'].source.bitmap);
  assert.ok(s.images['C'].source.bitmap);
});

test('concurrent ensureBitmap for the same id dedupes decoding', async () => {
  seedQueue(['A', 'B']);
  const decoder = makeAsyncDecoder();
  const lc = createLifecycle({ decoder, closer: makeCloser() });

  const p1 = lc.ensureBitmap('A');
  const p2 = lc.ensureBitmap('A');
  assert.equal(decodeCalls, 1, 'single decode for two concurrent ensureBitmap');

  for (const r of pendingResolvers) r();
  const [b1, b2] = await Promise.all([p1, p2]);
  assert.ok(b1);
  assert.strictEqual(b1, b2, 'both callers see the same bitmap');
});

// -- evictAll --------------------------------------------------------------

test('evictAll closes every decoded bitmap and clears references', async () => {
  seedQueue(['A', 'B', 'C']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('B');
  assert.equal(decodeCalls, 3);
  assert.equal(closeCalls, 0);

  lc.evictAll();
  assert.equal(closeCalls, 3);
  const s = getState();
  assert.equal(s.images['A'].source.bitmap, null);
  assert.equal(s.images['B'].source.bitmap, null);
  assert.equal(s.images['C'].source.bitmap, null);
});

test('evictAll on a queue with no decoded bitmaps is a no-op', () => {
  seedQueue(['A', 'B']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  lc.evictAll();
  assert.equal(closeCalls, 0);
});

// -- edge cases ------------------------------------------------------------

test('queue with only 1 image: setWindow decodes only that one', async () => {
  seedQueue(['A']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('A');
  assert.equal(decodeCalls, 1);
  assert.deepEqual(decodeIds, ['A']);
});

test('queue with 2 images: setWindow on item 0 decodes items 0 and 1 (no -1 neighbor)', async () => {
  seedQueue(['A', 'B']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('A');
  assert.equal(decodeCalls, 2);
  assert.deepEqual(new Set(decodeIds), new Set(['A', 'B']));
});

test('queue with 2 images: setWindow on item 1 decodes items 0 and 1 (no +1 neighbor)', async () => {
  seedQueue(['A', 'B']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('B');
  assert.equal(decodeCalls, 2);
  assert.deepEqual(new Set(decodeIds), new Set(['A', 'B']));
});

test('empty queue: setWindow(null) is a no-op', async () => {
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow(null);
  assert.equal(decodeCalls, 0);
  assert.equal(closeCalls, 0);
});

test('setWindow with unknown activeId is a no-op', async () => {
  seedQueue(['A', 'B']);
  const lc = createLifecycle({ decoder: makeDecoder(), closer: makeCloser() });
  await lc.setWindow('not-in-queue');
  assert.equal(decodeCalls, 0);
});

test('setWindow tolerates an image that disappears mid-decode', async () => {
  seedQueue(['A', 'B']);
  const decoder = makeAsyncDecoder();
  const closer  = makeCloser();
  const lc = createLifecycle({ decoder, closer });

  const p = lc.setWindow('A');
  assert.equal(decodeCalls, 2);

  // Remove B before its decode resolves — committed bitmap should be
  // closed instead of leaking.
  const s = getState();
  const idxB = s.queue.indexOf('B');
  s.queue.splice(idxB, 1);
  delete s.images['B'];

  for (const r of pendingResolvers) r();
  await p;
  // A committed normally; B was closed because its image was gone.
  assert.ok(getState().images['A'].source.bitmap);
  assert.equal(closeCalls, 1, 'orphan bitmap closed');
});
