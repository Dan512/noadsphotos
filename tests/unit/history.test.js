// tests/unit/history.test.js — undo/redo + transaction grouping + byte budget.
//
// history.js shares the module-level state singleton with the other modules,
// so each test starts by clearing the history stack AND resetting the state
// to a known shape (images object, etc.). The shared `setup()` helper does
// both.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getState, update } from '../../js/state.js';
import {
  recordOp,
  recordTransaction,
  withHistory,
  withBatchTransaction,
  undo,
  redo,
  getHistoryStats,
  clearHistory,
  setByteBudget,
  estimateSize,
  pickKeys,
  writeKeys,
  __test__,
  subscribeHistory,
} from '../../js/history.js';

// --- shared helpers --------------------------------------------------------

function makeImageState(id, { width = 100, height = 80 } = {}) {
  return {
    id,
    source: { width, height, blob: null, bitmap: null, name: 'x', type: 'image/png', thumbnail: null },
    transforms: { crop: null, rotate: 0, flipH: false, flipV: false, resize: null },
    adjust:     { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filterPreset: 'none',
    chromakey: null,
    chromakeyMask: null,
    bgRemoved: false,
    bgMask: null,
    overlays: [],
    baseDirty: false,
    overlaysDirty: false,
  };
}

function setup() {
  // Reset history.
  clearHistory();
  setByteBudget(100 * 1024 * 1024);
  // Reset state singleton.
  const s = getState();
  s.ui.view = 'queue';
  s.ui.activeImageId = null;
  s.ui.activeTool = 'select';
  s.ui.selectedOverlayId = null;
  s.queue.length = 0;
  for (const k of Object.keys(s.images)) delete s.images[k];
}

beforeEach(setup);

// --- recordOp / undo / redo ------------------------------------------------

test('recordOp: appends to past, clears future, increments bytes', () => {
  const img = makeImageState('a');
  getState().images.a = img;

  recordOp({
    label: 'Rotate 90',
    imageId: 'a',
    kind: 'transforms',
    before: { transforms: { rotate: 0, crop: null, flipH: false, flipV: false, resize: null } },
    after:  { transforms: { rotate: 90, crop: null, flipH: false, flipV: false, resize: null } },
  });

  const stats = getHistoryStats();
  assert.equal(stats.pastCount, 1);
  assert.equal(stats.futureCount, 0);
  assert.ok(stats.bytes > 0);
});

test('recordOp: rejects empty imageId', () => {
  assert.throws(() => recordOp({
    label: 'x', imageId: '', kind: 'transforms', before: {}, after: {},
  }), /imageId/);
});

test('recordOp: rejects empty kind', () => {
  assert.throws(() => recordOp({
    label: 'x', imageId: 'a', kind: '', before: {}, after: {},
  }), /kind/);
});

test('undo: writes the before snapshot back onto the image', () => {
  const img = makeImageState('a');
  getState().images.a = img;

  // Caller has mutated state and then recorded.
  img.transforms.rotate = 90;
  recordOp({
    label: 'Rotate 90',
    imageId: 'a',
    kind: 'transforms',
    before: { transforms: { rotate: 0, crop: null, flipH: false, flipV: false, resize: null } },
    after:  { transforms: { rotate: 90, crop: null, flipH: false, flipV: false, resize: null } },
  });

  const result = undo();
  assert.equal(result, true);
  assert.equal(getState().images.a.transforms.rotate, 0);

  const stats = getHistoryStats();
  assert.equal(stats.pastCount, 0);
  assert.equal(stats.futureCount, 1);
});

test('redo: writes the after snapshot back onto the image', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  img.transforms.rotate = 90;
  recordOp({
    label: 'Rotate 90',
    imageId: 'a',
    kind: 'transforms',
    before: { transforms: { rotate: 0, crop: null, flipH: false, flipV: false, resize: null } },
    after:  { transforms: { rotate: 90, crop: null, flipH: false, flipV: false, resize: null } },
  });
  undo();
  const result = redo();
  assert.equal(result, true);
  assert.equal(getState().images.a.transforms.rotate, 90);

  const stats = getHistoryStats();
  assert.equal(stats.pastCount, 1);
  assert.equal(stats.futureCount, 0);
});

test('multiple ops: undo unwinds in LIFO order', () => {
  const img = makeImageState('a');
  getState().images.a = img;

  // Op 1: rotate 0 → 90.
  img.transforms.rotate = 90;
  recordOp({
    label: 'r1', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0, crop: null, flipH: false, flipV: false, resize: null } },
    after:  { transforms: { rotate: 90, crop: null, flipH: false, flipV: false, resize: null } },
  });
  // Op 2: rotate 90 → 180.
  img.transforms.rotate = 180;
  recordOp({
    label: 'r2', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 90, crop: null, flipH: false, flipV: false, resize: null } },
    after:  { transforms: { rotate: 180, crop: null, flipH: false, flipV: false, resize: null } },
  });

  // First undo → back to 90.
  undo();
  assert.equal(getState().images.a.transforms.rotate, 90);
  // Second undo → back to 0.
  undo();
  assert.equal(getState().images.a.transforms.rotate, 0);
});

test('new action after undo clears the future stack', () => {
  const img = makeImageState('a');
  getState().images.a = img;

  img.transforms.rotate = 90;
  recordOp({
    label: 'r1', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0 } },
    after:  { transforms: { rotate: 90 } },
  });
  undo();
  assert.equal(getHistoryStats().futureCount, 1);

  // New action — future should clear.
  img.transforms.rotate = 45;
  recordOp({
    label: 'r2', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0 } },
    after:  { transforms: { rotate: 45 } },
  });
  assert.equal(getHistoryStats().futureCount, 0);
});

test('undo with empty past returns false', () => {
  assert.equal(undo(), false);
});

test('redo with empty future returns false', () => {
  assert.equal(redo(), false);
});

// --- recordTransaction -----------------------------------------------------

test('recordTransaction: one undo reverts all affected images', () => {
  const a = makeImageState('a');
  const b = makeImageState('b');
  const c = makeImageState('c');
  getState().images.a = a;
  getState().images.b = b;
  getState().images.c = c;

  // Simulate "apply brightness +20 to all".
  a.adjust.brightness = 20;
  b.adjust.brightness = 20;
  c.adjust.brightness = 20;

  recordTransaction({
    label: 'Apply brightness to all',
    affectedImageIds: ['a', 'b', 'c'],
    beforeByImage: {
      a: { adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 } },
      b: { adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 } },
      c: { adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 } },
    },
    afterByImage: {
      a: { adjust: { brightness: 20, contrast: 0, saturation: 0, blur: 0 } },
      b: { adjust: { brightness: 20, contrast: 0, saturation: 0, blur: 0 } },
      c: { adjust: { brightness: 20, contrast: 0, saturation: 0, blur: 0 } },
    },
    opKind: 'adjust',
  });

  // One undo → all three revert.
  undo();
  assert.equal(getState().images.a.adjust.brightness, 0);
  assert.equal(getState().images.b.adjust.brightness, 0);
  assert.equal(getState().images.c.adjust.brightness, 0);
});

test('recordTransaction: redo reapplies all images', () => {
  const a = makeImageState('a');
  const b = makeImageState('b');
  getState().images.a = a;
  getState().images.b = b;
  a.adjust.brightness = 30;
  b.adjust.brightness = 30;

  recordTransaction({
    label: 'Apply',
    affectedImageIds: ['a', 'b'],
    beforeByImage: {
      a: { adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 } },
      b: { adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 } },
    },
    afterByImage: {
      a: { adjust: { brightness: 30, contrast: 0, saturation: 0, blur: 0 } },
      b: { adjust: { brightness: 30, contrast: 0, saturation: 0, blur: 0 } },
    },
    opKind: 'adjust',
  });

  undo();
  assert.equal(getState().images.a.adjust.brightness, 0);
  assert.equal(getState().images.b.adjust.brightness, 0);

  redo();
  assert.equal(getState().images.a.adjust.brightness, 30);
  assert.equal(getState().images.b.adjust.brightness, 30);
});

test('recordTransaction: rejects empty affectedImageIds', () => {
  assert.throws(() => recordTransaction({
    label: 'x', affectedImageIds: [], beforeByImage: {}, afterByImage: {},
  }), /affectedImageIds/);
});

test('recordTransaction: rejects missing snapshots', () => {
  assert.throws(() => recordTransaction({
    label: 'x', affectedImageIds: ['a'], beforeByImage: null, afterByImage: null,
  }), /beforeByImage/);
});

// --- byte budget eviction --------------------------------------------------

test('byte budget: oldest entries evicted when total exceeds budget', () => {
  const img = makeImageState('a');
  getState().images.a = img;

  // Force a tiny budget so 3 cheap ops overflow.
  setByteBudget(200);

  for (let i = 0; i < 5; i++) {
    recordOp({
      label: `op${i}`, imageId: 'a', kind: 'transforms',
      // ~100 bytes per snapshot is plenty when budget = 200.
      before: { transforms: { rotate: i, crop: null, flipH: false, flipV: false, resize: null } },
      after:  { transforms: { rotate: i + 1, crop: null, flipH: false, flipV: false, resize: null } },
      sizeEstimate: 100,
    });
  }

  // 5 * 100 = 500 bytes > 200 budget. Some entries should have been evicted.
  const stats = getHistoryStats();
  assert.ok(stats.bytes <= stats.budget, 'bytes should be <= budget after eviction');
  assert.ok(stats.pastCount < 5, 'some entries should have been evicted');
});

test('byte budget: eviction drops from the front (oldest first)', () => {
  const img = makeImageState('a');
  getState().images.a = img;

  setByteBudget(150);

  // Three ops of 100 bytes each; budget 150 → only the newest should survive.
  recordOp({ label: 'first',  imageId: 'a', kind: 'transforms', before: {}, after: {}, sizeEstimate: 100 });
  recordOp({ label: 'middle', imageId: 'a', kind: 'transforms', before: {}, after: {}, sizeEstimate: 100 });
  recordOp({ label: 'last',   imageId: 'a', kind: 'transforms', before: {}, after: {}, sizeEstimate: 100 });

  const stats = getHistoryStats();
  assert.equal(stats.pastCount, 1);
});

test('setByteBudget: shrinking the budget evicts immediately', () => {
  const img = makeImageState('a');
  getState().images.a = img;

  for (let i = 0; i < 3; i++) {
    recordOp({
      label: `op${i}`, imageId: 'a', kind: 'transforms',
      before: { transforms: { rotate: i } }, after: { transforms: { rotate: i + 1 } },
      sizeEstimate: 1000,
    });
  }
  assert.equal(getHistoryStats().pastCount, 3);
  setByteBudget(1500);
  // After eviction, only the newest survives (oldest two = 2000 > 1500).
  assert.ok(getHistoryStats().pastCount <= 2);
});

// --- getHistoryStats / clearHistory ---------------------------------------

test('getHistoryStats: reports correct counts and bytes', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  recordOp({
    label: 'r1', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0 } }, after: { transforms: { rotate: 90 } },
    sizeEstimate: 42,
  });
  const s = getHistoryStats();
  assert.equal(s.pastCount, 1);
  assert.equal(s.futureCount, 0);
  assert.equal(s.bytes, 42);
  assert.equal(s.budget, 100 * 1024 * 1024);
});

test('clearHistory: resets past, future, bytes', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  recordOp({
    label: 'r1', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0 } }, after: { transforms: { rotate: 90 } },
  });
  undo();
  clearHistory();
  const s = getHistoryStats();
  assert.equal(s.pastCount, 0);
  assert.equal(s.futureCount, 0);
  assert.equal(s.bytes, 0);
});

// --- withHistory bracket helper -------------------------------------------

test('withHistory: captures before/after and records', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  withHistory('Rotate 90', 'a', 'transforms', ['transforms'], state => {
    state.images.a.transforms.rotate = 90;
  });
  assert.equal(getHistoryStats().pastCount, 1);
  // Undo should revert.
  undo();
  assert.equal(getState().images.a.transforms.rotate, 0);
});

test('withHistory: no-op edits (before deep-equals after) do not pollute history', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  withHistory('Noop', 'a', 'transforms', ['transforms'], _state => {
    // Don't change anything.
  });
  assert.equal(getHistoryStats().pastCount, 0);
});

test('withHistory: missing image is a no-op (no throw)', () => {
  withHistory('x', 'does-not-exist', 'transforms', ['transforms'], _state => {});
  assert.equal(getHistoryStats().pastCount, 0);
});

test('withHistory: image deleted mid-mutation skips recording', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  withHistory('x', 'a', 'transforms', ['transforms'], state => {
    delete state.images.a;
  });
  assert.equal(getHistoryStats().pastCount, 0);
});

// --- withBatchTransaction --------------------------------------------------

test('withBatchTransaction: captures all images and records once', () => {
  const a = makeImageState('a');
  const b = makeImageState('b');
  getState().images.a = a;
  getState().images.b = b;

  withBatchTransaction('Apply to all', ['a', 'b'], 'adjust', ['adjust'], state => {
    state.images.a.adjust.brightness = 20;
    state.images.b.adjust.brightness = 20;
  });

  assert.equal(getHistoryStats().pastCount, 1);
  undo();
  assert.equal(getState().images.a.adjust.brightness, 0);
  assert.equal(getState().images.b.adjust.brightness, 0);
});

test('withBatchTransaction: skips recording when nothing changed', () => {
  const a = makeImageState('a');
  const b = makeImageState('b');
  getState().images.a = a;
  getState().images.b = b;
  withBatchTransaction('Noop', ['a', 'b'], 'adjust', ['adjust'], _state => {
    // No mutation.
  });
  assert.equal(getHistoryStats().pastCount, 0);
});

test('withBatchTransaction: missing images are skipped without error', () => {
  const a = makeImageState('a');
  getState().images.a = a;
  withBatchTransaction('x', ['a', 'b'], 'adjust', ['adjust'], state => {
    state.images.a.adjust.brightness = 10;
  });
  // Recorded only against the surviving id.
  assert.equal(getHistoryStats().pastCount, 1);
  undo();
  assert.equal(getState().images.a.adjust.brightness, 0);
});

// --- estimateSize / snapshot helpers --------------------------------------

test('estimateSize: returns a positive number for typical adjust snapshots', () => {
  const s = estimateSize(
    { adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 } },
    { adjust: { brightness: 20, contrast: 0, saturation: 0, blur: 0 } },
  );
  assert.ok(s > 0);
});

test('estimateSize: counts typed-array byteLength', () => {
  const mask = new Uint8Array(1024);
  const before = { chromakeyMask: null };
  const after = { chromakeyMask: mask };
  const s = estimateSize(before, after);
  // Should include the 1024-byte mask + a few overhead bytes for the keys.
  assert.ok(s >= 1024);
});

test('pickKeys: clones nested objects (does not alias)', () => {
  const img = makeImageState('a');
  img.adjust.brightness = 50;
  const snap = pickKeys(img, ['adjust']);
  img.adjust.brightness = 99;
  // Snapshot should still see 50.
  assert.equal(snap.adjust.brightness, 50);
});

test('pickKeys: typed arrays held by reference (immutable)', () => {
  const img = makeImageState('a');
  const mask = new Uint8Array([1, 2, 3]);
  img.chromakeyMask = mask;
  const snap = pickKeys(img, ['chromakeyMask']);
  assert.strictEqual(snap.chromakeyMask, mask);
});

test('writeKeys: applies snapshot values onto image', () => {
  const img = makeImageState('a');
  const snap = { adjust: { brightness: 77, contrast: 0, saturation: 0, blur: 0 } };
  writeKeys(img, snap);
  assert.equal(img.adjust.brightness, 77);
});

// --- applyInverse invalidation flags --------------------------------------

test('undo on transforms op flips baseDirty (via invalidate TRANSFORMS)', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  img.transforms.rotate = 90;
  recordOp({
    label: 'r', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0, crop: null, flipH: false, flipV: false, resize: null } },
    after:  { transforms: { rotate: 90, crop: null, flipH: false, flipV: false, resize: null } },
  });
  // Reset dirty flag so we can observe the invalidate side effect.
  img.baseDirty = false;
  undo();
  assert.equal(getState().images.a.baseDirty, true);
});

test('undo on overlay op flips overlaysDirty (via invalidate OVERLAY)', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  img.overlays = [{ id: 'o1', type: 'text', x: 0, y: 0, text: 'hi' }];
  recordOp({
    label: 'add text', imageId: 'a', kind: 'overlay',
    before: { overlays: [] },
    after:  { overlays: [{ id: 'o1', type: 'text', x: 0, y: 0, text: 'hi' }] },
  });
  img.overlaysDirty = false;
  undo();
  assert.equal(getState().images.a.overlaysDirty, true);
});

test('undo on adjust op does NOT flip baseDirty (CSS filter path)', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  img.adjust.brightness = 50;
  recordOp({
    label: 'b', imageId: 'a', kind: 'adjust',
    before: { adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 }, filterPreset: 'none' },
    after:  { adjust: { brightness: 50, contrast: 0, saturation: 0, blur: 0 }, filterPreset: 'none' },
  });
  img.baseDirty = false;
  undo();
  // ADJUST invalidation maps to null target — no dirty flag flip.
  assert.equal(getState().images.a.baseDirty, false);
});

test('undo on chromakey op flips baseDirty (via invalidate CHROMAKEY)', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  img.chromakey = { hex: '#FF0000', tolerance: 25 };
  recordOp({
    label: 'ck', imageId: 'a', kind: 'chromakey',
    before: { chromakey: null, chromakeyMask: null },
    after:  { chromakey: { hex: '#FF0000', tolerance: 25 }, chromakeyMask: null },
  });
  img.baseDirty = false;
  undo();
  assert.equal(getState().images.a.baseDirty, true);
});

// --- deepEqual (internal) --------------------------------------------------

test('deepEqual: structurally equal objects compare equal', () => {
  assert.equal(__test__.deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), true);
});

test('deepEqual: typed arrays are compared by reference', () => {
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([1, 2]);
  assert.equal(__test__.deepEqual(a, b), false);
  assert.equal(__test__.deepEqual(a, a), true);
});

test('deepEqual: differing keys not equal', () => {
  assert.equal(__test__.deepEqual({ a: 1 }, { b: 1 }), false);
});

// --- subscribeHistory ------------------------------------------------------

test('subscribeHistory: fires after recordOp and exposes stats', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  let lastStats = null;
  const unsub = subscribeHistory(stats => { lastStats = stats; });
  recordOp({
    label: 'r', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0 } }, after: { transforms: { rotate: 90 } },
  });
  assert.ok(lastStats);
  assert.equal(lastStats.pastCount, 1);
  unsub();
});

test('subscribeHistory: unsub stops further notifications', () => {
  const img = makeImageState('a');
  getState().images.a = img;
  let count = 0;
  const unsub = subscribeHistory(() => { count++; });
  recordOp({
    label: 'r', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0 } }, after: { transforms: { rotate: 90 } },
  });
  unsub();
  recordOp({
    label: 'r2', imageId: 'a', kind: 'transforms',
    before: { transforms: { rotate: 0 } }, after: { transforms: { rotate: 45 } },
  });
  assert.equal(count, 1);
});
