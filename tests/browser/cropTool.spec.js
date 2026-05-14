import { test, expect } from '@playwright/test';

// --- helpers -------------------------------------------------------------

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

// Import a single 200x100 red image, open the editor on it. Returns the id.
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

  // Wait for the base canvas to be sized.
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const c = document.getElementById('base-canvas');
      return c ? c.width : 0;
    });
  }, { timeout: 2000 }).toBeGreaterThan(0);

  return id;
}

async function activateCropTool(page) {
  await page.locator('#editor-view .editor-toolbar button[data-tool="crop"]').click();
  // The crop side panel should appear.
  await expect(page.locator('#panel-tool .crop-tool-panel')).toBeVisible();
}

async function getPreviewRect(page) {
  return await page.evaluate(async () => {
    // The preview rect is a module-level var; expose via the overlay non-zero
    // pixel area as a proxy. We sample the overlay canvas for any non-zero
    // alpha pixel.
    const c = document.getElementById('overlay-canvas');
    if (!c || !c.width) return null;
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonZero = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) nonZero++;
    }
    return { nonZero, total: data.length / 4 };
  });
}

// --- tests --------------------------------------------------------------

test('crop tool: activating shows the overlay rect (non-zero overlay pixels)', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateCropTool(page);

  // Give the renderer a frame to draw the overlay.
  await page.waitForTimeout(120);

  const stats = await getPreviewRect(page);
  expect(stats).not.toBeNull();
  expect(stats.nonZero).toBeGreaterThan(0);
});

test('crop tool: side panel shows aspect-lock dropdown + Apply + Cancel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateCropTool(page);

  await expect(page.locator('#panel-tool .crop-aspect')).toBeVisible();
  await expect(page.locator('#panel-tool .crop-apply')).toBeVisible();
  await expect(page.locator('#panel-tool .crop-cancel')).toBeVisible();
});

test('crop tool: defaults preview rect to full image bounds', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 200, 100);
  await activateCropTool(page);

  // Right after activation, state.transforms.crop should still be null (the
  // preview rect is local). The Apply button should commit a rect equal to
  // the full image.
  const before = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.crop;
  }, id);
  expect(before).toBeNull();

  // Click Apply.
  await page.locator('#panel-tool .crop-apply').click();

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].transforms.crop;
  }, id);
  expect(after).not.toBeNull();
  expect(after.w).toBe(200);
  expect(after.h).toBe(100);
});

test('crop tool: Apply commits previewRect and switches back to select tool', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 200, 100);
  await activateCropTool(page);

  await page.locator('#panel-tool .crop-apply').click();

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return {
      activeTool: getState().ui.activeTool,
      crop: getState().images[id].transforms.crop,
    };
  }, id);
  expect(after.activeTool).toBe('select');
  expect(after.crop).not.toBeNull();
});

test('crop tool: Cancel discards preview and switches to select; state.crop unchanged', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  await activateCropTool(page);

  await page.locator('#panel-tool .crop-cancel').click();

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return {
      activeTool: getState().ui.activeTool,
      crop: getState().images[id].transforms.crop,
    };
  }, id);
  expect(after.activeTool).toBe('select');
  expect(after.crop).toBeNull();
});

test('crop tool: switching to another tool detaches and clears the panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateCropTool(page);

  // Switch to text tool. The crop panel should be gone.
  await page.locator('#editor-view .editor-toolbar button[data-tool="text"]').click();
  await expect(page.locator('#panel-tool .crop-tool-panel')).toHaveCount(0);
});

test('crop tool: aspect lock "1:1" makes corner drag keep w === h', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 300, 300);
  await activateCropTool(page);

  // Pick 1:1.
  await page.locator('#panel-tool .crop-aspect').selectOption('1:1');

  // Compute the overlay-canvas bounding rect and click-drag in the interior
  // to create a new rect. We drag from one point to another to start fresh.
  const overlay = page.locator('#overlay-canvas');
  const box = await overlay.boundingBox();
  expect(box).not.toBeNull();

  // Drag outside the current rect won't be easy since the default rect is
  // full image. Instead drag a corner handle (bottom-right): the handle
  // sits at (box.x + box.width, box.y + box.height) approximately.
  // We dispatch pointer events directly so we can hit pixels exactly.
  await page.evaluate(({ x, y, w, h }) => {
    const overlay = document.getElementById('overlay-canvas');
    const rect = overlay.getBoundingClientRect();
    // Down on bottom-right handle.
    const ev = (type, cx, cy) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: cx, clientY: cy, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
    });
    overlay.dispatchEvent(ev('pointerdown', rect.right - 1, rect.bottom - 1));
    // Drag inward to (rect.left + 50, rect.top + 80) — asymmetric move so we
    // can verify 1:1 lock actually constrains.
    overlay.dispatchEvent(ev('pointermove', rect.left + 50, rect.top + 80));
    overlay.dispatchEvent(ev('pointerup',   rect.left + 50, rect.top + 80));
  }, box);

  // Apply and check the committed rect.
  await page.locator('#panel-tool .crop-apply').click();

  const crop = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return s.images[s.queue[0]].transforms.crop;
  });
  expect(crop).not.toBeNull();
  // 1:1 lock should make w === h (within rounding from the clamp).
  expect(Math.abs(crop.w - crop.h)).toBeLessThan(2);
});

test('crop tool: corner drag changes preview rect bounds', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 200, 200);
  await activateCropTool(page);

  // Drag the bottom-right handle inward — verify the applied crop is smaller
  // than the original image.
  await page.evaluate(() => {
    const overlay = document.getElementById('overlay-canvas');
    const rect = overlay.getBoundingClientRect();
    const ev = (type, cx, cy) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: cx, clientY: cy, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
    });
    overlay.dispatchEvent(ev('pointerdown', rect.right - 1, rect.bottom - 1));
    overlay.dispatchEvent(ev('pointermove', rect.left + rect.width / 2, rect.top + rect.height / 2));
    overlay.dispatchEvent(ev('pointerup',   rect.left + rect.width / 2, rect.top + rect.height / 2));
  });

  await page.locator('#panel-tool .crop-apply').click();

  const crop = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return s.images[s.queue[0]].transforms.crop;
  });
  expect(crop).not.toBeNull();
  expect(crop.w).toBeLessThan(200);
  expect(crop.h).toBeLessThan(200);
});
