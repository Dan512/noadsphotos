// selectTool.spec.js — pointer + overlay-editor tool (v1.1.2 redesign).
//
// Pre-v1.1.2 this spec covered rotate/flip controls in the Select panel.
// Those moved to transformTool.spec.js. This file now exercises the new
// Select behaviour: empty-state hint, hit-test on click, edit fields per
// overlay type.
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

async function setupEditorWithImage(page, w = 400, h = 300) {
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

test('select tool: shows the empty-state hint when nothing is selected', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  // Single-image import lands in the editor with Select active by default.
  await expect(page.locator('#panel-tool .tool-hint')).toBeVisible();
  await expect(page.locator('#panel-tool .tool-hint')).toContainText(/click/i);
});

test('select tool: selecting a shape overlay (via state) shows its edit fields', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // Add a rectangle overlay programmatically + select it.
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    const { newShapeOverlay } = await import('/js/ops/shape.js');
    const { addOverlay } = await import('/js/overlays.js');
    update(s => {
      const o = newShapeOverlay('rect', 50, 50, 150, 100, { stroke: '#ff00ff', fill: '#00ff00', strokeWidth: 4 });
      addOverlay(s.images[id], o);
      s.ui.selectedOverlayId = o.id;
    });
  }, id);

  // Heading should say "Editing: <kind>" — anything containing the word
  // "Rect" (English label for the rect shape kind) is good enough here.
  await expect(page.locator('#panel-tool .panel-heading')).toContainText(/Editing/i);
  // Two color pickers (stroke + fill) + a stroke-width range slider.
  await expect(page.locator('#panel-tool input[type="color"]')).toHaveCount(2);
  await expect(page.locator('#panel-tool input[type="range"]')).toHaveCount(1);
});

test('select tool: deselect clears the editing heading back to the hint', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    const { newShapeOverlay } = await import('/js/ops/shape.js');
    const { addOverlay } = await import('/js/overlays.js');
    update(s => {
      const o = newShapeOverlay('circle', 100, 100, 200, 200);
      addOverlay(s.images[id], o);
      s.ui.selectedOverlayId = o.id;
    });
  }, id);
  await expect(page.locator('#panel-tool .panel-heading')).toContainText(/Editing/i);

  // Deselect.
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.ui.selectedOverlayId = null; });
  });

  await expect(page.locator('#panel-tool .tool-hint')).toBeVisible();
  await expect(page.locator('#panel-tool .panel-heading')).toHaveCount(0);
});
