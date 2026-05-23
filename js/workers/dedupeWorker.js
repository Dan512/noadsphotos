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

import {
  computeDHashFromLuminance,
  rgbaToLuminance72,
  computePHashFromLuminance,
  rgbaToLuminance1024,
} from '../ops/dedupe.js';

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
      const { dhash, phash } = await hashThumbnail(item.thumbBlob);
      payload.sha256 = sha256;
      payload.dhash  = dhash;
      payload.phash  = phash;
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

// --- dHash + pHash of thumbnail Blob --------------------------------------
//
// We do ONE createImageBitmap at 32×32 (the size pHash needs), then
// derive the 9×8 dHash input by drawing that bitmap onto a smaller
// canvas. Saves one decode pass per image vs. fetching the thumb twice.

async function hashThumbnail(thumbBlob) {
  if (!thumbBlob) throw new Error('thumb blob unavailable');
  const bitmap32 = await createImageBitmap(thumbBlob, {
    resizeWidth: 32,
    resizeHeight: 32,
    resizeQuality: 'high',
  });
  try {
    // 32×32 → pHash (DCT-based).
    const big = new OffscreenCanvas(32, 32);
    const ctxBig = big.getContext('2d', { willReadFrequently: true });
    if (!ctxBig) throw new Error('no 2d context in worker');
    ctxBig.drawImage(bitmap32, 0, 0, 32, 32);
    const dataBig = ctxBig.getImageData(0, 0, 32, 32).data;
    const lum1024 = rgbaToLuminance1024(dataBig);
    const phash = computePHashFromLuminance(lum1024);

    // 32×32 → 9×8 → dHash. Derived from the same source bitmap to avoid
    // a second createImageBitmap call.
    const small = new OffscreenCanvas(9, 8);
    const ctxSmall = small.getContext('2d', { willReadFrequently: true });
    if (!ctxSmall) throw new Error('no 2d context in worker (9×8)');
    ctxSmall.imageSmoothingEnabled = true;
    ctxSmall.imageSmoothingQuality = 'high';
    ctxSmall.drawImage(bitmap32, 0, 0, 9, 8);
    const dataSmall = ctxSmall.getImageData(0, 0, 9, 8).data;
    const lum72 = rgbaToLuminance72(dataSmall);
    const dhash = computeDHashFromLuminance(lum72);

    return { dhash, phash };
  } finally {
    if (bitmap32 && typeof bitmap32.close === 'function') bitmap32.close();
  }
}
