// js/render/pdfRenderer.js — image to PDF (single and multi-page).
//
// PDF export sits one layer above the regular export pipeline: it asks
// `renderForExport` to produce a high-quality JPEG (or PNG if alpha is
// material), then embeds that bitmap into a jsPDF document at a chosen
// page size + orientation + margin + fit mode. The "container is a PDF"
// is a transport-layer concern; the actual image bake is shared with
// the per-format PNG/JPG/WebP exports for parity.
//
// Why JPEG for the embedded bitmap by default:
//   * PDF files are dramatically larger when they embed PNG than JPEG —
//     a 2 MB JPEG vs a 12 MB PNG for the same photo is typical.
//   * Quality 0.92 (the same default the regular export uses) is
//     visually indistinguishable on photographs and keeps PDFs in the
//     "send by email" size range.
//
// We switch to PNG embedding when the image has transparency, because
// JPEG would otherwise composite the alpha onto opaque black/white and
// silently change appearance. The `hasTransparency` heuristic lives in
// `js/exporter.js` and is the same predicate the "Smallest size" preset
// uses to gate JPEG candidates.

import { renderForExport } from './exportRenderer.js';
import { loadJsPdf } from '../vendor/jspdf-loader.js';
import { hasTransparency } from '../exporter.js';
import { effectiveImageSize } from '../geometry.js';

// Named page dimensions in PDF points (1pt = 1/72 inch). Matches the
// classic ISO + US Letter set. "Fit to image" is handled by code, not
// by an entry here — it uses the image's natural pixel dims at 72dpi.
export const PAGE_SIZES_PT = Object.freeze({
  letter: { w: 612,  h: 792  }, // 8.5 × 11   in
  a4:     { w: 595,  h: 842  }, // 210 × 297  mm
  legal:  { w: 612,  h: 1008 }, // 8.5 × 14   in
  a3:     { w: 842,  h: 1191 }, // 297 × 420  mm
  b5:     { w: 499,  h: 709  }, // 176 × 250  mm
});

// JPEG quality for the embedded bitmap. Matches the regular export default
// so PNG/JPG/WebP/PDF "Download" buttons produce consistent fidelity for the
// same source.
const PDF_JPEG_QUALITY = 0.92;

/**
 * Default opts. Margin = 0 only when pageSize is 'fit'; named paper sizes
 * default to 36pt (1/2 inch) so the image isn't pressed against the edge.
 */
const DEFAULT_OPTS = Object.freeze({
  pageSize: 'fit',        // 'fit' | 'letter' | 'a4' | 'legal' | 'a3' | 'b5'
  orientation: 'auto',    // 'auto' | 'portrait' | 'landscape'
  margins: undefined,     // number (points) — undefined → 0 for 'fit', 36 otherwise
  fitMode: 'contain',     // 'contain' | 'cover' — only honored for named pages
});

/**
 * Compute the page dimensions and image placement for a single PDF page.
 * Pure math; exported for unit-style tests so we don't have to involve
 * jsPDF at all to verify the layout.
 *
 * @param {object} imageState  Per-image state (used only for source.width/height
 *                             + effectiveImageSize to honour resize/crop/rotate).
 * @param {object} [opts]      pageSize / orientation / margins / fitMode.
 * @returns {{pageW: number, pageH: number, imgX: number, imgY: number, imgW: number, imgH: number}}
 */
export function layoutPage(imageState, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  // The "logical" image dims for layout are the effective post-crop / rotate /
  // resize dims, since that's what renderForExport will hand us back. Falling
  // back to source.width/height keeps `layoutPage` callable in tests where
  // imageState is a bare stub without transforms.
  let imgDims;
  try {
    imgDims = effectiveImageSize(imageState);
  } catch {
    imgDims = null;
  }
  if (!imgDims || !(imgDims.w > 0 && imgDims.h > 0)) {
    const sw = (imageState && imageState.source && imageState.source.width) || 0;
    const sh = (imageState && imageState.source && imageState.source.height) || 0;
    imgDims = { w: sw, h: sh };
  }
  const imgAspect = imgDims.w / imgDims.h;

  // Page dimensions. 'fit' uses image pixels treated as 1pt each — a 2000px
  // image becomes a 2000pt page (matches how jsPDF embeds pixels-at-72dpi).
  let pageW, pageH;
  let margin;
  if (o.pageSize === 'fit' || !PAGE_SIZES_PT[o.pageSize]) {
    pageW = imgDims.w;
    pageH = imgDims.h;
    margin = Number.isFinite(o.margins) ? Math.max(0, o.margins) : 0;
  } else {
    const named = PAGE_SIZES_PT[o.pageSize];
    pageW = named.w;
    pageH = named.h;
    margin = Number.isFinite(o.margins) ? Math.max(0, o.margins) : 36;
  }

  // Apply orientation. 'auto' picks the side that matches the image's aspect.
  let orient = o.orientation;
  if (orient === 'auto') {
    orient = imgAspect >= 1 ? 'landscape' : 'portrait';
  }
  if (orient === 'landscape' && pageW < pageH) {
    [pageW, pageH] = [pageH, pageW];
  } else if (orient === 'portrait' && pageW > pageH) {
    [pageW, pageH] = [pageH, pageW];
  }

  // Inner content rect after margins.
  const innerW = Math.max(1, pageW - 2 * margin);
  const innerH = Math.max(1, pageH - 2 * margin);

  // Place the image inside the inner rect according to fitMode.
  // 'fit' page size + no margins → image fills page edge-to-edge (the natural
  // intent for an image-sized PDF). For named sizes, contain (default) fits
  // entirely inside; cover fills and crops overflow.
  let imgW, imgH;
  if (o.pageSize === 'fit' && margin === 0) {
    // The page IS the image's pixel rect — render edge-to-edge.
    imgW = pageW;
    imgH = pageH;
  } else if (o.fitMode === 'cover') {
    // Scale up so the smaller axis matches; the larger axis overflows and
    // gets clipped by the page rect at render time.
    const scale = Math.max(innerW / imgDims.w, innerH / imgDims.h);
    imgW = imgDims.w * scale;
    imgH = imgDims.h * scale;
  } else {
    // contain (default) — scale so the larger axis matches.
    const scale = Math.min(innerW / imgDims.w, innerH / imgDims.h);
    imgW = imgDims.w * scale;
    imgH = imgDims.h * scale;
  }

  // Center within the inner rect.
  const imgX = margin + (innerW - imgW) / 2;
  const imgY = margin + (innerH - imgH) / 2;

  return { pageW, pageH, imgX, imgY, imgW, imgH };
}

/**
 * Convert a Blob to a data URL (suitable for `pdf.addImage`).
 * jsPDF accepts an array buffer or a data URL; data URL is the simplest
 * cross-version path and avoids a sniffing step on jsPDF's end.
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('blob_to_data_url_failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Render a single image to a one-page PDF. Returns a Promise<Blob> with
 * MIME `application/pdf`.
 *
 * The embedded bitmap goes through `renderForExport` (the regular bake
 * pipeline) so transforms, adjustments, overlays, masks all apply — the
 * PDF is just a different transport for the same baked image.
 *
 * @param {object} imageState
 * @param {{pageSize?: string, orientation?: string, margins?: number, fitMode?: string}} opts
 * @param {object} caps
 * @param {object} lifecycle
 * @returns {Promise<Blob>}
 */
export async function renderForPdf(imageState, opts, caps, lifecycle) {
  if (!imageState) throw new Error('source_bitmap_unavailable');
  const useAlpha = hasTransparency(imageState);
  // 1. Bake the image as a JPEG (or PNG when alpha matters). The renderer
  //    handles transforms / adjustments / overlays / masks for us.
  const fmt = useAlpha ? 'png' : 'jpeg';
  const imageBlob = await renderForExport(
    imageState,
    { format: fmt, quality: PDF_JPEG_QUALITY },
    caps,
    lifecycle,
  );
  // 2. Decode to a data URL for jsPDF.
  const dataUrl = await blobToDataUrl(imageBlob);
  // 3. Compute placement.
  const { pageW, pageH, imgX, imgY, imgW, imgH } = layoutPage(imageState, opts);
  // 4. Build the PDF.
  const jsPDF = await loadJsPdf();
  const pdf = new jsPDF({
    unit: 'pt',
    format: [pageW, pageH],
    orientation: pageW > pageH ? 'landscape' : 'portrait',
    compress: true,
  });
  const fmtTag = useAlpha ? 'PNG' : 'JPEG';
  // 'MEDIUM' compression: jsPDF uses this hint to decide its internal stream
  // compression. The image bytes are already JPEG/PNG-compressed, so the
  // header-level option mostly affects metadata streams. Compress is enabled
  // for the whole document via the constructor `compress: true` option.
  pdf.addImage(dataUrl, fmtTag, imgX, imgY, imgW, imgH, undefined, 'MEDIUM');
  return pdf.output('blob');
}

/**
 * Build a multi-page PDF, one image per page, in queue order. Failures on
 * individual images are reported via `onProgress` but don't bail the whole
 * PDF — the result is a partial PDF with the successful pages.
 *
 * @param {string[]} imageIds  Image ids in queue order.
 * @param {object} opts        Same shape as renderForPdf opts; applied per-page.
 * @param {object} caps
 * @param {object} lifecycle
 * @param {{onProgress?: (info: {index:number,total:number,id:string,state:string,detail?:string}) => void, onCancel?: () => boolean, getImage?: (id:string) => object|null}} [hooks]
 * @returns {Promise<{ blob: Blob|null, count: number, failed: number, cancelled: boolean }>}
 */
export async function renderForPdfBatch(imageIds, opts, caps, lifecycle, hooks = {}) {
  const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};
  const onCancel = typeof hooks.onCancel === 'function' ? hooks.onCancel : () => false;
  const getImage = typeof hooks.getImage === 'function' ? hooks.getImage : null;
  const evictAfterUse = typeof hooks.evictAfterUse === 'function' ? hooks.evictAfterUse : null;

  if (!Array.isArray(imageIds) || imageIds.length === 0) {
    return { blob: null, count: 0, failed: 0, cancelled: false };
  }

  const jsPDF = await loadJsPdf();
  let pdf = null;
  let count = 0;
  let failed = 0;

  for (let i = 0; i < imageIds.length; i++) {
    if (onCancel()) {
      return { blob: null, count, failed, cancelled: true };
    }
    const id = imageIds[i];
    const img = getImage ? getImage(id) : null;
    if (!img) {
      failed += 1;
      onProgress({ index: i, total: imageIds.length, id, state: 'skipped', detail: '(removed)' });
      continue;
    }
    onProgress({ index: i, total: imageIds.length, id, state: 'encoding' });
    try {
      const useAlpha = hasTransparency(img);
      const fmt = useAlpha ? 'png' : 'jpeg';
      const imageBlob = await renderForExport(
        img,
        { format: fmt, quality: PDF_JPEG_QUALITY },
        caps,
        lifecycle,
      );
      const dataUrl = await blobToDataUrl(imageBlob);
      const { pageW, pageH, imgX, imgY, imgW, imgH } = layoutPage(img, opts);

      if (pdf == null) {
        // First page: constructor sets initial page dims. Subsequent pages
        // use `addPage` with explicit dims to support mixed orientations.
        pdf = new jsPDF({
          unit: 'pt',
          format: [pageW, pageH],
          orientation: pageW > pageH ? 'landscape' : 'portrait',
          compress: true,
        });
      } else {
        pdf.addPage([pageW, pageH], pageW > pageH ? 'landscape' : 'portrait');
      }
      const fmtTag = useAlpha ? 'PNG' : 'JPEG';
      pdf.addImage(dataUrl, fmtTag, imgX, imgY, imgW, imgH, undefined, 'MEDIUM');
      count += 1;
      onProgress({ index: i, total: imageIds.length, id, state: 'done' });
    } catch (err) {
      failed += 1;
      onProgress({
        index: i,
        total: imageIds.length,
        id,
        state: 'failed',
        detail: err && err.message ? String(err.message) : 'error',
      });
    }
    if (evictAfterUse) {
      try { evictAfterUse(id); } catch { /* ignore */ }
    }
  }

  if (count === 0 || pdf == null) {
    return { blob: null, count, failed, cancelled: false };
  }
  const blob = pdf.output('blob');
  return { blob, count, failed, cancelled: false };
}
