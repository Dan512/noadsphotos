// js/codec.js — verified encoding. Detects silent PNG fallback when WebP/JPEG unsupported.
//
// Accepts either an HTMLCanvasElement (uses canvas.toBlob) or an
// OffscreenCanvas (uses canvas.convertToBlob). The latter returns a Promise
// directly rather than taking a callback, so we branch on availability.
export async function encodeCanvas(canvas, requestedMime, quality) {
  let blob;
  if (typeof canvas.convertToBlob === 'function') {
    try {
      blob = await canvas.convertToBlob({ type: requestedMime, quality });
    } catch {
      blob = null;
    }
  } else if (typeof canvas.toBlob === 'function') {
    blob = await new Promise(resolve => canvas.toBlob(resolve, requestedMime, quality));
  } else {
    throw new EncodeError('encode_failed', requestedMime);
  }
  if (!blob) throw new EncodeError('encode_failed', requestedMime);
  if (blob.type !== requestedMime) throw new EncodeError('format_unsupported', requestedMime, blob.type);
  return blob;
}

export class EncodeError extends Error {
  constructor(code, requested, actual) {
    super(`Encode failed: ${code} (requested ${requested}${actual ? `, got ${actual}` : ''})`);
    this.name = 'EncodeError';
    this.code = code;
    this.requested = requested;
    this.actual = actual;
  }
}
