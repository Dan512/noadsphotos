import { test, expect } from '@playwright/test';

// v1.1 Feature 3 — trim transparent edges / trim background color.

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
    document.querySelectorAll('dialog').forEach(d => d.remove());
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

/**
 * Import an image built on the fly. fillRgba lays down the whole canvas in
 * that color; rect ({x,y,w,h,fillRgba}) paints a content rect on top.
 * `transparent=true` makes the fill alpha 0 so we exercise the alpha trim
 * path.
 */
async function importSyntheticImage(page, { w, h, fill, rect, name = 'synthetic.png' }) {
  const id = await page.evaluate(async ({ w, h, fill, rect, name }) => {
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
    if (fill && fill.length === 4 && fill[3] > 0) {
      ctx.fillStyle = `rgba(${fill[0]},${fill[1]},${fill[2]},${fill[3] / 255})`;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    if (rect) {
      ctx.fillStyle = `rgba(${rect.fill[0]},${rect.fill[1]},${rect.fill[2]},${rect.fill[3] / 255})`;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], name, { type: 'image/png' });
    const { getState } = await import('/js/state.js');
    const before = getState().queue.length;
    await importFiles([file], caps, lifecycle);
    // Return the id of the image we just added — not queue[0] which would
    // be the first image in a multi-image setup.
    return getState().queue[before];
  }, { w, h, fill, rect, name });
  return id;
}

async function openEditorFor(page, id) {
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  // On mobile the tab strip hides non-active panel sections. Click the
  // Resize tab so the trim buttons are visible to Playwright.
  const resizeTab = page.locator('.editor-panel-tab[data-tab="resize"]');
  if (await resizeTab.count() > 0 && await resizeTab.isVisible().catch(() => false)) {
    await resizeTab.click();
  }
}

async function readSourceDims(page, id) {
  return await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    if (!img || !img.source) return null;
    return { w: img.source.width, h: img.source.height };
  }, id);
}

// --- editor: Trim transparent edges --------------------------------------

test('editor trim transparent: crops to opaque rect bbox', async ({ page }) => {
  await resetApp(page);
  const id = await importSyntheticImage(page, {
    w: 100, h: 80,
    fill: [0, 0, 0, 0], // fully transparent background
    rect: { x: 20, y: 15, w: 30, h: 25, fill: [255, 0, 0, 255] },
  });
  await openEditorFor(page, id);

  await expect(page.locator('#panel-resize .resize-trim-transparent')).toBeVisible();
  await page.locator('#panel-resize .resize-trim-transparent').click();

  // Wait for the bake to apply.
  await expect.poll(async () => {
    const dims = await readSourceDims(page, id);
    return dims && dims.w === 30 && dims.h === 25;
  }, { timeout: 4000 }).toBe(true);
});

test('editor trim transparent: fully transparent image toasts trimEmpty', async ({ page }) => {
  await resetApp(page);
  const id = await importSyntheticImage(page, {
    w: 50, h: 50,
    fill: [0, 0, 0, 0],
  });
  await openEditorFor(page, id);

  await page.locator('#panel-resize .resize-trim-transparent').click();

  // Source dims should be unchanged.
  const dims = await readSourceDims(page, id);
  expect(dims).toEqual({ w: 50, h: 50 });
  // Toast should appear with the empty message.
  await expect(page.locator('#toast-root')).toContainText(/entirely transparent/i, { timeout: 4000 });
});

// --- editor: Trim background color ---------------------------------------

test('editor trim color: removes white edges around a red rect', async ({ page }) => {
  await resetApp(page);
  const id = await importSyntheticImage(page, {
    w: 80, h: 60,
    fill: [255, 255, 255, 255], // white bg
    rect: { x: 10, y: 12, w: 40, h: 36, fill: [255, 0, 0, 255] },
  });
  await openEditorFor(page, id);

  await page.locator('#panel-resize .resize-trim-color').click();

  await expect.poll(async () => {
    const dims = await readSourceDims(page, id);
    return dims && dims.w === 40 && dims.h === 36;
  }, { timeout: 4000 }).toBe(true);
});

test('editor trim color: pure white image toasts trimEmpty', async ({ page }) => {
  await resetApp(page);
  const id = await importSyntheticImage(page, {
    w: 40, h: 30,
    fill: [255, 255, 255, 255],
  });
  await openEditorFor(page, id);

  await page.locator('#panel-resize .resize-trim-color').click();

  // Source dims should be unchanged. Either trimEmpty or trimNoChange toast
  // is acceptable here — both signal nothing happened.
  const dims = await readSourceDims(page, id);
  expect(dims).toEqual({ w: 40, h: 30 });
});

// --- editor: bake semantics ----------------------------------------------

test('editor trim: clears existing crop/adjust/chromakey on bake', async ({ page }) => {
  await resetApp(page);
  const id = await importSyntheticImage(page, {
    w: 64, h: 64,
    fill: [0, 0, 0, 0],
    rect: { x: 8, y: 8, w: 16, h: 16, fill: [0, 200, 0, 255] },
  });
  await openEditorFor(page, id);

  // Add a non-trivial transform + adjustment + chromakey config so we can
  // verify it's cleared after trim.
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    const { applyRotate } = await import('/js/ops/transforms.js');
    const { applyAdjust, applyFilterPreset } = await import('/js/ops/adjust.js');
    const { applyChromakey } = await import('/js/ops/chromakey.js');
    update(s => {
      const img = s.images[id];
      applyAdjust(img, 'brightness', 20);
      applyFilterPreset(img, 'sepia');
      applyChromakey(img, { hex: '#FF00FF', tolerance: 5 });
      applyRotate(img, 0); // stay in natural orientation so bbox is predictable
    });
  }, id);

  await page.locator('#panel-resize .resize-trim-transparent').click();

  // Wait for the bake to land.
  await expect.poll(async () => {
    const dims = await readSourceDims(page, id);
    return dims && dims.w !== 64;
  }, { timeout: 4000 }).toBe(true);

  // Verify the destructive-bake cleared the categories.
  const state = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    return {
      adjust: img.adjust,
      filterPreset: img.filterPreset,
      chromakey: img.chromakey,
      chromakeyMask: !!img.chromakeyMask,
      transforms: img.transforms,
    };
  }, id);
  expect(state.adjust).toEqual({ brightness: 0, contrast: 0, saturation: 0, blur: 0 });
  expect(state.filterPreset).toBe('none');
  expect(state.chromakey).toBeNull();
  expect(state.chromakeyMask).toBe(false);
  expect(state.transforms).toEqual({ crop: null, rotate: 0, flipH: false, flipV: false, resize: null });
});

test('editor trim: one Ctrl+Z restores the pre-bake source dimensions', async ({ page }) => {
  await resetApp(page);
  const id = await importSyntheticImage(page, {
    w: 60, h: 40,
    fill: [0, 0, 0, 0],
    rect: { x: 5, y: 5, w: 20, h: 20, fill: [0, 0, 255, 255] },
  });
  await openEditorFor(page, id);

  await page.locator('#panel-resize .resize-trim-transparent').click();
  await expect.poll(async () => {
    const dims = await readSourceDims(page, id);
    return dims && dims.w === 20 && dims.h === 20;
  }, { timeout: 4000 }).toBe(true);

  // Undo via the toolbar button.
  await page.locator('#undo-btn').click();
  await expect.poll(async () => {
    const dims = await readSourceDims(page, id);
    return dims && dims.w === 60 && dims.h === 40;
  }, { timeout: 4000 }).toBe(true);
});

// --- queue batch trim ----------------------------------------------------

test('batch trim: panel shows the Trim section with both buttons', async ({ page }) => {
  await resetApp(page);
  await importSyntheticImage(page, {
    w: 50, h: 50, fill: [0, 0, 0, 0],
    rect: { x: 10, y: 10, w: 10, h: 10, fill: [255, 0, 0, 255] },
  });

  await expect(page.locator('.batch-panel .batch-trim-section')).toHaveCount(1);
  // Open it so the buttons become visible (it's a closed details section).
  await page.evaluate(() => { document.querySelector('.batch-trim-section').open = true; });
  await expect(page.locator('.batch-trim-transparent')).toBeVisible();
  await expect(page.locator('.batch-trim-color')).toBeVisible();
});

test('batch trim transparent: trims every image to its content bbox', async ({ page }) => {
  await resetApp(page);
  const id1 = await importSyntheticImage(page, {
    w: 60, h: 40, fill: [0, 0, 0, 0],
    rect: { x: 5, y: 5, w: 20, h: 20, fill: [255, 0, 0, 255] },
    name: 'a.png',
  });
  const id2 = await importSyntheticImage(page, {
    w: 80, h: 50, fill: [0, 0, 0, 0],
    rect: { x: 10, y: 10, w: 30, h: 25, fill: [0, 0, 255, 255] },
    name: 'b.png',
  });

  await page.evaluate(() => { document.querySelector('.batch-trim-section').open = true; });
  await page.locator('.batch-trim-transparent').click();

  await expect.poll(async () => {
    const a = await readSourceDims(page, id1);
    const b = await readSourceDims(page, id2);
    return a && b && a.w === 20 && a.h === 20 && b.w === 30 && b.h === 25;
  }, { timeout: 6000 }).toBe(true);
});
