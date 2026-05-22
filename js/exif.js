// js/exif.js — minimal metadata detector for exported Blobs.
//
// Purpose: when the user clicks "Verify last export", read the bytes of the
// most recently exported Blob and check whether ANY metadata (EXIF / XMP /
// GPS) leaked through the export pipeline. The expected answer for every
// path is "no" — Canvas re-encoding strips this stuff naturally. The
// detector exists so the privacy claim is INSPECTABLE rather than just
// asserted.
//
// We intentionally hand-roll the parser instead of vendoring a library
// (~30 KB exifreader). The job is *detection*, not extraction — we only need
// to spot the chunk/marker headers in the three formats we emit (PNG, JPEG,
// WebP). All three have well-known signatures within the first ~few KB.
//
// Spec references consulted:
//   - JPEG / JFIF / EXIF in APP1: ISO/IEC 10918-1, Exif 2.32
//   - PNG eXIf chunk: PNG 2nd ed., chapter 11.3.4.7 (2017 amendment)
//   - WebP EXIF/XMP chunks: RIFF container; chunk FOURCC 'EXIF' or 'XMP '
//     per the WebP container spec.
//
// API:
//   await hasMetadata(blob)
//     → { exif: bool, xmp: bool, gps: bool, format: string, tags: string[] }
//
// `gps` is implied by `exif: true` containing a GPS IFD. We only do a
// shallow check for the GPSInfo tag (0x8825) in the IFD0 entry list — we do
// NOT decode coordinates. The intent is "is there GPS data?", not "where
// was the photo taken?".

const JPEG_SOI         = 0xFFD8;
const JPEG_MARKER_APP1 = 0xFFE1;
const JPEG_MARKER_APP0 = 0xFFE0;
const JPEG_MARKER_SOS  = 0xFFDA; // start-of-scan: stop scanning metadata past this
const PNG_SIGNATURE    = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const RIFF_SIGNATURE   = 'RIFF';
const WEBP_SIGNATURE   = 'WEBP';

/**
 * Detect metadata blocks in an exported Blob.
 *
 * @param {Blob} blob
 * @returns {Promise<{ exif: boolean, xmp: boolean, gps: boolean, format: string, tags: string[] }>}
 */
export async function hasMetadata(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    return { exif: false, xmp: false, gps: false, format: 'unknown', tags: [] };
  }
  // Only need the head + tail few KB for our checks. JPEG metadata sits
  // before the first SOS marker (usually within the first 10 KB), PNG/WebP
  // chunks can appear anywhere; we read the whole buffer because exports are
  // typically <50 MB and the cost is acceptable.
  const buf = new Uint8Array(await blob.arrayBuffer());
  const format = detectFormat(buf);
  if (format === 'jpeg') return scanJpeg(buf);
  if (format === 'png')  return scanPng(buf);
  if (format === 'webp') return scanWebp(buf);
  return { exif: false, xmp: false, gps: false, format, tags: [] };
}

// --- Format sniff ---------------------------------------------------------

function detectFormat(buf) {
  if (buf.length < 8) return 'unknown';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (matches(buf, 0, PNG_SIGNATURE)) return 'png';
  if (asciiAt(buf, 0, 4) === RIFF_SIGNATURE && asciiAt(buf, 8, 4) === WEBP_SIGNATURE) return 'webp';
  return 'unknown';
}

function matches(buf, offset, sig) {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function asciiAt(buf, offset, len) {
  if (buf.length < offset + len) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}

// --- JPEG scanner ---------------------------------------------------------
//
// JPEG is a sequence of FFxx markers. APP1 (FFE1) is where EXIF and XMP live:
//   - EXIF: APP1 payload starts with "Exif\0\0"
//   - XMP:  APP1 payload starts with "http://ns.adobe.com/xap/1.0/\0"
// We walk markers until we hit SOS (FFDA) — anything after that is image
// data, no more metadata.
function scanJpeg(buf) {
  const out = { exif: false, xmp: false, gps: false, format: 'jpeg', tags: [] };
  if (buf.length < 4) return out;
  // Verify SOI.
  if (((buf[0] << 8) | buf[1]) !== JPEG_SOI) return out;

  let i = 2;
  while (i < buf.length - 1) {
    // Markers all start with 0xFF; consecutive 0xFFs are padding.
    if (buf[i] !== 0xFF) break;
    while (buf[i] === 0xFF && i < buf.length) i++;
    if (i >= buf.length) break;
    const marker = 0xFF00 | buf[i];
    i++;
    if (marker === JPEG_MARKER_SOS) break;
    // SOI / EOI / RST* have no length.
    if (marker === 0xFFD8 || marker === 0xFFD9 ||
        (marker >= 0xFFD0 && marker <= 0xFFD7)) {
      continue;
    }
    if (i + 2 > buf.length) break;
    const segLen = (buf[i] << 8) | buf[i + 1];
    if (segLen < 2) break;
    const payloadStart = i + 2;
    const payloadEnd = i + segLen;
    if (payloadEnd > buf.length) break;
    if (marker === JPEG_MARKER_APP1 && segLen > 8) {
      // Check EXIF header.
      const tag = asciiAt(buf, payloadStart, 6);
      if (tag === 'Exif\0\0') {
        out.exif = true;
        out.tags.push('APP1/Exif');
        // Try to find a GPS IFD pointer (tag 0x8825 in IFD0).
        if (findGpsTagInExif(buf, payloadStart + 6)) {
          out.gps = true;
          out.tags.push('GPSInfo');
        }
      } else {
        // XMP segment: ASCII namespace URI then \0 then xpacket XML.
        const xmpHeader = asciiAt(buf, payloadStart, 29);
        if (xmpHeader.startsWith('http://ns.adobe.com/xap/1.0/')) {
          out.xmp = true;
          out.tags.push('APP1/XMP');
        }
      }
    } else if (marker === 0xFFE0 + 13 /* APP13 - Photoshop IRB / IPTC */) {
      // Some encoders smuggle XMP via APP13. Less common in JPEGs we'd emit,
      // but if it shows up, flag it.
      const tag = asciiAt(buf, payloadStart, 14);
      if (tag.startsWith('Photoshop 3.0')) {
        out.tags.push('APP13/Photoshop');
      }
    }
    i = payloadEnd;
  }
  return out;
}

// Inside an EXIF blob (starting at the TIFF header, post "Exif\0\0"), look
// for the GPSInfo (0x8825) tag in IFD0. Returns true if found.
//
// The TIFF header is:
//   bytes 0-1: byte order — 'II' (little-endian) or 'MM' (big-endian)
//   bytes 2-3: 0x002A magic
//   bytes 4-7: offset to IFD0 (from start of TIFF header)
//
// IFD0 entries are 12 bytes each, preceded by a 2-byte count.
function findGpsTagInExif(buf, tiffStart) {
  if (tiffStart + 8 > buf.length) return false;
  const bo = String.fromCharCode(buf[tiffStart], buf[tiffStart + 1]);
  const le = bo === 'II';
  if (!le && bo !== 'MM') return false;
  const read16 = (off) => le
    ? (buf[off] | (buf[off + 1] << 8))
    : ((buf[off] << 8) | buf[off + 1]);
  const read32 = (off) => le
    ? (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
    : ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  const magic = read16(tiffStart + 2);
  if (magic !== 0x002A) return false;
  const ifd0Off = read32(tiffStart + 4);
  const ifd0 = tiffStart + ifd0Off;
  if (ifd0 + 2 > buf.length) return false;
  const count = read16(ifd0);
  if (count < 0 || count > 1024) return false; // sanity
  for (let n = 0; n < count; n++) {
    const entry = ifd0 + 2 + n * 12;
    if (entry + 12 > buf.length) return false;
    const tag = read16(entry);
    if (tag === 0x8825) return true;
  }
  return false;
}

// --- PNG scanner ----------------------------------------------------------
//
// PNG is signature (8B) then a sequence of chunks. Each chunk:
//   4B length (BE) + 4B type (ASCII) + length B data + 4B CRC.
// Metadata chunks we look for:
//   - eXIf — EXIF block (2017 PNG spec amendment)
//   - tEXt / zTXt / iTXt — generic text. iTXt can carry XMP under keyword "XML:com.adobe.xmp"
//   - tIME — timestamp (we don't flag this; it's not personal info)
// We scan until IEND or the buffer ends.
function scanPng(buf) {
  const out = { exif: false, xmp: false, gps: false, format: 'png', tags: [] };
  let i = 8; // past signature
  while (i + 8 <= buf.length) {
    const len = (buf[i] << 24 | buf[i + 1] << 16 | buf[i + 2] << 8 | buf[i + 3]) >>> 0;
    const type = asciiAt(buf, i + 4, 4);
    if (type === 'IEND') break;
    const dataStart = i + 8;
    if (dataStart + len + 4 > buf.length) break;
    if (type === 'eXIf') {
      out.exif = true;
      out.tags.push('PNG/eXIf');
      // PNG eXIf is a raw TIFF stream (no "Exif\0\0" prefix per the spec).
      if (findGpsTagInExif(buf, dataStart)) {
        out.gps = true;
        out.tags.push('GPSInfo');
      }
    } else if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      // Read the keyword (null-terminated ASCII).
      let kwEnd = dataStart;
      while (kwEnd < dataStart + len && buf[kwEnd] !== 0) kwEnd++;
      const keyword = asciiAt(buf, dataStart, kwEnd - dataStart);
      if (keyword === 'XML:com.adobe.xmp' || /xmp/i.test(keyword)) {
        out.xmp = true;
        out.tags.push(`PNG/${type}:${keyword}`);
      } else if (keyword) {
        // Any other text chunk is still metadata; report it as a tag so the
        // verify UI can show it, but don't classify it as EXIF/XMP.
        out.tags.push(`PNG/${type}:${keyword}`);
      }
    }
    i = dataStart + len + 4;
  }
  return out;
}

// --- WebP scanner ---------------------------------------------------------
//
// WebP is a RIFF container:
//   "RIFF" + 4B size + "WEBP" + chunks
// Each chunk: 4B FOURCC + 4B size (LE) + payload (size bytes, pad to even).
// Metadata FOURCCs:
//   "EXIF" — raw TIFF stream (no "Exif\0\0" prefix in the WebP container)
//   "XMP " — UTF-8 XMP packet
/**
 * Extract the APP1/Exif segment from a JPEG blob, ready to splice into
 * another JPEG. Returns the raw bytes of the entire segment, INCLUDING the
 * FF E1 marker and the 2-byte length field — i.e. exactly what needs to be
 * dropped into a destination JPEG between the SOI and everything else.
 *
 * Returns null if the source isn't JPEG or has no APP1/Exif segment.
 *
 * Used by exporter.js when `state.export.stripMetadata === false` to carry
 * the source image's EXIF (camera model, timestamp, GPS, etc.) over into
 * the Canvas-encoded output. The default still strips, so users opt in
 * to preservation.
 *
 * @param {Blob} blob — the source image blob (typically a JPEG from the camera)
 * @returns {Promise<Uint8Array | null>}
 */
export async function extractExifSegment(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (detectFormat(buf) !== 'jpeg') return null;
  if (buf.length < 4) return null;
  if (((buf[0] << 8) | buf[1]) !== JPEG_SOI) return null;

  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) break;
    while (buf[i] === 0xFF && i < buf.length) i++;
    if (i >= buf.length) break;
    const marker = 0xFF00 | buf[i];
    i++;
    if (marker === JPEG_MARKER_SOS) break;
    if (marker === 0xFFD8 || marker === 0xFFD9 ||
        (marker >= 0xFFD0 && marker <= 0xFFD7)) {
      continue;
    }
    if (i + 2 > buf.length) break;
    const segLen = (buf[i] << 8) | buf[i + 1];
    if (segLen < 2) break;
    const segEnd = i + segLen;
    if (segEnd > buf.length) break;
    if (marker === JPEG_MARKER_APP1 && segLen > 8) {
      const tag = asciiAt(buf, i + 2, 6);
      if (tag === 'Exif\0\0') {
        // Slice includes marker (2B) + length (already counted by segLen) +
        // payload. i currently points at the length byte; rewind 2 to grab
        // the marker too.
        return buf.slice(i - 2, segEnd);
      }
    }
    i = segEnd;
  }
  return null;
}

/**
 * Splice an APP1/Exif segment into a JPEG blob. Inserts the segment right
 * after the SOI marker, dropping any existing APP1/Exif segment in the
 * destination (Canvas-encoded JPEGs won't have one, but we defend against
 * future encoders that might).
 *
 * Other JPEG markers (APP0/JFIF, quantisation tables, etc.) are preserved
 * unchanged — the output blob is identical to the input except for the
 * inserted EXIF.
 *
 * Returns the input blob unchanged if it isn't a JPEG (no-op fallback so
 * callers don't have to type-check; the toggle's "preserve metadata"
 * branch just does nothing for PNG/WebP outputs).
 *
 * @param {Blob} jpegBlob — destination JPEG (Canvas-encoded output)
 * @param {Uint8Array} exifSegment — segment bytes from extractExifSegment()
 * @returns {Promise<Blob>}
 */
export async function injectExifIntoJpeg(jpegBlob, exifSegment) {
  if (!jpegBlob || !exifSegment || exifSegment.length === 0) return jpegBlob;
  if (typeof jpegBlob.arrayBuffer !== 'function') return jpegBlob;
  const buf = new Uint8Array(await jpegBlob.arrayBuffer());
  if (detectFormat(buf) !== 'jpeg') return jpegBlob;
  if (buf.length < 4) return jpegBlob;
  if (((buf[0] << 8) | buf[1]) !== JPEG_SOI) return jpegBlob;

  // Walk segments looking for an existing APP1/Exif we'd want to replace.
  // For Canvas output this almost always returns null. For defensiveness we
  // still strip it before inserting our own.
  let cut = null;
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) break;
    while (buf[i] === 0xFF && i < buf.length) i++;
    if (i >= buf.length) break;
    const marker = 0xFF00 | buf[i];
    const markerStart = i - 1; // points at the 0xFF
    i++;
    if (marker === JPEG_MARKER_SOS) break;
    if (marker === 0xFFD8 || marker === 0xFFD9 ||
        (marker >= 0xFFD0 && marker <= 0xFFD7)) {
      continue;
    }
    if (i + 2 > buf.length) break;
    const segLen = (buf[i] << 8) | buf[i + 1];
    if (segLen < 2) break;
    const segEnd = i + segLen;
    if (segEnd > buf.length) break;
    if (marker === JPEG_MARKER_APP1 && segLen > 8) {
      const tag = asciiAt(buf, i + 2, 6);
      if (tag === 'Exif\0\0') {
        cut = { start: markerStart, end: segEnd };
        break;
      }
    }
    i = segEnd;
  }

  // Compose output: SOI + new EXIF + (rest, minus any existing EXIF segment).
  const parts = [];
  parts.push(buf.slice(0, 2)); // SOI
  parts.push(exifSegment);
  if (cut) {
    parts.push(buf.slice(2, cut.start));
    parts.push(buf.slice(cut.end));
  } else {
    parts.push(buf.slice(2));
  }
  // Concatenate. Total length avoids realloc grow-cost.
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return new Blob([out], { type: jpegBlob.type || 'image/jpeg' });
}

/**
 * Extract the EXIF payload from a HEIF/HEIC blob and return it as a JPEG
 * APP1 segment (ready to splice into a JPEG via injectExifIntoJpeg).
 *
 * Why this exists: HEIC importers (libheif) decode pixels into a raw bitmap
 * which we re-encode as PNG for downstream compatibility. The original
 * EXIF/GPS metadata lives in HEIF "meta" boxes, not in the bitmap, so it
 * disappears in the PNG round-trip. To preserve it for users who pick
 * "keep metadata" + export as JPEG, we extract it from the raw HEIC bytes
 * at import time, stash the segment on the image state, and inject it at
 * export time.
 *
 * HEIF is ISOBMFF (MP4-style boxes). Layout we care about:
 *   ftyp                       (file type)
 *   meta                       (full-box: 1B version + 3B flags + children)
 *     hdlr                     (handler; declares "pict" for HEIC)
 *     iinf                     (item info — list of infe entries by item_id)
 *     iloc                     (item locations — offset+length per item_id)
 *     iref / iprp / pitm       (irrelevant for EXIF)
 *
 * Finding EXIF:
 *   1. Walk infe entries; find the one with item_type == 'Exif' → get item_id
 *   2. Look up that item_id in iloc → file offset + length
 *   3. The data at that offset starts with a 4-byte big-endian "Exif prefix
 *      offset" (per the HEIF spec). Skip it; the remainder is a TIFF stream
 *      identical to what a JPEG APP1/Exif payload carries after "Exif\0\0".
 *   4. Wrap in JPEG APP1 framing: FF E1 + 2B length + "Exif\0\0" + TIFF.
 *
 * Returns null on any structural mismatch — robustness matters more than
 * exhaustive coverage here. The fallback path (no metadata preserved) is
 * always safe.
 *
 * @param {Blob} blob — HEIC/HEIF source blob
 * @returns {Promise<Uint8Array | null>}
 */
export async function extractExifFromHeif(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (!isHeifLike(buf)) return null;

  // 1. Locate the top-level `meta` box.
  const meta = findTopBox(buf, 'meta');
  if (!meta) return null;
  // `meta` is a full box: skip the 1B version + 3B flags before its children.
  const childrenStart = meta.contentStart + 4;
  if (childrenStart >= meta.end) return null;

  // 2. Inside meta, locate iinf + iloc.
  const iinf = findChildBox(buf, childrenStart, meta.end, 'iinf');
  const iloc = findChildBox(buf, childrenStart, meta.end, 'iloc');
  if (!iinf || !iloc) return null;

  // 3. Find the EXIF item's item_id in iinf.
  const exifItemId = findExifItemIdInIinf(buf, iinf);
  if (exifItemId == null) return null;

  // 4. Look up its offset + length in iloc.
  const loc = findItemLocationInIloc(buf, iloc, exifItemId);
  if (!loc || loc.length < 4) return null;

  // 5. Skip the leading 4-byte "Exif prefix offset" (HEIF convention).
  const tiffOffset = loc.offset + 4;
  const tiffLen = loc.length - 4;
  if (tiffOffset + tiffLen > buf.length || tiffLen <= 0) return null;

  // 6. Frame as a JPEG APP1/Exif segment.
  //    Layout:  [FF E1] [2B length] [Exif\0\0] [TIFF...]
  //    The JPEG "length" field counts itself + the payload, NOT the marker.
  //    Total bytes on the wire = 2 (marker) + length-field-value.
  const payloadLen = 6 + tiffLen;        // "Exif\0\0" + TIFF
  const segLen = 2 + payloadLen;          // length field counts itself + payload
  if (segLen > 0xFFFF) return null;       // JPEG segments cap at 64 KiB
  const out = new Uint8Array(2 + segLen); // marker (2) + length field's-worth of bytes
  out[0] = 0xFF;
  out[1] = 0xE1;
  out[2] = (segLen >> 8) & 0xFF;
  out[3] = segLen & 0xFF;
  out[4] = 0x45; out[5] = 0x78; out[6] = 0x69; out[7] = 0x66; out[8] = 0x00; out[9] = 0x00; // "Exif\0\0"
  out.set(buf.subarray(tiffOffset, tiffOffset + tiffLen), 10);
  return out;
}

// HEIF/HEIC sniff: must start with an `ftyp` box whose brand is a known HEIF
// variant. We accept the common brands phones emit: heic / heix / heim / heis
// / mif1 / msf1 / heif / heim / heis. Sufficient for the import path.
function isHeifLike(buf) {
  if (buf.length < 12) return false;
  if (buf[4] !== 0x66 || buf[5] !== 0x74 || buf[6] !== 0x79 || buf[7] !== 0x70) return false; // 'ftyp'
  const brand = asciiAt(buf, 8, 4);
  return /^(heic|heix|heim|heis|mif1|msf1|heif)$/i.test(brand);
}

// Walk top-level ISOBMFF boxes and return the first one matching `type`.
// Returns { type, start, contentStart, end } or null.
function findTopBox(buf, type) {
  let i = 0;
  while (i + 8 <= buf.length) {
    const box = readBoxHeader(buf, i);
    if (!box) return null;
    if (box.type === type) return box;
    i = box.end;
    if (box.end <= box.start) return null; // guard against zero-size loops
  }
  return null;
}

// Same as findTopBox but bounded to a sub-range — used for walking the
// children of `meta`.
function findChildBox(buf, start, end, type) {
  let i = start;
  while (i + 8 <= end) {
    const box = readBoxHeader(buf, i);
    if (!box) return null;
    if (box.end > end) return null;
    if (box.type === type) return box;
    i = box.end;
    if (box.end <= box.start) return null;
  }
  return null;
}

// Parse a single box header at `offset`. Returns null on malformed input.
function readBoxHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  const size = readU32BE(buf, offset);
  const type = asciiAt(buf, offset + 4, 4);
  let contentStart = offset + 8;
  let end;
  if (size === 1) {
    // 64-bit extended size in the next 8 bytes. We don't bother with the
    // upper 32 bits — single HEIC files >4 GiB don't exist in the wild.
    if (offset + 16 > buf.length) return null;
    const sizeHi = readU32BE(buf, offset + 8);
    const sizeLo = readU32BE(buf, offset + 12);
    if (sizeHi !== 0) return null; // bail on >4GB
    contentStart = offset + 16;
    end = offset + sizeLo;
  } else if (size === 0) {
    // "extends to end of file" — rare. Treat as the rest of the buffer.
    end = buf.length;
  } else {
    end = offset + size;
  }
  if (end > buf.length || end < contentStart) return null;
  return { type, start: offset, contentStart, end };
}

// iinf is a full-box wrapping a count + N `infe` entries. Each infe carries
// item_id + item_type. We scan for the entry whose item_type ASCII is
// 'Exif' and return its item_id.
//
// iinf structure:
//   1B version + 3B flags
//   if version == 0: 2B entry_count
//   else (1..N):     4B entry_count
//   then N × infe boxes
//
// infe structure (we only support v2+; v1 is from ISO/IEC 14496-12:2008 and
// is irrelevant for modern HEIC):
//   1B version + 3B flags
//   2B item_id (v2; 4B in v3)
//   2B item_protection_index
//   4B item_type (ASCII)
//   ...further fields we ignore.
function findExifItemIdInIinf(buf, iinf) {
  let p = iinf.contentStart;
  if (p + 4 > iinf.end) return null;
  const version = buf[p];
  p += 4; // version + flags
  let entryCount;
  if (version === 0) {
    if (p + 2 > iinf.end) return null;
    entryCount = (buf[p] << 8) | buf[p + 1];
    p += 2;
  } else {
    if (p + 4 > iinf.end) return null;
    entryCount = readU32BE(buf, p);
    p += 4;
  }
  for (let n = 0; n < entryCount && p < iinf.end; n++) {
    const entry = readBoxHeader(buf, p);
    if (!entry || entry.type !== 'infe') return null;
    if (entry.end > iinf.end) return null;
    const infeVersion = buf[entry.contentStart];
    let ip = entry.contentStart + 4; // skip version + flags
    let itemId;
    if (infeVersion < 3) {
      if (ip + 2 > entry.end) { p = entry.end; continue; }
      itemId = (buf[ip] << 8) | buf[ip + 1];
      ip += 2;
    } else {
      if (ip + 4 > entry.end) { p = entry.end; continue; }
      itemId = readU32BE(buf, ip);
      ip += 4;
    }
    // Skip item_protection_index (2 bytes).
    if (ip + 2 > entry.end) { p = entry.end; continue; }
    ip += 2;
    // item_type ASCII (4 bytes).
    if (ip + 4 > entry.end) { p = entry.end; continue; }
    const itemType = asciiAt(buf, ip, 4);
    if (itemType === 'Exif') return itemId;
    p = entry.end;
  }
  return null;
}

// iloc holds per-item file offsets + lengths. The encoding is dense: a
// small bitfield decides field widths (offset_size, length_size, etc.)
// and each item has a list of "extents" describing where its bytes live.
//
// We support the common subset HEIC files use:
//   - version 0 or 1
//   - offset_size = 4 or 8
//   - length_size = 4 or 8
//   - base_offset_size = 0, 4, or 8
//   - one extent per item (which is what every HEIC encoder writes)
function findItemLocationInIloc(buf, iloc, targetId) {
  let p = iloc.contentStart;
  if (p + 4 > iloc.end) return null;
  const version = buf[p];
  p += 4; // version + flags
  if (p + 2 > iloc.end) return null;
  const flags = (buf[p] << 8) | buf[p + 1];
  const offsetSize     = (flags >> 12) & 0xF;
  const lengthSize     = (flags >>  8) & 0xF;
  const baseOffsetSize = (flags >>  4) & 0xF;
  const indexSize      = version >= 1 ? (flags & 0xF) : 0;
  p += 2;

  if (offsetSize !== 4 && offsetSize !== 8) return null;
  if (lengthSize !== 4 && lengthSize !== 8) return null;
  if (baseOffsetSize !== 0 && baseOffsetSize !== 4 && baseOffsetSize !== 8) return null;

  let itemCount;
  if (version < 2) {
    if (p + 2 > iloc.end) return null;
    itemCount = (buf[p] << 8) | buf[p + 1];
    p += 2;
  } else {
    if (p + 4 > iloc.end) return null;
    itemCount = readU32BE(buf, p);
    p += 4;
  }
  for (let i = 0; i < itemCount; i++) {
    // item_id (2B in v0/v1, 4B in v2)
    let itemId;
    if (version < 2) {
      if (p + 2 > iloc.end) return null;
      itemId = (buf[p] << 8) | buf[p + 1];
      p += 2;
    } else {
      if (p + 4 > iloc.end) return null;
      itemId = readU32BE(buf, p);
      p += 4;
    }
    // v1+ has a 2-byte construction_method byte pair (high 12 bits reserved
    // + low 4 bits method). 0 = file offset, 1 = idat (extracted from idat
    // box), 2 = item offset. We only support method 0 (file offset).
    let constructionMethod = 0;
    if (version >= 1) {
      if (p + 2 > iloc.end) return null;
      constructionMethod = ((buf[p] << 8) | buf[p + 1]) & 0xF;
      p += 2;
    }
    if (p + 2 > iloc.end) return null;
    // data_reference_index — 0 means this file.
    p += 2;
    // base_offset
    let baseOffset = 0;
    if (baseOffsetSize > 0) {
      if (p + baseOffsetSize > iloc.end) return null;
      baseOffset = readUintBE(buf, p, baseOffsetSize);
      p += baseOffsetSize;
    }
    if (p + 2 > iloc.end) return null;
    const extentCount = (buf[p] << 8) | buf[p + 1];
    p += 2;
    let firstExtentOffset = 0;
    let firstExtentLength = 0;
    for (let e = 0; e < extentCount; e++) {
      if (version >= 1 && indexSize > 0) {
        p += indexSize; // extent_index — we skip
      }
      if (p + offsetSize > iloc.end) return null;
      const extentOffset = readUintBE(buf, p, offsetSize);
      p += offsetSize;
      if (p + lengthSize > iloc.end) return null;
      const extentLength = readUintBE(buf, p, lengthSize);
      p += lengthSize;
      if (e === 0) {
        firstExtentOffset = extentOffset;
        firstExtentLength = extentLength;
      }
      // Multi-extent items mean the EXIF is split across discontinuous
      // ranges — rare for camera HEICs. We bail rather than incorrectly
      // reassemble: returning null causes the export to fall back to
      // "no metadata preserved", which is still safe.
    }
    if (itemId === targetId) {
      if (constructionMethod !== 0) return null;
      if (extentCount !== 1) return null;
      return { offset: baseOffset + firstExtentOffset, length: firstExtentLength };
    }
  }
  return null;
}

function readU32BE(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function readUintBE(buf, offset, size) {
  if (size === 4) return readU32BE(buf, offset);
  if (size === 8) {
    // We already bail on >4 GiB elsewhere, so the upper 4 bytes are zero in
    // practice. Read lower 32 bits and assume zero upper.
    const hi = readU32BE(buf, offset);
    const lo = readU32BE(buf, offset + 4);
    if (hi !== 0) return Number.MAX_SAFE_INTEGER; // poison; caller bounds-check fails
    return lo;
  }
  // Fallback (shouldn't reach — guarded above).
  let v = 0;
  for (let i = 0; i < size; i++) v = (v << 8) | buf[offset + i];
  return v >>> 0;
}

function scanWebp(buf) {
  const out = { exif: false, xmp: false, gps: false, format: 'webp', tags: [] };
  if (buf.length < 12) return out;
  let i = 12;
  while (i + 8 <= buf.length) {
    const cc = asciiAt(buf, i, 4);
    const size = (buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24)) >>> 0;
    const payloadStart = i + 8;
    if (payloadStart + size > buf.length) break;
    if (cc === 'EXIF') {
      out.exif = true;
      out.tags.push('WebP/EXIF');
      if (findGpsTagInExif(buf, payloadStart)) {
        out.gps = true;
        out.tags.push('GPSInfo');
      }
    } else if (cc === 'XMP ') {
      out.xmp = true;
      out.tags.push('WebP/XMP');
    }
    // Chunks are aligned to 2-byte boundaries.
    const advance = size + (size % 2);
    i = payloadStart + advance;
  }
  return out;
}
