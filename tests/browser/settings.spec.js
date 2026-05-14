// tests/browser/settings.spec.js — settings popover + theme override.
import { test, expect } from '@playwright/test';

// Boot a clean page with no persisted settings or language preference.
async function bootClean(page) {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__settingsTestArmed__')) {
        localStorage.removeItem('noadsimages_lang');
        localStorage.removeItem('noadsimages_settings');
        sessionStorage.setItem('__settingsTestArmed__', '1');
      }
    } catch { /* ignore */ }
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

// Same but pre-seeds localStorage with a known settings blob — handy for
// "reload preserves the value" tests.
async function bootWithSettings(page, blob) {
  await page.addInitScript((stored) => {
    try {
      localStorage.removeItem('noadsimages_lang');
      localStorage.setItem('noadsimages_settings', JSON.stringify(stored));
    } catch { /* ignore */ }
  }, blob);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

test('clicking the gear opens a settings popover', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  await expect(page.locator('.settings-popover')).toBeVisible();
});

test('settings popover contains all 6 rows + restore button', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  const rows = page.locator('.settings-popover .settings-row');
  await expect(rows).toHaveCount(6);
  const keys = await rows.evaluateAll(els => els.map(el => el.dataset.setting));
  expect(keys.sort()).toEqual([
    'confirmBeforeRemove',
    'defaultExportFormat',
    'defaultQuality',
    'showOverlayOutlines',
    'smoothBrushStrokes',
    'theme',
  ]);
  await expect(page.locator('.settings-popover .settings-revert-btn')).toHaveCount(1);
});

test('selecting Dark sets html[data-theme="dark"] immediately', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  await page.locator('.settings-popover [data-setting="theme"] select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('selecting Light sets html[data-theme="light"] immediately', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  await page.locator('.settings-popover [data-setting="theme"] select').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('selecting Auto removes the data-theme attribute', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  // Flip to dark first to make sure the attribute is set, then back to auto.
  await page.locator('.settings-popover [data-setting="theme"] select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.settings-popover [data-setting="theme"] select').selectOption('auto');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
});

test('theme persists across reloads', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  await page.locator('.settings-popover [data-setting="theme"] select').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Reload — the dark theme should already be on <html> by boot completion,
  // i.e. no flash of wrong theme.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('pressing Escape closes the settings popover', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  await expect(page.locator('.settings-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-popover')).toHaveCount(0);
});

test('clicking outside closes the settings popover', async ({ page }) => {
  await bootClean(page);
  await page.locator('#settings-toggle').click();
  await expect(page.locator('.settings-popover')).toBeVisible();
  // Click far away from the popover (which is anchored to the gear button
  // in the top-right). The bottom-left of the viewport is safely outside
  // across desktop + mobile viewports. We dispatch the event directly so
  // the click lands at the absolute coordinates we want regardless of
  // whichever element happens to be at that position.
  await page.evaluate(() => {
    const evt = new MouseEvent('click', { bubbles: true, clientX: 5, clientY: window.innerHeight - 5 });
    document.body.dispatchEvent(evt);
  });
  await expect(page.locator('.settings-popover')).toHaveCount(0);
});

test('Restore defaults resets every control', async ({ page }) => {
  await bootWithSettings(page, {
    theme: 'dark',
    defaultExportFormat: 'webp',
    defaultQuality: 0.7,
    confirmBeforeRemove: true,
    showOverlayOutlines: true,
    smoothBrushStrokes: false,
  });
  // The dark theme should already be on <html> by boot complete.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.locator('#settings-toggle').click();
  await page.locator('.settings-popover .settings-revert-btn').click();
  // After restore: theme back to auto (no data-theme attr).
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  // Each control reflects its default. Note the popover gets rebuilt by
  // the revert handler, so we re-query.
  await expect(page.locator('.settings-popover [data-setting="theme"] select')).toHaveValue('auto');
  await expect(page.locator('.settings-popover [data-setting="defaultExportFormat"] select')).toHaveValue('png');
  await expect(page.locator('.settings-popover [data-setting="confirmBeforeRemove"] input')).not.toBeChecked();
  await expect(page.locator('.settings-popover [data-setting="showOverlayOutlines"] input')).not.toBeChecked();
  await expect(page.locator('.settings-popover [data-setting="smoothBrushStrokes"] input')).toBeChecked();
});

test('defaultExportFormat seeds state.export.format on boot', async ({ page }) => {
  await bootWithSettings(page, {
    theme: 'auto',
    defaultExportFormat: 'webp',
    defaultQuality: 0.92,
    confirmBeforeRemove: false,
    showOverlayOutlines: false,
    smoothBrushStrokes: true,
  });
  const fmt = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.format;
  });
  expect(fmt).toBe('webp');
});

test('default quality seeds state.export.quality on boot', async ({ page }) => {
  await bootWithSettings(page, {
    theme: 'auto',
    defaultExportFormat: 'jpeg',
    defaultQuality: 0.7,
    confirmBeforeRemove: false,
    showOverlayOutlines: false,
    smoothBrushStrokes: true,
  });
  const q = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.quality;
  });
  expect(q).toBeCloseTo(0.7, 6);
});

test('tampered localStorage falls back to defaults on boot', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('noadsimages_lang');
      localStorage.setItem('noadsimages_settings', JSON.stringify({
        theme: 'javascript:hack',
        defaultExportFormat: '<script>',
        defaultQuality: 'not a number',
        confirmBeforeRemove: 'whatever',
      }));
    } catch { /* ignore */ }
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  // Tampered theme → default 'auto' → no data-theme attribute.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  const exported = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.format;
  });
  expect(exported).toBe('png');
});
