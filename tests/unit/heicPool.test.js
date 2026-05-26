// tests/unit/heicPool.test.js — coordinator tests for v1.3 parallel HEIC decode.
//
// Covers:
//   - getHeicPool() respects MAX_POOL_SIZE cap (4) even when hwc is large.
//   - getHeicPool() respects hwc when below cap.
//   - getHeicPool() falls back to 2 when hwc is unknown.
//   - decodeHeicBatch() round-robin distributes items across the pool,
//     aggregates per-item progress, resolves to a keyed result Map.
//
// Workers are stubbed via the `_factoryForTest` hook so the suite never
// spawns real Web Workers (Node test env has no Worker constructor).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetPool,
  getHeicPool,
  decodeHeicBatch,
  MAX_POOL_SIZE,
} from '../../js/heicPool.js';

// Node 20+ exposes a built-in `globalThis.navigator` as a read-only
// accessor, so plain assignment throws "has only a getter". Use
// defineProperty so each test can install its own stub.
function setNavigator(stub) {
  Object.defineProperty(globalThis, 'navigator', {
    value: stub,
    configurable: true,
    writable: true,
  });
}

test('heicPool: getHeicPool() respects MAX_POOL_SIZE cap', () => {
  setNavigator({ hardwareConcurrency: 16 });
  _resetPool();
  const pool = getHeicPool({ _factoryForTest: () => ({ postMessage: () => {}, terminate: () => {} }) });
  assert.equal(pool.size, MAX_POOL_SIZE);
  assert.equal(pool.size, 4);
  _resetPool();
});

test('heicPool: getHeicPool() respects hardware concurrency when below cap', () => {
  setNavigator({ hardwareConcurrency: 2 });
  _resetPool();
  const pool = getHeicPool({ _factoryForTest: () => ({ postMessage: () => {}, terminate: () => {} }) });
  assert.equal(pool.size, 2);
  _resetPool();
});

test('heicPool: getHeicPool() falls back to 2 when hardware concurrency unknown', () => {
  setNavigator({});
  _resetPool();
  const pool = getHeicPool({ _factoryForTest: () => ({ postMessage: () => {}, terminate: () => {} }) });
  assert.equal(pool.size, 2);
  _resetPool();
});

test('heicPool: decodeHeicBatch distributes items round-robin across workers', async () => {
  setNavigator({ hardwareConcurrency: 4 });
  _resetPool();
  const assignments = [[], [], [], []];
  const factory = (i) => ({
    postMessage(msg) {
      // Capture which IDs this worker received, then asynchronously
      // post progress + done.
      const items = msg.items;
      assignments[i].push(...items.map(it => it.id));
      queueMicrotask(() => {
        for (const it of items) {
          this.onmessage({ data: { type: 'progress', id: it.id, imageData: { width: 10, height: 10, data: new Uint8ClampedArray(400) } } });
        }
        this.onmessage({ data: { type: 'done' } });
      });
    },
    terminate() {},
  });
  getHeicPool({ _factoryForTest: factory });
  const items = Array.from({ length: 10 }, (_, n) => ({ id: 'i' + n, arrayBuffer: new ArrayBuffer(8) }));
  const progressEvents = [];
  const results = await decodeHeicBatch(items, (msg) => progressEvents.push(msg), () => {});
  assert.equal(results.size, 10);
  // Round-robin: 10 items across 4 workers → 3,3,2,2
  assert.deepEqual(assignments.map(a => a.length), [3, 3, 2, 2]);
  // Progress callback fires once per item
  assert.equal(progressEvents.length, 10);
  // Final progress event reports done=total
  assert.equal(progressEvents[progressEvents.length - 1].done, 10);
  assert.equal(progressEvents[progressEvents.length - 1].total, 10);
  _resetPool();
});

test('heicPool: decodeHeicBatch propagates worker-encoded pngBlob to result entries', async () => {
  // v1.3 fix: the worker encodes the decoded pixels to a PNG Blob with
  // OffscreenCanvas.convertToBlob and posts it alongside the imageData so
  // the main thread can skip its own re-encode pass. The pool must
  // surface that pngBlob on the result Map entry. When the worker can't
  // encode (pngBlob: null or omitted), the entry should still be a valid
  // success record — main thread falls back to encoding itself.
  setNavigator({ hardwareConcurrency: 2 });
  _resetPool();
  const fakeBlob = new Blob(['fake-png'], { type: 'image/png' });
  const factory = () => ({
    postMessage(msg) {
      const items = msg.items;
      queueMicrotask(() => {
        items.forEach((it, idx) => {
          // First item per worker gets a real pngBlob; second gets null
          // (simulating worker encode failure on that file).
          this.onmessage({
            data: {
              type: 'progress',
              id: it.id,
              imageData: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
              pngBlob: idx === 0 ? fakeBlob : null,
            },
          });
        });
        this.onmessage({ data: { type: 'done' } });
      });
    },
    terminate() {},
  });
  getHeicPool({ _factoryForTest: factory });
  const items = Array.from({ length: 4 }, (_, n) => ({ id: 'p' + n, arrayBuffer: new ArrayBuffer(8) }));
  const results = await decodeHeicBatch(items, () => {}, () => {});
  assert.equal(results.size, 4);
  // Round-robin with 4 items across 2 workers: worker 0 sees [p0, p2],
  // worker 1 sees [p1, p3]. First-per-worker (p0, p1) get the real blob;
  // second-per-worker (p2, p3) get null.
  assert.equal(results.get('p0').pngBlob, fakeBlob);
  assert.equal(results.get('p1').pngBlob, fakeBlob);
  assert.equal(results.get('p2').pngBlob, null);
  assert.equal(results.get('p3').pngBlob, null);
  // imageData fields still intact
  assert.equal(results.get('p0').width, 2);
  assert.equal(results.get('p0').height, 2);
  _resetPool();
});

test('heicPool: decodeHeicBatch records per-item error and continues batch', async () => {
  // Validates the `{ type: 'error', id, error }` branch in the worker
  // onmessage handler: one bad file shouldn't poison the rest of the
  // batch, and the result Map should carry an { error } sentinel for
  // each failed id while progress still completes to done=total.
  setNavigator({ hardwareConcurrency: 2 });
  _resetPool();
  const factory = () => ({
    postMessage(msg) {
      const items = msg.items;
      queueMicrotask(() => {
        for (const it of items) {
          // First item the worker sees errors; remaining items succeed.
          // With 4 items across 2 workers (round-robin), worker 0 gets
          // [x0, x2] and worker 1 gets [x1, x3], so x0 and x1 error
          // while x2 and x3 succeed.
          if (items.indexOf(it) === 0) {
            this.onmessage({ data: { type: 'error', id: it.id, error: 'bad heic' } });
          } else {
            this.onmessage({ data: { type: 'progress', id: it.id, imageData: { width: 1, height: 1, data: new Uint8ClampedArray(4) } } });
          }
        }
        this.onmessage({ data: { type: 'done' } });
      });
    },
    terminate() {},
  });
  getHeicPool({ _factoryForTest: factory });
  const items = Array.from({ length: 4 }, (_, n) => ({ id: 'x' + n, arrayBuffer: new ArrayBuffer(8) }));
  const events = [];
  const results = await decodeHeicBatch(items, (m) => events.push(m), () => {});
  assert.equal(results.size, 4);
  assert.ok(results.get('x0').error, 'x0 should be an error result');
  assert.ok(results.get('x1').error, 'x1 should be an error result');
  assert.equal(results.get('x0').error, 'bad heic');
  assert.ok(results.get('x2') && results.get('x2').width === 1, 'x2 should be a successful imageData');
  assert.ok(results.get('x3') && results.get('x3').width === 1, 'x3 should be a successful imageData');
  // Per-item errors count toward progress so the bar can complete.
  assert.equal(events.length, 4);
  assert.equal(events[events.length - 1].done, 4);
  assert.equal(events[events.length - 1].total, 4);
  _resetPool();
});

test('heicPool: decodeHeicBatch fires onResult per-item as workers complete', async () => {
  // v1.3 streaming pipeline: the importer needs each per-file result the
  // moment a worker reports it, so post-decode (thumbnail, queue add) can
  // run on a file while other workers are still decoding. Without this,
  // the user sees a long "Decoding" pause and then all thumbnails pop in
  // at once. With it, the first thumbnail appears as soon as the first
  // worker's first file decodes.
  setNavigator({ hardwareConcurrency: 2 });
  _resetPool();
  const factory = () => ({
    postMessage(msg) {
      const items = msg.items;
      queueMicrotask(() => {
        items.forEach((it, idx) => {
          if (idx === 0) {
            // First per-worker item errors, exercising the error branch
            // of fireOnResult().
            this.onmessage({ data: { type: 'error', id: it.id, error: 'bad heic' } });
          } else {
            this.onmessage({
              data: {
                type: 'progress',
                id: it.id,
                imageData: { width: 3, height: 3, data: new Uint8ClampedArray(36) },
              },
            });
          }
        });
        this.onmessage({ data: { type: 'done' } });
      });
    },
    terminate() {},
  });
  getHeicPool({ _factoryForTest: factory });
  const items = Array.from({ length: 4 }, (_, n) => ({ id: 'r' + n, arrayBuffer: new ArrayBuffer(8) }));
  const streamed = [];
  await decodeHeicBatch(items, () => {}, (id, result) => streamed.push({ id, result }));
  // One callback per item — same count as the result Map.
  assert.equal(streamed.length, 4);
  // Each streamed entry has the id and either imageData or an error sentinel.
  assert.ok(streamed.every(s => s.id && (s.result.data || s.result.error)),
    'each streamed entry should carry an id and a result shape');
  // Each id is reported exactly once.
  const ids = new Set(streamed.map(s => s.id));
  assert.equal(ids.size, 4);
  _resetPool();
});
