import { test, expect } from '@playwright/test';

// --- helpers -------------------------------------------------------------

async function resetApp(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    const { clearHistory } = await import('/js/history.js');
    clearHistory();
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

// Read raw state slice.
async function readImage(page, id) {
  return await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    if (!img) return null;
    return {
      transforms: img.transforms,
      adjust: img.adjust,
      filterPreset: img.filterPreset,
      overlaysCount: img.overlays.length,
      chromakey: img.chromakey,
    };
  }, id);
}

async function readHistoryStats(page) {
  return await page.evaluate(async () => {
    const { getHistoryStats } = await import('/js/history.js');
    return getHistoryStats();
  });
}

// --- tests ---------------------------------------------------------------

test('toolbar Undo/Redo buttons start disabled and enable as history fills', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await expect(page.locator('#editor-view #undo-btn')).toBeDisabled();
  await expect(page.locator('#editor-view #redo-btn')).toBeDisabled();

  await page.locator('#panel-tool .rotate-plus-90').click();
  await expect(page.locator('#editor-view #undo-btn')).toBeEnabled();
  await expect(page.locator('#editor-view #redo-btn')).toBeDisabled();

  await page.locator('#editor-view #undo-btn').click();
  await expect(page.locator('#editor-view #undo-btn')).toBeDisabled();
  await expect(page.locator('#editor-view #redo-btn')).toBeEnabled();
});

test('rotate +90: Ctrl+Z reverts it', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-plus-90').click();
  let img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(90);

  await page.keyboard.press('Control+z');
  img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(0);
});

test('rotate +90 then Ctrl+Y redoes it', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-plus-90').click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  const img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(90);
});

test('Ctrl+Shift+Z also redoes', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-plus-90').click();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+Z');
  const img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(90);
});

test('multi-step history: rotate, flip, undo all in LIFO order', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // rotate +90, flip H.
  await page.locator('#panel-tool .rotate-plus-90').click();
  await page.locator('#panel-tool .flip-h-btn').click();

  let img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(90);
  expect(img.transforms.flipH).toBe(true);

  // Undo flip → still rotated, no flip.
  await page.keyboard.press('Control+z');
  img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(90);
  expect(img.transforms.flipH).toBe(false);

  // Undo rotate → back to initial.
  await page.keyboard.press('Control+z');
  img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(0);
  expect(img.transforms.flipH).toBe(false);
});

test('text overlay add + delete: Ctrl+Z brings the overlay back, second Ctrl+Z removes it again', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // Activate text tool, create overlay by clicking centre.
  await page.locator('#editor-view .editor-toolbar button[data-tool="text"]').click();
  await expect(page.locator('#panel-tool .text-tool-panel')).toBeVisible();
  await page.evaluate(() => {
    const c = document.getElementById('overlay-canvas');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const ev = (type) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: x, clientY: y, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
    });
    c.dispatchEvent(ev('pointerdown'));
    c.dispatchEvent(ev('pointerup'));
  });

  let img = await readImage(page, id);
  expect(img.overlaysCount).toBe(1);

  // Delete via the overlays panel × button.
  await page.locator('#panel-overlays .overlay-delete').first().click();
  img = await readImage(page, id);
  expect(img.overlaysCount).toBe(0);

  // Undo delete: overlay reappears.
  await page.keyboard.press('Control+z');
  img = await readImage(page, id);
  expect(img.overlaysCount).toBe(1);

  // Undo add: overlay disappears.
  await page.keyboard.press('Control+z');
  img = await readImage(page, id);
  expect(img.overlaysCount).toBe(0);
});

test('Ctrl+Z inside a textarea is ignored by the global handler', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // Rotate to put one entry on the global stack.
  await page.locator('#panel-tool .rotate-plus-90').click();
  let stats = await readHistoryStats(page);
  expect(stats.pastCount).toBe(1);

  // Create a text overlay so the textarea is on screen.
  await page.locator('#editor-view .editor-toolbar button[data-tool="text"]').click();
  await page.evaluate(() => {
    const c = document.getElementById('overlay-canvas');
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const ev = (type) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: x, clientY: y, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
    });
    c.dispatchEvent(ev('pointerdown'));
    c.dispatchEvent(ev('pointerup'));
  });
  await expect(page.locator('#panel-tool .text-input')).toBeVisible();

  // Focus the textarea, then press Ctrl+Z while focused. The global handler
  // should NOT pop our history entry.
  await page.locator('#panel-tool .text-input').focus();
  await page.keyboard.press('Control+z');

  // The rotate op is the FIRST entry; the text-add is the SECOND. Both should
  // still be on the stack (well, after the Ctrl+Z inside textarea we expect
  // pastCount === 2 — the global handler ignored it).
  stats = await readHistoryStats(page);
  expect(stats.pastCount).toBe(2);

  // And the image is still rotated.
  const img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(90);
});

test('undo on adjust slider drag reverts brightness to 0', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // Drive the brightness slider via JS so we fire both input and change.
  await page.evaluate(() => {
    const slider = document.querySelector('#panel-adjust .adjust-brightness');
    slider.focus();
    slider.value = '30';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });

  let img = await readImage(page, id);
  expect(img.adjust.brightness).toBe(30);

  await page.keyboard.press('Control+z');
  img = await readImage(page, id);
  expect(img.adjust.brightness).toBe(0);
});

test('clicking the toolbar Undo button reverts the last op', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-plus-90').click();
  let img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(90);

  await page.locator('#editor-view #undo-btn').click();
  img = await readImage(page, id);
  expect(img.transforms.rotate).toBe(0);
});

test('batch transaction across multiple images reverts all in one undo', async ({ page }) => {
  await resetApp(page);
  // Import two images.
  await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    const make = async (color) => {
      const c = document.createElement('canvas');
      c.width = 100; c.height = 100;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 100, 100);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
      return new File([blob], `${color}.png`, { type: 'image/png' });
    };
    const f1 = await make('#ff0000');
    const f2 = await make('#00ff00');
    await importFiles([f1, f2], caps, lifecycle);
  });

  const ids = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return [...getState().queue];
  });
  expect(ids.length).toBe(2);

  // Manually run a batch transaction (the "Apply to all" UI lands in a later
  // phase; the helper is what we're testing).
  await page.evaluate(async (ids) => {
    const { withBatchAdjust } = await import('/js/historyOps.js');
    withBatchAdjust('Apply brightness to all', ids, state => {
      for (const id of ids) {
        state.images[id].adjust.brightness = 25;
      }
    });
  }, ids);

  // Both images now have brightness 25.
  for (const id of ids) {
    const img = await readImage(page, id);
    expect(img.adjust.brightness).toBe(25);
  }

  // One Ctrl+Z reverts both.
  await page.keyboard.press('Control+z');
  for (const id of ids) {
    const img = await readImage(page, id);
    expect(img.adjust.brightness).toBe(0);
  }
});

test('new action after undo clears the future stack', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-tool .rotate-plus-90').click();
  await page.keyboard.press('Control+z');

  let stats = await readHistoryStats(page);
  expect(stats.futureCount).toBe(1);

  // New action — future should clear.
  await page.locator('#panel-tool .flip-h-btn').click();
  stats = await readHistoryStats(page);
  expect(stats.futureCount).toBe(0);

  // Redo button should now be disabled.
  await expect(page.locator('#editor-view #redo-btn')).toBeDisabled();
});
