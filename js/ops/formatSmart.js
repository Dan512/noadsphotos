// js/ops/formatSmart.js — smart match-source default export format.
//
// When the user hasn't explicitly picked an export format this session, we
// pick one that matches the source image's container so a 4 MB JPEG photo
// doesn't get exported as a 30 MB PNG by accident. Source-match falls back
// to JPEG for unknown / HEIC inputs (HEIC isn't a sensible output), and
// promotes to a transparency-capable format when the active image has any
// alpha-bearing state (bgMask / chromakeyMask / bgRemoved).
//
// Why WebP over PNG for the alpha-promotion path: WebP is ~30% smaller than
// PNG at equivalent quality and also supports transparency, so when a JPEG-
// sourced image picks up bg-removed alpha mid-session, WebP is the friendlier
// default. (When the source IS PNG, we leave it alone — PNG-in/PNG-out is what
// the user implicitly asked for.)

/**
 * Pick a sensible default export format for a given image state. Returns one
 * of 'jpeg' | 'png' | 'webp'. Null / undefined inputs fall back to 'jpeg'.
 *
 * @param {object|null|undefined} imageState
 * @returns {'jpeg'|'png'|'webp'}
 */
export function getSmartDefaultFormat(imageState) {
  if (!imageState) return 'jpeg';

  const hasTransparency =
    !!imageState.bgMask ||
    !!imageState.chromakeyMask ||
    !!imageState.bgRemoved;

  const src = imageState.source || null;
  const mime = String((src && (src.type || src.mime)) || '').toLowerCase();
  const name = String((src && src.name) || '').toLowerCase();

  // HEIC origin always picks JPEG as the base (iPhone users want small files).
  // The importer decodes HEIC → PNG-backed bytes for storage, so the MIME /
  // extension below would otherwise mis-fire as 'png'. The `fromHeic` flag
  // is set in js/importer.js at HEIC-import time; the .heic/.heif extension
  // check is a belt-and-braces fallback for any path that bypassed the tag.
  // Transparency promotion (below) still applies — HEIC + alpha → WebP.
  const fromHeic =
    !!(src && src.fromHeic) ||
    name.endsWith('.heic') ||
    name.endsWith('.heif');

  // Base mapping from source MIME first, then file extension as a fallback
  // (some browsers don't set a useful type for HEIC/HEIF).
  let base;
  if (fromHeic) base = 'jpeg';
  else if (mime === 'image/png') base = 'png';
  else if (mime === 'image/jpeg' || mime === 'image/jpg') base = 'jpeg';
  else if (mime === 'image/webp') base = 'webp';
  else if (mime === 'image/heic' || mime === 'image/heif') base = 'jpeg';
  else if (name.endsWith('.png')) base = 'png';
  else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) base = 'jpeg';
  else if (name.endsWith('.webp')) base = 'webp';
  else base = 'jpeg';

  // Transparency override: promote JPEG → WebP (smaller than PNG, still
  // supports alpha). PNG / WebP already carry alpha, so leave them alone.
  if (hasTransparency && base === 'jpeg') return 'webp';
  return base;
}
