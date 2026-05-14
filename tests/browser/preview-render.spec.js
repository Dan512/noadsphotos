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
      s.ui.zoom = 'fit';
    });
  });
}

// Import a single test image with a known solid color so we can read it back
// out of the rendered canvas.
async function importRedImage(page, w = 200, h = 100) {
  return await page.evaluate(async ({ w, h }) => {
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
}

test('importing then opening editor: base canvas has non-zero internal dims within 1s', async ({ page }) => {
  await resetApp(page);
  const id = await importRedImage(page, 200, 100);
  expect(id).toBeTruthy();

  // Click the thumbnail to open editor.
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();

  // Wait for the renderer to size the canvas.
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const c = document.getElementById('base-canvas');
      return c ? c.width : 0;
    });
  }, { timeout: 1500 }).toBeGreaterThan(0);

  const dims = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return { w: c.width, h: c.height };
  });
  expect(dims.w).toBeGreaterThan(0);
  expect(dims.h).toBeGreaterThan(0);
});

test('rendered base canvas pixel matches source color (red)', async ({ page }) => {
  await resetApp(page);
  const id = await importRedImage(page, 200, 100);

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();

  // Wait for non-zero canvas size.
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const c = document.getElementById('base-canvas');
      return c ? c.width : 0;
    });
  }, { timeout: 2000 }).toBeGreaterThan(0);

  // Wait for the bitmap to be drawn (baseDirty becomes false).
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      const s = getState();
      const id = s.ui.activeImageId;
      return id ? s.images[id].baseDirty : true;
    });
  }, { timeout: 3000 }).toBe(false);

  const pixel = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    const ctx = c.getContext('2d');
    // Sample center pixel.
    const cx = Math.floor(c.width / 2);
    const cy = Math.floor(c.height / 2);
    const d = ctx.getImageData(cx, cy, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  });
  // Red, with possible minor smoothing tolerance.
  expect(pixel.r).toBeGreaterThan(220);
  expect(pixel.g).toBeLessThan(40);
  expect(pixel.b).toBeLessThan(40);
  expect(pixel.a).toBe(255);
});

test('resizing the viewport re-fits the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await resetApp(page);
  // Use a wide image (1200 px) so the fit scale is meaningfully different
  // at the two viewport sizes we exercise. With a small source image the
  // fit is capped at 1× in BOTH viewports and we can't observe the resize.
  // Both viewports below stay above 768 px so the desktop editor layout
  // (1fr 320px) is in effect — comparing apples to apples.
  const id = await importRedImage(page, 1200, 600);

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();

  await expect.poll(async () => {
    return await page.evaluate(() => {
      const c = document.getElementById('base-canvas');
      return c ? c.width : 0;
    });
  }, { timeout: 2000 }).toBeGreaterThan(0);

  const widthBefore = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return parseFloat(c.style.width);
  });

  // Shrink viewport (still desktop layout — above 768 px so the side panel
  // still occupies 320 px of width).
  await page.setViewportSize({ width: 900, height: 700 });

  // Allow time for ResizeObserver + rAF.
  await page.waitForTimeout(300);

  const widthAfter = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return parseFloat(c.style.width);
  });

  // The CSS width should have shrunk after the viewport shrank (or at least
  // not exceed the previous width by much).
  expect(widthAfter).toBeLessThan(widthBefore);
});

test('setting zoom to 100% sizes canvas to source × DPR (capped)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await resetApp(page);
  const srcW = 200;
  const srcH = 100;
  const id = await importRedImage(page, srcW, srcH);

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();

  // Switch zoom to 100% via the dropdown.
  await page.locator('#editor-view .zoom-controls select').selectOption('1');

  await expect.poll(async () => {
    return await page.evaluate((expectedW) => {
      const c = document.getElementById('base-canvas');
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      return c ? c.width === Math.min(expectedW * dpr, 16384) : false;
    }, srcW);
  }, { timeout: 2000 }).toBe(true);

  const result = await page.evaluate(({ srcW, srcH }) => {
    const c = document.getElementById('base-canvas');
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    return {
      internalW: c.width,
      internalH: c.height,
      cssW: parseFloat(c.style.width),
      cssH: parseFloat(c.style.height),
      dpr,
    };
  }, { srcW, srcH });

  // At 100% zoom CSS size equals source dims; internal = CSS × DPR.
  expect(result.cssW).toBe(srcW);
  expect(result.cssH).toBe(srcH);
  expect(result.internalW).toBe(srcW * result.dpr);
  expect(result.internalH).toBe(srcH * result.dpr);
});
