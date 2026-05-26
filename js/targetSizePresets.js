// js/targetSizePresets.js — preset catalog for Feature 11 "Exact file size."
//
// The presets are the canned byte targets shown as chips in the editor's
// export panel and the queue batch panel. They cover the common "X under 10
// MB / under 25 MB" places people upload images to (Discord, email, IRS
// portal, Reddit). The catalog is a flat array so the UI can iterate it
// without sub-grouping; ordering here is the chip order.
//
// Bytes are precomputed (1 MB = 1024 * 1024 bytes, mebibyte convention to
// match what file managers and upload validators typically measure against)
// so the UI never has to do unit math at render time.
//
// `getActiveTargetBytes(targetSize)` is the single source of truth for
// "what byte budget should the exporter aim for given the current state?" —
// both the editor and the batch panel route through it.

/** @typedef {{ id: string, labelKey: string, bytes: number }} TargetSizePreset */

/** @type {ReadonlyArray<TargetSizePreset>} */
export const TARGET_SIZE_PRESETS = Object.freeze([
  { id: 'discord-10', labelKey: 'targetSizePresetDiscord10', bytes: 10 * 1024 * 1024 },
  { id: 'discord-25', labelKey: 'targetSizePresetDiscord25', bytes: 25 * 1024 * 1024 },
  { id: 'email-25',   labelKey: 'targetSizePresetEmail25',   bytes: 25 * 1024 * 1024 },
  { id: 'irs-1',      labelKey: 'targetSizePresetIrs1',      bytes:  1 * 1024 * 1024 },
  { id: 'reddit-20',  labelKey: 'targetSizePresetReddit20',  bytes: 20 * 1024 * 1024 },
]);

/**
 * Look up a preset by ID. Returns null if not found (e.g. localStorage held
 * a preset ID that was later renamed/removed).
 *
 * @param {string} id
 * @returns {TargetSizePreset | null}
 */
export function getPresetById(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  for (const p of TARGET_SIZE_PRESETS) {
    if (p.id === id) return p;
  }
  return null;
}

/**
 * Resolve the user's current target-size selection into a concrete byte
 * count, or null if the selection is not usable (preset ID missing, custom
 * value zero / negative / NaN).
 *
 * @param {{
 *   mode?: 'preset' | 'custom',
 *   presetId?: string | null,
 *   customValue?: number,
 *   customUnit?: 'MB' | 'KB',
 * } | null | undefined} targetSize
 * @returns {number | null}
 */
export function getActiveTargetBytes(targetSize) {
  if (!targetSize || typeof targetSize !== 'object') return null;
  const mode = targetSize.mode === 'custom' ? 'custom' : 'preset';
  if (mode === 'preset') {
    const preset = getPresetById(targetSize.presetId);
    return preset ? preset.bytes : null;
  }
  // Custom mode.
  const value = Number(targetSize.customValue);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = targetSize.customUnit === 'KB' ? 'KB' : 'MB';
  const multiplier = unit === 'KB' ? 1024 : 1024 * 1024;
  return value * multiplier;
}
