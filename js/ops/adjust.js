// js/ops/adjust.js — brightness/contrast/saturation/blur. Live preview via CSS filter; software fallback for export.
//
// Adjustments are stored on imageState.adjust (B/C/S in [-100..+100],
// blur in [0..50] px). They do NOT bake into the base canvas — instead
// the preview renderer sets `style.filter` on the base canvas element
// every frame an image is active. Export (Phase 9) will either re-use
// the canvas filter property when caps.ctxFilter is true, or fall back
// to softwareApply pixel-mutation.
//
// Filter presets (grayscale/sepia/invert) compose with the four
// adjustment sliders inside the same CSS filter string, so this module
// also owns the preset allowlist and the cssFilterString builder.

const ADJUST_KEYS = ['brightness', 'contrast', 'saturation', 'blur'];

const ALLOWED_PRESETS = new Set(['none', 'grayscale', 'sepia', 'invert']);

// Mutate imageState.adjust[key] = clamped(value). Unknown keys are a no-op.
// Non-finite values snap to 0.
//
// NOTE: ADJUST does not flip baseDirty (renderCache INVALIDATE.ADJUST === null).
// Live preview rides CSS filter on the base canvas element.
export function applyAdjust(imageState, key, value) {
  if (!imageState) return;
  if (!ADJUST_KEYS.includes(key)) return;
  const clamped = clampAdjust(key, Number(value));
  imageState.adjust[key] = clamped;
}

function clampAdjust(key, value) {
  if (!Number.isFinite(value)) return 0;
  if (key === 'blur') return Math.max(0, Math.min(50, value));
  return Math.max(-100, Math.min(100, value));
}

// Set the filter preset. Unknown values fall back to 'none'.
export function applyFilterPreset(imageState, preset) {
  if (!imageState) return;
  imageState.filterPreset = ALLOWED_PRESETS.has(preset) ? preset : 'none';
}

// Reset every adjustment slider to 0 and clear the filter preset in one
// shot. Used by the "Reset all" button in the side panel.
export function resetAllAdjust(imageState) {
  if (!imageState) return;
  imageState.adjust.brightness = 0;
  imageState.adjust.contrast = 0;
  imageState.adjust.saturation = 0;
  imageState.adjust.blur = 0;
  imageState.filterPreset = 'none';
}

/**
 * Build the CSS `filter` property value for live preview.
 * - blurForPreview is the on-screen blur radius (already scaled to display zoom).
 *   For export, pass blurForExport = adjust.blur (source-pixel radius).
 * - Filter preset prepended so it composes naturally with adjustments.
 *
 * Returns 'none' (not '') when nothing applies, so the value is always a
 * valid CSS filter declaration.
 */
export function cssFilterString(adjust, filterPreset, blurPxForCurrentRender) {
  const parts = [];
  if (filterPreset === 'grayscale') parts.push('grayscale(1)');
  if (filterPreset === 'sepia')     parts.push('sepia(1)');
  if (filterPreset === 'invert')    parts.push('invert(1)');
  if (adjust.brightness)            parts.push(`brightness(${1 + adjust.brightness / 100})`);
  if (adjust.contrast)              parts.push(`contrast(${1 + adjust.contrast / 100})`);
  if (adjust.saturation)            parts.push(`saturate(${1 + adjust.saturation / 100})`);
  const b = blurPxForCurrentRender ?? adjust.blur;
  if (b > 0)                        parts.push(`blur(${b}px)`);
  return parts.join(' ') || 'none';
}

/**
 * Software fallback — used by exportRenderer (Phase 9) when caps.ctxFilter is false.
 * Mutates the ImageData in place. Skips blur (handled separately because it needs a kernel).
 * Caller is expected to apply blur via a separate pass (e.g., Pica or canvas) if blur > 0.
 *
 * The math mirrors what CSS filter() does so preview and export match:
 *   brightness(n)  ≈ multiply value by n  (here we use +/- ADD form: ±100 = ±255)
 *   contrast(n)    ≈ (px - 128) * n + 128
 *   saturate(n)    ≈ mix toward Rec.709 luma
 *   grayscale(1)   ≈ snap to Rec.709 luma
 *   sepia(1)       ≈ classic CSS sepia matrix
 *   invert(1)      ≈ 255 - channel
 */
export function softwareApply(imageData, adjust, filterPreset) {
  const data = imageData.data;
  const b = adjust.brightness / 100;                  // -1..+1
  const c = (adjust.contrast / 100) + 1;              //  0..2
  const s = (adjust.saturation / 100) + 1;            //  0..2
  const preset = filterPreset;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], bl = data[i + 2];

    // Brightness (add)
    if (b !== 0) { r += b * 255; g += b * 255; bl += b * 255; }
    // Contrast (around 128)
    if (c !== 1) { r = (r - 128) * c + 128; g = (g - 128) * c + 128; bl = (bl - 128) * c + 128; }
    // Saturation (mix toward luma)
    if (s !== 1) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      r = luma + (r - luma) * s;
      g = luma + (g - luma) * s;
      bl = luma + (bl - luma) * s;
    }
    // Preset
    if (preset === 'grayscale') {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      r = g = bl = l;
    } else if (preset === 'sepia') {
      const nr = (0.393 * r + 0.769 * g + 0.189 * bl);
      const ng = (0.349 * r + 0.686 * g + 0.168 * bl);
      const nb = (0.272 * r + 0.534 * g + 0.131 * bl);
      r = nr; g = ng; bl = nb;
    } else if (preset === 'invert') {
      r = 255 - r; g = 255 - g; bl = 255 - bl;
    }
    data[i]     = Math.max(0, Math.min(255, r));
    data[i + 1] = Math.max(0, Math.min(255, g));
    data[i + 2] = Math.max(0, Math.min(255, bl));
  }
  return imageData;
}

// Re-export the constants for use by tests + filters.js.
export const ADJUST_RANGES = Object.freeze({
  brightness: { min: -100, max: 100 },
  contrast:   { min: -100, max: 100 },
  saturation: { min: -100, max: 100 },
  blur:       { min: 0,    max: 50  },
});
