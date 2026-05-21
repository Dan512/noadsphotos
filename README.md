# NoAdsPhotos

NoAdsPhotos is a privacy-first, client-side image editor and batch processor
in the NoAds suite. **Image files never leave the browser.** Edit one image
or a hundred — crop, resize, rotate/flip, brightness/contrast/saturation,
blur, color-to-transparent, text overlays, freehand brush, shapes,
blur/pixelate redaction, ML background removal, smart compression and
"smallest size" preset, EXIF metadata stripping, auto-trim of transparent
or solid-color borders, HEIC/HEIF import, and export to PNG, JPG, WebP, or
PDF — per image or as a ZIP. All locally.

## Privacy

Image files never leave the browser. The site fetches its own code, fonts,
and ML model assets from this origin only. No third-party CDNs, no
analytics, no tracking, no cookies. See [`privacy.html`](privacy.html) or
the in-app privacy panel for the full disclosure (including the exact
localStorage keys we set and which vendored libraries load lazily on first
use).

## Vendored ML assets (repo size note)

This repo ships ~118&nbsp;MB of pre-vendored binary assets under
[`js/vendor/bgremove/`](js/vendor/bgremove/) so that the in-browser
"Remove background" feature works end-to-end after `git clone && npm install`
with no separate model-download step. With the v1.1 additions
(jsPDF ~420&nbsp;KB and libheif ~1.1&nbsp;MB), the total disk footprint of
the working tree is ~135&nbsp;MB; including `.git` history the on-disk
repo is ~245&nbsp;MB.

That's:

- The [@imgly/background-removal](https://github.com/imgly/background-removal-js)
  ESM bundle (~170&nbsp;KB, AGPL-3.0) and its license text.
- The ISNET fp16 segmentation model — content-addressable chunks fetched
  from `staticimgly.com/@imgly/background-removal-data/1.7.0/` once at
  install time, then vendored.
- The [ONNX Runtime Web](https://github.com/microsoft/onnxruntime/tree/main/js/web)
  SIMD WASM kernels — both the CPU path and the WebGPU/JSEP path — also as
  content-addressable chunks alongside the model. The browser only
  downloads the variant it actually uses at runtime.
- The matching [onnxruntime-web@1.21.0](https://github.com/microsoft/onnxruntime/tree/main/js/web)
  ESM bundles (CPU + WebGPU, ~800&nbsp;KB total, MIT) under
  `js/vendor/onnxruntime-web/`, resolved at runtime via an import map in
  `index.html`.
- The [jsPDF](https://github.com/parallax/jsPDF) UMD bundle (~420&nbsp;KB,
  MIT) under `js/vendor/jspdf/` for image-to-PDF export.
- The [libheif-js](https://github.com/catdad-experiments/libheif-js)
  decoder (~1.1&nbsp;MB JS + WASM, LGPL-3.0) under `js/vendor/heic/` for
  HEIC/HEIF import. Loaded on first .heic open, gated by a one-time
  consent modal.
- The [JSZip](https://stuk.github.io/jszip/) library (~97&nbsp;KB, MIT) at
  `js/vendor/jszip.min.js` for batch ZIP export.

A clone of this repo is consequently larger and slower than a typical
static-site repo. The trade is intentional: zero third-party CDN reliance,
self-hosted everything, and a deploy that works immediately on a freshly
cloned site. See [THIRD-PARTY.md](THIRD-PARTY.md) and
[`js/vendor/bgremove/.notice`](js/vendor/bgremove/.notice) for the full
inventory + re-vendoring instructions.

## What we ship

- **vanilla JS, no framework, no build step** — native ES modules and a
  single CSS file.
- **Self-hosted Onest font** (variable, OFL) under `fonts/`.
- **Vendored libraries** under `js/vendor/`:
  [`bgremove/`](js/vendor/bgremove/) (@imgly/background-removal + ISNET
  model + ONNX runtime WASM),
  [`onnxruntime-web/`](js/vendor/onnxruntime-web/) (peer ESM bundle),
  [`jspdf/`](js/vendor/jspdf/) (PDF export),
  [`heic/`](js/vendor/heic/) (HEIC decoder),
  [`jszip.min.js`](js/vendor/jszip.min.js) (ZIP batch export).
- **PWA manifest + icons** — installable on desktop and mobile. Icons live
  at `img/logo.svg`, `img/icon-192.png`, `img/icon-512.png`,
  `img/icon-512-maskable.png`, `img/apple-touch-icon.png` (all generated
  from `img/logo.svg` via `node scripts/build-icons.mjs`).
- **No analytics, no telemetry, no third-party requests at runtime.**

## License

This project is licensed under the GNU AGPL v3.0 — see [LICENSE](LICENSE).
The AGPL's source-availability requirement means the running site links to
its own source repository in the footer and privacy panel.

Source: <https://github.com/Dan512/noadsphotos>

## Local dev setup

Requires Node 22+.

- `nvm use && npm install` — install dev deps (Playwright, axe-core)
- `npm test` — unit tests via Node's built-in test runner
- `npm run test:browser` — Playwright browser tests (after
  `npm run test:browser:install` to fetch browser binaries)
- `npm run serve` — local static dev server on `http://localhost:4173`
- `node scripts/build-icons.mjs` — re-render `img/icon-*.png` from
  `img/logo.svg` (committed to the repo; only re-run if the logo changes)
- `node scripts/measure-weight.mjs` — print the initial-load wire byte
  count (raw + gzipped) for the static page
