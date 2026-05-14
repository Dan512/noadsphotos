// js/render/renderCache.js — dirty flags and cache invalidation per image.
//
// The preview pipeline has two cached intermediates:
//   - the base canvas (bitmap + transforms + chromakey + bgMask baked in)
//   - the overlays canvas (text/brush/shape/redact overlays)
//
// Adjustments + filter presets are applied via CSS `filter` at preview time
// — no need to re-bake the base for those, so they map to `null` here.
//
// Callers signal "this input changed" via invalidate(imageState, kind) using
// one of the keys in INVALIDATE. The renderer then redraws whichever
// intermediate is flagged dirty on its next rAF tick and clears the flag
// through markClean().

export const INVALIDATE = Object.freeze({
  TRANSFORMS:    'base',
  CHROMAKEY:     'base',
  BGMASK:        'base',
  ADJUST:        null,  // live preview via CSS filter; no base bake needed
  FILTER_PRESET: null,
  OVERLAY:       'overlays',
});

export function invalidate(imageState, kind) {
  if (!imageState) return;
  const flag = INVALIDATE[kind];
  if (flag === 'base')     imageState.baseDirty = true;
  if (flag === 'overlays') imageState.overlaysDirty = true;
  // flag === null or undefined → no-op
}

export function markClean(imageState, target /* 'base' | 'overlays' */) {
  if (!imageState) return;
  if (target === 'base')     imageState.baseDirty = false;
  if (target === 'overlays') imageState.overlaysDirty = false;
}
