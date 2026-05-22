// tests/unit/exif.test.js — unit tests for the metadata detector.
//
// The detector lives in js/exif.js. It's a hand-rolled parser that walks
// JPEG markers, PNG chunks, and WebP RIFF chunks looking for EXIF, XMP, and
// GPS evidence. We DO NOT decode any payloads — only detect presence.
//
// Fixtures here are SYNTHESIZED in-memory rather than committed as binary
// files. JPEG/PNG/WebP have small well-defined headers; building a sample
// from scratch keeps the test self-contained and lets us assert what's in
// the bytes WITHOUT depending on a third-party encoder being installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Blob is available in Node 24 globally. arrayBuffer() is supported.
import { hasMetadata, extractExifSegment, injectExifIntoJpeg, extractExifFromHeif } from '../../js/exif.js';

// --- Fixture builders ---------------------------------------------------
//
// All builders return a Uint8Array. We wrap in a Blob at the call site
// because Blob.arrayBuffer() is what hasMetadata() consumes.

// JPEG with EXIF (and optionally GPS) in APP1. Body = a single FFD9 EOI
// after the APP1. Not a valid image otherwise, but the detector doesn't
// decode pixels — it just walks markers.
function buildJpegWithExif({ withGps = false } = {}) {
  // TIFF header: little-endian, magic 0x002A, IFD0 offset = 8
  // IFD0 entry count + entries — each entry is 12 B. We use 1 entry without
  // GPS and 2 entries with GPS (orientation + GPSInfo pointer).
  const entries = [];
  // Orientation tag (0x0112), short (3), count 1, value 1
  entries.push([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
  if (withGps) {
    // GPSInfo tag (0x8825), long (4), count 1, value 0 (just a pointer
    // sentinel — we never follow it).
    entries.push([0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  const count = entries.length;
  const tiff = [
    0x49, 0x49,                   // II (LE)
    0x2A, 0x00,                   // magic
    0x08, 0x00, 0x00, 0x00,       // IFD0 offset = 8
    count & 0xFF, (count >> 8) & 0xFF,  // entry count
  ];
  for (const e of entries) tiff.push(...e);
  // Next-IFD offset = 0
  tiff.push(0, 0, 0, 0);

  // APP1 payload = "Exif\0\0" then TIFF stream
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  // Segment length includes the 2-byte length itself.
  const segLen = payload.length + 2;

  return Uint8Array.from([
    0xFF, 0xD8,                                       // SOI
    0xFF, 0xE1,                                       // APP1
    (segLen >> 8) & 0xFF, segLen & 0xFF,              // length
    ...payload,
    0xFF, 0xD9,                                       // EOI
  ]);
}

// JPEG with XMP in APP1 (Adobe's standard namespace).
function buildJpegWithXmp() {
  const NS = 'http://ns.adobe.com/xap/1.0/\0';
  const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
  const payload = [];
  for (const ch of NS) payload.push(ch.charCodeAt(0));
  for (const ch of XMP) payload.push(ch.charCodeAt(0));
  const segLen = payload.length + 2;
  return Uint8Array.from([
    0xFF, 0xD8,
    0xFF, 0xE1,
    (segLen >> 8) & 0xFF, segLen & 0xFF,
    ...payload,
    0xFF, 0xD9,
  ]);
}

// Minimal clean JPEG: SOI + APP0 (JFIF) + EOI. No EXIF, no XMP.
function buildJpegClean() {
  // APP0 / JFIF segment, length 16, identifier "JFIF\0", version 1.01, etc.
  return Uint8Array.from([
    0xFF, 0xD8,
    0xFF, 0xE0,
    0x00, 0x10,                                       // length 16
    0x4A, 0x46, 0x49, 0x46, 0x00,                     // "JFIF\0"
    0x01, 0x01,                                       // version
    0x00,                                             // units
    0x00, 0x01, 0x00, 0x01,                           // density
    0x00, 0x00,                                       // thumbnail wh
    0xFF, 0xD9,
  ]);
}

// PNG with an eXIf chunk. Signature + IHDR + eXIf + IEND. We don't compute
// real CRCs (the detector doesn't validate them).
function buildPngWithExif({ withGps = false } = {}) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const ihdr = chunk('IHDR', [
    0, 0, 0, 1,   // width 1
    0, 0, 0, 1,   // height 1
    8, 6, 0, 0, 0, // bit depth, color type, etc.
  ]);
  // PNG eXIf chunk: raw TIFF stream (no "Exif\0\0" prefix).
  const tiff = [];
  const entries = [];
  entries.push([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
  if (withGps) {
    entries.push([0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  tiff.push(0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00);
  tiff.push(entries.length & 0xFF, (entries.length >> 8) & 0xFF);
  for (const e of entries) tiff.push(...e);
  tiff.push(0, 0, 0, 0);
  const exifChunk = chunk('eXIf', tiff);
  const iend = chunk('IEND', []);
  return Uint8Array.from([...sig, ...ihdr, ...exifChunk, ...iend]);
}

// PNG with an iTXt chunk carrying XMP.
function buildPngWithXmp() {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  // iTXt structure:
  //   keyword (1-79B Latin-1) \0
  //   compression flag (1B) \0
  //   compression method (1B)
  //   language tag (Latin-1) \0
  //   translated keyword (UTF-8) \0
  //   text (UTF-8)
  const keyword = 'XML:com.adobe.xmp';
  const text = '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>';
  const body = [];
  for (const ch of keyword) body.push(ch.charCodeAt(0));
  body.push(0);   // keyword null
  body.push(0);   // compression flag
  body.push(0);   // compression method
  body.push(0);   // language null
  body.push(0);   // translated keyword null
  for (const ch of text) body.push(ch.charCodeAt(0));
  const iTxt = chunk('iTXt', body);
  const iend = chunk('IEND', []);
  return Uint8Array.from([...sig, ...ihdr, ...iTxt, ...iend]);
}

// Minimal clean PNG: signature + IHDR + IEND. No text/eXIf.
function buildPngClean() {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const iend = chunk('IEND', []);
  return Uint8Array.from([...sig, ...ihdr, ...iend]);
}

// PNG chunk: [4B length BE][4B type ASCII][data][4B CRC zero].
function chunk(type, data) {
  const len = data.length;
  const out = [
    (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF,
    type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3),
    ...data,
    0, 0, 0, 0, // CRC — detector doesn't verify
  ];
  return out;
}

// WebP with an EXIF chunk. RIFF header + VP8 stub + EXIF.
function buildWebpWithExif({ withGps = false } = {}) {
  const tiff = [];
  const entries = [];
  entries.push([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
  if (withGps) {
    entries.push([0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }
  tiff.push(0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00);
  tiff.push(entries.length & 0xFF, (entries.length >> 8) & 0xFF);
  for (const e of entries) tiff.push(...e);
  tiff.push(0, 0, 0, 0);

  // VP8 (stub): just a 4-byte payload — content doesn't matter for the
  // detector, only its size and the EXIF chunk after it.
  const vp8Payload = [0, 0, 0, 0];
  const vp8Chunk = webpChunk('VP8 ', vp8Payload);
  const exifChunk = webpChunk('EXIF', tiff);

  // RIFF outer
  const body = [...stringBytes('WEBP'), ...vp8Chunk, ...exifChunk];
  return Uint8Array.from([
    ...stringBytes('RIFF'),
    body.length & 0xFF, (body.length >> 8) & 0xFF,
    (body.length >> 16) & 0xFF, (body.length >> 24) & 0xFF,
    ...body,
  ]);
}

function buildWebpWithXmp() {
  const xmp = '<x:xmpmeta/>';
  const xmpBytes = [];
  for (const ch of xmp) xmpBytes.push(ch.charCodeAt(0));
  const vp8Payload = [0, 0, 0, 0];
  const vp8Chunk = webpChunk('VP8 ', vp8Payload);
  const xmpChunk = webpChunk('XMP ', xmpBytes);
  const body = [...stringBytes('WEBP'), ...vp8Chunk, ...xmpChunk];
  return Uint8Array.from([
    ...stringBytes('RIFF'),
    body.length & 0xFF, (body.length >> 8) & 0xFF,
    (body.length >> 16) & 0xFF, (body.length >> 24) & 0xFF,
    ...body,
  ]);
}

function buildWebpClean() {
  const vp8Payload = [0, 0, 0, 0];
  const vp8Chunk = webpChunk('VP8 ', vp8Payload);
  const body = [...stringBytes('WEBP'), ...vp8Chunk];
  return Uint8Array.from([
    ...stringBytes('RIFF'),
    body.length & 0xFF, (body.length >> 8) & 0xFF,
    (body.length >> 16) & 0xFF, (body.length >> 24) & 0xFF,
    ...body,
  ]);
}

function webpChunk(fourcc, data) {
  const size = data.length;
  const padded = (size % 2 === 0) ? data : [...data, 0];
  return [
    fourcc.charCodeAt(0), fourcc.charCodeAt(1), fourcc.charCodeAt(2), fourcc.charCodeAt(3),
    size & 0xFF, (size >> 8) & 0xFF, (size >> 16) & 0xFF, (size >> 24) & 0xFF,
    ...padded,
  ];
}

function stringBytes(s) {
  const out = [];
  for (const ch of s) out.push(ch.charCodeAt(0));
  return out;
}

function blobOf(bytes) {
  return new Blob([bytes], { type: 'application/octet-stream' });
}

// --- Tests --------------------------------------------------------------

test('hasMetadata: returns unknown for empty or non-blob input', async () => {
  const empty = blobOf(new Uint8Array([]));
  const r1 = await hasMetadata(empty);
  assert.equal(r1.format, 'unknown');
  assert.equal(r1.exif, false);
  assert.equal(r1.xmp, false);
  assert.equal(r1.gps, false);

  const r2 = await hasMetadata(null);
  assert.equal(r2.format, 'unknown');
});

test('hasMetadata: clean JPEG has no metadata', async () => {
  const r = await hasMetadata(blobOf(buildJpegClean()));
  assert.equal(r.format, 'jpeg');
  assert.equal(r.exif, false);
  assert.equal(r.xmp, false);
  assert.equal(r.gps, false);
  assert.deepEqual(r.tags, []);
});

test('hasMetadata: JPEG with EXIF flags exif=true, gps=false', async () => {
  const r = await hasMetadata(blobOf(buildJpegWithExif({ withGps: false })));
  assert.equal(r.format, 'jpeg');
  assert.equal(r.exif, true);
  assert.equal(r.xmp, false);
  assert.equal(r.gps, false);
  assert.ok(r.tags.includes('APP1/Exif'));
});

test('hasMetadata: JPEG with EXIF + GPSInfo flags gps=true', async () => {
  const r = await hasMetadata(blobOf(buildJpegWithExif({ withGps: true })));
  assert.equal(r.format, 'jpeg');
  assert.equal(r.exif, true);
  assert.equal(r.gps, true);
  assert.ok(r.tags.includes('GPSInfo'));
});

test('hasMetadata: JPEG with XMP flags xmp=true', async () => {
  const r = await hasMetadata(blobOf(buildJpegWithXmp()));
  assert.equal(r.format, 'jpeg');
  assert.equal(r.xmp, true);
  assert.equal(r.exif, false);
  assert.ok(r.tags.includes('APP1/XMP'));
});

test('hasMetadata: clean PNG has no metadata', async () => {
  const r = await hasMetadata(blobOf(buildPngClean()));
  assert.equal(r.format, 'png');
  assert.equal(r.exif, false);
  assert.equal(r.xmp, false);
  assert.equal(r.gps, false);
  assert.deepEqual(r.tags, []);
});

test('hasMetadata: PNG with eXIf chunk flags exif=true', async () => {
  const r = await hasMetadata(blobOf(buildPngWithExif({ withGps: false })));
  assert.equal(r.format, 'png');
  assert.equal(r.exif, true);
  assert.equal(r.gps, false);
  assert.ok(r.tags.includes('PNG/eXIf'));
});

test('hasMetadata: PNG with eXIf + GPSInfo flags gps=true', async () => {
  const r = await hasMetadata(blobOf(buildPngWithExif({ withGps: true })));
  assert.equal(r.format, 'png');
  assert.equal(r.exif, true);
  assert.equal(r.gps, true);
});

test('hasMetadata: PNG with iTXt XMP flags xmp=true', async () => {
  const r = await hasMetadata(blobOf(buildPngWithXmp()));
  assert.equal(r.format, 'png');
  assert.equal(r.xmp, true);
  assert.ok(r.tags.some(t => t.startsWith('PNG/iTXt')));
});

test('hasMetadata: clean WebP has no metadata', async () => {
  const r = await hasMetadata(blobOf(buildWebpClean()));
  assert.equal(r.format, 'webp');
  assert.equal(r.exif, false);
  assert.equal(r.xmp, false);
  assert.equal(r.gps, false);
});

test('hasMetadata: WebP with EXIF chunk flags exif=true', async () => {
  const r = await hasMetadata(blobOf(buildWebpWithExif({ withGps: false })));
  assert.equal(r.format, 'webp');
  assert.equal(r.exif, true);
  assert.equal(r.gps, false);
  assert.ok(r.tags.includes('WebP/EXIF'));
});

test('hasMetadata: WebP with EXIF + GPSInfo flags gps=true', async () => {
  const r = await hasMetadata(blobOf(buildWebpWithExif({ withGps: true })));
  assert.equal(r.format, 'webp');
  assert.equal(r.exif, true);
  assert.equal(r.gps, true);
});

test('hasMetadata: WebP with XMP chunk flags xmp=true', async () => {
  const r = await hasMetadata(blobOf(buildWebpWithXmp()));
  assert.equal(r.format, 'webp');
  assert.equal(r.xmp, true);
  assert.equal(r.exif, false);
  assert.ok(r.tags.includes('WebP/XMP'));
});

// --- v1.1.2: extract / inject EXIF round-trip --------------------------

test('extractExifSegment: returns the APP1 bytes for a JPEG with EXIF', async () => {
  const bytes = buildJpegWithExif({ withGps: true });
  const segment = await extractExifSegment(blobOf(bytes));
  assert.ok(segment, 'segment should not be null');
  // First two bytes are the FF E1 APP1 marker.
  assert.equal(segment[0], 0xFF);
  assert.equal(segment[1], 0xE1);
  // After marker + 2B length, the payload starts with "Exif\0\0".
  assert.equal(segment[4], 0x45); // E
  assert.equal(segment[5], 0x78); // x
  assert.equal(segment[6], 0x69); // i
  assert.equal(segment[7], 0x66); // f
  assert.equal(segment[8], 0x00);
  assert.equal(segment[9], 0x00);
});

test('extractExifSegment: returns null for a clean JPEG with no EXIF', async () => {
  const segment = await extractExifSegment(blobOf(buildJpegClean()));
  assert.equal(segment, null);
});

test('extractExifSegment: returns null for non-JPEG input', async () => {
  const segment = await extractExifSegment(blobOf(buildPngClean()));
  assert.equal(segment, null);
});

test('injectExifIntoJpeg: round-trips through a clean JPEG so hasMetadata sees the EXIF + GPS', async () => {
  // Extract from a fixture with GPS, inject into a clean target, then
  // detect — closes the loop on the exporter's preserve-metadata path.
  const sourceSegment = await extractExifSegment(blobOf(buildJpegWithExif({ withGps: true })));
  assert.ok(sourceSegment, 'source segment must extract');
  const cleanJpeg = blobOf(buildJpegClean());
  const merged = await injectExifIntoJpeg(cleanJpeg, sourceSegment);
  const report = await hasMetadata(merged);
  assert.equal(report.format, 'jpeg');
  assert.equal(report.exif, true);
  assert.equal(report.gps, true);
});

test('injectExifIntoJpeg: no-op for non-JPEG input (defensive fallback)', async () => {
  const sourceSegment = await extractExifSegment(blobOf(buildJpegWithExif()));
  assert.ok(sourceSegment, 'source segment must extract');
  const png = blobOf(buildPngClean());
  const result = await injectExifIntoJpeg(png, sourceSegment);
  // injectExifIntoJpeg returns the input blob unchanged when format !== JPEG.
  // The "unchanged" check is structural: same byte count, same first bytes.
  const inBytes  = new Uint8Array(await png.arrayBuffer());
  const outBytes = new Uint8Array(await result.arrayBuffer());
  assert.equal(outBytes.length, inBytes.length);
  for (let i = 0; i < 8; i++) assert.equal(outBytes[i], inBytes[i]);
});

// --- v1.1.2: extractExifFromHeif ---------------------------------------
//
// Full HEIF fixture-from-scratch is complex (ISOBMFF box tree, iinf + iloc
// encoding, etc.). We assert basic robustness here — the parser must
// return null for non-HEIF input rather than throwing. The full
// round-trip is covered by the browser spec (exif-strip.spec.js) using
// real HEIC files when those land.

test('extractExifFromHeif: returns null for non-HEIF input (JPEG)', async () => {
  const segment = await extractExifFromHeif(blobOf(buildJpegWithExif()));
  assert.equal(segment, null);
});

test('extractExifFromHeif: returns null for non-HEIF input (PNG)', async () => {
  const segment = await extractExifFromHeif(blobOf(buildPngClean()));
  assert.equal(segment, null);
});

test('extractExifFromHeif: returns null on a tiny/malformed file', async () => {
  const tinyBlob = new Blob([new Uint8Array([0, 1, 2])]);
  const segment = await extractExifFromHeif(tinyBlob);
  assert.equal(segment, null);
});

test('extractExifFromHeif: parses a synthesized minimal HEIF file', async () => {
  // Build the smallest HEIF container our parser accepts. Structure:
  //   ftyp(brand=mif1)
  //   meta(full-box: 1B ver=0 + 3B flags=0)
  //     iinf v0 with 1 infe v2 entry → item_id=1, item_type='Exif'
  //     iloc v0: 1 item → item_id=1, offset=mdat_payload_start, length=N
  //   mdat: [4-byte EXIF prefix offset = 0] + [TIFF stream with GPSInfo]
  //
  // Box header = 4B size + 4B type.
  // We compute sizes in two passes: first lay out children with placeholder
  // offsets, then patch the iloc's "offset" field with the real mdat position.

  // 1. EXIF TIFF stream (with GPSInfo tag), same as the JPEG fixture's
  //    inner payload. The 4-byte prefix below puts it at offset 0 of the
  //    EXIF item — HEIF requires this even when there's no prefix.
  const tiff = Uint8Array.from([
    0x49, 0x49, 0x2A, 0x00,                        // II + magic
    0x08, 0x00, 0x00, 0x00,                        // IFD0 offset = 8
    0x01, 0x00,                                    // entry count = 1
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,                        // GPSInfo
    0x00, 0x00, 0x00, 0x00,                        // next IFD = 0
  ]);
  const exifItemPayload = new Uint8Array(4 + tiff.length);
  // First 4 bytes = "offset to TIFF header within this item". Zero is fine.
  exifItemPayload.set(tiff, 4);

  // 2. mdat box: header (8B) + payload.
  const mdat = makeBox('mdat', exifItemPayload);

  // 3. iinf v0 with 1 infe v2:
  //    infe v2 layout: 1B ver=2 + 3B flags + 2B item_id + 2B prot_idx +
  //                    4B item_type ('Exif') + 1B null terminator for name
  const infe = makeBox('infe', new Uint8Array([
    0x02, 0x00, 0x00, 0x00,                  // version 2 + flags
    0x00, 0x01,                              // item_id = 1
    0x00, 0x00,                              // protection_index = 0
    0x45, 0x78, 0x69, 0x66,                  // item_type 'Exif'
    0x00,                                    // empty item_name (null terminated)
  ]));
  const iinfPayload = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),  // v0 + flags + entry_count (uint16 = 1)
    infe,
  );
  const iinf = makeBox('iinf', iinfPayload);

  // 4. iloc v0 with 1 item — placeholder offset, patched below.
  //    Layout (v0): 1B ver + 3B flags + 2B flags(field-size bitfield):
  //                 offset_size=4, length_size=4, base_offset_size=0
  //    Then 2B item_count, and per-item:
  //                 2B item_id + 2B data_ref_index + 0B base_offset +
  //                 2B extent_count + (4B offset + 4B length)
  const ilocPayload = new Uint8Array(16);
  // version + flags
  // bytes 0-3: version 0 + 3B flags = 0
  // bytes 4-5: size bitfield = 0x4400 (offset_size=4, length_size=4, base_off=0, index=0)
  ilocPayload[4] = 0x44;
  ilocPayload[5] = 0x00;
  // bytes 6-7: item_count = 1
  ilocPayload[6] = 0x00; ilocPayload[7] = 0x01;
  // bytes 8-9: item_id = 1
  ilocPayload[8] = 0x00; ilocPayload[9] = 0x01;
  // bytes 10-11: data_reference_index = 0
  ilocPayload[10] = 0x00; ilocPayload[11] = 0x00;
  // bytes 12-13: extent_count = 1
  ilocPayload[12] = 0x00; ilocPayload[13] = 0x01;
  // bytes 14-17 will be the offset (patched), 18-21 the length
  // (we'll resize below)
  const ilocFullPayload = new Uint8Array(22);
  ilocFullPayload.set(ilocPayload.subarray(0, 14), 0);
  // length = exifItemPayload.length
  writeU32BE(ilocFullPayload, 18, exifItemPayload.length);

  // 5. meta box (full-box) wrapping iinf + iloc.
  // Full-box prefix = 4 bytes (1B ver + 3B flags).
  const metaInner = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00]), // ver + flags
    iinf,
    ilocFullPayload.subarray(0, 0), // placeholder — we'll insert iloc after we know offset
  );
  // We can't compute mdat's offset until we know the meta+ftyp size. So:
  // ftyp + (meta header 8 + metaInnerSize) + iloc box ...
  // Easier: precompute layouts and patch the iloc offset at the end.

  const ftyp = makeBox('ftyp', new Uint8Array([
    0x6D, 0x69, 0x66, 0x31,                  // major_brand 'mif1'
    0x00, 0x00, 0x00, 0x00,                  // minor_version
    0x6D, 0x69, 0x66, 0x31,                  // compatible_brand 'mif1'
  ]));

  // Build iloc box header now (we'll patch the offset within it).
  const ilocBox = makeBox('iloc', ilocFullPayload);

  // Assemble meta = full-box prefix + iinf + iloc.
  const metaPayload = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    iinf,
    ilocBox,
  );
  const metaBox = makeBox('meta', metaPayload);

  // Final file = ftyp + meta + mdat. Compute mdat-content offset.
  const mdatContentOffset = ftyp.length + metaBox.length + 8; // 8 = mdat header
  // Patch the iloc's offset field. Find it: ftyp.length + 8 (meta header) +
  // 4 (full-box prefix) + iinf.length + 8 (iloc header) + 14 = offset slot.
  const ilocOffsetSlot = ftyp.length + 8 + 4 + iinf.length + 8 + 14;
  const file = concat(ftyp, metaBox, mdat);
  writeU32BE(file, ilocOffsetSlot, mdatContentOffset);

  // Sanity: parser should now find + extract the EXIF segment.
  const segment = await extractExifFromHeif(blobOf(file));
  assert.ok(segment, 'segment should be extracted from synthesized HEIF');
  // JPEG APP1 framing: FF E1 + length + "Exif\0\0" + TIFF
  assert.equal(segment[0], 0xFF);
  assert.equal(segment[1], 0xE1);
  assert.equal(segment[4], 0x45); // E
  assert.equal(segment[5], 0x78); // x
  // The wrapped TIFF should be byte-identical to the source TIFF.
  for (let i = 0; i < tiff.length; i++) {
    assert.equal(segment[10 + i], tiff[i], `TIFF byte ${i} should round-trip`);
  }
});

// Helpers for the HEIF fixture builder.
function makeBox(type, payload) {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  writeU32BE(out, 0, size);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function writeU32BE(buf, offset, value) {
  buf[offset]     = (value >>> 24) & 0xFF;
  buf[offset + 1] = (value >>> 16) & 0xFF;
  buf[offset + 2] = (value >>> 8)  & 0xFF;
  buf[offset + 3] = value          & 0xFF;
}
