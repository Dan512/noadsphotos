// js/history.js — undo / redo with per-image ops + batch transactions.
//
// Phase 8 of the v1 plan. Maintains ONE global past/future stack — per-image
// ops carry their `imageId` so inverse application can find the right image,
// and batch transactions span multiple images via `affectedImageIds`. This is
// simpler than keeping per-image stacks AND a separate global transaction
// stack (which would race on undo order), and matches the design doc's
// "one Ctrl+Z reverts the whole batch" rule trivially.
//
// Public surface:
//   recordOp({ label, imageId, kind, before, after, sizeEstimate? })
//   recordTransaction({ label, affectedImageIds, beforeByImage, afterByImage, sizeEstimate? })
//   withHistory(label, imageId, opKind, snapshotKeys, mutator)
//   withBatchTransaction(label, affectedImageIds, snapshotKeys, mutator)
//   undo() → boolean
//   redo() → boolean
//   getHistoryStats() → { pastCount, futureCount, bytes, budget }
//   clearHistory()
//   subscribeHistory(fn) → unsub
//
// Each entry shape:
//   Per-image op:
//     { kind:'op', label, imageId, opKind, before, after, sizeEstimate, ts }
//   Batch transaction:
//     { kind:'transaction', label, affectedImageIds, beforeByImage,
//       afterByImage, opKind, sizeEstimate, ts }
//
// before/after snapshots are objects of structuredClone'd key values from the
// ImageState — see `pickKeys`. Typed arrays (chromakeyMask, bgMask, brush
// points) are HELD BY REFERENCE because they're treated as immutable; this
// matches the design doc and keeps history small.
//
// On undo, we write the `before` snapshot back into the image and invalidate
// the right render-cache flag (derived from opKind). Redo does the same with
// `after`. Eviction drops the oldest entries from the past stack until total
// estimated bytes <= byteBudget.

import { getState, update } from './state.js';
import { invalidate } from './render/renderCache.js';

// Default byte budget — design doc says ~100 MB.
const DEFAULT_BYTE_BUDGET = 100 * 1024 * 1024;

// Map opKind → renderCache invalidate kind. Used by applyInverse/applyForward
// so the renderer re-bakes the right intermediate after we mutate state.
const OP_KIND_TO_INVALIDATE = Object.freeze({
  transforms: 'TRANSFORMS',
  adjust:     'ADJUST',         // null target — renderer just re-renders via CSS filter
  chromakey:  'CHROMAKEY',
  bgmask:     'BGMASK',
  overlay:    'OVERLAY',
  reorder:    'OVERLAY',
});

// Module-level history. One global past/future + a bytes counter + budget.
const history = {
  past:       [],
  future:     [],
  bytes:      0,
  byteBudget: DEFAULT_BYTE_BUDGET,
};

// Subscribers fire after every change — undo/redo/record/clear. Used by the
// toolbar Undo/Redo buttons to enable/disable themselves.
const subs = new Set();

// The most recent change to the history — kind ('undo'|'redo'|'record'|'clear')
// + the affected image IDs. Subscribers (e.g. queueView) read this on each
// notify() to figure out whether they need to do follow-up work (refreshing
// thumbnails after undo, mainly). Reset to null after each notification so
// stale data doesn't leak into a future read.
let lastChange = null;

/**
 * Returns the descriptor of the most recently applied change, or null if
 * nothing has happened (or the descriptor was already consumed in this tick).
 * Shape: { kind: 'undo'|'redo'|'record'|'clear', ids: string[] }.
 */
export function getLastChange() {
  return lastChange;
}

function notify() {
  for (const fn of subs) {
    try { fn(getHistoryStats()); } catch (err) { console.error('history subscriber error', err); }
  }
}

export function subscribeHistory(fn) {
  if (typeof fn !== 'function') throw new TypeError('subscribeHistory: fn must be a function');
  subs.add(fn);
  return () => subs.delete(fn);
}

// --- Public: stats / clear / config ---------------------------------------

export function getHistoryStats() {
  return {
    pastCount:   history.past.length,
    futureCount: history.future.length,
    bytes:       history.bytes,
    budget:      history.byteBudget,
  };
}

export function clearHistory() {
  history.past.length = 0;
  history.future.length = 0;
  history.bytes = 0;
  notify();
}

// Test/runtime hook for tuning the budget; tests use this to force eviction
// with tiny totals.
export function setByteBudget(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return;
  history.byteBudget = n;
  evictIfNeeded();
  notify();
}

// --- Public: recording ----------------------------------------------------

/**
 * Push a per-image op onto the past stack. Clears the future stack (a fresh
 * action invalidates previously-undone redos, as is standard).
 *
 * Caller has already made the state mutation. This module never executes the
 * "do" half — only the inverse on undo and the forward on redo. The before/
 * after snapshots are what those replays use.
 *
 * @param {{
 *   label: string,
 *   imageId: string,
 *   kind: 'transforms'|'adjust'|'chromakey'|'overlay'|'reorder'|'bgmask'|string,
 *   before: object,
 *   after: object,
 *   sizeEstimate?: number,
 * }} entry
 */
export function recordOp({ label, imageId, kind, before, after, sizeEstimate }) {
  if (typeof imageId !== 'string' || !imageId) {
    throw new TypeError('recordOp: imageId must be a non-empty string');
  }
  if (typeof kind !== 'string' || !kind) {
    throw new TypeError('recordOp: kind must be a non-empty string');
  }
  const size = Number.isFinite(sizeEstimate) ? sizeEstimate : estimateSize(before, after);
  const entry = {
    kind:        'op',
    label:       String(label ?? ''),
    imageId,
    opKind:      kind,
    before,
    after,
    sizeEstimate: size,
    ts:          Date.now(),
  };
  history.past.push(entry);
  history.bytes += size;
  history.future.length = 0;
  evictIfNeeded();
  notify();
}

/**
 * Push a batch transaction onto the past stack. One transaction can affect
 * many images; one undo reverts all of them in a single state mutation.
 *
 * @param {{
 *   label: string,
 *   affectedImageIds: string[],
 *   beforeByImage: { [id]: object },
 *   afterByImage: { [id]: object },
 *   opKind?: string,             // used to pick the renderCache flag on inverse
 *   sizeEstimate?: number,
 * }} entry
 */
export function recordTransaction({
  label,
  affectedImageIds,
  beforeByImage,
  afterByImage,
  opKind,
  sizeEstimate,
}) {
  if (!Array.isArray(affectedImageIds) || affectedImageIds.length === 0) {
    throw new TypeError('recordTransaction: affectedImageIds must be a non-empty array');
  }
  if (!beforeByImage || !afterByImage) {
    throw new TypeError('recordTransaction: beforeByImage and afterByImage are required');
  }

  let size;
  if (Number.isFinite(sizeEstimate)) {
    size = sizeEstimate;
  } else {
    size = 0;
    for (const id of affectedImageIds) {
      size += estimateSize(beforeByImage[id], afterByImage[id]);
    }
  }

  const entry = {
    kind:             'transaction',
    label:            String(label ?? ''),
    affectedImageIds: [...affectedImageIds],
    beforeByImage,
    afterByImage,
    opKind:           typeof opKind === 'string' && opKind ? opKind : null,
    sizeEstimate:     size,
    ts:               Date.now(),
  };
  history.past.push(entry);
  history.bytes += size;
  history.future.length = 0;
  evictIfNeeded();
  notify();
}

/**
 * Bracket helper: capture a before-snapshot of the listed keys, run the
 * mutator (which is responsible for calling `update()` itself if it needs
 * subscribers to fire), capture an after-snapshot, record the op.
 *
 * If the mutator produces no observable change (before deep-equals after),
 * NOTHING is recorded — no-op edits don't pollute history.
 *
 * The mutator receives the state directly. Most callers will run the actual
 * mutation inside `update(s => ...)` so subscribers fire; this helper does
 * NOT auto-wrap because some callers (like batch transactions across many
 * images) want a single outer `update()` boundary.
 *
 * @param {string} label
 * @param {string} imageId
 * @param {string} opKind
 * @param {string[]} snapshotKeys
 * @param {(state: object) => void} mutator
 */
export function withHistory(label, imageId, opKind, snapshotKeys, mutator) {
  const s = getState();
  const img = s.images[imageId];
  if (!img) {
    // Image missing — just run the mutator without recording.
    if (typeof mutator === 'function') mutator(s);
    return;
  }
  const before = pickKeys(img, snapshotKeys);
  if (typeof mutator === 'function') mutator(s);
  const afterImg = getState().images[imageId];
  if (!afterImg) return; // image removed mid-mutation — nothing to record
  const after = pickKeys(afterImg, snapshotKeys);
  if (deepEqual(before, after)) return;
  recordOp({ label, imageId, kind: opKind, before, after });
}

/**
 * Bracket helper for batch transactions. Captures before/after snapshots for
 * each affected image, runs the mutator once, records as a transaction.
 *
 * @param {string} label
 * @param {string[]} affectedImageIds
 * @param {string} opKind            renderCache invalidate kind for inverse
 * @param {string[]} snapshotKeys
 * @param {(state: object) => void} mutator
 */
export function withBatchTransaction(label, affectedImageIds, opKind, snapshotKeys, mutator) {
  const s = getState();
  const ids = affectedImageIds.filter(id => !!s.images[id]);
  if (ids.length === 0) {
    if (typeof mutator === 'function') mutator(s);
    return;
  }
  const beforeByImage = Object.create(null);
  for (const id of ids) {
    beforeByImage[id] = pickKeys(s.images[id], snapshotKeys);
  }

  if (typeof mutator === 'function') mutator(s);

  const sAfter = getState();
  const afterByImage = Object.create(null);
  const survivingIds = [];
  for (const id of ids) {
    const img = sAfter.images[id];
    if (!img) continue;
    afterByImage[id] = pickKeys(img, snapshotKeys);
    survivingIds.push(id);
  }
  if (survivingIds.length === 0) return;

  // Skip if nothing actually changed for any image.
  let anyChanged = false;
  for (const id of survivingIds) {
    if (!deepEqual(beforeByImage[id], afterByImage[id])) { anyChanged = true; break; }
  }
  if (!anyChanged) return;

  recordTransaction({
    label,
    affectedImageIds: survivingIds,
    beforeByImage,
    afterByImage,
    opKind,
  });
}

// --- Public: undo / redo --------------------------------------------------

/**
 * Pop the most recent entry from the past stack, apply its `before` snapshot
 * to the relevant image(s), push it onto the future stack. Returns false if
 * there was nothing to undo.
 */
export function undo() {
  const entry = history.past.pop();
  if (!entry) return false;
  history.bytes = Math.max(0, history.bytes - entry.sizeEstimate);
  history.future.push(entry);
  applyInverse(entry);
  lastChange = { kind: 'undo', ids: entryAffectedIds(entry) };
  notify();
  return true;
}

/**
 * Pop the most recent entry from the future stack, apply its `after`
 * snapshot, push it back onto the past stack. Returns false if there was
 * nothing to redo.
 */
export function redo() {
  const entry = history.future.pop();
  if (!entry) return false;
  history.past.push(entry);
  history.bytes += entry.sizeEstimate;
  applyForward(entry);
  lastChange = { kind: 'redo', ids: entryAffectedIds(entry) };
  notify();
  return true;
}

// Return the image IDs affected by a history entry — single-image ops have
// one ID, batch transactions have many. Used by getLastChange() so
// subscribers know which images need follow-up (e.g. thumbnail refresh).
function entryAffectedIds(entry) {
  if (!entry) return [];
  if (entry.kind === 'transaction') {
    return Array.isArray(entry.affectedImageIds) ? entry.affectedImageIds.slice() : [];
  }
  if (entry.imageId) return [entry.imageId];
  return [];
}

// --- Internal: apply / invalidate -----------------------------------------

function applyInverse(entry) {
  if (entry.kind === 'op') {
    update(state => {
      const img = state.images[entry.imageId];
      if (!img) return;
      writeKeys(img, entry.before);
      invalidateForOp(img, entry.opKind);
    });
  } else if (entry.kind === 'transaction') {
    update(state => {
      for (const id of entry.affectedImageIds) {
        const img = state.images[id];
        if (!img) continue;
        const snap = entry.beforeByImage[id];
        if (!snap) continue;
        writeKeys(img, snap);
        invalidateForOp(img, entry.opKind);
      }
    });
  }
}

function applyForward(entry) {
  if (entry.kind === 'op') {
    update(state => {
      const img = state.images[entry.imageId];
      if (!img) return;
      writeKeys(img, entry.after);
      invalidateForOp(img, entry.opKind);
    });
  } else if (entry.kind === 'transaction') {
    update(state => {
      for (const id of entry.affectedImageIds) {
        const img = state.images[id];
        if (!img) continue;
        const snap = entry.afterByImage[id];
        if (!snap) continue;
        writeKeys(img, snap);
        invalidateForOp(img, entry.opKind);
      }
    });
  }
}

function invalidateForOp(img, opKind) {
  const key = opKind ? OP_KIND_TO_INVALIDATE[opKind] : null;
  if (!key) return;
  invalidate(img, key);
}

// --- Internal: eviction ---------------------------------------------------

function evictIfNeeded() {
  // Drop oldest past entries (shift from front) until bytes <= budget.
  // Future is NOT touched — it's user redo state and the user expects it to
  // stick around until they take a new action.
  while (history.bytes > history.byteBudget && history.past.length > 0) {
    const dropped = history.past.shift();
    history.bytes = Math.max(0, history.bytes - dropped.sizeEstimate);
  }
}

// --- Internal: snapshot helpers -------------------------------------------

/**
 * Given an image and an array of top-level keys (e.g. ['transforms',
 * 'adjust']), return an object whose properties are deep clones of those
 * keys' values. Typed arrays (Uint8Array / Float32Array / etc.) and
 * ImageBitmap-like references are held BY REFERENCE because they're treated
 * as immutable per the design doc — cloning a 100 MB bgMask on every adjust
 * would defeat the byte budget.
 *
 * Falls back to a shallow copy of the value if structuredClone throws (e.g.,
 * a function or DOM node). In practice callers should only ever ask for
 * keys that hold plain data.
 *
 * @param {object} img
 * @param {string[]} keys
 */
export function pickKeys(img, keys) {
  const out = Object.create(null);
  if (!img || !Array.isArray(keys)) return out;
  for (const k of keys) {
    const v = img[k];
    out[k] = cloneSnapshotValue(v);
  }
  return out;
}

/**
 * Write the snapshotted values back onto the image, mutating in place.
 * Caller is expected to already be inside an `update()` boundary so
 * subscribers fire.
 */
export function writeKeys(img, snapshot) {
  if (!img || !snapshot) return;
  for (const k of Object.keys(snapshot)) {
    img[k] = snapshot[k];
  }
}

// Clone helper: typed arrays and ImageBitmap-likes pass through; everything
// else gets structuredClone'd. structuredClone of a typed array would
// allocate a fresh copy — for masks that costs us their byteLength on each
// snapshot, which we don't want.
function cloneSnapshotValue(v) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  // Typed arrays (Uint8Array, Float32Array, etc.) — hold by reference.
  if (ArrayBuffer.isView(v)) return v;
  // ImageBitmap / OffscreenCanvas — never legitimate inside snapshots, but
  // pass-through if encountered.
  if (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) return v;
  // Plain objects / arrays / etc. — deep clone.
  try {
    return structuredClone(v);
  } catch {
    // Fallback: shallow copy. Better than throwing.
    if (Array.isArray(v)) return v.slice();
    return { ...v };
  }
}

// Rough byte estimate used for the budget. Cheap heuristic per kind: stringify
// non-typed-array values and sum their lengths (counts 1 char = 1 byte —
// undercounts but close enough for eviction); add byteLength for typed arrays.
export function estimateSize(before, after) {
  return rougeBytes(before) + rougeBytes(after);
}

function rougeBytes(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  if (typeof v === 'number' || typeof v === 'boolean') return 8;
  if (typeof v !== 'object') return 16;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  // Top-level snapshot is a small object {transforms: {...}, adjust: {...}}.
  // Walk one level then JSON-stringify the rest (deals with arrays too).
  let total = 0;
  if (Array.isArray(v)) {
    for (const item of v) total += rougeBytes(item);
    return total;
  }
  for (const k of Object.keys(v)) {
    total += k.length;
    const child = v[k];
    if (child && typeof child === 'object') {
      if (ArrayBuffer.isView(child)) { total += child.byteLength; continue; }
      try {
        total += JSON.stringify(child).length;
      } catch {
        total += 64;
      }
    } else {
      total += rougeBytes(child);
    }
  }
  return total;
}

// --- Internal: deep equal -------------------------------------------------

// Cheap deep equality, tuned for snapshot comparisons:
//   - typed arrays compared by identity (treated as immutable)
//   - objects + arrays walked recursively
//   - everything else compared with ===
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  // Typed arrays: same reference only — we treat them as immutable, so a new
  // ref always means a change.
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// Re-export for tests.
export const __test__ = { deepEqual, pickKeys, writeKeys, estimateSize };
