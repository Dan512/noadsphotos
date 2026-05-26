// js/ops/transparentPng.js — v1.3 transparent-PNG tools (Feature 16).
//
// Three small, leaf-importable helpers used by the Transparent PNG tool. The
// tool itself (js/tools/transparentPngTool.js) is the wiring; this module is
// pure-ish (touches the canvas API for pixel buffers, but never the DOM tree
// or app state). Browser specs cover the canvas-touching paths; the unit
// tests in tests/unit/transparentPng.test.js use ImageData-shaped ducks for
// replaceTransparentImageData + parseColor.
//
// Sibling module pattern: ops/trim.js. Same posture — pure helpers here, the
// wiring (render → bake → install) lives in the tool module + editor.
//
// Coordinate / units note: padCanvas margins are in source-pixel space (so
// "pad 32 on each side" is 32 source pixels regardless of zoom). replace-
// Transparent threshold is normalized 0..1 (0.01 default = "any transparency
// at all," matching the most common use case of dropping a JPEG-y mask back
// onto a solid background).

/**
 * Pad a canvas by adding margin on each side. Returns a NEW canvas — the
 * source is left untouched.
 *
 * @param {HTMLCanvasElement | OffscreenCanvas} src
 * @param {{ top: number, right: number, bottom: number, left: number, color: string | null }} opts
 * @returns {HTMLCanvasElement | OffscreenCanvas}
 */
export function padCanvas(src, { top = 0, right = 0, bottom = 0, left = 0, color = null } = {}) {
  if (!src || !Number.isFinite(src.width) || !Number.isFinite(src.height)) {
    throw new Error('padCanvas: missing source canvas');
  }
  const t = sanitizePad(top);
  const r = sanitizePad(right);
  const b = sanitizePad(bottom);
  const l = sanitizePad(left);
  const newW = src.width + l + r;
  const newH = src.height + t + b;
  if (newW <= 0 || newH <= 0) {
    throw new Error('padCanvas: resulting canvas would be empty');
  }
  const out = makeCanvas(newW, newH);
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('padCanvas: 2d context unavailable');
  if (color != null && color !== '' && color !== 'transparent') {
    ctx.fillStyle = String(color);
    ctx.fillRect(0, 0, newW, newH);
  }
  ctx.drawImage(src, l, t);
  return out;
}

/**
 * Replace pixels with alpha < threshold with the provided solid color.
 * Mutates the passed canvas in place via putImageData.
 *
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 * @param {{ color: string, threshold?: number }} opts  threshold 0..1; default 0.01 ("any transparency")
 * @returns {HTMLCanvasElement | OffscreenCanvas}  the same canvas, for chaining
 */
export function replaceTransparent(canvas, { color, threshold = 0.01 } = {}) {
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height)) {
    throw new Error('replaceTransparent: missing canvas');
  }
  if (!color) throw new Error('replaceTransparent: missing color');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('replaceTransparent: 2d context unavailable');
  const w = canvas.width, h = canvas.height;
  if (w === 0 || h === 0) return canvas;
  const imageData = ctx.getImageData(0, 0, w, h);
  replaceTransparentImageData(imageData, { color, threshold });
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Pure ImageData mutator. Exported for tests so we can verify the per-pixel
 * logic without a real canvas. Replaces every pixel whose alpha/255 is
 * strictly less than `threshold` with the parsed color (alpha forced to 255
 * — the whole point is opaque-out the transparent bits).
 *
 * @param {ImageData|{data: Uint8ClampedArray, width: number, height: number}} imageData
 * @param {{ color: string, threshold?: number }} opts
 * @returns {ImageData|{data: Uint8ClampedArray, width: number, height: number}}
 */
export function replaceTransparentImageData(imageData, { color, threshold = 0.01 } = {}) {
  if (!imageData || !imageData.data) throw new Error('replaceTransparentImageData: missing imageData');
  if (!color) throw new Error('replaceTransparentImageData: missing color');
  const thr = Number.isFinite(threshold) ? Math.max(0, Math.min(1, threshold)) : 0.01;
  const cutoff = thr * 255; // pre-multiply once
  const { r, g, b } = parseColor(color);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < cutoff) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return imageData;
}

/**
 * Convert a CSS color string to {r, g, b, a} as 0..255 ints. Uses a tiny
 * detached canvas; in pure-Node environments without canvas support, falls
 * back to a small hex/rgb/named-color parser that covers the values we
 * actually pass at runtime (the tool only ever feeds us a #rrggbb from an
 * <input type="color">, but tests also poke at named colors + rgb() strings).
 *
 * Throws for unparseable input — better than silently substituting black,
 * which would make a typo paint a giant black rectangle on the user's image.
 *
 * @param {string} colorString
 * @returns {{r: number, g: number, b: number, a: number}}
 */
export function parseColor(colorString) {
  if (typeof colorString !== 'string' || colorString.length === 0) {
    throw new Error('parseColor: expected non-empty string');
  }
  // Canvas path — preferred when available. Handles every CSS color the
  // browser does (named, hex, rgb(), rgba(), hsl(), etc).
  if (typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined') {
    try {
      const c = makeCanvas(1, 1);
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000000'; // reset
        // Detect rejected values: setting fillStyle to invalid leaves prior value.
        ctx.fillStyle = colorString;
        const applied = ctx.fillStyle;
        if (typeof applied === 'string' && applied === '#000000' && !/^(#0{3,6}|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*1\s*\))$/i.test(colorString)) {
          // Browser rejected the color and kept #000 from our reset. Fall through.
        } else {
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return { r: d[0], g: d[1], b: d[2], a: d[3] };
        }
      }
    } catch { /* fall through to manual parse */ }
  }
  // Manual fallback for Node tests / no-canvas envs.
  return parseColorManual(colorString);
}

// --- Internal helpers -----------------------------------------------------

function sanitizePad(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100000) return 100000; // hard cap; UI clamps tighter
  return Math.round(v);
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error('makeCanvas: no canvas implementation available');
}

// Minimal CSS-color parser covering the formats the tool actually emits +
// the formats unit tests exercise: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(),
// and a tiny named-color allowlist. Anything else throws so a typo is loud.
const NAMED = Object.freeze({
  transparent: { r: 0,   g: 0,   b: 0,   a: 0   },
  black:       { r: 0,   g: 0,   b: 0,   a: 255 },
  white:       { r: 255, g: 255, b: 255, a: 255 },
  red:         { r: 255, g: 0,   b: 0,   a: 255 },
  green:       { r: 0,   g: 128, b: 0,   a: 255 },
  blue:        { r: 0,   g: 0,   b: 255, a: 255 },
  gray:        { r: 128, g: 128, b: 128, a: 255 },
  grey:        { r: 128, g: 128, b: 128, a: 255 },
});

function parseColorManual(s) {
  const lower = s.trim().toLowerCase();
  if (NAMED[lower]) return { ...NAMED[lower] };

  // Hex: #rgb, #rrggbb, #rrggbbaa.
  if (lower.startsWith('#')) {
    const hex = lower.slice(1);
    if (/^[0-9a-f]{3}$/.test(hex)) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { r, g, b, a: 255 };
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 255,
      };
    }
    if (/^[0-9a-f]{8}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16),
      };
    }
    throw new Error(`parseColor: invalid hex "${s}"`);
  }

  // rgb()/rgba()
  const m = lower.match(/^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) {
    const r = clamp255(Number(m[1]));
    const g = clamp255(Number(m[2]));
    const b = clamp255(Number(m[3]));
    const a = m[4] !== undefined ? Math.round(clamp01(Number(m[4])) * 255) : 255;
    return { r, g, b, a };
  }
  throw new Error(`parseColor: unrecognized color "${s}"`);
}

function clamp255(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}
function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
