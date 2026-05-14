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

async function setupEditorWithImage(page, w = 200, h = 100) {
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

  await expect.poll(async () => {
    return await page.evaluate(() => {
      const c = document.getElementById('base-canvas');
      return c ? c.width : 0;
    });
  }, { timeout: 2000 }).toBeGreaterThan(0);

  return id;
}

test('select tool: side panel shows rotate +/- 90 buttons, slider, and flip buttons', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  // Default active tool is 'select'. Side panel should already show the
  // select-tool controls.
  await expect(page.locator('#panel-tool .rotate-minus-90')).toBeVisible();
  await expect(page.locator('#panel-tool .rotate-plus-90')).toBeVisible();
  await expect(page.locator('#panel-tool .rotate-slider')).toBeVisible();
  await expect(page.locator('#panel-tool .rotate-readout')).toBeVisible();
  await expect(page.locator('#panel-tool .flip-h-btn')).toBeVisible();
  await expect(page.locator('#panel-tool .flip-v-btn')).toBeVisible();
});

test('select tool: +90° rotates state.transforms.rotate by 90', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-plus-90').click();
  const r = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.rotate;
  }, id);
  expect(r).toBe(90);
});

test('select tool: -90° rotates and normalises -90 → 270', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-minus-90').click();
  const r = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.rotate;
  }, id);
  expect(r).toBe(270);
});

test('select tool: flip H toggles transforms.flipH', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .flip-h-btn').click();
  let v = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.flipH;
  }, id);
  expect(v).toBe(true);

  await page.locator('#panel-tool .flip-h-btn').click();
  v = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.flipH;
  }, id);
  expect(v).toBe(false);
});

test('select tool: flip V toggles transforms.flipV', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .flip-v-btn').click();
  const v = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.flipV;
  }, id);
  expect(v).toBe(true);
});

test('select tool: rotation readout updates after rotate', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-plus-90').click();
  await expect(page.locator('#panel-tool .rotate-readout')).toHaveText(/Rotation: 90/);
});

test('select tool: switching to crop tool removes the rotate/flip panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  // Sanity: select-tool panel present.
  await expect(page.locator('#panel-tool .rotate-slider')).toBeVisible();

  await page.locator('#editor-view .editor-toolbar button[data-tool="crop"]').click();
  await expect(page.locator('#panel-tool .rotate-slider')).toHaveCount(0);

  // Switch back to select.
  await page.locator('#editor-view .editor-toolbar button[data-tool="select"]').click();
  await expect(page.locator('#panel-tool .rotate-slider')).toBeVisible();
});
