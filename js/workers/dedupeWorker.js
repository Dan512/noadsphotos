// js/workers/dedupeWorker.js — off-main-thread hash compute for the
// "Find duplicates" batch action.
//
// Spawned by js/dedupe.js with `new Worker(url, { type: 'module' })`.
// Receives a batch of queue items (each as { id, sourceBlob, thumbBlob }),
// computes a SHA-256 of the source bytes and a dHash of the thumbnail, and
// streams progress back per item. The main thread does the clustering
// (cheap) and orchestrates UI updates.
//
// Why a worker:
//   - Hashing 100+ images on the main thread freezes the UI thread,
//     making the queue grid + progress UI feel broken.
//   - All compute here is pure (no DOM access), so a worker is the right
//     fit. OffscreenCanvas and crypto.subtle.digest both work in workers.
//
// Message protocol:
//   Main → Worker: { type: 'hash', items: [{ id, sourceBlob, thumbBlob }, ...] }
//   Worker → Main: { type: 'progress', done, total, id, sha256?, dhash?, error? }
//   Worker → Main: { type: 'done', total }
//
// Errors per item are reported via `error` in the progress message; the
// worker continues with the remaining items. Catastrophic worker errors
// (e.g., out of memory) propagate via the standard onerror channel.

import { computeDHashFromLuminance, rgbaToLuminance72 } from '../ops/dedupe.js';

self.addEventListener('message', async (event) => {
  const msg = event && event.data;
  if (!msg || msg.type !== 'hash') return;
  const items = Array.isArray(msg.items) ? msg.items : [];
  const total = items.length;
  let done = 0;
  for (const item of items) {
    let payload = { type: 'progress', done: done + 1, total, id: item && item.id };
    try {
      if (!item || !item.id) throw new Error('missing item id');
      const sha256 = await hashSourceBytes(item.sourceBlob);
      const dhash  = await hashThumbnail(item.thumbBlob);
      payload.sha256 = sha256;
      payload.dhash  = dhash;
    } catch (err) {
      payload.error = (err && err.message) ? err.message : String(err);
    }
    done++;
    payload.done = done;
    self.postMessage(payload);
  }
  self.postMessage({ type: 'done', total });
});

// --- SHA-256 of arbitrary Blob bytes -------------------------------------

async function hashSourceBytes(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new Error('source blob unavailable');
  }
  const buf = await blob.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return bufToHex(hashBuf);
}

function bufToHex(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const h = view[i].toString(16);
    out += h.length === 1 ? ('0' + h) : h;
  }
  return out;
}

// --- dHash of thumbnail Blob ---------------------------------------------

async function hashThumbnail(thumbBlob) {
  if (!thumbBlob) throw new Error('thumb blob unavailable');
  // createImageBitmap is async + handles JPEG/PNG/WebP transparently.
  // resizeWidth/resizeHeight option asks the browser to do the downsample
  // for us (faster than drawing to a separate canvas first).
  const bitmap = await createImageBitmap(thumbBlob, {
    resizeWidth: 9,
    resizeHeight: 8,
    resizeQuality: 'high',
  });
  try {
    const off = new OffscreenCanvas(9, 8);
    const ctx = off.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context in worker');
    ctx.drawImage(bitmap, 0, 0, 9, 8);
    const { data } = ctx.getImageData(0, 0, 9, 8);
    const lum = rgbaToLuminance72(data);
    return computeDHashFromLuminance(lum);
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}
