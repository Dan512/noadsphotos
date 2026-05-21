# Third-party code in NoAdsPhotos

Everything listed here is **vendored** — the source files live under our own
repository and are served from our own origin. We never load any of these from
a third-party CDN at runtime. The brand stance ("ad-free, tracker-free,
self-hosted") requires that the runtime never makes a network request to a
third-party host.

If you are auditing this site, the privacy panel mirrors this list with a
plain-language summary of what each library does and what (if anything) it
sends over the network. None of the libraries below have any network traffic.

## Vendored at build time

| Library                                              | Version | License        | Selected | Location                              | Purpose |
| ---------------------------------------------------- | ------- | -------------- | -------- | ------------------------------------- | --- |
| [JSZip](https://stuk.github.io/jszip/)               | 3.10.1  | MIT or GPL-3.0 | **MIT**  | `js/vendor/jszip.min.js`              | Batch export ZIP archive (Phase 10) |
| [jsPDF](https://github.com/parallax/jsPDF)           | 3.0.4   | MIT            | MIT      | `js/vendor/jspdf/jspdf.umd.min.js` (~419 KB) + `LICENSE` | Image-to-PDF export (v1.1 Feature 4) |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.19.8  | LGPL-3.0       | LGPL-3.0 | `js/vendor/heic/libheif.js` (~80 KB) + `libheif.wasm` (~1.0 MB) + `LICENSE`. Vendored 2026-05-20. | HEIC/HEIF input decoder (v1.1 Feature 5). Wraps [strukturag/libheif](https://github.com/strukturag/libheif). |
| [Pica](https://github.com/nodeca/pica)               | _TBD_   | MIT            | MIT      | `js/vendor/pica.min.js` _(planned)_   | High-quality resampling for large resize / oversize import (a later phase) |
| [@imgly/background-removal](https://github.com/imgly/background-removal-js) | 1.7.0   | AGPL-3.0      | AGPL-3.0 | `js/vendor/bgremove/index.mjs` (~170 KB) + chunked data assets (~95.4 MB across 26 hash-named binary files + `resources.json`). See [`js/vendor/bgremove/.notice`](js/vendor/bgremove/.notice). | Browser-side ML background removal (Phase 11) |
| [@imgly/background-removal-data](https://github.com/imgly/background-removal-js) (data assets) | 1.7.0 (from `staticimgly.com`) | AGPL-3.0 | AGPL-3.0 | Co-located under `js/vendor/bgremove/` (resources.json + 26 binary chunks for the CPU-only `isnet_fp16` model + the `ort-wasm-simd-threaded` runtime). | ISNET fp16 segmentation model + ONNX Runtime Web SIMD WASM kernel (data half of the bg-removal feature). |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime/tree/main/js/web) | 1.21.0  | MIT            | MIT      | `js/vendor/onnxruntime-web/ort.bundle.min.mjs` (~400 KB) + `LICENSE`. Resolved at runtime via an import map in `index.html`. | Peer dependency of @imgly/background-removal — the JS half of the ONNX runtime that drives inference. |

## License selections

- **JSZip** is dual-licensed (MIT-or-GPL-3.0). We pick **MIT**, the more
  permissive option. Attribution preserved in the unmodified
  `js/vendor/jszip.min.js` header comment.
- **jsPDF** is **MIT**. Attribution preserved in the unmodified
  `js/vendor/jspdf/jspdf.umd.min.js` header comment + `LICENSE` in the same
  folder. We vendor the UMD build rather than the ES build because the ES
  build's bare imports (`fflate`, `fast-png`, `@babel/runtime/*`) would
  require additional vendoring.
- **libheif-js** is **LGPL-3.0** (the wrapper) packaging upstream **libheif**
  (also LGPL-3.0). LGPL is compatible with our AGPL-3.0 license — the LGPL
  half is redistributed unmodified under LGPL terms (full text at
  `js/vendor/heic/LICENSE`). We vendor the SPLIT wasm variant
  (`libheif-wasm/libheif.js` + `libheif-wasm/libheif.wasm`) rather than the
  pre-bundled `libheif-bundle.mjs` (which base64-inlines the WASM): the split
  is ~30% smaller and lets the browser stream the native binary instead of
  decoding a string at boot. The loader (`js/vendor/heic-loader.js`) sets
  `locateFile` so the WASM resolves to the same vendored directory — no
  third-party CDN at runtime.
- **Pica** is plain MIT. Attribution preserved in the bundled header comment.
- **@imgly/background-removal** is **AGPL-3.0** only. Vendoring this library
  is the reason the *entire* NoAdsPhotos project is licensed AGPL-3.0
  (see `LICENSE`). The deployed site MUST link to its own source repository
  (this is done in the footer and the privacy panel).
- **onnxruntime-web** is **MIT**. Microsoft's license text is preserved at
  `js/vendor/onnxruntime-web/LICENSE`.

## Loading discipline

- JSZip, jsPDF, libheif-js, and Pica are loaded **lazily** — the `<script>`
  (or dynamic `import()`) is only fetched when the user takes the action
  that needs it (Export queue ZIP / PDF export / first HEIC import / oversize
  import respectively). Users who never use those features never pay the
  bandwidth or CPU cost. libheif-js additionally goes through a one-time
  consent modal on first use so the ~1.1 MB download is disclosed up front.
- @imgly/background-removal is loaded **lazily** via dynamic `import()` of
  `js/vendor/bgremove/index.mjs` (~170 KB) on the first "Remove background"
  click. That import in turn triggers a chained dynamic
  `import("onnxruntime-web")` — resolved via the import map in `index.html`
  to `js/vendor/onnxruntime-web/ort.bundle.min.mjs` (~400 KB).
- The bg-removal model + WASM data — `resources.json` plus the 26
  content-addressable binary chunks under `js/vendor/bgremove/` totalling
  ~95.4 MB — is fetched chunk-by-chunk by the @imgly bundle the first time
  the user runs the model. Subsequent runs are served from the browser
  cache. Everything is served from this origin only — no third-party CDN
  at runtime.

## Disk footprint

- `js/vendor/bgremove/` is ~96 MB (170 KB code + 34 KB license + 7 KB
  manifest + 95.4 MB of chunked binary data).
- `js/vendor/onnxruntime-web/` is ~400 KB.
- `js/vendor/jszip.min.js` is ~97 KB.
- `js/vendor/jspdf/` is ~420 KB (UMD bundle + LICENSE).
- `js/vendor/heic/` is ~1.1 MB (80 KB JS + 1.0 MB WASM + 43 KB LICENSE).
- The total `js/vendor/` footprint is ~97 MB, dominated by the chunked
  ML model + ORT WASM kernel. A `git clone` of this repo is consequently
  larger than a typical static-site repo. The trade is: zero deploy-time
  install, first-bg-removal works immediately on a freshly cloned site.

## Vendoring notes

When upgrading `@imgly/background-removal`:
1. Update `IMGLY_VERSION` (and `ORT_VERSION` if the peer dep changed) at
   the top of `scripts/install-bgremove.mjs`.
2. Run `node scripts/install-bgremove.mjs` — fetches the new chunks and
   refreshes `resources.json` automatically (existing chunks with matching
   hashes are skipped).
3. Bump the version in this table and in
   [`js/vendor/bgremove/.notice`](js/vendor/bgremove/.notice).
4. Bump `MODEL_HASH` in `js/ops/bgremove.js` so users re-consent.
5. Update the size disclosure in `privacy.html` if the new model size differs.
6. Re-verify the consent modal copy still reflects the chosen model.

## Fonts and other assets

- The **Onest** font (variable-weight, OFL-licensed) is self-hosted under
  `fonts/`. We do not request fonts from Google Fonts or any third-party
  service.

If you are adding a new third-party library, update this file *and* the
privacy panel disclosure. Both are user-facing claims.
