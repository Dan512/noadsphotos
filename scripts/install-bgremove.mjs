#!/usr/bin/env node
// scripts/install-bgremove.mjs — fetches the @imgly/background-removal data
// chunks + onnxruntime-web ESM bundle into js/vendor/, mirroring img.ly's
// content-addressable chunked layout exactly. Run this when bumping the
// @imgly version. Idempotent: chunks that already exist with the right
// sha256 are skipped.
//
// What this script does, end-to-end:
//   1. Fetches `resources.json` from staticimgly.com for the configured
//      @imgly version.
//   2. Downloads each chunk listed under the kept keys (CPU + WebGPU model +
//      both wasm kernel variants + their ESM glue) into js/vendor/bgremove/,
//      named by sha256 hash.
//   3. Verifies each chunk against the hash in `resources.json`.
//   4. Writes a TRIMMED `resources.json` into js/vendor/bgremove/ containing
//      ONLY the keys we vendor.
//   5. `npm pack`'s onnxruntime-web at the version pinned by @imgly's
//      peerDependencies and copies BOTH `dist/ort.bundle.min.mjs` (CPU
//      execution provider) AND `dist/ort.webgpu.bundle.min.mjs` (WebGPU
//      execution provider) into js/vendor/onnxruntime-web/.
//
// Run with: `node scripts/install-bgremove.mjs`.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

// ----- Configuration -------------------------------------------------------
const IMGLY_VERSION = '1.7.0';
// Keys to vendor. We ship BOTH CPU and WebGPU/JSEP kernel variants so the
// runtime can pick the right path at boot time without a follow-up fetch.
//   - `/models/isnet_fp16`                                  → segmentation model (~88 MB)
//   - `/onnxruntime-web/ort-wasm-simd-threaded.{wasm,mjs}`  → CPU SIMD kernel (~12 MB)
//   - `/onnxruntime-web/ort-wasm-simd-threaded.jsep.{wasm,mjs}` → WebGPU/JSEP kernel (~23 MB)
const KEEP_KEYS = new Set([
  '/models/isnet_fp16',
  '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.mjs',
  '/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs',
]);
// Pinned peer dependency. If you bump IMGLY_VERSION, check the new package's
// peerDependencies field — see `node_modules/@imgly/background-removal/package.json`.
const ORT_VERSION = '1.21.0';

const CDN_BASE = `https://staticimgly.com/@imgly/background-removal-data/${IMGLY_VERSION}/dist/`;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BGREMOVE_DIR = path.join(PROJECT_ROOT, 'js', 'vendor', 'bgremove');
const ORT_DIR      = path.join(PROJECT_ROOT, 'js', 'vendor', 'onnxruntime-web');
const TMP_DIR      = path.join(PROJECT_ROOT, '.tmp-vendor');

async function fetchResourceManifest() {
  const url = CDN_BASE + 'resources.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Manifest fetch failed: ${url} → HTTP ${res.status}`);
  return res.json();
}

async function downloadChunks(manifest) {
  await mkdir(BGREMOVE_DIR, { recursive: true });
  const chunks = [];
  for (const [k, v] of Object.entries(manifest)) {
    if (!KEEP_KEYS.has(k)) continue;
    for (const c of v.chunks) chunks.push({ key: k, ...c });
  }
  const totalBytes = chunks.reduce((s, c) => s + (c.offsets[1] - c.offsets[0]), 0);
  console.log(`Downloading ${chunks.length} chunks, ~${(totalBytes / 1048576).toFixed(1)} MB total`);

  let doneBytes = 0;
  let skipped = 0;
  let failed = 0;
  const CONCURRENCY = 6;
  let idx = 0;

  async function fetchOne(c) {
    const out = path.join(BGREMOVE_DIR, c.name);
    // Skip if file exists and hash matches.
    if (existsSync(out)) {
      const existing = await readFile(out);
      const h = createHash('sha256').update(existing).digest('hex');
      if (h === c.hash) {
        doneBytes += existing.length;
        skipped++;
        return;
      }
    }
    const res = await fetch(CDN_BASE + c.name);
    if (!res.ok) throw new Error(`${c.name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const h = createHash('sha256').update(buf).digest('hex');
    if (h !== c.hash) throw new Error(`${c.name}: hash mismatch`);
    const expectedSize = c.offsets[1] - c.offsets[0];
    if (buf.length !== expectedSize) throw new Error(`${c.name}: size mismatch`);
    await writeFile(out, buf);
    doneBytes += buf.length;
  }

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < chunks.length) {
      const c = chunks[idx++];
      try {
        await fetchOne(c);
        const pct = (doneBytes / totalBytes * 100).toFixed(1);
        process.stdout.write(`\r  [${pct}%] ${idx}/${chunks.length} chunks`);
      } catch (err) {
        failed++;
        console.error(`\n  FAIL: ${c.name}:`, err.message);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');
  console.log(`Chunks: ${skipped} skipped (already present), ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} chunks failed to download`);

  return chunks;
}

async function writeTrimmedManifest(manifest) {
  const trimmed = {};
  for (const [k, v] of Object.entries(manifest)) if (KEEP_KEYS.has(k)) trimmed[k] = v;
  await writeFile(
    path.join(BGREMOVE_DIR, 'resources.json'),
    JSON.stringify(trimmed, null, 2),
  );
  console.log(`Wrote trimmed resources.json with ${Object.keys(trimmed).length} keys`);
}

async function vendorOnnxRuntime() {
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(ORT_DIR, { recursive: true });
  console.log(`npm pack onnxruntime-web@${ORT_VERSION}…`);
  execSync(`npm pack onnxruntime-web@${ORT_VERSION}`, { cwd: TMP_DIR, stdio: 'inherit' });
  const tarball = `onnxruntime-web-${ORT_VERSION}.tgz`;
  execSync(`tar -xzf ${tarball} -C ${TMP_DIR.replaceAll('\\', '/')}`, { cwd: TMP_DIR, stdio: 'inherit' });

  // Vendor BOTH the CPU bundle (`ort.bundle.min.mjs`) and the WebGPU bundle
  // (`ort.webgpu.bundle.min.mjs`). The import map in index.html points the
  // bare specifier `onnxruntime-web` at the CPU bundle and `onnxruntime-web/webgpu`
  // at the WebGPU one; the @imgly bundle dynamic-imports whichever it needs.
  for (const bundleName of ['ort.bundle.min.mjs', 'ort.webgpu.bundle.min.mjs']) {
    const src = path.join(TMP_DIR, 'package', 'dist', bundleName);
    const dst = path.join(ORT_DIR, bundleName);
    await writeFile(dst, await readFile(src));
    console.log(`Vendored ${bundleName} → ${dst}`);
  }

  // Fetch upstream LICENSE (not in tarball — it lives only in the GitHub repo).
  const licUrl = `https://raw.githubusercontent.com/microsoft/onnxruntime/v${ORT_VERSION}/LICENSE`;
  const res = await fetch(licUrl);
  if (!res.ok) throw new Error(`License fetch failed: ${licUrl} → HTTP ${res.status}`);
  await writeFile(path.join(ORT_DIR, 'LICENSE'), Buffer.from(await res.arrayBuffer()));
  console.log('Vendored LICENSE');
}

async function main() {
  console.log('--- Phase 1: img.ly chunks + manifest ---');
  const manifest = await fetchResourceManifest();
  await downloadChunks(manifest);
  await writeTrimmedManifest(manifest);

  console.log('--- Phase 2: onnxruntime-web ESM bundle ---');
  await vendorOnnxRuntime();

  // Optionally clear scratch dir to keep the working tree tidy.
  if (process.argv.includes('--clean-tmp')) {
    await rm(TMP_DIR, { recursive: true, force: true });
    console.log('Cleaned .tmp-vendor/');
  }
  console.log('All done.');
}

main().catch(err => {
  console.error('Install failed:', err);
  process.exit(1);
});
