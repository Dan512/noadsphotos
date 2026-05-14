import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilterPreset, PRESETS } from '../../js/ops/filters.js';
import { applyFilterPreset as adjustApplyFilterPreset } from '../../js/ops/adjust.js';

test('PRESETS lists all four preset values in canonical order', () => {
  assert.deepStrictEqual([...PRESETS], ['none', 'grayscale', 'sepia', 'invert']);
});

test('PRESETS is frozen', () => {
  assert.equal(Object.isFrozen(PRESETS), true);
});

test('filters.applyFilterPreset is the same function as adjust.applyFilterPreset (re-export)', () => {
  assert.equal(applyFilterPreset, adjustApplyFilterPreset);
});

test('applyFilterPreset via filters.js sets state.filterPreset', () => {
  const img = { filterPreset: 'none' };
  applyFilterPreset(img, 'sepia');
  assert.equal(img.filterPreset, 'sepia');
});

test('applyFilterPreset via filters.js falls back to "none" on unknown', () => {
  const img = { filterPreset: 'grayscale' };
  applyFilterPreset(img, 'bogus');
  assert.equal(img.filterPreset, 'none');
});
