// js/lifecycle.js — sliding-window bitmap lifecycle policy.
//
// Decoded ImageBitmaps are large; we keep at most 3 at a time (active +
// 1 prev + 1 next in state.queue). Outside that window, bitmaps are closed
// and references nulled. The underlying blob is retained on each
// ImageState so the bitmap can be re-decoded on demand.
//
// Created via a factory so tests can inject stubs. Runtime callers do:
//   createLifecycle({ decoder: createImageBitmap, closer: b => b.close() })
import { getState, update } from './state.js';

const defaultDecoder = (blob, options) => createImageBitmap(blob, options);
const defaultCloser  = bitmap => bitmap.close();

export function createLifecycle({ decoder = defaultDecoder, closer = defaultCloser } = {}) {
  // In-flight decodes, keyed by image id, so concurrent setWindow calls
  // don't double-decode the same image.
  const inflight = new Map();

  // Compute the desired window: active id + 1 prev + 1 next in state.queue.
  function computeWindow(activeId) {
    const { queue } = getState();
    if (activeId === null || activeId === undefined) return new Set();
    const idx = queue.indexOf(activeId);
    if (idx === -1) return new Set();
    const want = new Set();
    want.add(queue[idx]);
    if (idx - 1 >= 0)            want.add(queue[idx - 1]);
    if (idx + 1 < queue.length)  want.add(queue[idx + 1]);
    return want;
  }

  // Kick off decoding for one image if not already decoded or in flight.
  // The decoder is invoked synchronously so callers (and tests) can
  // observe `inflight` registration immediately after this returns —
  // crucial for dedupe semantics under back-to-back calls.
  function startDecode(id) {
    const s = getState();
    const img = s.images[id];
    if (!img) return null;
    if (img.source.bitmap) return Promise.resolve(img.source.bitmap);
    if (inflight.has(id)) return inflight.get(id);

    const decodePromise = Promise.resolve(decoder(img.source.blob));
    const p = decodePromise
      .then(bitmap => {
        // Commit only if the image still exists and still has no bitmap.
        const cur = getState().images[id];
        if (cur && !cur.source.bitmap) {
          update(state => {
            const target = state.images[id];
            if (target && !target.source.bitmap) {
              target.source.bitmap = bitmap;
            } else if (!target) {
              // Removed while decoding — close orphan.
              try { closer(bitmap); } catch { /* ignore */ }
            }
          });
        } else if (!cur) {
          try { closer(bitmap); } catch { /* ignore */ }
        }
        return bitmap;
      })
      .finally(() => {
        inflight.delete(id);
      });

    inflight.set(id, p);
    return p;
  }

  // Close + null a single bitmap. Caller must wrap in update().
  function evictOne(state, id) {
    const img = state.images[id];
    if (img && img.source.bitmap) {
      try { closer(img.source.bitmap); } catch { /* ignore */ }
      img.source.bitmap = null;
    }
  }

  return {
    // Bring the sliding window into sync with `activeId`. Decodes any
    // missing in-window bitmaps and evicts any decoded out-of-window
    // ones. Returns a promise that resolves once all decodes are done.
    async setWindow(activeId) {
      const want = computeWindow(activeId);
      const s = getState();

      // Evict anything decoded but not wanted. Single update batches all
      // evictions and notifies subscribers once.
      const evictIds = [];
      for (const id of Object.keys(s.images)) {
        if (!want.has(id) && s.images[id].source.bitmap) {
          evictIds.push(id);
        }
      }
      if (evictIds.length > 0) {
        update(state => {
          for (const id of evictIds) evictOne(state, id);
        });
      }

      // Trigger decode for every in-window id (no-op if already decoded
      // or in flight). Await all to give callers a single completion
      // signal — failures propagate.
      const decodes = [];
      for (const id of want) {
        const p = startDecode(id);
        if (p) decodes.push(p);
      }
      await Promise.all(decodes);
    },

    // Return the bitmap for `id`, decoding from blob if needed. Throws
    // synchronously (via promise rejection) if the id is not in
    // state.images.
    async ensureBitmap(id) {
      const s = getState();
      const img = s.images[id];
      if (!img) throw new Error(`ensureBitmap: unknown image id ${id}`);
      if (img.source.bitmap) return img.source.bitmap;
      const p = startDecode(id);
      // startDecode returned null only if the image disappeared mid-call,
      // which we just guarded against — but be defensive.
      if (!p) throw new Error(`ensureBitmap: unknown image id ${id}`);
      await p;
      return getState().images[id]?.source.bitmap ?? null;
    },

    // Close every decoded bitmap and clear all references. Used on
    // teardown / massive state changes.
    evictAll() {
      const s = getState();
      const ids = Object.keys(s.images);
      const hasAny = ids.some(id => s.images[id].source.bitmap);
      if (!hasAny) return;
      update(state => {
        for (const id of Object.keys(state.images)) evictOne(state, id);
      });
    },

    // Free a single decoded bitmap. Used by batch export after each image is
    // encoded to keep peak memory bounded — without this, exporting a 100-
    // image queue would accumulate 100 decoded bitmaps. Skips no-ops and
    // never throws.
    evictAfterUse(id) {
      const s = getState();
      const img = s.images[id];
      if (!img || !img.source.bitmap) return;
      update(state => evictOne(state, id));
    },
  };
}
