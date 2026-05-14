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
      s.ui.selectedOverlayId = null;
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
    ctx.fillStyle = '#ddeeff';
    ctx.fillRect(0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'test.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
  return id;
}

async function activateBrushTool(page) {
  await page.locator('#editor-view .editor-toolbar button[data-tool="brush"]').click();
  await expect(page.locator('#panel-tool .brush-tool-panel')).toBeVisible();
}

// Drag a stroke across the overlay canvas from (fx1, fy1) to (fx2, fy2)
// (fractions of the canvas dimensions). Uses several intermediate moves so
// the brush accumulates multiple points.
async function dragCanvas(page, fx1, fy1, fx2, fy2, steps = 6) {
  await page.evaluate(({ fx1, fy1, fx2, fy2, steps }) => {
    const overlay = document.getElementById('overlay-canvas');
    const rect = overlay.getBoundingClientRect();
    const x1 = rect.left + rect.width * fx1;
    const y1 = rect.top  + rect.height * fy1;
    const x2 = rect.left + rect.width * fx2;
    const y2 = rect.top  + rect.height * fy2;
    const ev = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: x, clientY: y, isPrimary: true,
      buttons: type === 'pointerup' ? 0 : 1,
    });
    overlay.dispatchEvent(ev('pointerdown', x1, y1));
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1);
      overlay.dispatchEvent(ev('pointermove', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t));
    }
    overlay.dispatchEvent(ev('pointerup', x2, y2));
  }, { fx1, fy1, fx2, fy2, steps });
}

// --- tests --------------------------------------------------------------

test('brush tool: side panel shows color picker, size slider, swatch', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateBrushTool(page);

  await expect(page.locator('#panel-tool .brush-color')).toBeVisible();
  await expect(page.locator('#panel-tool .brush-size')).toBeVisible();
  await expect(page.locator('#panel-tool .brush-swatch')).toBeVisible();
  await expect(page.locator('#panel-tool .brush-hint')).toBeVisible();
});

test('brush tool: drag on canvas creates a brush overlay in state', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateBrushTool(page);
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const result = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    return {
      count: img.overlays.length,
      type: img.overlays[0]?.type,
      selected: getState().ui.selectedOverlayId,
    };
  }, id);
  expect(result.count).toBe(1);
  expect(result.type).toBe('brush');
  expect(result.selected).toBeTruthy();
});

test('brush tool: drag produces multiple points (Float32Array length > 3)', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateBrushTool(page);
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7, 8);

  const numPoints = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    return o?.points?.length || 0;
  }, id);
  // Stride 3, so >3 means at least 2 points.
  expect(numPoints).toBeGreaterThan(3);
});

test('brush tool: stroke appears in the overlays panel after release', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 400, 200);
  await activateBrushTool(page);
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  // The overlays panel lives in the Overlays section. After committing
  // the stroke, a row labelled "Brush" should be present.
  await expect(page.locator('#panel-overlays .overlay-row').first()).toBeVisible();
  const labels = await page.locator('#panel-overlays .overlay-row .overlay-label').allTextContents();
  expect(labels).toContain('Brush');
});

test('brush tool: changing color before drawing uses the new color', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateBrushTool(page);

  // Set color to red.
  await page.evaluate(() => {
    const c = document.querySelector('#panel-tool .brush-color');
    c.value = '#ff0000';
    c.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const color = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    return o?.color;
  }, id);
  expect(color).toBe('#ff0000');
});

test('brush tool: changing size before drawing uses the new size', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateBrushTool(page);

  // Set size to 20.
  await page.evaluate(() => {
    const s = document.querySelector('#panel-tool .brush-size');
    s.value = '20';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const size = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    return o?.size;
  }, id);
  expect(size).toBe(20);
});

test('brush tool: switching to another tool clears the panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateBrushTool(page);

  await page.locator('#editor-view .editor-toolbar button[data-tool="select"]').click();
  await expect(page.locator('#panel-tool .brush-tool-panel')).toHaveCount(0);
});

test('brush tool: a tap (no drag) does not create an overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateBrushTool(page);

  // Pointer down + up at the same position with no move.
  await page.evaluate(() => {
    const overlay = document.getElementById('overlay-canvas');
    const rect = overlay.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top  + rect.height / 2;
    const ev = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: x, clientY: y, isPrimary: true,
      buttons: type === 'pointerup' ? 0 : 1,
    });
    overlay.dispatchEvent(ev('pointerdown', cx, cy));
    overlay.dispatchEvent(ev('pointerup', cx, cy));
  });

  const count = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays.length;
  }, id);
  expect(count).toBe(0);
});
