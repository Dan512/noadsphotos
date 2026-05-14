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

// Import a single small test image and enter the editor on it. The fill
// callback receives the canvas + 2d ctx and is responsible for painting it.
async function setupEditorWithImage(page, w, h, paint) {
  const id = await page.evaluate(async ({ w, h, paintSrc }) => {
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
    // eslint-disable-next-line no-new-func
    const fn = new Function('canvas', 'ctx', paintSrc);
    fn(c, ctx);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'test.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h, paintSrc: paint });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  // Wait for the base canvas to be sized.
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
  return id;
}

async function activateEyedropper(page) {
  await page.locator('#editor-view .editor-toolbar button[data-tool="eyedropper"]').click();
  await expect(page.locator('#panel-tool .eyedropper-tool-panel')).toBeVisible();
}

// Paint helpers (run inside the browser, no closures over node scope).
const PAINT_HALF_RED_HALF_BLACK = `
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width / 2, canvas.height);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height);
`;

// --- structural tests ---------------------------------------------------

test('eyedropper: activating shows the side panel with heading + controls', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 20, 10, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  const heading = page.locator('#panel-tool .eyedropper-tool-panel .panel-heading');
  await expect(heading).toHaveText('Color to transparent');
  await expect(page.locator('#panel-tool .eyedropper-swatch')).toBeVisible();
  await expect(page.locator('#panel-tool .eyedropper-hex')).toBeVisible();
  await expect(page.locator('#panel-tool .eyedropper-tolerance')).toBeVisible();
  await expect(page.locator('#panel-tool .eyedropper-apply')).toBeVisible();
  await expect(page.locator('#panel-tool .eyedropper-cancel')).toBeVisible();
});

test('eyedropper: tolerance slider has range [0, 100] and defaults to 25', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 20, 10, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  const tolValues = await page.evaluate(() => {
    const s = document.querySelector('#panel-tool .eyedropper-tolerance');
    return { min: s.min, max: s.max, value: s.value };
  });
  expect(tolValues.min).toBe('0');
  expect(tolValues.max).toBe('100');
  expect(tolValues.value).toBe('25');
});

test('eyedropper: switching to another tool clears the panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 20, 10, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  // Switch to select tool — the eyedropper panel should be gone.
  await page.locator('#editor-view .editor-toolbar button[data-tool="select"]').click();
  await expect(page.locator('#panel-tool .eyedropper-tool-panel')).toHaveCount(0);
});

// --- pixel sampling -----------------------------------------------------

test('eyedropper: clicking the canvas reads the pixel color into the swatch + hex input', async ({ page }) => {
  await resetApp(page);
  // 100×40 image with black left half + red right half.
  await setupEditorWithImage(page, 100, 40, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  // Give the renderer a couple of frames to draw the base canvas.
  await page.waitForTimeout(120);

  // Click the left half (black) of the overlay canvas.
  await page.evaluate(() => {
    const overlay = document.getElementById('overlay-canvas');
    const r = overlay.getBoundingClientRect();
    const cx = r.left + r.width * 0.25;
    const cy = r.top + r.height * 0.5;
    const ev = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: x, clientY: y, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
    });
    overlay.dispatchEvent(ev('pointerdown', cx, cy));
    overlay.dispatchEvent(ev('pointerup', cx, cy));
  });

  await expect.poll(async () => {
    return await page.evaluate(() => document.querySelector('#panel-tool .eyedropper-hex').value);
  }, { timeout: 2000 }).toMatch(/^#0{6}$/i);
});

// --- live mask + render -------------------------------------------------

test('eyedropper: typing hex + tolerance builds a chromakey mask on state.images[id]', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 20, 10, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  // Type a hex and let the input event fire.
  await page.locator('#panel-tool .eyedropper-hex').fill('#000000');

  // Bump tolerance a bit.
  await page.evaluate(() => {
    const s = document.querySelector('#panel-tool .eyedropper-tolerance');
    s.value = '30';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // The mask is built via rAF; poll for it.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      const img = getState().images[id];
      return img && img.chromakeyMask ? img.chromakeyMask.length : 0;
    }, id);
  }, { timeout: 2000 }).toBe(200); // 20 * 10
});

test('eyedropper: after Apply, the canvas shows transparent pixels where black was', async ({ page }) => {
  await resetApp(page);
  // 100×40 image with black left half + red right half. Apply chromakey for
  // black and check that the rendered base canvas has alpha=0 in the left
  // half and alpha≠0 in the right half.
  await setupEditorWithImage(page, 100, 40, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  await page.waitForTimeout(120);

  // Type a hex value programmatically and dispatch the input event so the
  // tool kicks the preview rebuild.
  await page.locator('#panel-tool .eyedropper-hex').fill('#000000');

  // Wait for the mask to land on state.
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      const s = getState();
      const img = s.images[s.queue[0]];
      return img && img.chromakeyMask ? img.chromakeyMask.length : 0;
    });
  }, { timeout: 2000 }).toBe(4000); // 100 * 40

  // Click Apply.
  await page.locator('#panel-tool .eyedropper-apply').click();

  // Give the renderer a frame to bake the masked source canvas.
  await page.waitForTimeout(200);

  // Now inspect the base canvas: left quarter should be ~transparent, right
  // quarter should still have red pixels.
  const stats = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    const ctx = c.getContext('2d');
    const leftSample = ctx.getImageData(Math.floor(c.width * 0.1), Math.floor(c.height * 0.5), 1, 1).data;
    const rightSample = ctx.getImageData(Math.floor(c.width * 0.9), Math.floor(c.height * 0.5), 1, 1).data;
    return {
      leftAlpha: leftSample[3],
      rightAlpha: rightSample[3],
      rightRed:   rightSample[0],
    };
  });
  expect(stats.leftAlpha).toBe(0);
  expect(stats.rightAlpha).toBeGreaterThan(0);
  // Right side should be red (or close to it after filtering / interpolation).
  expect(stats.rightRed).toBeGreaterThan(200);
});

test('eyedropper: Apply commits state.images[id].chromakey', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 20, 10, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  await page.locator('#panel-tool .eyedropper-hex').fill('#000000');
  // Wait for mask to build before applying.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return getState().images[id].chromakeyMask ? 1 : 0;
    }, id);
  }, { timeout: 2000 }).toBe(1);

  await page.locator('#panel-tool .eyedropper-apply').click();

  const result = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return { chromakey: s.images[id].chromakey, activeTool: s.ui.activeTool };
  }, id);
  expect(result.chromakey).not.toBeNull();
  expect(result.chromakey.hex).toBe('#000000');
  // Apply switches back to select tool (matches crop tool UX).
  expect(result.activeTool).toBe('select');
});

test('eyedropper: Cancel clears chromakey + chromakeyMask', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 20, 10, PAINT_HALF_RED_HALF_BLACK);
  await activateEyedropper(page);

  await page.locator('#panel-tool .eyedropper-hex').fill('#000000');
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return getState().images[id].chromakeyMask ? 1 : 0;
    }, id);
  }, { timeout: 2000 }).toBe(1);

  await page.locator('#panel-tool .eyedropper-cancel').click();

  const result = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return {
      chromakey:     getState().images[id].chromakey,
      chromakeyMask: getState().images[id].chromakeyMask,
      activeTool:    getState().ui.activeTool,
    };
  }, id);
  expect(result.chromakey).toBeNull();
  expect(result.chromakeyMask).toBeNull();
  expect(result.activeTool).toBe('select');
});

test('eyedropper: state.images[id].chromakeyMask field exists on freshly imported images', async ({ page }) => {
  // The importer (Phase 6 wire-up) should add chromakeyMask: null alongside
  // bgMask: null so the field is always present on every ImageState.
  await resetApp(page);
  const id = await setupEditorWithImage(page, 20, 10, PAINT_HALF_RED_HALF_BLACK);
  const has = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    return Object.prototype.hasOwnProperty.call(img, 'chromakeyMask') && img.chromakeyMask === null;
  }, id);
  expect(has).toBe(true);
});
