// js/dedupe.js — coordinator for v1.2 Feature 7: find & remove duplicates.
//
// Bridges state.js + the dedupeWorker. Provides the public API the batch
// panel and shortcuts.js call.
//
// Flow:
//   findDuplicates({ onProgress }) :
//     1. Gather (id, sourceBlob, thumbBlob) for every queue item that
//        doesn't already have a cached hash.
//     2. Spawn dedupeWorker (lazily — first-use) and post the batch.
//     3. Stream progress events back to onProgress({ done, total }).
//     4. When worker completes, run clusterByDHash + groupBySha256 on the
//        combined hash set (cached + newly computed).
//     5. Pick keepers, build state.dedupe.{clusters, markedIds, ...},
//        reorder state.queue, set state.dedupe.active = true.
//     6. Return summary { clusters: [...], totalMarked, total }.
//
//   cancelFindMode() :
//     Restore state.queue to preFindOrder. Reset state.dedupe.
//
//   removeMarkedDuplicates() :
//     Delete every id in state.dedupe.markedIds from state.images and
//     state.queue. Clear state.dedupe. Returns the snapshot used for
//     toast-undo (the caller of this function shows the toast).
//
//   restoreRemoved(snapshot) :
//     Re-add the removed images to state.images and state.queue at their
//     previous positions. Re-enter find-mode with the same clusters.

import { getState, update } from './state.js';
import {
  groupBySha256,
  clusterByPerceptual,
  pickKeeper,
  reorderQueueByCluster,
  thresholdFor,
} from './ops/dedupe.js';

// --- Worker pool -----------------------------------------------------------
//
// v1.2.x: parallel hashing across navigator.hardwareConcurrency workers
// (capped at MAX_POOL_SIZE to avoid OOM on phones with claimed-but-anemic
// cores). Each worker has its own ORT-free WASM/canvas context so they
// run truly in parallel; the main thread distributes items round-robin
// and waits for all workers to drain.
//
// GitHub Pages compatibility: no SharedArrayBuffer needed (workers
// communicate purely via postMessage), so no COOP/COEP requirements.
const MAX_POOL_SIZE = 4;
let workerPool = null;

// Snapshot of the MOST RECENT removeMarkedDuplicates() call, retained so
// the global Ctrl+Z handler can restore. Cleared when:
//   - restoreRemoved() runs (the user already restored, either via the
//     toast Undo or via Ctrl+Z itself)
//   - findDuplicates() runs again (new context invalidates old snapshot)
//   - the queue is otherwise mutated (e.g. user removes an image
//     individually; the snapshot's queue positions are no longer valid)
// Only ONE snapshot is kept — we don't try to model a multi-level dedupe
// undo stack, because subsequent removes are typically against newly
// added images and the user can always re-import.
let lastRemoveSnapshot = null;

function getWorkerPool() {
  if (workerPool) return workerPool;
  // Pick pool size: respect navigator.hardwareConcurrency but cap at
  // MAX_POOL_SIZE to avoid runaway memory on phones. Default to 2 if
  // the global isn't available (older Safari).
  const hc = (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency))
    ? navigator.hardwareConcurrency : 2;
  const size = Math.max(1, Math.min(MAX_POOL_SIZE, hc));
  const workers = [];
  for (let i = 0; i < size; i++) {
    const url = new URL('./workers/dedupeWorker.js', import.meta.url);
    workers.push(new Worker(url, { type: 'module' }));
  }
  workerPool = { workers, size };
  return workerPool;
}

/**
 * Terminate all workers (for tests / hot reload). Safe to call when the
 * pool doesn't exist. Next findDuplicates() respawns.
 */
export function _resetWorker() {
  if (workerPool) {
    for (const w of workerPool.workers) {
      try { w.terminate(); } catch { /* ignore */ }
    }
    workerPool = null;
  }
}

// --- Public API -----------------------------------------------------------

/**
 * Run the find-duplicates flow. Returns when find-mode is fully entered
 * (or no clusters were found).
 *
 * Skips items whose hashes are already cached on the image (via prior
 * find-runs in the same session). For typical "rerun at a different
 * sensitivity" flows this means the worker step is a no-op.
 *
 * @param {{ onProgress?: (msg: {done: number, total: number}) => void }} [opts]
 * @returns {Promise<{
 *   clusters: Array<{ id: string, memberIds: string[], keeperIds: string[] }>,
 *   totalMarked: number,
 *   total: number,
 * }>}
 */
export async function findDuplicates(opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // If a previous find-mode is active, exit it first so we re-cluster
  // from the saved pre-find order (not from the reordered queue).
  if (getState().dedupe.active) {
    cancelFindMode();
  }
  // Any prior removal snapshot is moot now — a new find/remove cycle is
  // about to start.
  lastRemoveSnapshot = null;

  const s = getState();
  const queueIds = s.queue.slice();
  if (queueIds.length === 0) {
    return { clusters: [], totalMarked: 0, total: 0 };
  }

  // 1. Hash any items missing a cached hash.
  const toHash = [];
  for (const id of queueIds) {
    const img = s.images[id];
    if (!img) continue;
    if (img._hashes && img._hashes.sha256 && img._hashes.dhash && img._hashes.phash) continue;
    const sourceBlob = (img.source && img.source.blob) || null;
    const thumbBlob  = (img.source && img.source.thumbnail) || sourceBlob;
    if (!sourceBlob) continue; // skip images without source bytes
    toHash.push({ id, sourceBlob, thumbBlob });
  }
  if (toHash.length > 0) {
    await runWorkerHash(toHash, onProgress);
  } else {
    onProgress({ done: 0, total: 0 });
  }

  // 2. Build the hash list from cached _hashes.
  const items = [];
  for (const id of queueIds) {
    const img = s.images[id];
    const h = img && img._hashes;
    if (!h) continue;
    items.push({ id, sha256: h.sha256, dhash: h.dhash, phash: h.phash });
  }

  // 3. Cluster: exact first, then perceptual on the unmatched.
  const exactGroups = groupBySha256(items);
  const exactlyMatched = new Set();
  for (const grp of exactGroups) for (const id of grp) exactlyMatched.add(id);

  const remainingItems = items.filter(it => !exactlyMatched.has(it.id));
  const threshold = thresholdFor(s.dedupe.sensitivity);
  const perceptualGroups = clusterByPerceptual(remainingItems, threshold);

  const allGroups = exactGroups.concat(perceptualGroups);
  if (allGroups.length === 0) {
    return { clusters: [], totalMarked: 0, total: queueIds.length };
  }

  // 4. Pick keepers for each cluster.
  const getMeta = (id) => {
    const img = s.images[id];
    if (!img) return { pixelCount: 0, byteSize: 0, queuePosition: Number.MAX_SAFE_INTEGER };
    const w = (img.source && img.source.width)  || 0;
    const h = (img.source && img.source.height) || 0;
    const bytes = (img.source && img.source.blob && img.source.blob.size) || 0;
    const qPos = queueIds.indexOf(id);
    return { pixelCount: w * h, byteSize: bytes, queuePosition: qPos < 0 ? Number.MAX_SAFE_INTEGER : qPos };
  };

  let clusterCounter = 0;
  const clusters = allGroups.map(memberIds => {
    const keeperId = pickKeeper(memberIds, getMeta);
    return {
      id: `c${++clusterCounter}`,
      memberIds: memberIds.slice(),
      keeperIds: keeperId ? [keeperId] : [],
    };
  });

  // 5. Initial markedIds = every non-keeper across clusters.
  const markedIds = [];
  const keeperSet = new Set();
  for (const c of clusters) for (const k of c.keeperIds) keeperSet.add(k);
  for (const c of clusters) {
    for (const m of c.memberIds) {
      if (!keeperSet.has(m)) markedIds.push(m);
    }
  }

  // 6. Build the reordered queue + commit state.dedupe.
  const newOrder = reorderQueueByCluster(queueIds, allGroups, keeperSet);

  update(state => {
    state.dedupe.active        = true;
    state.dedupe.clusters      = clusters;
    state.dedupe.markedIds     = markedIds;
    state.dedupe.preFindOrder  = queueIds.slice(); // snapshot for cancel
    state.queue                = newOrder;
  });

  return { clusters, totalMarked: markedIds.length, total: queueIds.length };
}

/**
 * Exit find-mode without removing anything. Restores queue order.
 */
export function cancelFindMode() {
  const s = getState();
  if (!s.dedupe.active) return;
  const orig = s.dedupe.preFindOrder ? s.dedupe.preFindOrder.slice() : null;
  update(state => {
    if (orig) state.queue = orig;
    state.dedupe.active       = false;
    state.dedupe.clusters     = [];
    state.dedupe.markedIds    = [];
    state.dedupe.preFindOrder = null;
  });
}

/**
 * Toggle a single id's marked state. Cosmetic — does NOT record history.
 * The "Remove duplicates (N)" button count updates via state subscribers.
 */
export function toggleMarked(id) {
  if (!id) return;
  update(state => {
    const arr = state.dedupe.markedIds;
    const i = arr.indexOf(id);
    if (i === -1) arr.push(id);
    else          arr.splice(i, 1);
  });
}

/**
 * Set the sensitivity preset. Caller is expected to re-run findDuplicates
 * if find-mode is currently active and they want to re-cluster.
 */
export function setSensitivity(level) {
  update(state => {
    state.dedupe.sensitivity = (level === 'strict' || level === 'loose') ? level : 'normal';
  });
}

/**
 * Remove every marked id from state.images and state.queue. Returns a
 * snapshot the caller can pass to restoreRemoved() within a short window
 * (the UI typically wraps this with a 15-second "Undo" toast).
 *
 * @returns {{
 *   removed: Array<{ id: string, image: object, queuePosition: number }>,
 *   clusters: Array<{ id: string, memberIds: string[], keeperIds: string[] }>,
 *   preFindOrder: string[] | null,
 * }}
 */
export function removeMarkedDuplicates() {
  const s = getState();
  if (!s.dedupe.active) return { removed: [], clusters: [], preFindOrder: null };

  // Snapshot the marked image state + their positions in CURRENT queue
  // (the reordered one). On restore we'll re-insert at the same positions.
  const removed = [];
  const markedSet = new Set(s.dedupe.markedIds);
  for (let i = 0; i < s.queue.length; i++) {
    const id = s.queue[i];
    if (!markedSet.has(id)) continue;
    const img = s.images[id];
    if (!img) continue;
    removed.push({ id, image: img, queuePosition: i });
  }

  const snapshot = {
    removed,
    clusters: s.dedupe.clusters.map(c => ({ id: c.id, memberIds: c.memberIds.slice(), keeperIds: c.keeperIds.slice() })),
    preFindOrder: s.dedupe.preFindOrder ? s.dedupe.preFindOrder.slice() : null,
  };

  // Perform the removal + exit find-mode. The queue order stays whatever
  // it was post-find with the marked items spliced out (we DON'T revert
  // to preFindOrder — the user just explicitly removed, so restoring the
  // original order on top of that would feel like un-doing the action).
  update(state => {
    for (const r of removed) {
      delete state.images[r.id];
    }
    state.queue = state.queue.filter(id => state.images[id]);
    state.dedupe.active       = false;
    state.dedupe.clusters     = [];
    state.dedupe.markedIds    = [];
    state.dedupe.preFindOrder = null;

    // If the active image was just removed, pick a sane fallback.
    if (state.ui.activeImageId && !state.images[state.ui.activeImageId]) {
      state.ui.activeImageId = state.queue.length > 0 ? state.queue[0] : null;
    }
  });

  // Stash for the global Ctrl+Z handler. The 15s toast Undo also uses
  // the snapshot returned from this function — whoever calls restore
  // first wins; the other clears the stash via restoreRemoved().
  lastRemoveSnapshot = snapshot;

  return snapshot;
}

/**
 * Read-only check: does dedupe have a removal that Ctrl+Z can restore?
 * Used by the global shortcut handler in shortcuts.js.
 */
export function hasUndoableRemove() {
  return lastRemoveSnapshot !== null
      && Array.isArray(lastRemoveSnapshot.removed)
      && lastRemoveSnapshot.removed.length > 0;
}

/**
 * Pop the stashed snapshot and call restoreRemoved on it. Returns true
 * if anything was restored. Called from the Ctrl+Z handler in shortcuts.js.
 */
export function undoLastRemove() {
  if (!hasUndoableRemove()) return false;
  const snap = lastRemoveSnapshot;
  lastRemoveSnapshot = null;
  restoreRemoved(snap);
  return true;
}

/**
 * Restore a snapshot produced by removeMarkedDuplicates(). Re-inserts the
 * images into state.images and state.queue at their original positions,
 * then re-enters find-mode with the same clusters.
 */
export function restoreRemoved(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.removed) || snapshot.removed.length === 0) return;
  // Whoever calls restore first wins — clear the stash so Ctrl+Z doesn't
  // also fire (and so a subsequent toast click is a no-op).
  if (lastRemoveSnapshot === snapshot) {
    lastRemoveSnapshot = null;
  }
  update(state => {
    // Re-add to images.
    for (const r of snapshot.removed) {
      state.images[r.id] = r.image;
    }
    // Splice back into queue at original positions. Sort ascending so
    // earlier indices are inserted first (later positions are stable
    // because the queue grows as we go).
    const ordered = snapshot.removed.slice().sort((a, b) => a.queuePosition - b.queuePosition);
    for (const r of ordered) {
      const pos = Math.max(0, Math.min(state.queue.length, r.queuePosition));
      state.queue.splice(pos, 0, r.id);
    }
    // Re-enter find-mode.
    state.dedupe.active   = true;
    state.dedupe.clusters = snapshot.clusters.map(c => ({ id: c.id, memberIds: c.memberIds.slice(), keeperIds: c.keeperIds.slice() }));
    // markedIds = non-keepers across clusters (same rule as the original
    // findDuplicates pass).
    const keeperSet = new Set();
    for (const c of state.dedupe.clusters) for (const k of c.keeperIds) keeperSet.add(k);
    state.dedupe.markedIds = [];
    for (const c of state.dedupe.clusters) {
      for (const m of c.memberIds) {
        if (!keeperSet.has(m)) state.dedupe.markedIds.push(m);
      }
    }
    state.dedupe.preFindOrder = snapshot.preFindOrder ? snapshot.preFindOrder.slice() : null;
  });
}

// --- Worker plumbing -------------------------------------------------------
//
// Distribute `items` across the worker pool round-robin. Each worker
// processes its slice independently; the main thread aggregates per-item
// progress events (writing the hash to image._hashes immediately) and
// waits for ALL workers to send their 'done' message before resolving.
//
// onProgress receives a synthesized { done, total } snapshot in
// arrival-order across workers (so the progress label advances smoothly
// even though individual workers race each other).
function runWorkerHash(items, onProgress) {
  const pool = getWorkerPool();
  const total = items.length;
  let globalDone = 0;

  // Round-robin distribute. For unequal slice sizes (total not divisible
  // by pool size), the first `total % size` workers get one extra item —
  // standard balanced partitioning.
  const buckets = Array.from({ length: pool.size }, () => []);
  for (let i = 0; i < items.length; i++) {
    buckets[i % pool.size].push(items[i]);
  }

  const runOne = (worker, batch) => new Promise((resolve, reject) => {
    if (batch.length === 0) {
      // Worker has no work; resolve immediately so the outer Promise.all
      // doesn't hang.
      resolve();
      return;
    }
    function onMessage(event) {
      const m = event && event.data;
      if (!m) return;
      if (m.type === 'progress') {
        globalDone++;
        // Cache the hash on the image immediately. Don't fire update()
        // for every per-item write — too noisy for subscribers; the
        // outer findDuplicates() update() at the end is what triggers
        // UI reaction.
        if (!m.error && m.id) {
          const img = getState().images[m.id];
          if (img) {
            img._hashes = { sha256: m.sha256, dhash: m.dhash, phash: m.phash };
          }
        }
        try { onProgress({ done: globalDone, total }); } catch { /* ignore */ }
        return;
      }
      if (m.type === 'done') {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        resolve();
      }
    }
    function onError(err) {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      reject(err);
    }
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'hash', items: batch });
  });

  return Promise.all(pool.workers.map((w, i) => runOne(w, buckets[i])));
}
