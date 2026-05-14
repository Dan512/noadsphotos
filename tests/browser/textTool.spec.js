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

// Import a small test image and open the editor on it. Returns its id.
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
    ctx.fillStyle = '#aabbcc';
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

async function activateTextTool(page) {
  await page.locator('#editor-view .editor-toolbar button[data-tool="text"]').click();
  await expect(page.locator('#panel-tool .text-tool-panel')).toBeVisible();
}

// Click at a position relative to the overlay canvas's bounding box.
async function clickCanvas(page, fracX, fracY) {
  await page.evaluate(({ fx, fy }) => {
    const overlay = document.getElementById('overlay-canvas');
    const rect = overlay.getBoundingClientRect();
    const cx = rect.left + rect.width * fx;
    const cy = rect.top + rect.height * fy;
    const ev = (type, x, y) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: x, clientY: y, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
    });
    overlay.dispatchEvent(ev('pointerdown', cx, cy));
    overlay.dispatchEvent(ev('pointerup', cx, cy));
  }, { fx: fracX, fy: fracY });
}

// --- tests --------------------------------------------------------------

test('text tool: side panel shows empty-state hint before any overlay', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateTextTool(page);

  await expect(page.locator('#panel-tool .text-empty')).toBeVisible();
  await expect(page.locator('#panel-tool .text-empty')).toHaveText('Click anywhere to add text.');
});

test('text tool: clicking on canvas creates a text overlay in state', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);

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
  expect(result.type).toBe('text');
  expect(result.selected).toBeTruthy();
});

test('text tool: side panel form is visible after creating overlay', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);

  await expect(page.locator('#panel-tool .text-input')).toBeVisible();
  await expect(page.locator('#panel-tool .text-font')).toBeVisible();
  await expect(page.locator('#panel-tool .text-size')).toBeVisible();
  await expect(page.locator('#panel-tool .text-color')).toBeVisible();
  await expect(page.locator('#panel-tool .text-weight')).toBeVisible();
  await expect(page.locator('#panel-tool .text-align-left')).toBeVisible();
  await expect(page.locator('#panel-tool .text-align-center')).toBeVisible();
  await expect(page.locator('#panel-tool .text-align-right')).toBeVisible();
  await expect(page.locator('#panel-tool .text-delete')).toBeVisible();
  // Empty hint hidden once an overlay is selected.
  await expect(page.locator('#panel-tool .text-empty')).toBeHidden();
});

test('text tool: typing in textarea updates overlay.text live', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);

  const textArea = page.locator('#panel-tool .text-input');
  await textArea.click();
  await textArea.fill('hello world');

  const overlayText = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const sel = getState().ui.selectedOverlayId;
    return getState().images[id].overlays.find(o => o.id === sel)?.text;
  }, id);
  expect(overlayText).toBe('hello world');
});

test('text tool: changing size input updates overlay.size', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);

  const sizeInput = page.locator('#panel-tool .text-size');
  await sizeInput.click();
  await sizeInput.fill('64');
  // Dispatch the input event explicitly since fill() may not fire it on all builds.
  await sizeInput.dispatchEvent('input');

  const size = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const sel = getState().ui.selectedOverlayId;
    return getState().images[id].overlays.find(o => o.id === sel)?.size;
  }, id);
  expect(size).toBe(64);
});

test('text tool: "Delete this text" removes the overlay from state', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);

  // Ensure form is up.
  await expect(page.locator('#panel-tool .text-delete')).toBeVisible();
  await page.locator('#panel-tool .text-delete').click();

  const remaining = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return {
      count: getState().images[id].overlays.length,
      selected: getState().ui.selectedOverlayId,
    };
  }, id);
  expect(remaining.count).toBe(0);
  expect(remaining.selected).toBeNull();
});

test('text tool: clicking on a different empty position creates a SECOND overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 400);
  await activateTextTool(page);
  await clickCanvas(page, 0.25, 0.25);
  // Wait for state to reflect first overlay.
  await page.waitForFunction(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays.length === 1;
  }, id);

  // Click a different location far from the first overlay. Even with the
  // default 'Text' string, it occupies ~ first-line-height of source pixels;
  // (0.75, 0.75) of a 400×400 image is well clear of (0.25, 0.25) plus
  // 32px text.
  await clickCanvas(page, 0.75, 0.75);
  await page.waitForFunction(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays.length === 2;
  }, id);

  const result = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    return {
      count: img.overlays.length,
      types: img.overlays.map(o => o.type),
    };
  }, id);
  expect(result.count).toBe(2);
  expect(result.types).toEqual(['text', 'text']);
});

test('text tool: switching to another tool clears the panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await activateTextTool(page);

  await page.locator('#editor-view .editor-toolbar button[data-tool="select"]').click();
  await expect(page.locator('#panel-tool .text-tool-panel')).toHaveCount(0);
});

test('text tool: clicking on an existing overlay selects it (no new overlay created)', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);
  await activateTextTool(page);

  // Create first overlay near the top-left.
  await clickCanvas(page, 0.2, 0.2);
  await page.waitForFunction(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays.length === 1;
  }, id);

  const firstId = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0].id;
  }, id);

  // Deselect by setting selectedOverlayId to null.
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.ui.selectedOverlayId = null; });
  });

  // Click ON the existing overlay (close to its (x, y) position which
  // mirrors the first click at (0.2, 0.2) of a 400×200 image = (80, 40)).
  await clickCanvas(page, 0.21, 0.22);

  const result = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return {
      count: getState().images[id].overlays.length,
      selected: getState().ui.selectedOverlayId,
    };
  }, id);
  // Still only one overlay; the first one is now selected.
  expect(result.count).toBe(1);
  expect(result.selected).toBe(firstId);
});

test('text tool: click position maps to expected source coords via canvasToSource', async ({ page }) => {
  // Use a 200×100 image at default fit zoom. The overlay canvas should
  // approximately cover the source image with letterboxing in the longer
  // dimension. Clicking at the center should land near (100, 50) in source
  // pixels regardless of DPR / zoom letterboxing.
  await resetApp(page);
  const id = await setupEditorWithImage(page, 200, 100);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);

  const pos = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    return { x: o.x, y: o.y };
  }, id);
  // Center click should land within a few pixels of (100, 50).
  expect(Math.abs(pos.x - 100)).toBeLessThan(5);
  expect(Math.abs(pos.y - 50)).toBeLessThan(5);
});

// Default font size for a NEW text overlay should scale with display zoom
// so the rendered text is visibly readable regardless of source image
// size. Two extreme cases:
//   - small image (~100 px) usually displays at 1× → default ~ TARGET_CSS
//   - large image (4000 px) usually displays at fit zoom (~0.15×) →
//     default source size is much larger so the rendered glyphs stay
//     legible.
test('text tool: default size on a small image is reasonable', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 100, 100);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);

  const size = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    return o.size;
  }, id);
  // Should be within the clamp band: [16, 512].
  expect(size).toBeGreaterThanOrEqual(16);
  expect(size).toBeLessThanOrEqual(512);
});

test('text tool: default size on a large image is much larger than on a small one', async ({ page }) => {
  // Place text on a tiny image first.
  await resetApp(page);
  const smallId = await setupEditorWithImage(page, 100, 100);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);
  const smallSize = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0].size;
  }, smallId);

  // Now do it again on a much larger image.
  await resetApp(page);
  const largeId = await setupEditorWithImage(page, 4000, 4000);
  await activateTextTool(page);
  await clickCanvas(page, 0.5, 0.5);
  const largeSize = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays[0].size;
  }, largeId);

  // The large-image text should be MUCH larger in source pixels because
  // it's compensating for the fit-zoom shrink factor.
  expect(largeSize).toBeGreaterThan(smallSize * 4);
});
