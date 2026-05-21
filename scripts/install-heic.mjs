#!/usr/bin/env node
// scripts/install-heic.mjs — vendors libheif-js (LGPL-3.0) into js/vendor/heic/.
//
// We pick the SPLIT wasm variant from the upstream package — `libheif-wasm/libheif.js`
// (~81 KB JS glue) + `libheif-wasm/libheif.wasm` (~1.03 MB compiled wasm) — rather
// than the all-in-one `libheif-bundle.mjs` (~1.46 MB with the wasm base64-inlined).
// The split version is leaner because the wasm bytes stream as native binary
// instead of decoding a base64 string at boot.
//
// What this script does:
//   1. `npm pack libheif-js@<VERSION>` into .tmp-vendor/.
//   2. Extract and copy the three files we ship:
//        - libheif-wasm/libheif.js   → js/vendor/heic/libheif.js
//        - libheif-wasm/libheif.wasm → js/vendor/heic/libheif.wasm
//        - libheif/LICENSE           → js/vendor/heic/LICENSE
//   3. (Optional) clean .tmp-vendor with --clean-tmp.
//
// Idempotent: re-running is a no-op if the vendored files already match the
// tarball's bytes. Run with `node scripts/install-heic.mjs`.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LIBHEIF_VERSION = '1.19.8';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEIC_DIR     = path.join(PROJECT_ROOT, 'js', 'vendor', 'heic');
const TMP_DIR      = path.join(PROJECT_ROOT, '.tmp-vendor');

// Files we copy from the tarball into js/vendor/heic/.
//   src: relative to extracted `package/` directory.
//   dst: relative to HEIC_DIR.
const COPY_PLAN = [
  { src: 'libheif-wasm/libheif.js',   dst: 'libheif.js' },
  { src: 'libheif-wasm/libheif.wasm', dst: 'libheif.wasm' },
  { src: 'libheif/LICENSE',           dst: 'LICENSE' },
];

async function fileHash(p) {
  if (!existsSync(p)) return null;
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

async function main() {
  console.log(`--- libheif-js v${LIBHEIF_VERSION} ---`);
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(HEIC_DIR, { recursive: true });

  // 1. Pack.
  console.log(`npm pack libheif-js@${LIBHEIF_VERSION}…`);
  execSync(`npm pack libheif-js@${LIBHEIF_VERSION}`, { cwd: TMP_DIR, stdio: 'inherit' });
  const tarball = `libheif-js-${LIBHEIF_VERSION}.tgz`;

  // 2. Extract.
  console.log('Extracting tarball…');
  execSync(`tar -xzf ${tarball}`, { cwd: TMP_DIR, stdio: 'inherit' });

  // 3. Copy the three files, with sha256 idempotency.
  let copied = 0;
  let skipped = 0;
  for (const { src, dst } of COPY_PLAN) {
    const srcPath = path.join(TMP_DIR, 'package', src);
    const dstPath = path.join(HEIC_DIR, dst);
    if (!existsSync(srcPath)) throw new Error(`Missing in tarball: ${src}`);
    const srcBytes = await readFile(srcPath);
    const srcSha   = createHash('sha256').update(srcBytes).digest('hex');
    const dstSha   = await fileHash(dstPath);
    if (dstSha === srcSha) {
      skipped++;
      console.log(`  skip  ${dst} (sha matches)`);
      continue;
    }
    await writeFile(dstPath, srcBytes);
    copied++;
    console.log(`  write ${dst} (${(srcBytes.length / 1024).toFixed(1)} KB)`);
  }
  console.log(`Copy: ${copied} written, ${skipped} skipped`);

  if (process.argv.includes('--clean-tmp')) {
    await rm(TMP_DIR, { recursive: true, force: true });
    console.log('Cleaned .tmp-vendor/');
  }
  console.log('All done.');
}

main().catch(err => {
  console.error('install-heic failed:', err);
  process.exit(1);
});
