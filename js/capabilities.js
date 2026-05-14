// js/capabilities.js — probe runtime capabilities at boot. Cache result for the session.
let cache = null;

export async function probeCapabilities() {
  if (cache) return cache;

  const result = {
    ctxFilter: false,
    webp: false,
    jpeg: true,   // always supported in modern browsers
    png:  true,   // always supported in modern browsers
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    webWorker: typeof Worker !== 'undefined',
    imageOrientation: false,
    maxCanvasSize: 4096,
    // WebGPU surface check. We deliberately DON'T await navigator.gpu.requestAdapter()
    // here — that's an async call that can be slow and may prompt for permission on
    // some browsers. The presence of `navigator.gpu` is a sufficient first-pass
    // signal; the @imgly bundle re-verifies internally before swapping execution
    // providers, falling back to CPU if requestAdapter() returns null.
    webGPU: typeof navigator !== 'undefined' && typeof navigator.gpu === 'object' && navigator.gpu !== null,
  };

  // ctx.filter probe
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.filter = 'brightness(2)';
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    result.ctxFilter = d[0] > 200;
  } catch {
    result.ctxFilter = false;
  }

  // WebP probe
  result.webp = await encodeTypeProbe('image/webp');

  // imageOrientation probe
  try {
    const blob = new Blob([new Uint8Array([137,80,78,71,13,10,26,10])], { type: 'image/png' });
    await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => null);
    result.imageOrientation = true;
  } catch {
    result.imageOrientation = false;
  }

  // maxCanvasSize binary-search heuristic
  result.maxCanvasSize = await probeMaxCanvas();

  cache = result;
  return result;
}

export function _resetForTest() {
  cache = null;
}

function encodeTypeProbe(mime) {
  return new Promise(resolve => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    c.getContext('2d').fillRect(0, 0, 1, 1);
    c.toBlob(blob => resolve(!!blob && blob.type === mime), mime, 1);
  });
}

async function probeMaxCanvas() {
  // Note: avoid 32767 — Firefox emits a GraphicsCriticalError trying to
  // allocate a 32767² surface that can destabilize the page. 16384 is enough
  // to detect "supports very large canvas" and exceeds every known browser
  // ceiling reliably (Firefox ~11180, Safari ~16384, Chrome ~16384).
  for (const n of [16384, 8192, 4096]) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = n;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#abc';
      ctx.fillRect(n - 1, n - 1, 1, 1);
      const d = ctx.getImageData(n - 1, n - 1, 1, 1).data;
      if (d[0] === 0xaa) return n;
    } catch { /* try next */ }
  }
  return 2048;
}
