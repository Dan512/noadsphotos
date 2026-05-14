import { test, expect } from '@playwright/test';

// Phase 10: batch export ZIP.

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
    document.querySelectorAll('dialog').forEach(d => d.remove());
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
    const { _setJSZipForTest } = await import('/js/vendor/jszip-loader.js');
    _setJSZipForTest(null);
  });
}

async function importImages(page, names) {
  await page.evaluate(async (nameList) => {
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
    const files = [];
    for (let i = 0; i < nameList.length; i++) {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 40;
      const ctx = c.getContext('2d');
      ctx.fillStyle = `hsl(${i * 60}, 70%, 50%)`;
      ctx.fillRect(0, 0, 40, 40);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
      files.push(new File([blob], nameList[i], { type: 'image/png' }));
    }
    await importFiles(files, caps, lifecycle);
  }, names);
}

async function installDownloadSpy(page) {
  await page.evaluate(() => {
    window.__lastDownload = null;
    window.__lastDownloadBlob = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      const url = origCreate(blob);
      window.__lastDownload = { type: blob.type, size: blob.size, url };
      window.__lastDownloadBlob = blob;
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
    window.__restoreSpy = () => {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    };
  });
}

// --- Tests ---------------------------------------------------------------

test('exportBatch: 3 images -> ZIP with 3 entries, filenames respect template', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['photo-a.png', 'photo-b.png', 'photo-c.png']);

  const result = await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    return await exportBatch();
  });
  expect(result).toBeTruthy();
  expect(result.count).toBe(3);
  expect(result.failed).toBe(0);
  expect(result.cancelled).toBe(false);

  // The download spy should have a ZIP blob.
  const dl = await page.evaluate(() => window.__lastDownload);
  expect(dl).toBeTruthy();
  expect(dl.download).toMatch(/^noadsphotos-.+\.zip$/);

  // Read the zip via JSZip and verify contents.
  const names = await page.evaluate(async () => {
    const { loadJSZip } = await import('/js/vendor/jszip-loader.js');
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(window.__lastDownloadBlob);
    return Object.keys(zip.files).sort();
  });
  expect(names).toEqual([
    'photo-a-edited.png',
    'photo-b-edited.png',
    'photo-c-edited.png',
  ]);
});

test('exportBatch: filename collision handling appends -2, -3', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  // Three images with the same name produce three different output names.
  await importImages(page, ['image.png', 'image.png', 'image.png']);

  const result = await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    return await exportBatch();
  });
  expect(result.count).toBe(3);

  const names = await page.evaluate(async () => {
    const { loadJSZip } = await import('/js/vendor/jszip-loader.js');
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(window.__lastDownloadBlob);
    return Object.keys(zip.files).sort();
  });
  // First wins canonical name; collisions get -2, -3.
  expect(names).toContain('image-edited.png');
  expect(names).toContain('image-edited-2.png');
  expect(names).toContain('image-edited-3.png');
});

test('exportBatch: template tokens {base} {n} {ext} substituted, {n} zero-padded', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['a.png', 'b.png', 'c.png']);

  // Use a template that exercises {n} padding (queue length = 3 → 1-digit pad).
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.export.filenameTemplate = '{n}-{base}.{ext}'; });
  });

  const result = await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    return await exportBatch();
  });
  expect(result.count).toBe(3);

  const names = await page.evaluate(async () => {
    const { loadJSZip } = await import('/js/vendor/jszip-loader.js');
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(window.__lastDownloadBlob);
    return Object.keys(zip.files).sort();
  });
  expect(names).toEqual(['1-a.png', '2-b.png', '3-c.png']);
});

test('exportBatch: JPEG format produces .jpg output', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['a.png', 'b.png']);

  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.export.format = 'jpeg'; });
  });

  const result = await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    return await exportBatch();
  });
  expect(result.count).toBe(2);

  const names = await page.evaluate(async () => {
    const { loadJSZip } = await import('/js/vendor/jszip-loader.js');
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(window.__lastDownloadBlob);
    return Object.keys(zip.files).sort();
  });
  expect(names.every(n => n.endsWith('.jpg'))).toBe(true);
});

test('exportBatch: empty queue → warn toast, no download', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);

  // Establish export context (no images, but the exporter needs lifecycle + caps
  // to be set or it short-circuits with an "Export not ready" error toast).
  await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { setExportContext } = await import('/js/exporter.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({ decoder: createImageBitmap, closer: bm => bm.close() });
    setExportContext({ lifecycle, caps });
  });

  const result = await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    return await exportBatch();
  });
  expect(result).toBeNull();

  await expect(page.locator('#toast-root .toast-warn').first()).toBeVisible();
  const dl = await page.evaluate(() => window.__lastDownload);
  expect(dl).toBeNull();
});

test('exportBatch: Cancel button stops mid-export', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);

  // Slow each encode by ~80ms so the cancel click has time to land mid-loop.
  // OffscreenCanvas.convertToBlob is the actual fast-path on chromium; we
  // wrap that AND the legacy toBlob to be safe across browsers.
  const result = await page.evaluate(async () => {
    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      const self = this;
      const args = [cb, ...rest];
      setTimeout(() => origToBlob.apply(self, args), 80);
    };
    let origConvert;
    if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
      origConvert = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function (...args) {
        const self = this;
        return new Promise(resolve => {
          setTimeout(() => resolve(origConvert.apply(self, args)), 80);
        });
      };
    }
    const observer = new MutationObserver(() => {
      const btn = document.querySelector('.batch-progress-cancel');
      if (btn && !btn.disabled) {
        btn.click();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let r;
    try {
      const { exportBatch } = await import('/js/exporter.js');
      r = await exportBatch();
    } finally {
      observer.disconnect();
      HTMLCanvasElement.prototype.toBlob = origToBlob;
      if (origConvert) OffscreenCanvas.prototype.convertToBlob = origConvert;
    }
    return r;
  });
  expect(result).toBeTruthy();
  expect(result.cancelled).toBe(true);
  expect(result.count).toBeLessThan(5);
});

test('exportBatch: failed image continues batch, reports `failed` count', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['a.png', 'b.png']);

  // Force the second image to lack a source bitmap AND blob so the
  // renderForExport throws.
  const ids = await page.evaluate(async () => {
    const { getState, update } = await import('/js/state.js');
    const second = getState().queue[1];
    update(s => {
      // Zero-out source.width to force output_invalid_dimensions.
      s.images[second].source.width = 0;
      s.images[second].source.height = 0;
    });
    return getState().queue;
  });

  const result = await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    return await exportBatch();
  });
  expect(result.count).toBe(1);
  expect(result.failed).toBe(1);
});

test('exportBatch: JSZip not loaded on initial page visit', async ({ page }) => {
  await resetApp(page);
  // Right after boot, before any batch export click, window.JSZip should
  // be undefined.
  const present = await page.evaluate(() => !!window.JSZip);
  expect(present).toBe(false);
});

test('exportBatch: after a batch export, JSZip is loaded (lazy hydration)', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['a.png']);
  await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    await exportBatch();
  });
  const present = await page.evaluate(() => !!window.JSZip);
  expect(present).toBe(true);
});

test('exportBatch: after export, non-active bitmaps are evicted', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['a.png', 'b.png', 'c.png']);

  // Make sure all bitmaps are decoded first by setting the active image and
  // poking the lifecycle window.
  await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    // Use the same lifecycle instance the exporter has — fetched via
    // getExportContext.
    const { getExportContext } = await import('/js/exporter.js');
    const { lifecycle } = getExportContext();
    const ids = getState().queue;
    for (const id of ids) {
      await lifecycle.ensureBitmap(id);
    }
  });

  // Verify all 3 have bitmaps decoded.
  let decoded = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.map(id => !!getState().images[id].source.bitmap);
  });
  expect(decoded.filter(Boolean).length).toBe(3);

  // Run the export.
  await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    await exportBatch();
  });

  // After export, only the active image (or none) should remain decoded.
  decoded = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return s.queue.map(id => ({ id, decoded: !!s.images[id].source.bitmap, active: id === s.ui.activeImageId }));
  });
  // Every non-active image should have been evicted.
  for (const entry of decoded) {
    if (!entry.active) expect(entry.decoded).toBe(false);
  }
});
