// js/ops/dedupe.js — pure logic for duplicate detection in the queue.
//
// Splits into two passes:
//   1. EXACT — group by SHA-256 of the source bytes. groupBySha256(items).
//   2. PERCEPTUAL — among the still-unmatched items, dHash on the
//      thumbnail and union-find by Hamming distance ≤ threshold.
//      clusterByDHash(items, threshold).
//
// All functions here are PURE — no DOM, no async, no I/O. The hashing
// happens elsewhere (in a Web Worker; see js/workers/dedupeWorker.js).
// Keeping the math pure means we can unit-test it without a browser.
//
// dHash representation:
//   { hi: int32, lo: int32 }  — 64 bits split into two unsigned 32-bit halves.
//   We avoid BigInt at hot-path call sites because xor + popcount on two
//   int32s is dramatically faster than BigInt arithmetic for clustering.

// --- dHash compute --------------------------------------------------------
//
// dHash = "difference hash". Given a 9×8 grayscale image (72 luminance
// values, row-major), compare each pixel to its right neighbor (8 comparisons
// per row × 8 rows = 64 bits). bit = 1 if lum[i] > lum[i+1], else 0.
//
// We keep this as a PURE function over a luminance array — the actual
// canvas-resize + RGBA-to-luminance step happens in the worker (because
// it needs OffscreenCanvas, which doesn't exist in node:test). That way
// this function is unit-testable without a browser.

/**
 * Compute the 64-bit dHash from a 9×8 luminance array (length 72).
 * Returns `{ hi: int32, lo: int32 }` matching the format hammingDistance
 * expects. Throws on bad input shape.
 *
 * @param {Uint8Array | Array<number>} lum — 72 grayscale values, row-major (9 cols × 8 rows).
 * @returns {{ hi: number, lo: number }}
 */
export function computeDHashFromLuminance(lum) {
  if (!lum || lum.length !== 72) {
    throw new Error('computeDHashFromLuminance: expected 72-element luminance array');
  }
  let hi = 0 | 0;
  let lo = 0 | 0;
  let bitIndex = 0;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const i = row * 9 + col;
      const bit = lum[i] > lum[i + 1] ? 1 : 0;
      if (bitIndex < 32) lo |= (bit << bitIndex);
      else               hi |= (bit << (bitIndex - 32));
      bitIndex++;
    }
  }
  // The bit-shifts above produce signed int32s; that's fine — popcount32
  // and hammingDistance treat them as unsigned internally.
  return { hi, lo };
}

/**
 * Convert a flat RGBA pixel array (length 72*4 = 288) to a 72-element
 * Uint8Array of luminance values. Uses BT.601 weights:
 *   Y = 0.299·R + 0.587·G + 0.114·B.
 *
 * @param {Uint8ClampedArray | Uint8Array | Array<number>} rgba
 * @returns {Uint8Array}
 */
export function rgbaToLuminance72(rgba) {
  if (!rgba || rgba.length < 72 * 4) {
    throw new Error('rgbaToLuminance72: expected at least 288 bytes (9×8 RGBA)');
  }
  const out = new Uint8Array(72);
  for (let i = 0; i < 72; i++) {
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    out[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return out;
}

/**
 * 32×32 luminance extractor for pHash. Same BT.601 weights as the 9×8
 * version; arity differs because pHash needs a wider DCT input.
 *
 * @param {Uint8ClampedArray | Uint8Array | Array<number>} rgba
 * @returns {Uint8Array}
 */
export function rgbaToLuminance1024(rgba) {
  if (!rgba || rgba.length < 1024 * 4) {
    throw new Error('rgbaToLuminance1024: expected at least 4096 bytes (32×32 RGBA)');
  }
  const out = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    out[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return out;
}

// --- pHash compute --------------------------------------------------------
//
// pHash = "perceptual hash". Algorithm:
//   1. Resize source to 32×32 grayscale (caller does this).
//   2. Compute 2D DCT (type II) of the 32×32 luminance matrix.
//   3. Take the top-left 8×8 block of coefficients — these encode the
//      lowest spatial frequencies, i.e. broad shape rather than fine
//      detail. This is what makes pHash robust to mild color shifts,
//      compression artifacts, and small crops.
//   4. Compute the median of those 64 coefficients EXCLUDING the DC term
//      at [0][0]. DC is the average brightness; it dominates and would
//      skew the median.
//   5. For each of the 64 coefficients (DC included this time), bit =
//      (coef > median) ? 1 : 0. That's the 64-bit hash.
//
// Compared to dHash:
//   - More robust to color grading / mild brightness shifts (DCT is
//     low-pass; high-frequency noise gets thrown away).
//   - More expensive (32×32 DCT vs 9×8 row-difference). ~3-5 ms per image
//     vs <1 ms for dHash.

// Precomputed cosine table for 32-point 1D DCT-II. Indexed as
// COS_TABLE_32[k * 32 + n] = cos(π/32 * (n + 0.5) * k).
const COS_TABLE_32 = (() => {
  const N = 32;
  const tbl = new Float32Array(N * N);
  for (let k = 0; k < N; k++) {
    for (let n = 0; n < N; n++) {
      tbl[k * N + n] = Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
  }
  return tbl;
})();

/** 1D DCT-II for a length-32 input. Allocates a Float32Array; cheap. */
function dct1D32(input) {
  const out = new Float32Array(32);
  for (let k = 0; k < 32; k++) {
    let sum = 0;
    const base = k * 32;
    for (let n = 0; n < 32; n++) {
      sum += input[n] * COS_TABLE_32[base + n];
    }
    out[k] = sum;
  }
  return out;
}

/** 2D DCT-II for a 32×32 input matrix (row-major Uint8Array). */
function dct2D32(matrix) {
  const N = 32;
  // Pass 1: DCT each row.
  const rowDCT = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    const row = new Float32Array(N);
    for (let n = 0; n < N; n++) row[n] = matrix[r * N + n];
    const out = dct1D32(row);
    for (let n = 0; n < N; n++) rowDCT[r * N + n] = out[n];
  }
  // Pass 2: DCT each column of the row-DCT result. We only need the
  // first 8 columns (since we'll only read top-left 8×8).
  const result = new Float32Array(8 * N);
  const colTmp = new Float32Array(N);
  for (let c = 0; c < 8; c++) {
    for (let r = 0; r < N; r++) colTmp[r] = rowDCT[r * N + c];
    const out = dct1D32(colTmp);
    // Store only the first 8 rows; we'll never read the rest.
    for (let r = 0; r < 8; r++) result[r * 8 + c] = out[r];
  }
  return result;
}

/**
 * Compute the 64-bit pHash from a 32×32 luminance array (length 1024).
 * Returns `{ hi: int32, lo: int32 }` matching the format hammingDistance
 * expects. Throws on bad input shape.
 *
 * @param {Uint8Array | Array<number>} lum — 1024 grayscale values, row-major.
 * @returns {{ hi: number, lo: number }}
 */
export function computePHashFromLuminance(lum) {
  if (!lum || lum.length !== 1024) {
    throw new Error('computePHashFromLuminance: expected 1024-element luminance array');
  }
  // Compute the 2D DCT. result is an 8×8 block (row-major).
  const block = dct2D32(lum);

  // Median over the 63 non-DC coefficients (skip block[0]).
  const nonDC = new Float32Array(63);
  for (let i = 1; i < 64; i++) nonDC[i - 1] = block[i];
  // sort() handles Float32Array.
  const sortable = Array.from(nonDC).sort((a, b) => a - b);
  const median = sortable[Math.floor(sortable.length / 2)];

  // Build 64-bit hash. DC included — it's almost always > median, so bit 0
  // is reliably 1 and contributes nothing to distance, but keeping it
  // matches standard pHash implementations.
  let hi = 0 | 0;
  let lo = 0 | 0;
  for (let i = 0; i < 64; i++) {
    const bit = block[i] > median ? 1 : 0;
    if (i < 32) lo |= (bit << i);
    else        hi |= (bit << (i - 32));
  }
  return { hi, lo };
}

// --- Hamming-distance math ------------------------------------------------

/** Count set bits in a 32-bit unsigned integer. Standard popcount. */
export function popcount32(x) {
  // Coerce to int32 — bitwise ops in JS truncate to int32 automatically,
  // but we mask the input first to guarantee the upper bits are zero.
  x = x | 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Hamming distance between two 64-bit dHashes (each as {hi, lo}).
 * Returns the number of differing bits, in 0..64.
 */
export function hammingDistance(a, b) {
  if (!a || !b) return 64;
  return popcount32((a.hi ^ b.hi) | 0) + popcount32((a.lo ^ b.lo) | 0);
}

// --- Clustering -----------------------------------------------------------

/**
 * Group items with byte-identical sha256 hashes. Items without a sha256
 * are dropped (not matched against anything). Returns an array of
 * arrays of IDs, where each inner array has length ≥ 2.
 *
 * @param {Array<{id: string, sha256: string}>} items
 * @returns {Array<Array<string>>}
 */
export function groupBySha256(items) {
  const buckets = new Map();
  for (const it of items) {
    if (!it || !it.sha256) continue;
    let arr = buckets.get(it.sha256);
    if (!arr) {
      arr = [];
      buckets.set(it.sha256, arr);
    }
    arr.push(it.id);
  }
  return [...buckets.values()].filter(g => g.length >= 2);
}

/**
 * Cluster items by perceptual dHash similarity. Union-find: if A matches
 * B and B matches C (each within threshold), all three end up in one
 * cluster even if A doesn't directly match C.
 *
 * Items missing a dhash are treated as non-matching (singletons, filtered
 * out of the result).
 *
 * @param {Array<{id: string, dhash: {hi:number, lo:number}}>} items
 * @param {number} threshold — Hamming distance (bits) up to which two
 *                              items are considered a match. Inclusive.
 * @returns {Array<Array<string>>} — groups of ≥ 2 IDs each.
 */
export function clusterByDHash(items, threshold) {
  if (!Array.isArray(items) || items.length < 2) return [];
  const t = Number.isFinite(threshold) ? threshold : 8;
  // Drop items without dhash up-front; their index in the work array
  // would mess up union-find without contributing matches.
  const work = items.filter(it => it && it.dhash);
  if (work.length < 2) return [];

  // Union-find with path compression.
  const parent = new Array(work.length);
  for (let i = 0; i < work.length; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // O(N²) — fine for queue sizes up to a few thousand. For 5000+ we'd
  // need locality-sensitive hashing; deferred.
  for (let i = 0; i < work.length; i++) {
    for (let j = i + 1; j < work.length; j++) {
      if (hammingDistance(work[i].dhash, work[j].dhash) <= t) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < work.length; i++) {
    const r = find(i);
    let arr = groups.get(r);
    if (!arr) {
      arr = [];
      groups.set(r, arr);
    }
    arr.push(work[i].id);
  }
  return [...groups.values()].filter(g => g.length >= 2);
}

/**
 * Cluster items by perceptual similarity using BOTH dHash and pHash.
 * Two items match if EITHER hash is within `threshold` Hamming distance.
 * Mirrors clusterByDHash's union-find structure; preferred over the
 * dHash-only variant since the two hashes complement each other:
 *   - dHash catches identical-content-different-encoding pairs cleanly.
 *   - pHash catches mildly color-graded / re-cropped pairs that dHash
 *     misses (it's robust to broad brightness/contrast shifts because
 *     the DCT discards high-frequency noise).
 * The OR-match means we get the union of both passes' coverage with a
 * single union-find walk instead of running two clusterings and merging.
 *
 * @param {Array<{id: string, dhash?: {hi:number,lo:number}, phash?: {hi:number,lo:number}}>} items
 * @param {number} threshold — Hamming distance (bits) up to which two
 *                              items are considered a match. Inclusive.
 * @returns {Array<Array<string>>} — groups of ≥ 2 IDs each.
 */
export function clusterByPerceptual(items, threshold) {
  if (!Array.isArray(items) || items.length < 2) return [];
  const t = Number.isFinite(threshold) ? threshold : 8;
  const work = items.filter(it => it && (it.dhash || it.phash));
  if (work.length < 2) return [];

  const parent = new Array(work.length);
  for (let i = 0; i < work.length; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const matchesEither = (a, b) => {
    if (a.dhash && b.dhash && hammingDistance(a.dhash, b.dhash) <= t) return true;
    if (a.phash && b.phash && hammingDistance(a.phash, b.phash) <= t) return true;
    return false;
  };

  for (let i = 0; i < work.length; i++) {
    for (let j = i + 1; j < work.length; j++) {
      if (matchesEither(work[i], work[j])) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < work.length; i++) {
    const r = find(i);
    let arr = groups.get(r);
    if (!arr) { arr = []; groups.set(r, arr); }
    arr.push(work[i].id);
  }
  return [...groups.values()].filter(g => g.length >= 2);
}

/**
 * Map of sensitivity preset → Hamming-distance threshold.
 * Exported so the UI dropdown and the cluster pass agree.
 */
export const SENSITIVITY_THRESHOLDS = Object.freeze({
  strict: 4,
  normal: 8,
  loose:  16,
});

export function thresholdFor(sensitivity) {
  if (sensitivity in SENSITIVITY_THRESHOLDS) return SENSITIVITY_THRESHOLDS[sensitivity];
  return SENSITIVITY_THRESHOLDS.normal;
}

// --- Keeper selection -----------------------------------------------------

/**
 * Pick the "keeper" within a duplicate cluster. Rule:
 *   1. Highest pixel count (width × height) wins.
 *   2. Tiebreaker: larger file size in bytes.
 *   3. Final tiebreaker: lowest queue position (i.e., earliest in the
 *      user's existing order — stable, deterministic).
 *
 * `getMeta(id)` returns `{ pixelCount, byteSize, queuePosition }`.
 *
 * @param {Array<string>} clusterIds
 * @param {(id: string) => {pixelCount: number, byteSize: number, queuePosition: number}} getMeta
 * @returns {string | null} — the keeper's id, or null if cluster is empty.
 */
export function pickKeeper(clusterIds, getMeta) {
  if (!Array.isArray(clusterIds) || clusterIds.length === 0) return null;
  if (typeof getMeta !== 'function') return clusterIds[0];

  let bestId = null;
  let bestMeta = null;
  for (const id of clusterIds) {
    const m = getMeta(id) || {};
    const pixelCount    = Number.isFinite(m.pixelCount)    ? m.pixelCount    : 0;
    const byteSize      = Number.isFinite(m.byteSize)      ? m.byteSize      : 0;
    const queuePosition = Number.isFinite(m.queuePosition) ? m.queuePosition : Number.MAX_SAFE_INTEGER;

    if (bestId === null) {
      bestId = id;
      bestMeta = { pixelCount, byteSize, queuePosition };
      continue;
    }
    // 1. Higher pixel count wins.
    if (pixelCount > bestMeta.pixelCount) {
      bestId = id;
      bestMeta = { pixelCount, byteSize, queuePosition };
      continue;
    }
    if (pixelCount < bestMeta.pixelCount) continue;
    // 2. Tie on pixels — larger file size wins.
    if (byteSize > bestMeta.byteSize) {
      bestId = id;
      bestMeta = { pixelCount, byteSize, queuePosition };
      continue;
    }
    if (byteSize < bestMeta.byteSize) continue;
    // 3. Tie on pixels and bytes — earliest queue position wins.
    if (queuePosition < bestMeta.queuePosition) {
      bestId = id;
      bestMeta = { pixelCount, byteSize, queuePosition };
    }
  }
  return bestId;
}

// --- Queue reorder helper -------------------------------------------------

/**
 * Reorder a queue (array of image IDs) so that duplicate-cluster members
 * sit adjacent to one another. The cluster is anchored at the queue
 * position of its FIRST member (smallest original queue index). Within a
 * cluster, the keeper comes first, then other members in their original
 * queue order. Non-clustered items stay at their original positions
 * (with gaps closed automatically by the rebuild).
 *
 * @param {Array<string>} originalOrder — queue IDs in their original order.
 * @param {Array<Array<string>>} clusters — duplicate clusters.
 * @param {Set<string>} keeperIds — IDs that are keepers (sorted first within their cluster).
 * @returns {Array<string>} — new queue order.
 */
export function reorderQueueByCluster(originalOrder, clusters, keeperIds) {
  if (!Array.isArray(originalOrder) || originalOrder.length === 0) return [];
  if (!Array.isArray(clusters) || clusters.length === 0) return originalOrder.slice();

  // Build: clusterAnchorIndex → sorted member IDs
  // Anchor = smallest queue index among cluster members.
  const idToOrigIndex = new Map();
  for (let i = 0; i < originalOrder.length; i++) idToOrigIndex.set(originalOrder[i], i);

  const idToClusterIdx = new Map();
  const clusterAnchor = new Array(clusters.length);
  const clusterSorted = new Array(clusters.length);

  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    let anchor = Infinity;
    for (const id of cluster) {
      idToClusterIdx.set(id, ci);
      const oi = idToOrigIndex.get(id);
      if (oi !== undefined && oi < anchor) anchor = oi;
    }
    clusterAnchor[ci] = anchor;
    // Sort members: keepers first (in original order), then non-keepers (in original order).
    const keepers    = cluster.filter(id => keeperIds && keeperIds.has(id));
    const nonKeepers = cluster.filter(id => !(keeperIds && keeperIds.has(id)));
    const byOrig = (a, b) => (idToOrigIndex.get(a) ?? 0) - (idToOrigIndex.get(b) ?? 0);
    keepers.sort(byOrig);
    nonKeepers.sort(byOrig);
    clusterSorted[ci] = keepers.concat(nonKeepers);
  }

  // Walk the original order. When we hit a cluster anchor, emit the
  // whole cluster (sorted) and mark its members as emitted.
  const emitted = new Set();
  const out = [];
  for (let i = 0; i < originalOrder.length; i++) {
    const id = originalOrder[i];
    if (emitted.has(id)) continue;
    const ci = idToClusterIdx.get(id);
    if (ci !== undefined && clusterAnchor[ci] === i) {
      // We're at the anchor — emit the cluster.
      for (const memberId of clusterSorted[ci]) {
        if (!emitted.has(memberId)) {
          out.push(memberId);
          emitted.add(memberId);
        }
      }
    } else if (ci === undefined) {
      // Non-clustered — emit at original position.
      out.push(id);
      emitted.add(id);
    }
    // Items that ARE clustered but are not at the anchor get skipped here
    // because the anchor pass emits them. Their original positions are
    // closed up automatically.
  }
  return out;
}
