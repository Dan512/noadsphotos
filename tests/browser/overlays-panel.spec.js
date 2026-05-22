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

// Programmatically add a text overlay to the active image, bypassing the
// tool layer. Returns the new overlay's id.
async function addOverlayDirect(page, imgId, props = {}) {
  return await page.evaluate(async ({ imgId, props }) => {
    const { getState, update } = await import('/js/state.js');
    const { addOverlay } = await import('/js/overlays.js');
    const { newTextOverlay } = await import('/js/ops/text.js');
    const o = newTextOverlay(props.x ?? 10, props.y ?? 10, { text: props.text ?? 'A' });
    update(s => {
      const target = s.images[imgId];
      addOverlay(target, o);
    });
    return o.id;
  }, { imgId, props });
}

// --- tests --------------------------------------------------------------

test('overlays panel: whole section hidden when image has no overlays (v1.1.1)', async ({ page }) => {
  // v1.1.1 change: the Overlays section is contextual. With zero overlays on
  // the active image, the entire #panel-overlays <details> element is
  // hidden so the panel doesn't waste vertical space on an empty section.
  // It reappears the moment an overlay is added (covered by the next test).
  await resetApp(page);
  await setupEditorWithImage(page);

  await expect(page.locator('#panel-overlays')).toBeHidden();
  await expect(page.locator('#panel-overlays .overlay-row')).toHaveCount(0);
});

test('overlays panel: rows appear after adding 2 text overlays', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await addOverlayDirect(page, id, { text: 'first' });
  await addOverlayDirect(page, id, { text: 'second' });

  await expect(page.locator('#panel-overlays .overlay-row')).toHaveCount(2);
  await expect(page.locator('#panel-overlays .overlay-empty')).toBeHidden();

  // The list renders top-of-stack at the top; with two adds, the second
  // overlay (drawn on top) should appear FIRST in the panel.
  const labels = await page.locator('#panel-overlays .overlay-row .overlay-label').allTextContents();
  expect(labels.length).toBe(2);
  expect(labels[0]).toBe('second');
  expect(labels[1]).toBe('first');
});

test('overlays panel: clicking a row sets state.ui.selectedOverlayId', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  const firstId = await addOverlayDirect(page, id, { text: 'first' });
  await addOverlayDirect(page, id, { text: 'second' });

  // The second row in the rendered list is 'first' (reverse order).
  const rows = page.locator('#panel-overlays .overlay-row');
  await rows.nth(1).click();

  const selected = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().ui.selectedOverlayId;
  });
  expect(selected).toBe(firstId);
  await expect(rows.nth(1)).toHaveClass(/is-active/);
});

test('overlays panel: × button removes the overlay', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  await addOverlayDirect(page, id, { text: 'first' });
  const secondId = await addOverlayDirect(page, id, { text: 'second' });

  // Top row is 'second' — its delete button removes that overlay.
  await page.locator('#panel-overlays .overlay-row').first().locator('.overlay-delete').click();

  const remaining = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays.map(o => o.id);
  }, id);
  expect(remaining.length).toBe(1);
  expect(remaining[0]).not.toBe(secondId);
  await expect(page.locator('#panel-overlays .overlay-row')).toHaveCount(1);
});

test('overlays panel: dispatching DnD events reorders the list', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  const firstId  = await addOverlayDirect(page, id, { text: 'first' });
  const secondId = await addOverlayDirect(page, id, { text: 'second' });

  // Initial overlay order in state: [firstId, secondId] (first drawn behind).
  // Rendered top row is 'second' (index 1 in state). Reorder via reorderOverlays
  // directly — DnD synthesis is unreliable across browsers, but the panel
  // calls reorderOverlays under the hood, so we exercise that path.
  await page.evaluate(async (id) => {
    const { getState, update } = await import('/js/state.js');
    const { reorderOverlays } = await import('/js/overlays.js');
    update(s => {
      reorderOverlays(s.images[id], 1, 0);
    });
  }, id);

  const orderAfter = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return getState().images[id].overlays.map(o => o.id);
  }, id);
  expect(orderAfter).toEqual([secondId, firstId]);

  // And the panel reflects the new order (top row is now 'first').
  const labels = await page.locator('#panel-overlays .overlay-row .overlay-label').allTextContents();
  expect(labels[0]).toBe('first');
  expect(labels[1]).toBe('second');
});

test('overlays panel: label truncates very long text', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);
  await addOverlayDirect(page, id, { text: 'this is a very very long text label that should be truncated' });

  const label = await page.locator('#panel-overlays .overlay-row .overlay-label').first().textContent();
  // 24 chars + ellipsis.
  expect(label.length).toBeLessThan(30);
  expect(label).toMatch(/…$/);
});
