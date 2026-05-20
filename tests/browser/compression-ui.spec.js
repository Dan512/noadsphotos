import { test, expect } from '@playwright/test';

// v1.1 compression UI: predicted-size readout, "Smallest size" preset
// button, and file-size in success toasts.
//
// These tests build on the export-panel.spec.js helpers but focus on the
// new compression-feedback surface.

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
    // Don't reset editor.js — its shell is mounted at boot and tearing it
    // down without a re-init leaves the DOM stale. State reset is enough.
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

async function setupEditorWithImage(page, w = 80, h = 60, name = 'photo.png', mime = 'image/png') {
  const id = await page.evaluate(async ({ w, h, name, mime }) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const { setExportContext } = await import('/js/exporter.js');
    const { setQueueViewContext } = await import('/js/queueView.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    setExportContext({ lifecycle, caps });
    setQueueViewContext({ lifecycle, caps });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#dddddd';
    ctx.fillRect(0, 0, w, h);
    // Add a gradient stripe so JPEG/WebP encodings differ in size from PNG.
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, '#330033');
    grad.addColorStop(1, '#cc99ff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, h / 2, w, h / 2);
    const blob = await new Promise(r => c.toBlob(r, mime, 1));
    const file = new File([blob], name, { type: mime });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h, name, mime });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
  return id;
}

async function installDownloadSpy(page) {
  await page.evaluate(() => {
    window.__lastDownload = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      const url = origCreate(blob);
      window.__lastDownload = { type: blob.type, size: blob.size, url };
      return url;
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        window.__lastDownload = Object.assign(window.__lastDownload || {}, {
          download: this.download,
          href: this.href,
        });
      }
      // Don't actually click.
    };
  });
}

// --- Predicted-size readout ----------------------------------------------

test('predicted size: readout appears in the Export panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await expect(page.locator('#panel-export .predicted-size')).toHaveCount(1);
});

test('predicted size: updates after debounce to a real byte count', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 200, 150);

  // After a short delay (>300ms debounce + encode time), the readout should
  // show a byte count, not the estimating placeholder.
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const el = document.querySelector('#panel-export .predicted-size');
      return el ? el.textContent : '';
    });
  }, { timeout: 4000 }).toMatch(/Predicted size: \d+/);
});

test('predicted size: changes when format chip is clicked', async ({ page }) => {
  await resetApp(page);
  // Use a larger gradient image so PNG and JPG produce noticeably different
  // byte counts (PNG is lossless + larger; JPG q=0.92 is smaller).
  await setupEditorWithImage(page, 600, 400);

  // Wait for initial PNG predict to land.
  await expect.poll(async () => {
    return await page.evaluate(() => document.querySelector('#panel-export .predicted-size')?.textContent || '');
  }, { timeout: 5000 }).toMatch(/Predicted size: \d+/);
  const pngText = await page.evaluate(() => document.querySelector('#panel-export .predicted-size')?.textContent || '');

  // Switch to JPG.
  await page.locator('#panel-export .format-chip[data-format="jpeg"]').click();

  // The readout should EVENTUALLY change to a different value (JPG of a
  // larger gradient is smaller than the lossless PNG). We poll until the
  // readout differs from the PNG text (the JPG predict has landed).
  await expect.poll(async () => {
    return await page.evaluate(() => document.querySelector('#panel-export .predicted-size')?.textContent || '');
  }, { timeout: 5000 }).not.toBe(pngText);
});

// --- Smallest size preset ------------------------------------------------

test('smallest size: button is present in the Export panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await expect(page.locator('#panel-export .smallest-preset-btn')).toHaveCount(1);
  await expect(page.locator('#panel-export .smallest-preset-btn')).toHaveText(/Smallest size/);
});

test('smallest size: clicking writes a format + quality to state.export and toasts', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page, 200, 150, 'photo.jpg', 'image/jpeg');

  await page.locator('#panel-export .smallest-preset-btn').click();

  // Wait for completion (button label returns to "Smallest size").
  await expect(page.locator('#panel-export .smallest-preset-btn')).toHaveText(/Smallest size/, { timeout: 8000 });

  // Toast should appear with the "Smallest:" prefix OR the "PNG (lossless)
  // is already smallest" hint.
  const toastText = await page.evaluate(() => {
    const el = document.querySelector('#toast-root .toast');
    return el ? el.textContent : '';
  });
  expect(toastText).toMatch(/Smallest:|PNG \(lossless\)/);

  // State should reflect a valid format and quality.
  const exp = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return { ...getState().export };
  });
  expect(['png', 'jpeg', 'webp']).toContain(exp.format);
  expect(typeof exp.quality).toBe('number');
});

test('smallest size: PNG image with alpha → JPEG is NOT chosen', async ({ page }) => {
  await resetApp(page);
  // PNG-with-transparency: import a PNG with the canvas left partially clear.
  const id = await page.evaluate(async () => {
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
    c.width = 80; c.height = 80;
    const ctx = c.getContext('2d');
    // Leave the top-left clear; fill bottom-right with a color.
    ctx.fillStyle = '#0080ff';
    ctx.fillRect(20, 20, 60, 60);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'alpha.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);

  await page.locator('#panel-export .smallest-preset-btn').click();
  await expect(page.locator('#panel-export .smallest-preset-btn')).toHaveText(/Smallest size/, { timeout: 8000 });

  // Even if a JPEG encode would be smaller, we MUST NOT pick it for an alpha
  // PNG — otherwise we'd silently discard the transparency. So state.export
  // .format must NOT be 'jpeg'.
  const fmt = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.format;
  });
  expect(fmt).not.toBe('jpeg');
});

// --- Success toasts include size ----------------------------------------

test('success toast: single export toast contains a size in parens', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const id = await setupEditorWithImage(page, 80, 60, 'snap.png');

  await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    await exportSingle(id);
  }, id);

  // Toast like "Exported snap-edited.png (XX KB)" or "(XXX B)".
  const toastText = await page.evaluate(() => {
    const el = document.querySelector('#toast-root .toast');
    return el ? el.textContent : '';
  });
  expect(toastText).toMatch(/Exported snap-edited\.png \((\d+ B|\d+ KB|\d+(\.\d+)? MB)\)/);
});
