import { test, expect } from '@playwright/test';

async function resetApp(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => {
      s.queue = [];
      s.images = Object.create(null);
      s.ui.activeImageId = null;
      s.ui.view = 'queue';
      s.ui.activeTool = 'select';
      s.ui.zoom = 'fit';
    });
  });
}

async function setupEditorWithImage(page, w = 800, h = 400) {
  const id = await page.evaluate(async ({ w, h }) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'red.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  return id;
}

test('resize panel: appears as a "Resize" details section', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await expect(page.locator('#panel-resize')).toBeVisible();
  await expect(page.locator('#panel-resize .resize-mode')).toBeVisible();
});

test('resize panel: choosing longestSide stores resize on state', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 800, 400);

  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('400');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');

  const resize = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.resize;
  }, id);
  expect(resize).not.toBeNull();
  expect(resize.mode).toBe('longestSide');
  expect(resize.value).toBe(400);
});

test('resize panel: readout updates to predicted dims', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 800, 400);

  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('400');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');

  // Output should be 400 × 200 (long side scales 800 → 400, ratio preserved).
  await expect(page.locator('#panel-resize .resize-readout')).toHaveText(/400.*200/);
});

test('resize panel: choosing Free clears resize', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // First set a resize.
  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('400');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');

  // Then clear it.
  await page.locator('#panel-resize .resize-mode').selectOption('free');

  const resize = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.resize;
  }, id);
  expect(resize).toBeNull();
});

test('resize panel: exact mode shows the height input', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await page.locator('#panel-resize .resize-mode').selectOption('exact');
  await expect(page.locator('#panel-resize .resize-height-row')).toBeVisible();
});

test('resize panel: resize does NOT affect the live preview canvas size', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 800, 400);

  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);

  const sizeBefore = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return { w: c.width, h: c.height, cssW: c.style.width, cssH: c.style.height };
  });

  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('100');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');

  // Wait a couple of frames for the renderer.
  await page.waitForTimeout(120);

  const sizeAfter = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return { w: c.width, h: c.height, cssW: c.style.width, cssH: c.style.height };
  });

  // Canvas size unchanged by resize (resize is export-time).
  expect(sizeAfter.w).toBe(sizeBefore.w);
  expect(sizeAfter.h).toBe(sizeBefore.h);
});
