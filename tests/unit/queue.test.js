import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getState, subscribe } from '../../js/state.js';
import {
  addImage, removeImage, reorder, setActive,
  getActiveId, getActive, getQueue, getImage, createId,
} from '../../js/queue.js';

// Build a minimal ImageState. queue.js does not care about the inner shape
// — it only needs a string `id` — but we use the design-doc shape so tests
// double as documentation of what callers will pass.
function makeImageState(id, partial = {}) {
  return {
    id,
    source: { blob: null, name: `${id}.png`, type: 'image/png', width: 10, height: 10, thumbnail: null, bitmap: null },
    transforms: { crop: null, rotate: 0, flipH: false, flipV: false, resize: null },
    adjust: { brightness: 0, contrast: 0, saturation: 0, blur: 0 },
    filterPreset: null, chromakey: null, bgRemoved: false, bgMask: null,
    overlays: [],
    baseDirty: true, overlaysDirty: true,
    ...partial,
  };
}

// Reset module-level state between tests, same approach as state.test.js.
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
});

// -- addImage --------------------------------------------------------------

test('addImage: adds id to state.queue and stores in state.images', () => {
  const img = makeImageState('a');
  addImage(img);
  const s = getState();
  assert.deepEqual(s.queue, ['a']);
  assert.strictEqual(s.images['a'], img);
});

test('addImage: idempotent — adding the same id twice does not duplicate', () => {
  const img = makeImageState('a');
  addImage(img);
  addImage(img);
  assert.deepEqual(getState().queue, ['a']);
});

test('addImage: throws if imageState lacks a string id', () => {
  assert.throws(() => addImage(null),         /string id/);
  assert.throws(() => addImage({}),           /string id/);
  assert.throws(() => addImage({ id: 123 }),  /string id/);
});

// -- removeImage -----------------------------------------------------------

test('removeImage: removes from queue and images', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  removeImage('a');
  const s = getState();
  assert.deepEqual(s.queue, ['b']);
  assert.equal('a' in s.images, false);
});

test('removeImage of the active image advances activeImageId to next', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  addImage(makeImageState('c'));
  setActive('b');
  removeImage('b');
  assert.equal(getState().ui.activeImageId, 'c');
});

test('removeImage of the active tail advances activeImageId to previous', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  setActive('b');
  removeImage('b');
  assert.equal(getState().ui.activeImageId, 'a');
});

test('removeImage of the last remaining active image sets activeImageId to null', () => {
  addImage(makeImageState('a'));
  setActive('a');
  removeImage('a');
  assert.equal(getState().ui.activeImageId, null);
});

test('removeImage of a non-active image leaves activeImageId unchanged', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  setActive('a');
  removeImage('b');
  assert.equal(getState().ui.activeImageId, 'a');
});

test('removeImage of an unknown id is a no-op (does not throw)', () => {
  addImage(makeImageState('a'));
  assert.doesNotThrow(() => removeImage('nope'));
  assert.deepEqual(getState().queue, ['a']);
});

// -- reorder ---------------------------------------------------------------

test('reorder(0, 2) moves the first image to position 2', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  addImage(makeImageState('c'));
  reorder(0, 2);
  assert.deepEqual(getState().queue, ['b', 'c', 'a']);
});

test('reorder(2, 0) moves the last image to the front', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  addImage(makeImageState('c'));
  reorder(2, 0);
  assert.deepEqual(getState().queue, ['c', 'a', 'b']);
});

test('reorder out-of-bounds throws RangeError', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  assert.throws(() => reorder(0, 5),  RangeError);
  assert.throws(() => reorder(-1, 1), RangeError);
  assert.throws(() => reorder(0, -1), RangeError);
  assert.throws(() => reorder(5, 0),  RangeError);
});

// -- setActive / getActiveId / getActive -----------------------------------

test('setActive updates state.ui.activeImageId', () => {
  addImage(makeImageState('a'));
  setActive('a');
  assert.equal(getState().ui.activeImageId, 'a');
  assert.equal(getActiveId(), 'a');
});

test('setActive to an unknown id throws', () => {
  addImage(makeImageState('a'));
  assert.throws(() => setActive('zzz'), /unknown image id/);
});

test('setActive(null) clears the active image', () => {
  addImage(makeImageState('a'));
  setActive('a');
  setActive(null);
  assert.equal(getActiveId(), null);
});

test('getActive returns the image state when active is set; null otherwise', () => {
  assert.equal(getActive(), null);
  const img = makeImageState('a');
  addImage(img);
  setActive('a');
  assert.strictEqual(getActive(), img);
  setActive(null);
  assert.equal(getActive(), null);
});

// -- getQueue / getImage ---------------------------------------------------

test('getQueue returns a copy — mutating the result does not affect state', () => {
  addImage(makeImageState('a'));
  addImage(makeImageState('b'));
  const q = getQueue();
  q.push('hacked');
  q[0] = 'overwritten';
  assert.deepEqual(getState().queue, ['a', 'b']);
});

test('getImage(unknown) returns null', () => {
  assert.equal(getImage('nope'), null);
});

test('getImage(known) returns the stored image state', () => {
  const img = makeImageState('a');
  addImage(img);
  assert.strictEqual(getImage('a'), img);
});

// -- createId --------------------------------------------------------------

test('createId returns distinct strings on consecutive calls', () => {
  const a = createId();
  const b = createId();
  const c = createId();
  assert.equal(typeof a, 'string');
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

// -- subscriber notifications ----------------------------------------------

test('addImage, removeImage, setActive, reorder all fire subscribers', () => {
  let count = 0;
  const unsub = subscribe(() => { count++; });
  try {
    addImage(makeImageState('a'));
    assert.equal(count, 1);
    addImage(makeImageState('b'));
    assert.equal(count, 2);
    setActive('a');
    assert.equal(count, 3);
    reorder(0, 1);
    assert.equal(count, 4);
    removeImage('a');
    assert.equal(count, 5);
  } finally {
    unsub();
  }
});
