import { test, expect } from '@playwright/test';

// Phase 9: export-panel.spec.js — the export side-panel UI.

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
      s.export = { format: 'png', quality: 0.92, filenameTemplate: '{base}-edited' };
    });
    const m = await import('/js/exporter.js');
    if (typeof m._resetForTest === 'function') m._resetForTest();
  });
}

async function setupEditorWithImage(page, w = 400, h = 200, name = 'test.png') {
  const id = await page.evaluate(async ({ w, h, name }) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const { setExportContext } = await import('/js/exporter.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    setExportContext({ lifecycle, caps });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#cccccc';
    ctx.fillRect(0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], name, { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h, name });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
  return id;
}

// --- Structural ----------------------------------------------------------

test('export panel: contains 3 format chips, quality slider, filename input, Download button', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await expect(page.locator('#panel-export .format-chip[data-format="png"]')).toHaveCount(1);
  await expect(page.locator('#panel-export .format-chip[data-format="jpeg"]')).toHaveCount(1);
  await expect(page.locator('#panel-export .format-chip[data-format="webp"]')).toHaveCount(1);
  await expect(page.locator('#panel-export .quality-slider')).toHaveCount(1);
  await expect(page.locator('#panel-export .filename-template')).toHaveCount(1);
  await expect(page.locator('#panel-export .download-btn')).toHaveCount(1);
});

test('export panel: PNG is the default active chip; quality row is hidden', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await expect(page.locator('#panel-export .format-chip[data-format="png"]')).toHaveClass(/is-active/);
  await expect(page.locator('#panel-export .quality-row')).toBeHidden();
});

test('export panel: clicking JPG chip updates state.export.format and shows quality', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await page.locator('#panel-export .format-chip[data-format="jpeg"]').click();
  await expect(page.locator('#panel-export .format-chip[data-format="jpeg"]')).toHaveClass(/is-active/);
  await expect(page.locator('#panel-export .format-chip[data-format="png"]')).not.toHaveClass(/is-active/);
  await expect(page.locator('#panel-export .quality-row')).toBeVisible();

  const fmt = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.format;
  });
  expect(fmt).toBe('jpeg');
});

test('export panel: clicking WebP chip updates state and shows quality', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await page.locator('#panel-export .format-chip[data-format="webp"]').click();
  await expect(page.locator('#panel-export .quality-row')).toBeVisible();

  const fmt = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.format;
  });
  expect(fmt).toBe('webp');
});

test('export panel: quality slider updates state.export.quality', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await page.locator('#panel-export .format-chip[data-format="jpeg"]').click();
  await page.evaluate(() => {
    const s = document.querySelector('#panel-export .quality-slider');
    s.value = '0.5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      return getState().export.quality;
    });
  }, { timeout: 1500 }).toBeCloseTo(0.5, 2);
});

test('export panel: filename template input updates state', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await page.evaluate(() => {
    const input = document.querySelector('#panel-export .filename-template');
    input.value = '{base}-custom';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      return getState().export.filenameTemplate;
    });
  }, { timeout: 1500 }).toBe('{base}-custom');
});

test('export panel: output dims readout reflects effectiveImageSize after rotate', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 400, 200);

  // No transforms: 400 x 200.
  await expect(page.locator('#panel-export .output-dims')).toContainText('400 × 200');

  // Rotate 90 → 200 x 400.
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    update(s => { s.images[id].transforms.rotate = 90; });
  }, id);
  await expect(page.locator('#panel-export .output-dims')).toContainText('200 × 400');

  // Add a resize → 100 x 200.
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    update(s => { s.images[id].transforms.resize = { mode: 'longestSide', value: 200 }; });
  }, id);
  await expect(page.locator('#panel-export .output-dims')).toContainText('200');
});

test('export panel: Download button triggers exportSingle and the underlying anchor click', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page, 80, 60, 'snap.png');

  // Stub anchor.click so the test doesn't fire a real download dialog.
  await page.evaluate(() => {
    window.__lastDownload = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.__lastDownload = { download: this.download, href: this.href };
    };
    window.__restoreClick = () => { HTMLAnchorElement.prototype.click = orig; };
  });

  await page.locator('#panel-export .download-btn').click();

  // Wait for the async export pipeline to complete and trigger the anchor click.
  await expect.poll(async () => {
    return await page.evaluate(() => window.__lastDownload?.download || null);
  }, { timeout: 5000 }).toBe('snap-edited.png');

  await page.evaluate(() => window.__restoreClick && window.__restoreClick());
});

test('export panel: Download disabled when no active image', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    // Force editor view without an image.
    const { update } = await import('/js/state.js');
    update(s => { s.ui.view = 'editor'; s.ui.activeImageId = null; });
  });
  await expect(page.locator('#panel-export .download-btn')).toBeDisabled();
});
