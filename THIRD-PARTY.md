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
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.19.8  | LGPL-3.0       | LGPL-3.0 | `js/vendor/heic/libheif.js` (~80 KB) + `libheif.wasm` (~1.0 MB) + `LICENSE`. Vendored 2026-05-20. Install via `node scripts/install-heic.mjs`. | HEIC/HEIF input decoder (v1.1 Feature 5). Wraps [strukturag/libheif](https://github.com/strukturag/libheif). |
| [@imgly/background-removal](https://github.com/imgly/background-removal-js) | 1.7.0   | AGPL-3.0      | AGPL-3.0 | `js/vendor/bgremove/index.mjs` (~170 KB) + chunked data assets (~117 MB across 33 hash-named binary files + `resources.json`). See [`js/vendor/bgremove/.notice`](js/vendor/bgremove/.notice). | Browser-side ML background removal (Phase 11) |
| [@imgly/background-removal-data](https://github.com/imgly/background-removal-js) (data assets) | 1.7.0 (from `staticimgly.com`) | AGPL-3.0 | AGPL-3.0 | Co-located under `js/vendor/bgremove/` (resources.json + 33 binary chunks for the CPU-only `isnet_fp16` model + the `ort-wasm-simd-threaded` runtime + the WebGPU/JSEP variant). | ISNET fp16 segmentation model + ONNX Runtime Web SIMD WASM kernel (data half of the bg-removal feature). |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime/tree/main/js/web) | 1.21.0  | MIT            | MIT      | `js/vendor/onnxruntime-web/ort.bundle.min.mjs` (~400 KB) + `ort.webgpu.bundle.min.mjs` (~400 KB) + the threaded JSEP WASM kernels `ort-wasm-simd-threaded.{jsep,}.{wasm,mjs}` (~36 MB total) + `LICENSE`. Resolved at runtime via an import map in `index.html`. Re-vendor with `node scripts/install-ort.mjs`. | JS + WASM halves of the ONNX runtime. Used by @imgly/background-removal AND the BlazeFace face-detect model (Feature 1). |
| [MediaPipe BlazeFace](https://github.com/google/mediapipe) (via [Qualcomm AI Hub Models](https://huggingface.co/qualcomm/MediaPipe-Face-Detection)) | QAI v0.54.0 | Apache-2.0 | Apache-2.0 | `js/vendor/blazeface/face_detector.onnx` (~78 KB) + `face_detector.data` (~517 KB) + `qualcomm-metadata.json` + `.notice`. Vendored 2026-05-22. Install via `node scripts/install-blazeface.mjs`. | "Auto-detect faces" redact button (v1.2 Feature 1). Runs against the existing vendored ORT — no extra runtime download. Tile-based multi-scale scan catches small faces in crowded group photos. |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | 7.0.0 | Apache-2.0 | Apache-2.0 | `js/vendor/tesseract/tesseract.min.js` (~63 KB) + `worker.min.js` (~111 KB) + `.notice`. Vendored 2026-05-22. Install via `node scripts/install-tesseract.mjs`. | OCR engine for the "Detect text" redact button (v1.2 Feature 4) + preview-select mode with PII regex auto-marking. |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | 7.0.0 | Apache-2.0 | Apache-2.0 | `js/vendor/tesseract/core/tesseract-core-{,simd-,relaxedsimd-}lstm.{wasm,wasm.js}` (~22 MB total, 6 variants). Tesseract.js auto-picks the best variant per browser at runtime. Single-threaded — no SharedArrayBuffer / COOP / COEP required, works on plain GitHub Pages. | WASM-compiled Tesseract OCR engine; data half of the OCR feature. |
| [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) | HEAD on 2024-08-01 (commit `87416418657359cb625c412a48b6e1d6d41c29bd`) | Apache-2.0 | Apache-2.0 | `js/vendor/tesseract/lang/eng.traineddata.gz` (~1.9 MB gzipped; ~4 MB raw). Gzipped during install. | English-language LSTM model for OCR. Other languages can be vendored on demand by extending `scripts/install-tesseract.mjs`. |

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
- **@imgly/background-removal** is **AGPL-3.0** only. Vendoring this library
  is the reason the *entire* NoAdsPhotos project is licensed AGPL-3.0
  (see `LICENSE`). The deployed site MUST link to its own source repository
  (this is done in the footer and the privacy panel).
- **onnxruntime-web** is **MIT**. Microsoft's license text is preserved at
  `js/vendor/onnxruntime-web/LICENSE`. The threaded JSEP WASM kernels are
  required by BOTH the @imgly bg-remove pipeline AND our BlazeFace face-
  detect, hence vendored here (~36 MB) rather than under either feature's
  own directory.
- **MediaPipe BlazeFace (Qualcomm AI Hub redistribution)** is **Apache-2.0**
  via the chain: MediaPipe → `zmurez/MediaPipePyTorch` → Qualcomm AI Hub.
  Each link of the chain redistributes under Apache-2.0; the upstream
  attributions live at the Qualcomm Hugging Face repo. Provenance + SHA-256
  hashes pinned at `js/vendor/blazeface/.notice`.
- **Tesseract.js + tesseract.js-core** are both **Apache-2.0** by Naptha.
  License preserved at `js/vendor/tesseract/.notice`. We vendor LSTM-only
  builds (Tesseract 5+ legacy mode dropped) which saves ~24 MB vs vendoring
  all 12 variants.
- **tessdata_fast (English LSTM model)** is **Apache-2.0** by the
  Tesseract OCR project. Commit pinned for reproducibility in
  `scripts/install-tesseract.mjs`.

## Loading discipline

- JSZip, jsPDF, and libheif-js are loaded **lazily** — the `<script>` (or
  dynamic `import()`) is only fetched when the user takes the action that
  needs it (Export queue ZIP / PDF export / first HEIC import respectively).
  Users who never use those features never pay the bandwidth or CPU cost.
  libheif-js additionally goes through a one-time consent modal on first
  use so the ~1.1 MB download is disclosed up front.
- @imgly/background-removal is loaded **lazily** via dynamic `import()` of
  `js/vendor/bgremove/index.mjs` (~170 KB) on the first "Remove background"
  click. That import in turn triggers a chained dynamic
  `import("onnxruntime-web")` — resolved via the import map in `index.html`
  to `js/vendor/onnxruntime-web/ort.bundle.min.mjs` (~400 KB).
- The bg-removal model + WASM data — `resources.json` plus the 33
  content-addressable binary chunks under `js/vendor/bgremove/` totalling
  ~117 MB — is fetched chunk-by-chunk by the @imgly bundle the first time
  the user runs the model. Subsequent runs are served from the browser
  cache. Everything is served from this origin only — no third-party CDN
  at runtime.
- **BlazeFace** is loaded **lazily** on first "Auto-detect faces" click,
  gated by a one-time consent modal that discloses the ~600 KB download.
  Subsequent runs reuse the ORT session.
- **Tesseract.js** is loaded **lazily** on first "Detect text" click, gated
  by a one-time consent modal that discloses the ~6 MB total (lib + English
  language data + the one matching WASM variant). Subsequent runs reuse the
  warmed worker.
- The threaded JSEP WASM kernels under `js/vendor/onnxruntime-web/` load
  on demand the first time EITHER bg-remove OR face-detect runs (whichever
  the user invokes first). One-time per browser session; subsequent ORT
  features reuse the same loaded WASM.

## Disk footprint

- `js/vendor/bgremove/` is ~118 MB (170 KB code + 34 KB license + 9 KB
  manifest + ~117 MB of chunked binary data for the CPU + WebGPU ORT
  kernels and the ISNET fp16 model).
- `js/vendor/onnxruntime-web/` is ~36 MB (CPU bundle + WebGPU bundle +
  4 threaded JSEP WASM kernel files + LICENSE).
- `js/vendor/jszip.min.js` is ~97 KB.
- `js/vendor/jspdf/` is ~420 KB (UMD bundle + LICENSE).
- `js/vendor/heic/` is ~1.1 MB (80 KB JS + 1.0 MB WASM + 43 KB LICENSE).
- `js/vendor/blazeface/` is ~600 KB (78 KB ONNX graph + 517 KB external
  weights + 3 KB metadata + `.notice`).
- `js/vendor/tesseract/` is ~22 MB (174 KB lib JS + 6 LSTM-only WASM
  variants + 1.9 MB gzipped English language data + `.notice`).
- The total `js/vendor/` footprint is ~155 MB, dominated by the chunked
  ML models + the ORT WASM kernels. A `git clone` of this repo is
  consequently larger than a typical static-site repo. The trade is: zero
  deploy-time install, every ML feature works immediately on a freshly
  cloned site.

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
