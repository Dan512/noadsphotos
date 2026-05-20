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
