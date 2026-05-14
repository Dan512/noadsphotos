# NoAdsPhotos

NoAdsPhotos is a privacy-first, client-side image editor + batch processor in the NoAds suite. Files never leave the browser. Edit one image or a hundred — cropping, resizing, rotating, color-to-transparent, text, brush, shapes, redaction, ML background removal, export to PNG/JPG/WebP per image or as a ZIP — all locally.

## Privacy

Image files never leave the browser. The site itself fetches its own code, fonts, and ML model assets from this origin only. No third-party CDNs, no analytics, no tracking. See PRIVACY.md or the in-app privacy panel for the full disclosure.

## Vendored ML assets (repo size note)

This repo ships ~118&nbsp;MB of pre-vendored binary assets under
[`js/vendor/bgremove/`](js/vendor/bgremove/) so that the in-browser
"Remove background" feature works end-to-end after `git clone && npm install`
with no separate model-download step. That's:

- The [@imgly/background-removal](https://github.com/imgly/background-removal-js)
  ESM bundle (~170&nbsp;KB, AGPL-3.0) and its license text.
- The ISNET fp16 segmentation model (84&nbsp;MB) — content-addressable
  chunks fetched from `staticimgly.com/@imgly/background-removal-data/1.7.0/`.
- The [ONNX Runtime Web](https://github.com/microsoft/onnxruntime/tree/main/js/web)
  SIMD WASM kernels — both the CPU path (12&nbsp;MB) and the WebGPU/JSEP path
  (22&nbsp;MB) — also as content-addressable chunks alongside the model. The
  browser only downloads the variant it actually uses.
- The matching [onnxruntime-web@1.21.0](https://github.com/microsoft/onnxruntime/tree/main/js/web)
  ESM bundles (CPU + WebGPU, ~800&nbsp;KB total, MIT) under
  `js/vendor/onnxruntime-web/`, resolved at runtime via an import map in
  `index.html`.

A clone of this repo is consequently larger and slower than a typical
static-site repo. The trade is intentional: zero third-party CDN reliance,
self-hosted everything (no `staticimgly.com` request at runtime), and a
deploy that works immediately on a freshly cloned site. See
[THIRD-PARTY.md](THIRD-PARTY.md) and
[`js/vendor/bgremove/.notice`](js/vendor/bgremove/.notice) for the full
inventory + re-vendoring instructions.

## License

This project is licensed under the GNU AGPL v3.0 — see [LICENSE](LICENSE). The AGPL's source-availability requirement means the running site links to its own source repository in the footer and privacy panel.

Source: <https://github.com/Dan512/noadsphotos>

## Local dev setup

Requires Node 22+.

- `nvm use && npm install`
- `npm test` — unit tests via Node's built-in test runner
- `npm run test:browser` — Playwright browser tests (after `npm run test:browser:install`)
- `npm run serve` — local static dev server

