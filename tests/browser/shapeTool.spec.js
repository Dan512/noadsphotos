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

async function activateShapeTool(page) {
  await page.locator('#editor-view .editor-toolbar button[data-tool="shape"]').click();
  await expect(page.locator('#panel-tool .shape-tool-panel')).toBeVisible();
}

async function selectKind(page, kind) {
  await page.locator(`#panel-tool .shape-kind-${kind}`).click();
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

test('shape tool: side panel shows kind chips + stroke + stroke width', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateShapeTool(page);

  await expect(page.locator('#panel-tool .shape-kind-line')).toBeVisible();
  await expect(page.locator('#panel-tool .shape-kind-rect')).toBeVisible();
  await expect(page.locator('#panel-tool .shape-kind-arrow')).toBeVisible();
  await expect(page.locator('#panel-tool .shape-kind-circle')).toBeVisible();
  await expect(page.locator('#panel-tool .shape-stroke')).toBeVisible();
  await expect(page.locator('#panel-tool .shape-stroke-width')).toBeVisible();
});

test('shape tool: rect kind — drag creates a rectangle overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateShapeTool(page);
  await selectKind(page, 'rect');
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const result = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    return { count: getState().images[id].overlays.length, type: o?.type, kind: o?.kind };
  }, id);
  expect(result.count).toBe(1);
  expect(result.type).toBe('shape');
  expect(result.kind).toBe('rect');
});

test('shape tool: circle kind — drag creates a circle overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateShapeTool(page);
  await selectKind(page, 'circle');
  await dragCanvas(page, 0.3, 0.3, 0.7, 0.7);

  const kind = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0]?.kind;
  }, id);
  expect(kind).toBe('circle');
});

test('shape tool: arrow kind — drag creates an arrow overlay with endpoints', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateShapeTool(page);
  await selectKind(page, 'arrow');
  await dragCanvas(page, 0.1, 0.5, 0.9, 0.5);

  const o = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0];
  }, id);
  expect(o.type).toBe('shape');
  expect(o.kind).toBe('arrow');
  // Arrow stores endpoints; x1 < x2 since we dragged left-to-right.
  expect(o.x2).toBeGreaterThan(o.x1);
});

test('shape tool: line kind — drag creates a line overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateShapeTool(page);
  await selectKind(page, 'line');
  await dragCanvas(page, 0.1, 0.1, 0.9, 0.9);

  const kind = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0]?.kind;
  }, id);
  expect(kind).toBe('line');
});

test('shape tool: changing stroke color before drag affects the next shape', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateShapeTool(page);
  await selectKind(page, 'rect');

  await page.evaluate(() => {
    const c = document.querySelector('#panel-tool .shape-stroke');
    c.value = '#00ff00';
    c.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await dragCanvas(page, 0.2, 0.3, 0.8, 0.7);

  const stroke = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0]?.stroke;
  }, id);
  expect(stroke).toBe('#00ff00');
});

test('shape tool: a tap (no drag) does not create an overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateShapeTool(page);
  await selectKind(page, 'rect');

  await page.evaluate(() => {
    const overlay = document.getElementById('overlay-canvas');
    const rect = overlay.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
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

test('shape tool: fill row visible for rect/circle, hidden for line/arrow', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateShapeTool(page);

  await selectKind(page, 'rect');
  await expect(page.locator('#panel-tool .shape-fill-row')).toBeVisible();

  await selectKind(page, 'circle');
  await expect(page.locator('#panel-tool .shape-fill-row')).toBeVisible();

  await selectKind(page, 'line');
  await expect(page.locator('#panel-tool .shape-fill-row')).toBeHidden();

  await selectKind(page, 'arrow');
  await expect(page.locator('#panel-tool .shape-fill-row')).toBeHidden();
});

test('shape tool: switching to another tool clears the panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateShapeTool(page);

  await page.locator('#editor-view .editor-toolbar button[data-tool="select"]').click();
  await expect(page.locator('#panel-tool .shape-tool-panel')).toHaveCount(0);
});
