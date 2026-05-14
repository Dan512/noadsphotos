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

async function activateRedactTool(page) {
  await page.locator('#editor-view .editor-toolbar button[data-tool="redact"]').click();
  await expect(page.locator('#panel-tool .redact-tool-panel')).toBeVisible();
}

async function dragCanvas(page, fx1, fy1, fx2, fy2) {
  await page.evaluate(({ fx1, fy1, fx2, fy2 }) => {
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
    overlay.dispatchEvent(ev('pointermove', (x1 + x2) / 2, (y1 + y2) / 2));
    overlay.dispatchEvent(ev('pointermove', x2, y2));
    overlay.dispatchEvent(ev('pointerup', x2, y2));
  }, { fx1, fy1, fx2, fy2 });
}

// --- tests --------------------------------------------------------------

test('redact tool: side panel shows mode toggle + strength slider', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateRedactTool(page);

  await expect(page.locator('#panel-tool .redact-mode-blur')).toBeVisible();
  await expect(page.locator('#panel-tool .redact-mode-pixelate')).toBeVisible();
  await expect(page.locator('#panel-tool .redact-strength')).toBeVisible();
  await expect(page.locator('#panel-tool .redact-hint')).toBeVisible();
});

test('redact tool: drag creates a redact overlay in state', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateRedactTool(page);
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const result = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    return {
      count: getState().images[id].overlays.length,
      type: o?.type,
      mode: o?.mode,
      strength: o?.strength,
      hasWH: o ? (o.w > 0 && o.h > 0) : false,
    };
  }, id);
  expect(result.count).toBe(1);
  expect(result.type).toBe('redact');
  expect(result.mode).toBe('blur'); // default
  expect(result.strength).toBe(12); // default
  expect(result.hasWH).toBe(true);
});

test('redact tool: switching mode to pixelate before drag changes the overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateRedactTool(page);
  await page.locator('#panel-tool .redact-mode-pixelate').click();
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const mode = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0]?.mode;
  }, id);
  expect(mode).toBe('pixelate');
});

test('redact tool: changing strength slider before drag applies the new value', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateRedactTool(page);

  await page.evaluate(() => {
    const s = document.querySelector('#panel-tool .redact-strength');
    s.value = '30';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const strength = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0]?.strength;
  }, id);
  expect(strength).toBe(30);
});

test('redact tool: a tap (no drag) does not create an overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateRedactTool(page);

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

test('redact tool: switching to another tool clears the panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateRedactTool(page);

  await page.locator('#editor-view .editor-toolbar button[data-tool="select"]').click();
  await expect(page.locator('#panel-tool .redact-tool-panel')).toHaveCount(0);
});
