import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getState, subscribe, update } from '../../js/state.js';

// Reset state and clear subscribers between tests. The state object is
// module-level and shared across tests, so we mutate it back to a known shape.
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

test('getState returns the same object reference on every call', () => {
  assert.strictEqual(getState(), getState());
});

test('initial shape: ui.view is "queue"', () => {
  assert.equal(getState().ui.view, 'queue');
});

test('initial shape: queue is an empty array', () => {
  const q = getState().queue;
  assert.equal(Array.isArray(q), true);
  assert.equal(q.length, 0);
});

test('initial shape: images object exists (null-prototype, no inherited methods)', () => {
  const images = getState().images;
  assert.equal(typeof images, 'object');
  assert.equal(images !== null, true);
  // Object.create(null) → no prototype, so no hasOwnProperty etc.
  assert.equal(Object.getPrototypeOf(images), null);
});

test('initial shape: export.format is "png"', () => {
  assert.equal(getState().export.format, 'png');
});

test('subscribe + update: subscriber fires with state on update', () => {
  let received = null;
  const unsub = subscribe(s => { received = s; });
  update(s => { s.ui.view = 'editor'; });
  assert.strictEqual(received, getState());
  assert.equal(getState().ui.view, 'editor');
  unsub();
});

test('unsubscribe: returned function removes the subscription', () => {
  let count = 0;
  const unsub = subscribe(() => { count++; });
  update(s => { s.ui.view = 'editor'; });
  assert.equal(count, 1);
  unsub();
  update(s => { s.ui.view = 'queue'; });
  assert.equal(count, 1);
});

test('multiple subscribers: both fire on update (order not asserted)', () => {
  let aFired = false;
  let bFired = false;
  const unsubA = subscribe(() => { aFired = true; });
  const unsubB = subscribe(() => { bFired = true; });
  update(s => { s.ui.view = 'editor'; });
  assert.equal(aFired, true);
  assert.equal(bFired, true);
  unsubA();
  unsubB();
});

test('update: mutator and subscriber both receive the same state reference', () => {
  let mutatorArg = null;
  let subscriberArg = null;
  const unsub = subscribe(s => { subscriberArg = s; });
  update(s => { mutatorArg = s; });
  assert.strictEqual(mutatorArg, getState());
  assert.strictEqual(subscriberArg, getState());
  assert.strictEqual(mutatorArg, subscriberArg);
  unsub();
});

test('update: mutation is visible in state after update returns (no immutable copy)', () => {
  update(s => { s.ui.activeTool = 'crop'; });
  assert.equal(getState().ui.activeTool, 'crop');
  update(s => { s.queue.push('img-1'); });
  assert.equal(getState().queue.length, 1);
  assert.equal(getState().queue[0], 'img-1');
});
