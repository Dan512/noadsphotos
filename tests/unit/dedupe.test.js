// tests/unit/dedupe.test.js — pure logic for v1.2 Feature 7 (find duplicates).
//
// Covers:
//   - popcount32 against a reference table.
//   - hammingDistance on edge cases (identical, fully-flipped, half).
//   - groupBySha256: groups, singletons, missing hashes.
//   - clusterByDHash: transitivity, threshold boundary, missing hashes.
//   - SENSITIVITY_THRESHOLDS / thresholdFor: known values + fallback.
//   - pickKeeper: pixel-count primary, byte-size tiebreaker, queue-position final.
//   - reorderQueueByCluster: cluster anchoring, keeper-first ordering, non-clustered preservation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  popcount32,
  hammingDistance,
  groupBySha256,
  clusterByDHash,
  clusterByPerceptual,
  SENSITIVITY_THRESHOLDS,
  thresholdFor,
  pickKeeper,
  reorderQueueByCluster,
  computeDHashFromLuminance,
  computePHashFromLuminance,
  rgbaToLuminance72,
  rgbaToLuminance1024,
} from '../../js/ops/dedupe.js';

// ---------------------------------------------------------------- popcount32

test('popcount32: 0 has 0 bits set', () => {
  assert.equal(popcount32(0), 0);
});

test('popcount32: 1 has 1 bit set', () => {
  assert.equal(popcount32(1), 1);
});

test('popcount32: 0xff has 8 bits set', () => {
  assert.equal(popcount32(0xff), 8);
});

test('popcount32: 0xffffffff has 32 bits set', () => {
  // JS bitwise truncates to signed int32, so >>>0 just to assert the
  // function treats it as unsigned.
  assert.equal(popcount32(0xffffffff | 0), 32);
});

test('popcount32: 0x55555555 has 16 bits set', () => {
  assert.equal(popcount32(0x55555555 | 0), 16);
});

test('popcount32: sign-bit position is counted correctly', () => {
  // -1 in two's-complement int32 is 0xffffffff → 32 bits set.
  // The function should treat input as unsigned for popcount purposes.
  assert.equal(popcount32(-1), 32);
});

// ------------------------------------------------------------ hammingDistance

test('hammingDistance: identical hashes → 0', () => {
  const a = { hi: 0x12345678 | 0, lo: 0x9abcdef0 | 0 };
  assert.equal(hammingDistance(a, a), 0);
});

test('hammingDistance: all-zeros vs all-ones → 64', () => {
  const zero = { hi: 0, lo: 0 };
  const one  = { hi: 0xffffffff | 0, lo: 0xffffffff | 0 };
  assert.equal(hammingDistance(zero, one), 64);
});

test('hammingDistance: half-flipped → 32', () => {
  const a = { hi: 0,                 lo: 0x55555555 | 0 };
  const b = { hi: 0,                 lo: 0xaaaaaaaa | 0 };
  // Lo halves are bitwise complements over 32 bits → 32 differences.
  assert.equal(hammingDistance(a, b), 32);
});

test('hammingDistance: null inputs → 64', () => {
  assert.equal(hammingDistance(null, { hi: 0, lo: 0 }), 64);
  assert.equal(hammingDistance({ hi: 0, lo: 0 }, null), 64);
});

// -------------------------------------------------------------- groupBySha256

test('groupBySha256: groups two identical hashes', () => {
  const items = [
    { id: 'a', sha256: 'aaa' },
    { id: 'b', sha256: 'aaa' },
    { id: 'c', sha256: 'bbb' },
  ];
  const groups = groupBySha256(items);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['a', 'b']);
});

test('groupBySha256: skips singletons', () => {
  const items = [
    { id: 'a', sha256: 'aaa' },
    { id: 'b', sha256: 'bbb' },
    { id: 'c', sha256: 'ccc' },
  ];
  assert.deepEqual(groupBySha256(items), []);
});

test('groupBySha256: forms 3-way group when all match', () => {
  const items = [
    { id: 'a', sha256: 'x' },
    { id: 'b', sha256: 'x' },
    { id: 'c', sha256: 'x' },
  ];
  const groups = groupBySha256(items);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['a', 'b', 'c']);
});

test('groupBySha256: ignores items missing sha256', () => {
  const items = [
    { id: 'a', sha256: null },
    { id: 'b', sha256: undefined },
    { id: 'c', sha256: 'shared' },
    { id: 'd', sha256: 'shared' },
  ];
  const groups = groupBySha256(items);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['c', 'd']);
});

test('groupBySha256: empty input → empty result', () => {
  assert.deepEqual(groupBySha256([]), []);
});

// ------------------------------------------------------------ clusterByDHash

test('clusterByDHash: identical hashes cluster together', () => {
  const items = [
    { id: 'a', dhash: { hi: 0, lo: 0 } },
    { id: 'b', dhash: { hi: 0, lo: 0 } },
    { id: 'c', dhash: { hi: 0xffffffff | 0, lo: 0xffffffff | 0 } }, // 64 apart → no match at any reasonable threshold
  ];
  const groups = clusterByDHash(items, 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['a', 'b']);
});

test('clusterByDHash: transitivity (A~B~C even if A and C are at threshold edge)', () => {
  // A and B differ by 4 bits (in lo). B and C differ by 4 bits (in lo).
  // A and C may differ by 8 bits. At threshold 8, all three cluster
  // via B.
  const items = [
    { id: 'A', dhash: { hi: 0, lo: 0x00 } },
    { id: 'B', dhash: { hi: 0, lo: 0x0f } },        // 4 bits diff vs A
    { id: 'C', dhash: { hi: 0, lo: 0xf0 } },        // 4 bits diff vs B's same byte
  ];
  // hamming(A, B) = popcount(0x0f) = 4
  // hamming(B, C) = popcount(0xff) = 8 — at the edge
  // At threshold 8, B↔C qualifies; A↔B too; A↔C is 4 bits direct (popcount(0xf0) = 4).
  // So all three trivially cluster directly. Tweak to actually exercise transitivity:
  const items2 = [
    { id: 'A', dhash: { hi: 0, lo: 0x00 } },
    { id: 'B', dhash: { hi: 0, lo: 0x0f } },        // 4 bits vs A
    { id: 'C', dhash: { hi: 0, lo: 0xff } },        // 4 bits vs B, 8 bits vs A
  ];
  const groups = clusterByDHash(items2, 5);
  // At threshold 5: A↔B (4) ✓, B↔C (4) ✓, A↔C (8) ✗. Union via B → all 3 in one cluster.
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['A', 'B', 'C']);
});

test('clusterByDHash: threshold boundary is inclusive', () => {
  const items = [
    { id: 'a', dhash: { hi: 0, lo: 0x00 } },
    { id: 'b', dhash: { hi: 0, lo: 0x0f } },        // 4 bits apart
  ];
  // At threshold 4 (exactly): should match.
  assert.equal(clusterByDHash(items, 4).length, 1);
  // At threshold 3: should NOT match.
  assert.equal(clusterByDHash(items, 3).length, 0);
});

test('clusterByDHash: items missing dhash are skipped', () => {
  const items = [
    { id: 'a', dhash: null },
    { id: 'b', dhash: undefined },
    { id: 'c', dhash: { hi: 0, lo: 0 } },
    { id: 'd', dhash: { hi: 0, lo: 0 } },
  ];
  const groups = clusterByDHash(items, 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['c', 'd']);
});

test('clusterByDHash: empty input → empty result', () => {
  assert.deepEqual(clusterByDHash([], 4), []);
});

test('clusterByDHash: single item → no cluster (need ≥ 2)', () => {
  assert.deepEqual(clusterByDHash([{ id: 'a', dhash: { hi: 0, lo: 0 } }], 4), []);
});

test('clusterByDHash: invalid threshold falls back to 8', () => {
  // dhash for a and b differ by 7 bits. At default 8 they should match.
  const items = [
    { id: 'a', dhash: { hi: 0, lo: 0x00 } },
    { id: 'b', dhash: { hi: 0, lo: 0x7f } },  // 7 bits
  ];
  assert.equal(clusterByDHash(items, NaN).length, 1);
  assert.equal(clusterByDHash(items, undefined).length, 1);
});

// ----------------------------------------------------------- thresholdFor

test('thresholdFor: known presets', () => {
  assert.equal(thresholdFor('strict'), 4);
  assert.equal(thresholdFor('normal'), 8);
  assert.equal(thresholdFor('loose'), 16);
});

test('thresholdFor: unknown → normal fallback', () => {
  assert.equal(thresholdFor('whatever'), 8);
  assert.equal(thresholdFor(null), 8);
  assert.equal(thresholdFor(undefined), 8);
});

test('SENSITIVITY_THRESHOLDS is frozen', () => {
  assert.throws(() => { SENSITIVITY_THRESHOLDS.strict = 99; }, TypeError);
});

// ----------------------------------------------------------- pickKeeper

test('pickKeeper: highest pixel count wins', () => {
  const meta = {
    a: { pixelCount: 100,  byteSize: 1000, queuePosition: 0 },
    b: { pixelCount: 1000, byteSize: 500,  queuePosition: 1 },
    c: { pixelCount: 500,  byteSize: 2000, queuePosition: 2 },
  };
  assert.equal(pickKeeper(['a', 'b', 'c'], (id) => meta[id]), 'b');
});

test('pickKeeper: byte size tiebreaker when pixel counts equal', () => {
  const meta = {
    a: { pixelCount: 1000, byteSize: 500,  queuePosition: 0 },
    b: { pixelCount: 1000, byteSize: 2000, queuePosition: 1 },
    c: { pixelCount: 1000, byteSize: 1000, queuePosition: 2 },
  };
  assert.equal(pickKeeper(['a', 'b', 'c'], (id) => meta[id]), 'b');
});

test('pickKeeper: queue position final tiebreaker (earliest wins)', () => {
  const meta = {
    a: { pixelCount: 1000, byteSize: 1000, queuePosition: 2 },
    b: { pixelCount: 1000, byteSize: 1000, queuePosition: 0 },
    c: { pixelCount: 1000, byteSize: 1000, queuePosition: 1 },
  };
  assert.equal(pickKeeper(['a', 'b', 'c'], (id) => meta[id]), 'b');
});

test('pickKeeper: empty cluster → null', () => {
  assert.equal(pickKeeper([], () => ({})), null);
});

test('pickKeeper: missing getMeta returns first id', () => {
  assert.equal(pickKeeper(['a', 'b'], null), 'a');
});

test('pickKeeper: missing meta values default to 0 pixels / 0 bytes / max position', () => {
  // a has no meta; b has full meta. b wins on pixels.
  const meta = {
    b: { pixelCount: 100, byteSize: 100, queuePosition: 1 },
  };
  assert.equal(pickKeeper(['a', 'b'], (id) => meta[id]), 'b');
});

// ------------------------------------------------------- reorderQueueByCluster

test('reorderQueueByCluster: empty queue → empty result', () => {
  assert.deepEqual(reorderQueueByCluster([], [], new Set()), []);
});

test('reorderQueueByCluster: no clusters → original order unchanged', () => {
  const orig = ['a', 'b', 'c', 'd'];
  assert.deepEqual(reorderQueueByCluster(orig, [], new Set()), orig);
});

test('reorderQueueByCluster: single cluster pulled adjacent at anchor', () => {
  // Original: A, B, C, D, E   (C is dup of A → cluster anchored at A)
  // Expected: A, C, B, D, E   (cluster {A, C} at position of A; keeper A first)
  const orig = ['A', 'B', 'C', 'D', 'E'];
  const clusters = [['A', 'C']];
  const keepers = new Set(['A']);
  assert.deepEqual(
    reorderQueueByCluster(orig, clusters, keepers),
    ['A', 'C', 'B', 'D', 'E'],
  );
});

test('reorderQueueByCluster: keeper sorts first within cluster', () => {
  // Original: A, B, C, D   (B is keeper, A and C are dups)
  // Anchor = A (smallest original index in cluster).
  // Within cluster: keeper B first, then A, then C (original order).
  const orig = ['A', 'B', 'C', 'D'];
  const clusters = [['A', 'B', 'C']];
  const keepers = new Set(['B']);
  assert.deepEqual(
    reorderQueueByCluster(orig, clusters, keepers),
    ['B', 'A', 'C', 'D'],
  );
});

test('reorderQueueByCluster: multiple clusters, each anchored independently', () => {
  // Original: A1, A2, B1, X, B2, Y
  // Cluster 1: A1, A2 (A1 keeper, anchored at A1=0). Cluster 2: B1, B2 (B1 keeper, anchored at B1=2).
  // Expected: A1, A2, B1, B2, X, Y  (B2 pulled adjacent to B1; X and Y close up)
  const orig = ['A1', 'A2', 'B1', 'X', 'B2', 'Y'];
  const clusters = [['A1', 'A2'], ['B1', 'B2']];
  const keepers = new Set(['A1', 'B1']);
  assert.deepEqual(
    reorderQueueByCluster(orig, clusters, keepers),
    ['A1', 'A2', 'B1', 'B2', 'X', 'Y'],
  );
});

test('reorderQueueByCluster: non-clustered items preserve their relative order', () => {
  const orig = ['p', 'A', 'q', 'r', 'B', 's'];
  const clusters = [['A', 'B']];
  const keepers = new Set(['A']);
  // Cluster anchored at A (index 1). Emit p (pre-anchor), then [A, B] together, then q, r, s.
  assert.deepEqual(
    reorderQueueByCluster(orig, clusters, keepers),
    ['p', 'A', 'B', 'q', 'r', 's'],
  );
});

// ------------------------------------------- computeDHashFromLuminance

test('computeDHashFromLuminance: all-equal luminance → all-zero hash', () => {
  // When every pixel equals its right neighbor, no comparison yields >,
  // so every bit is 0.
  const lum = new Uint8Array(72).fill(128);
  const h = computeDHashFromLuminance(lum);
  assert.equal(h.hi, 0);
  assert.equal(h.lo, 0);
});

test('computeDHashFromLuminance: strictly increasing row → all-zero hash', () => {
  // Each row [0,1,2,...,8] — every pixel is LESS than its right neighbor,
  // so `lum[i] > lum[i+1]` is false for every comparison.
  const lum = new Uint8Array(72);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) lum[r * 9 + c] = c;
  }
  const h = computeDHashFromLuminance(lum);
  assert.equal(h.hi, 0);
  assert.equal(h.lo, 0);
});

test('computeDHashFromLuminance: strictly decreasing row → all-one hash', () => {
  // Each row [8,7,...,0] — every pixel is GREATER than its right neighbor,
  // so every bit is 1 → both halves are 0xffffffff (popcount = 32 each).
  const lum = new Uint8Array(72);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) lum[r * 9 + c] = 8 - c;
  }
  const h = computeDHashFromLuminance(lum);
  assert.equal(popcount32(h.hi), 32);
  assert.equal(popcount32(h.lo), 32);
});

test('computeDHashFromLuminance: rejects wrong-length input', () => {
  assert.throws(() => computeDHashFromLuminance(new Uint8Array(71)));
  assert.throws(() => computeDHashFromLuminance(null));
});

test('computeDHashFromLuminance: similar luminance arrays produce small Hamming distance', () => {
  // Same pattern, but with a single pixel perturbed: should flip at most
  // ~2 bits (the two comparisons that pixel participates in).
  const lumA = new Uint8Array(72);
  for (let i = 0; i < 72; i++) lumA[i] = (i * 7) % 256; // arbitrary pattern
  const lumB = new Uint8Array(lumA);
  lumB[35] = lumB[35] ^ 0xff;  // dramatic flip on one pixel
  const ha = computeDHashFromLuminance(lumA);
  const hb = computeDHashFromLuminance(lumB);
  // The perturbed pixel participates in at most 2 bit comparisons (i=34→35 and i=35→36).
  // So hamming distance should be 0, 1, or 2.
  assert.ok(hammingDistance(ha, hb) <= 2);
});

// ------------------------------------------- computePHashFromLuminance

test('computePHashFromLuminance: rejects wrong-length input', () => {
  assert.throws(() => computePHashFromLuminance(new Uint8Array(1023)));
  assert.throws(() => computePHashFromLuminance(null));
});

test('computePHashFromLuminance: identical inputs → identical hashes', () => {
  const lumA = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) lumA[i] = (i * 13) & 0xff; // arbitrary pattern
  const lumB = new Uint8Array(lumA);
  const ha = computePHashFromLuminance(lumA);
  const hb = computePHashFromLuminance(lumB);
  assert.equal(hammingDistance(ha, hb), 0);
});

test('computePHashFromLuminance: small perturbation → small Hamming distance', () => {
  const lumA = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) lumA[i] = (i * 11) & 0xff;
  const lumB = new Uint8Array(lumA);
  // Flip a handful of pixels — should change LOW-FREQUENCY DCT a bit but
  // not catastrophically. Expect distance well under 32 (50% of bits).
  for (let i = 100; i < 110; i++) lumB[i] = (lumB[i] + 50) & 0xff;
  const ha = computePHashFromLuminance(lumA);
  const hb = computePHashFromLuminance(lumB);
  assert.ok(hammingDistance(ha, hb) < 32);
});

test('computePHashFromLuminance: unrelated noise patterns → large Hamming distance', () => {
  const lumA = new Uint8Array(1024);
  const lumB = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    lumA[i] = (i * 17 + 7) & 0xff;     // one pattern
    lumB[i] = (i * 41 + 200) & 0xff;   // unrelated pattern
  }
  const ha = computePHashFromLuminance(lumA);
  const hb = computePHashFromLuminance(lumB);
  // Large but bounded by 64.
  assert.ok(hammingDistance(ha, hb) > 16);
  assert.ok(hammingDistance(ha, hb) <= 64);
});

// ------------------------------------------- clusterByPerceptual

test('clusterByPerceptual: clusters via dHash even when phash differs', () => {
  const items = [
    { id: 'a', dhash: { hi: 0, lo: 0 }, phash: { hi: 0, lo: 0x12345678 | 0 } },
    { id: 'b', dhash: { hi: 0, lo: 0 }, phash: { hi: 0, lo: 0x87654321 | 0 } }, // very different phash, identical dhash
  ];
  const groups = clusterByPerceptual(items, 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['a', 'b']);
});

test('clusterByPerceptual: clusters via pHash even when dhash differs', () => {
  const items = [
    { id: 'a', dhash: { hi: 0, lo: 0x12345678 | 0 }, phash: { hi: 0, lo: 0 } },
    { id: 'b', dhash: { hi: 0, lo: 0x87654321 | 0 }, phash: { hi: 0, lo: 0 } }, // very different dhash, identical phash
  ];
  const groups = clusterByPerceptual(items, 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['a', 'b']);
});

test('clusterByPerceptual: missing dhash/phash falls back to the other', () => {
  const items = [
    { id: 'a', dhash: { hi: 0, lo: 0 } },                // pHash missing
    { id: 'b', dhash: { hi: 0, lo: 0 } },                // pHash missing
    { id: 'c', phash: { hi: 0, lo: 0 } },                // dHash missing
    { id: 'd', phash: { hi: 0, lo: 0 } },                // dHash missing
  ];
  const groups = clusterByPerceptual(items, 4);
  // a+b cluster via dhash. c+d cluster via phash. Not a+b+c+d (a has no
  // phash to compare against c's phash, etc).
  assert.equal(groups.length, 2);
});

test('clusterByPerceptual: items with neither hash are dropped', () => {
  const items = [
    { id: 'a' },
    { id: 'b', dhash: { hi: 0, lo: 0 } },
    { id: 'c', dhash: { hi: 0, lo: 0 } },
  ];
  const groups = clusterByPerceptual(items, 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['b', 'c']);
});

// --------------------------------------------------- rgbaToLuminance1024

test('rgbaToLuminance1024: pure-white → 255', () => {
  const rgba = new Uint8ClampedArray(1024 * 4).fill(255);
  const lum = rgbaToLuminance1024(rgba);
  assert.equal(lum[0], 255);
  assert.equal(lum[1023], 255);
});

test('rgbaToLuminance1024: rejects short input', () => {
  assert.throws(() => rgbaToLuminance1024(new Uint8Array(100)));
  assert.throws(() => rgbaToLuminance1024(null));
});

// --------------------------------------------------- rgbaToLuminance72

test('rgbaToLuminance72: pure-white pixel → 255 luminance', () => {
  const rgba = new Uint8ClampedArray(72 * 4).fill(255);
  // Alpha=255 too but ignored.
  const lum = rgbaToLuminance72(rgba);
  // 0.299*255 + 0.587*255 + 0.114*255 = 255.
  assert.equal(lum[0], 255);
  assert.equal(lum[71], 255);
});

test('rgbaToLuminance72: pure-black → 0 luminance', () => {
  const rgba = new Uint8ClampedArray(72 * 4); // zeros
  const lum = rgbaToLuminance72(rgba);
  assert.equal(lum[0], 0);
  assert.equal(lum[71], 0);
});

test('rgbaToLuminance72: pure-red (255,0,0) → 76 luminance', () => {
  // 0.299 * 255 = 76.245 → truncate to 76.
  const rgba = new Uint8ClampedArray(72 * 4);
  for (let i = 0; i < 72; i++) rgba[i * 4 + 0] = 255;
  const lum = rgbaToLuminance72(rgba);
  assert.equal(lum[0], 76);
});

test('rgbaToLuminance72: rejects short input', () => {
  assert.throws(() => rgbaToLuminance72(new Uint8Array(100)));
  assert.throws(() => rgbaToLuminance72(null));
});

test('reorderQueueByCluster: 3-item cluster, all keepers → all sort by original', () => {
  const orig = ['x', 'A', 'B', 'C', 'y'];
  const clusters = [['A', 'B', 'C']];
  const keepers = new Set(['A', 'B', 'C']);
  // All keepers → all sort first by original order within. Result: A, B, C all adjacent at A's anchor.
  assert.deepEqual(
    reorderQueueByCluster(orig, clusters, keepers),
    ['x', 'A', 'B', 'C', 'y'],
  );
});
