// js/ops/filters.js — filter presets. Thin facade because cssFilterString in adjust.js handles preset composition; this module exists for symmetry with other ops.
//
// Preset values: 'none', 'grayscale', 'sepia', 'invert'. The actual
// composition with adjustment sliders happens inside adjust.cssFilterString
// (preview) and adjust.softwareApply (export fallback). Importing
// applyFilterPreset from either module is equivalent.
export { applyFilterPreset } from './adjust.js';

export const PRESETS = Object.freeze(['none', 'grayscale', 'sepia', 'invert']);
