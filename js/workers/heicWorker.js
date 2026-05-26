// js/workers/heicWorker.js — classic worker that decodes HEIC files via
// the vendored libheif. Spawned by js/heicPool.js. One instance per pool
// slot, shared across the worker's lifetime.
//
// Classic (not module) because libheif is UMD-only — assigns to
// `self.libheif` from a single global script. `importScripts` is the
// canonical way to load that into a worker scope; ESM imports won't work.
//
// The init dance mirrors js/vendor/heic-loader.js (main-thread version):
// load the glue, pre-fetch the wasm bytes ourselves, hand them to
// emscripten as `wasmBinary` so the upstream code doesn't try its own
// sync XHR. Same `locateFile` override pinning all traffic to our origin.
//
// Lazy init: we don't touch libheif until the first 'decode' message —
// idle workers cost a few hundred KB of JS heap each, and 4 of them
// shouldn't pay the wasm boot cost if the user never imports a HEIC.
//
// Protocol (matches js/heicPool.js):
//   ← { type: 'decode', items: [{id, arrayBuffer}, ...] }
//   → { type: 'progress', id, imageData: {data, width, height}, pngBlob }
//        // pngBlob: worker-encoded PNG (OffscreenCanvas.convertToBlob), or
//        //          null if encode failed — main thread falls back to its
//        //          existing imageDataToPngFile path in that case.
//   → { type: 'error',    id, error: 'message' }                    // per-item failure
//   → { type: 'done' }                                              // batch complete
//
// If init itself fails (e.g. wasm fetch 404s), every item in the batch
// is reported as `{ type: 'error', error: 'worker_init_failed: ...' }`
// so the pool's per-item fallback path activates uniformly — no item
// is left orphaned waiting for a progress event that will never come.

let libheifModule = null;
let initPromise = null;

async function initLibheif() {
  if (libheifModule) return libheifModule;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Load the UMD glue. Sets self.libheif to a factory.
    importScripts('/js/vendor/heic/libheif.js');
    if (typeof self.libheif !== 'function') {
      throw new Error('heicWorker: libheif factory missing after importScripts');
    }
    // Pre-fetch wasm bytes; browser cache de-duplicates across workers.
    // Handing emscripten `wasmBinary` directly avoids its internal sync-XHR
    // fallback path that fires in worker contexts.
    const wasmResp = await fetch('/js/vendor/heic/libheif.wasm');
    if (!wasmResp.ok) throw new Error('heicWorker: wasm fetch failed: ' + wasmResp.status);
    const wasmBinary = new Uint8Array(await wasmResp.arrayBuffer());
    // Instantiate and wait for runtime init. Same closure dance as
    // heic-loader.js — `onRuntimeInitialized` can fire SYNCHRONOUSLY inside
    // the factory call, so we keep a `settled` guard and reference the
    // config object (emscripten mutates it into the Module instance).
    const module = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ok, m) => { if (!settled) { settled = true; ok ? resolve(m) : reject(m); } };
      const config = {
        wasmBinary,
        locateFile: (name) => '/js/vendor/heic/' + name,
        onRuntimeInitialized() { finish(true, config); },
        onAbort(reason) { finish(false, new Error('heic_wasm_abort: ' + reason)); },
      };
      try {
        const inst = self.libheif(config);
        // Belt-and-braces backstop: some emscripten builds also resolve a
        // `ready` thenable on the returned instance.
        if (inst && typeof inst.then === 'function') {
          inst.then(m => finish(true, m), e => finish(false, e));
        }
      } catch (err) {
        finish(false, err);
      }
    });
    if (!module || typeof module.HeifDecoder !== 'function') {
      throw new Error('heicWorker: module missing HeifDecoder');
    }
    libheifModule = module;
    return libheifModule;
  })();
  // Don't poison the init cache on failure — a re-spawned worker (or
  // subsequent batch) should be free to retry.
  initPromise.catch(() => { initPromise = null; });
  return initPromise;
}

/**
 * Decode the first image in a HEIC ArrayBuffer. Mirrors
 * js/vendor/heic-loader.js#decodeOne — libheif handles EXIF/irot/imir
 * orientation during decode, so callers get post-rotation pixels and
 * dimensions with no extra work.
 *
 * @param {*} module — initialized libheif Module instance
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number }>}
 */
function decodeOne(module, arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const decoder = new module.HeifDecoder();
  // HEIC files can hold image sequences — most camera output is a single
  // primary image, but we explicitly pick [0] rather than assuming length.
  const images = decoder.decode(bytes);
  if (!images || images.length === 0) throw new Error('heic_no_images');
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('heic_invalid_dimensions');
  }
  const imageData = {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
  return new Promise((resolve, reject) => {
    image.display(imageData, (dd) => {
      if (!dd) reject(new Error('heic_display_failed'));
      else resolve(imageData);
    });
  });
}

self.onmessage = async (e) => {
  const data = e.data || {};
  if (data.type !== 'decode') return;
  const items = data.items || [];
  let module;
  try {
    module = await initLibheif();
  } catch (err) {
    // Fatal init failure — worker can't proceed at all. Report every
    // item as an error so the main thread can fall back per-file. Always
    // emit 'done' afterwards so the pool's per-worker promise resolves.
    const msg = 'worker_init_failed: ' + (err && err.message ? err.message : String(err));
    for (const item of items) {
      self.postMessage({ type: 'error', id: item.id, error: msg });
    }
    self.postMessage({ type: 'done' });
    return;
  }
  for (const item of items) {
    try {
      const imageData = await decodeOne(module, item.arrayBuffer);
      // Encode the decoded pixels to a PNG Blob in the worker so the main
      // thread can skip the redundant putImageData → toBlob → createImageBitmap
      // round-trip. Workers can use OffscreenCanvas + convertToBlob without
      // touching the DOM. Encode is best-effort: any failure (truly old
      // browser, lack of OffscreenCanvas.convertToBlob) sends pngBlob: null
      // and the main thread falls back to its existing imageDataToPngFile path.
      let pngBlob = null;
      try {
        const offscreen = new OffscreenCanvas(imageData.width, imageData.height);
        const octx = offscreen.getContext('2d');
        octx.putImageData(imageData, 0, 0);
        pngBlob = await offscreen.convertToBlob({ type: 'image/png' });
      } catch {
        pngBlob = null;
      }
      // Transfer the pixel buffer back instead of copying — the main
      // thread gets ownership, and our worker heap drops it immediately.
      // pngBlob is reference-passed (Blobs aren't transferable).
      self.postMessage(
        { type: 'progress', id: item.id, imageData, pngBlob },
        [imageData.data.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: item.id,
        error: (err && err.message) ? err.message : 'decode_failed',
      });
    }
  }
  self.postMessage({ type: 'done' });
};
