import { test, expect } from '@playwright/test';

// Phase 9: exporter.spec.js — single-image export orchestration.
//
// We test exportSingle by stubbing/inspecting the dynamic anchor element used
// for the download trick, plus filename generation and error toasts.

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
    // Reset the per-session warning latches so toast assertions are stable.
    const m = await import('/js/exporter.js');
    if (typeof m._resetForTest === 'function') m._resetForTest();
    // Clear toasts.
    const root = document.getElementById('toast-root');
    if (root) root.remove();
  });
}

async function importImage(page, name = 'foo.png', color = '#abcdef') {
  return await page.evaluate(async ({ name, color }) => {
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
    c.width = 80; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 80, 60);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], name, { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    await lifecycle.ensureBitmap((await import('/js/state.js')).getState().queue[0]);
    return (await import('/js/state.js')).getState().queue[0];
  }, { name, color });
}

// Stub the URL.createObjectURL + anchor.click pipeline so we can inspect
// what would have been downloaded without actually triggering a save.
async function installDownloadSpy(page) {
  await page.evaluate(() => {
    window.__lastDownload = null;
    window.__origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      const url = window.__origCreateObjectURL(blob);
      window.__lastDownload = { type: blob.type, size: blob.size, url };
      return url;
    };
    window.__origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      // Capture the download attribute on the click moment.
      if (this.download) {
        window.__lastDownload = Object.assign(window.__lastDownload || {}, {
          download: this.download,
          href: this.href,
        });
      }
      // Don't actually click — prevents the browser from opening the file dialog.
    };
  });
}

async function readDownload(page) {
  return await page.evaluate(() => window.__lastDownload);
}

// --- Tests ----------------------------------------------------------------

test('exportSingle: PNG triggers download with .png filename derived from {base}', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const id = await importImage(page, 'photo.png');

  const result = await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    const blob = await exportSingle(id);
    return blob ? { type: blob.type, size: blob.size } : null;
  }, id);
  expect(result).toBeTruthy();
  expect(result.type).toBe('image/png');

  const dl = await readDownload(page);
  expect(dl).toBeTruthy();
  expect(dl.download).toBe('photo-edited.png');
});

test('exportSingle: JPEG format swaps extension to .jpg', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const id = await importImage(page, 'sunset.png');

  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.export.format = 'jpeg'; s.export.quality = 0.9; });
  });

  const result = await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    const blob = await exportSingle(id);
    return blob ? { type: blob.type } : null;
  }, id);
  expect(result).toBeTruthy();
  expect(result.type).toBe('image/jpeg');

  const dl = await readDownload(page);
  expect(dl.download).toBe('sunset-edited.jpg');
});

test('exportSingle: custom filename template with {base} and {date}', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const id = await importImage(page, 'hello.png');

  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.export.filenameTemplate = '{base}-{date}-final'; });
  });

  await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    await exportSingle(id);
  }, id);

  const dl = await readDownload(page);
  // {date} → YYYYMMDD; we just assert it's 8 digits.
  expect(dl.download).toMatch(/^hello-\d{8}-final\.png$/);
});

test('exportSingle: no image with that id → warn toast, no download', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);

  await page.evaluate(async () => {
    const { exportSingle } = await import('/js/exporter.js');
    await exportSingle('nonexistent-id');
  });

  // Toast appears.
  await expect(page.locator('#toast-root .toast').first()).toBeVisible();
  await expect(page.locator('#toast-root .toast').first()).toHaveClass(/toast-warn/);
  // No download recorded.
  const dl = await readDownload(page);
  expect(dl).toBeNull();
});

test('exportSingle: WebP request on a browser without WebP → error toast', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const id = await importImage(page, 'pic.png');

  // Force webp request — if browser does support it, this passes silently.
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.export.format = 'webp'; });
  });

  const supportsWebp = await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    return (await probeCapabilities()).webp;
  });

  await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    await exportSingle(id);
  }, id);

  if (supportsWebp) {
    // Browser supports it — should have triggered a download.
    const dl = await readDownload(page);
    expect(dl).toBeTruthy();
    expect(dl.type).toBe('image/webp');
  } else {
    // Should have shown an error toast.
    await expect(page.locator('#toast-root .toast-error').first()).toBeVisible();
  }
});

test('exportSingle: output exceeds canvas limit → error toast', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const id = await importImage(page, 'big.png');

  // Override caps.maxCanvasSize for this export by re-setting the export
  // context with a tiny cap. We can't easily mutate the cached caps in
  // place; instead, set a resize that demands a huge output relative to
  // a faked tiny cap.
  await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { setExportContext } = await import('/js/exporter.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const caps = await probeCapabilities();
    const tinyCaps = { ...caps, maxCanvasSize: 32 };
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    setExportContext({ lifecycle, caps: tinyCaps });
  });

  await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    await exportSingle(id);
  }, id);

  await expect(page.locator('#toast-root .toast-error').first()).toBeVisible();
  await expect(page.locator('#toast-root .toast-error').first()).toContainText(/too large/i);
});

test('makeFilename: empty / fallback behaviors', async ({ page }) => {
  await resetApp(page);
  const result = await page.evaluate(async () => {
    const { makeFilename } = await import('/js/exporter.js');
    return {
      basic: makeFilename({ source: { name: 'pic.jpg' } }, 'image/png', '{base}-edited'),
      jpgFromJpegMime: makeFilename({ source: { name: 'a.png' } }, 'image/jpeg', '{base}'),
      noExt: makeFilename({ source: { name: 'noext' } }, 'png', '{base}-x'),
      missing: makeFilename({ source: {} }, 'png', '{base}'),
    };
  });
  expect(result.basic).toBe('pic-edited.png');
  expect(result.jpgFromJpegMime).toBe('a.jpg');
  expect(result.noExt).toBe('noext-x.png');
  expect(result.missing).toBe('image.png');
});

test('triggerDownload: creates <a download> attached to body briefly', async ({ page }) => {
  await resetApp(page);

  const result = await page.evaluate(async () => {
    const { triggerDownload } = await import('/js/exporter.js');
    let observedDownload = null;
    // Spy on anchor click without actually clicking.
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      observedDownload = { download: this.download, href: this.href };
    };
    try {
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
      triggerDownload(blob, 'test.png');
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    return observedDownload;
  });
  expect(result).toBeTruthy();
  expect(result.download).toBe('test.png');
  expect(result.href).toMatch(/^blob:/);
});
