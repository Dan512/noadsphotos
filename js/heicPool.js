// js/heicPool.js — coordinator for parallel HEIC decoding (v1.3).
//
// Mirrors the dedupe worker pool pattern from js/dedupe.js. Spawns a
// capped pool of classic Web Workers (libheif is UMD-only and needs
// importScripts, so module workers aren't viable here), then distributes
// decode work round-robin and aggregates per-item progress.
//
// Public API:
//   MAX_POOL_SIZE                     → numeric cap (4)
//   getHeicPool({ _factoryForTest })  → lazy spawn, returns { workers, size }
//   decodeHeicBatch(items, onProgress) → distribute, await all-done
//   _resetPool()                      → terminate + clear (tests / hot-reload)

// --- Worker pool -----------------------------------------------------------
//
// Cap at MAX_POOL_SIZE to avoid OOM on phones that claim many cores but
// have anemic memory. Each worker has its own libheif WASM instance, so
// they truly decode in parallel; the main thread just buckets items.
export const MAX_POOL_SIZE = 4;
let workerPool = null;

/**
 * Lazily spawn (or return the cached) HEIC worker pool.
 *
 * Pool size = clamp(hardwareConcurrency, 1, MAX_POOL_SIZE), defaulting
 * to 2 when navigator.hardwareConcurrency is unknown (older Safari).
 *
 * @param {{ _factoryForTest?: (i: number) => { postMessage: Function, terminate: Function } }} [opts]
 *   Test hook — when present, called once per slot instead of `new Worker(...)`.
 *   Lets unit tests exercise the coordinator without spawning real workers.
 * @returns {{ workers: Array, size: number }}
 */
export function getHeicPool({ _factoryForTest } = {}) {
  if (workerPool) return workerPool;
  const hc = (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency))
    ? navigator.hardwareConcurrency
    : 2;
  const size = Math.max(1, Math.min(MAX_POOL_SIZE, hc));
  const workers = [];
  for (let i = 0; i < size; i++) {
    if (_factoryForTest) {
      workers.push(_factoryForTest(i));
    } else {
      // Classic worker — libheif is UMD-only and needs importScripts.
      // Resolve relative to this module's URL so it works under any base.
      const url = new URL('./workers/heicWorker.js', import.meta.url);
      workers.push(new Worker(url));
    }
  }
  workerPool = { workers, size };
  return workerPool;
}

// --- Public API -----------------------------------------------------------

/**
 * Decode an array of HEIC items in parallel across the worker pool.
 *
 * Items are bucketed round-robin across `pool.size` workers. Each item's
 * raw ArrayBuffer is *transferred* (not copied) into its worker, which
 * keeps the main thread heap free of multi-MB HEIC blobs during decode.
 * Per-item failures are recorded as `{ error }` in the result Map rather
 * than rejecting the whole batch — one corrupt file shouldn't poison the
 * other 99 in an import.
 *
 * Empty `items` returns immediately without touching the pool (no spawn).
 *
 * @param {Array<{id: string, arrayBuffer: ArrayBuffer}>} items
 * @param {(msg: {done: number, total: number}) => void} [onProgress]
 *   Called once per item completion (success or per-item error).
 * @param {(id: string, result: any) => void} [onResult]
 *   Per-item streaming callback. Fires as each worker reports a result
 *   (success or `{ error }`) so callers can begin post-decode work on a
 *   file while other workers are still decoding. The callback is wrapped
 *   in try/catch so a buggy callback can't crash the batch.
 * @returns {Promise<Map<string, {data: Uint8ClampedArray, width: number, height: number, pngBlob: Blob | null} | {error: string}>>}
 *   Success entries include `pngBlob` — a worker-encoded PNG (via
 *   OffscreenCanvas.convertToBlob) so the main thread can skip the
 *   re-encode + re-decode round-trip. `pngBlob` is null if the worker
 *   encode failed; callers should fall back to encoding from `data` themselves.
 */
export async function decodeHeicBatch(items, onProgress = () => {}, onResult = () => {}) {
  if (!items || items.length === 0) return new Map();
  const pool = workerPool || getHeicPool();
  const { workers, size } = pool;
  const total = items.length;
  let done = 0;
  const results = new Map();

  // Bucket items round-robin so workers stay roughly balanced regardless
  // of file-size variance within the batch.
  const buckets = Array.from({ length: size }, () => []);
  items.forEach((item, i) => buckets[i % size].push(item));

  // Fire onResult for an id we just stored — wrapped so a misbehaving
  // callback can't crash the whole batch (and so one bad file's callback
  // doesn't poison the others).
  const fireOnResult = (id) => {
    try {
      onResult(id, results.get(id));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('heicPool: onResult callback threw for', id, err);
    }
  };

  // Per-worker promise. ArrayBuffers are transferable, so we transfer
  // them to avoid copying the (potentially 10+ MB) raw HEIC bytes.
  const workerPromises = workers.map((worker, i) => new Promise((resolve, reject) => {
    const bucket = buckets[i];
    if (bucket.length === 0) { resolve(); return; }
    worker.onmessage = (e) => {
      const { type } = e.data;
      if (type === 'progress') {
        // Attach the worker-encoded PNG (or null) to the imageData entry so
        // the main thread can skip its re-encode pass when present.
        const entry = e.data.imageData;
        if (entry && typeof entry === 'object') {
          entry.pngBlob = e.data.pngBlob ?? null;
        }
        results.set(e.data.id, entry);
        done++;
        onProgress({ done, total });
        fireOnResult(e.data.id);
      } else if (type === 'error') {
        // Per-item failure: record + count as done so progress can complete.
        // A worker-fatal failure surfaces via onerror instead.
        results.set(e.data.id, { error: e.data.error });
        done++;
        onProgress({ done, total });
        fireOnResult(e.data.id);
      } else if (type === 'done') {
        resolve();
      }
    };
    worker.onerror = (err) => reject(new Error('heicPool: worker error: ' + (err.message || 'unknown')));
    const transfer = bucket.map(it => it.arrayBuffer);
    worker.postMessage({ type: 'decode', items: bucket }, transfer);
  }));

  await Promise.all(workerPromises);
  return results;
}

/**
 * Terminate all workers and drop the cached pool. Next getHeicPool()
 * or decodeHeicBatch() call respawns. Safe to call when no pool exists.
 */
export function _resetPool() {
  if (workerPool) {
    for (const w of workerPool.workers) {
      try { w.terminate(); } catch { /* ignore */ }
    }
    workerPool = null;
  }
}
