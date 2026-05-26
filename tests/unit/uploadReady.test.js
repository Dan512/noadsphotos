// tests/unit/uploadReady.test.js — pure logic for v1.3 Feature 9
// (upload-ready preset).
//
// Covers:
//   - shouldDownscale: skip-resize logic when source is already small enough
//   - applyFilenameTemplate with the upload-ready default template
//   - sanitizeUploadReady config validation (rejects nonsense longEdge /
//     out-of-range quality / unknown format)
//
// The end-to-end "encode + ZIP" path is covered by the existing exporter
// tests (which already exercise renderForExport + JSZip); this file pins
// the small pure helpers the preset adds on top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDownscale } from '../../js/ops/uploadReady.js';
import { sanitizeUploadReady } from '../../js/state.js';
import { applyFilenameTemplate } from '../../js/exporter.js';

// --- shouldDownscale ------------------------------------------------------

test('shouldDownscale: source long edge > target → true', () => {
  assert.equal(shouldDownscale(4000, 3000, 1920), true);
  assert.equal(shouldDownscale(3000, 4000, 1920), true);  // portrait
  assert.equal(shouldDownscale(1921, 1080, 1920), true);  // 1 px over
});

test('shouldDownscale: source long edge ≤ target → false (skip resize)', () => {
  assert.equal(shouldDownscale(1920, 1080, 1920), false); // exactly at target
  assert.equal(shouldDownscale(800, 600, 1920), false);   // well under
  assert.equal(shouldDownscale(100, 100, 1920), false);   // tiny
});

test('shouldDownscale: invalid inputs → false (safe — no resize attempt)', () => {
  // We don't want to attempt a resize on garbage dims; default to "leave it".
  assert.equal(shouldDownscale(0, 0, 1920), false);
  assert.equal(shouldDownscale(-1, 100, 1920), false);
  assert.equal(shouldDownscale(NaN, 100, 1920), false);
  assert.equal(shouldDownscale(100, 100, 0), false);     // target zero
  assert.equal(shouldDownscale(100, 100, NaN), false);
});

// --- applyFilenameTemplate with upload-ready defaults --------------------

test('applyFilenameTemplate: default `{base}-edited` produces base-edited.jpg', () => {
  const img = { source: { name: 'IMG_0001.JPG' } };
  const out = applyFilenameTemplate('{base}-edited', img, 0, 'jpeg', 1);
  assert.equal(out, 'IMG_0001-edited.jpg');
});

test('applyFilenameTemplate: `{base}-{n}` batch fills zero-padded index', () => {
  const img = { source: { name: 'photo.png' } };
  // 12-image queue → indices padded to 2 digits.
  const out = applyFilenameTemplate('{base}-{n}', img, 4, 'webp', 12);
  assert.equal(out, 'photo-05.webp');
});

// --- sanitizeUploadReady --------------------------------------------------

test('sanitizeUploadReady: missing input → defaults', () => {
  assert.deepEqual(sanitizeUploadReady(null), {
    longEdge: 1920,
    format: 'jpeg',
    quality: 0.85,
    stripExif: true,
    filenameTemplate: '{base}-edited',
  });
  assert.deepEqual(sanitizeUploadReady(undefined), sanitizeUploadReady(null));
  assert.deepEqual(sanitizeUploadReady('garbage'), sanitizeUploadReady(null));
});

test('sanitizeUploadReady: rejects out-of-range longEdge', () => {
  // Negative, zero, too-small, too-large, NaN all fall back to default.
  assert.equal(sanitizeUploadReady({ longEdge: -1 }).longEdge, 1920);
  assert.equal(sanitizeUploadReady({ longEdge: 0 }).longEdge, 1920);
  assert.equal(sanitizeUploadReady({ longEdge: 32 }).longEdge, 1920);     // below 64 floor
  assert.equal(sanitizeUploadReady({ longEdge: 999999 }).longEdge, 1920); // above 16384 ceiling
  assert.equal(sanitizeUploadReady({ longEdge: 'not a number' }).longEdge, 1920);
  // Valid values are kept (rounded).
  assert.equal(sanitizeUploadReady({ longEdge: 2048 }).longEdge, 2048);
  assert.equal(sanitizeUploadReady({ longEdge: 1500.7 }).longEdge, 1501);
});

test('sanitizeUploadReady: rejects out-of-range quality / unknown format', () => {
  assert.equal(sanitizeUploadReady({ quality: -0.5 }).quality, 0.85);
  assert.equal(sanitizeUploadReady({ quality: 0.10 }).quality, 0.85); // below 0.20 floor
  assert.equal(sanitizeUploadReady({ quality: 1.5 }).quality, 0.85);  // above 1.00 ceiling
  assert.equal(sanitizeUploadReady({ quality: 0.55 }).quality, 0.55);
  // Format must be one of the known three.
  assert.equal(sanitizeUploadReady({ format: 'tiff' }).format, 'jpeg');
  assert.equal(sanitizeUploadReady({ format: 'png' }).format, 'png');
  assert.equal(sanitizeUploadReady({ format: 'webp' }).format, 'webp');
});

test('sanitizeUploadReady: preserves valid filenameTemplate, rejects empty / huge', () => {
  assert.equal(sanitizeUploadReady({ filenameTemplate: '' }).filenameTemplate, '{base}-edited');
  assert.equal(sanitizeUploadReady({ filenameTemplate: 'x'.repeat(500) }).filenameTemplate, '{base}-edited');
  assert.equal(sanitizeUploadReady({ filenameTemplate: '{base}-web' }).filenameTemplate, '{base}-web');
});
