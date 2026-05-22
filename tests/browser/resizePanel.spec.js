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

test('resize panel: clicking Apply stores resize on state', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 800, 400);

  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('400');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');

  // Pending-until-Apply: state should still be null before the click.
  const before = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.resize;
  }, id);
  expect(before).toBeNull();

  await page.locator('#panel-resize .resize-apply').click();

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.resize;
  }, id);
  expect(after).not.toBeNull();
  expect(after.mode).toBe('longestSide');
  expect(after.value).toBe(400);
});

test('resize panel: readout updates to predicted dims (pending, before Apply)', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 800, 400);

  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('400');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');

  // Output reflects the pending pick (400 × 200), even though Apply hasn't
  // been clicked yet — readout is the user's preview of what export will do.
  await expect(page.locator('#panel-resize .resize-readout')).toHaveText(/400.*200/);
});

test('resize panel: choosing Free clears resize immediately', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // First set a resize via Apply.
  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('400');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');
  await page.locator('#panel-resize .resize-apply').click();

  // Free mode bypasses the Apply button (it's a one-click action).
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

test('resize panel: typing alone does NOT change the canvas (state is pending)', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 800, 400);

  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);

  const sizeBefore = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return { w: c.width, h: c.height };
  });

  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('100');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');

  // Wait a couple of frames so any (incorrect) re-render would land.
  await page.waitForTimeout(120);

  const sizeAfter = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return { w: c.width, h: c.height };
  });

  // No Apply click yet → state hasn't been touched → canvas size unchanged.
  expect(sizeAfter.w).toBe(sizeBefore.w);
  expect(sizeAfter.h).toBe(sizeBefore.h);
});

test('resize panel: clicking Apply leaves the canvas painted (no blank)', async ({ page }) => {
  // Sanity check that the pixelation pre-pass introduced for v1.1.1 doesn't
  // accidentally clear the canvas. We don't try to assert "looks pixelated"
  // here — a solid-color fixture has no visible degradation regardless. The
  // important assertion is just that the centre pixel stays painted after
  // the downsample-then-upsample round-trip kicks in.
  await resetApp(page);
  await setupEditorWithImage(page, 800, 400);

  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);

  await page.locator('#panel-resize .resize-mode').selectOption('percent');
  await page.locator('#panel-resize .resize-value').fill('5');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');
  await page.locator('#panel-resize .resize-apply').click();

  await page.waitForTimeout(150);

  const centerPixel = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    const ctx = c.getContext('2d');
    const px = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { r: px[0], g: px[1], b: px[2], a: px[3] };
  });
  expect(centerPixel.a).toBeGreaterThan(0);
  expect(centerPixel.r).toBeGreaterThan(100); // still red-dominant
});

test('resize panel: Apply button is disabled until the user changes something', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 800, 400);

  // No edits yet → disabled.
  await expect(page.locator('#panel-resize .resize-apply')).toBeDisabled();

  // Pick mode + type a value → enabled.
  await page.locator('#panel-resize .resize-mode').selectOption('longestSide');
  await page.locator('#panel-resize .resize-value').fill('200');
  await page.locator('#panel-resize .resize-value').dispatchEvent('input');
  await expect(page.locator('#panel-resize .resize-apply')).toBeEnabled();

  // Click Apply → state matches DOM → disabled again.
  await page.locator('#panel-resize .resize-apply').click();
  await expect(page.locator('#panel-resize .resize-apply')).toBeDisabled();
});
