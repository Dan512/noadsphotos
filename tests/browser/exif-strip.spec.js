import { test, expect } from '@playwright/test';

// v1.1 + v1.1.2 EXIF/GPS export behaviour.
//
// Three halves to verify:
//   1) DEFAULT path: with stripMetadata: true (default), every exported
//      format (PNG, JPG, WebP) contains NO EXIF, NO XMP, NO GPS even when
//      the source did. Canvas re-encoding strips this naturally; these
//      tests are the regression guard.
//   2) OPT-IN path (v1.1.2): with stripMetadata: false AND source = JPEG
//      AND output = JPEG, the source's EXIF/GPS survives the round-trip.
//      This is the "I'm just resizing family photos, keep the GPS" flow.
//   3) The export panel renders the "Strip metadata" checkbox + hint, and
//      the obsolete "Verify last export" button is GONE (v1.1.2 removed it
//      — see editor.js comment for the privacy framing rationale).
//
// Fixtures are SYNTHESIZED inside the browser context rather than committed
// as binary files. The strategy: build a JPEG byte array in JS that
// contains a real EXIF + GPS APP1 segment, wrap it in a File, import it
// through the normal pipeline. After export, decode the exported Blob's
// bytes with js/exif.js#hasMetadata and assert the expected presence /
// absence.

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
      s.export = { format: 'png', quality: 0.92, filenameTemplate: '{base}-edited', stripMetadata: true };
    });
    const m = await import('/js/exporter.js');
    if (typeof m._resetForTest === 'function') m._resetForTest();
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

// Build a JPEG containing real EXIF + GPS APP1 plus a single 1×1 pixel,
// then import it. We construct the byte array entirely inside the page so
// no fixture file is needed on disk — keeps the test self-contained and
// portable to any CI environment.
async function importJpegWithExif(page) {
  return await page.evaluate(async () => {
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
    c.width = 100; c.height = 100;
    const cx = c.getContext('2d');
    cx.fillStyle = '#aa3355';
    cx.fillRect(0, 0, 100, 100);
    const baseBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    const baseBytes = new Uint8Array(await baseBlob.arrayBuffer());

    function buildExifApp1() {
      const entries = [];
      entries.push([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
      entries.push([0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const tiff = [
        0x49, 0x49, 0x2A, 0x00,
        0x08, 0x00, 0x00, 0x00,
        entries.length & 0xFF, (entries.length >> 8) & 0xFF,
      ];
      for (const e of entries) tiff.push(...e);
      tiff.push(0, 0, 0, 0);
      const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
      const segLen = payload.length + 2;
      return [
        0xFF, 0xE1,
        (segLen >> 8) & 0xFF, segLen & 0xFF,
        ...payload,
      ];
    }
    const exifSegment = new Uint8Array(buildExifApp1());

    const out = new Uint8Array(baseBytes.length + exifSegment.length);
    out.set(baseBytes.subarray(0, 2), 0);
    out.set(exifSegment, 2);
    out.set(baseBytes.subarray(2), 2 + exifSegment.length);

    const blob = new Blob([out], { type: 'image/jpeg' });
    const file = new File([blob], 'gps-photo.jpg', { type: 'image/jpeg' });

    const { hasMetadata } = await import('/js/exif.js');
    const sourceCheck = await hasMetadata(blob);
    window.__exifFixtureCheck = sourceCheck;

    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return { id: getState().queue[0], sourceCheck };
  });
}

async function selectImage(page, id) {
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
}

async function ensureExportPanelVisible(page) {
  const exportTab = page.locator('.editor-panel-tab[data-tab="export"]');
  if (await exportTab.isVisible().catch(() => false)) {
    await exportTab.click();
    await expect(page.locator('#panel-export')).toHaveClass(/is-active-tab/);
  }
}

async function installDownloadSpy(page) {
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () { /* swallow */ };
  });
}

// --- 1) DEFAULT path: exports strip metadata ----------------------------

test('source fixture has EXIF + GPS before import', async ({ page }) => {
  await resetApp(page);
  const { sourceCheck } = await importJpegWithExif(page);
  expect(sourceCheck.exif).toBe(true);
  expect(sourceCheck.gps).toBe(true);
});

test('PNG export (default strip): contains NO EXIF, NO XMP, NO GPS', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);

  const check = await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    const { update } = await import('/js/state.js');
    update(s => { s.export.format = 'png'; });
    const blob = await exportSingle(id);
    const { hasMetadata } = await import('/js/exif.js');
    return await hasMetadata(blob);
  }, id);

  expect(check.format).toBe('png');
  expect(check.exif).toBe(false);
  expect(check.xmp).toBe(false);
  expect(check.gps).toBe(false);
});

test('JPG export (default strip): contains NO EXIF, NO XMP, NO GPS', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);

  const check = await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    const { update } = await import('/js/state.js');
    update(s => { s.export.format = 'jpeg'; s.export.quality = 0.9; });
    const blob = await exportSingle(id);
    const { hasMetadata } = await import('/js/exif.js');
    return await hasMetadata(blob);
  }, id);

  expect(check.format).toBe('jpeg');
  expect(check.exif).toBe(false);
  expect(check.xmp).toBe(false);
  expect(check.gps).toBe(false);
});

test('WebP export (default strip): contains NO EXIF, NO XMP, NO GPS (where supported)', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);

  const result = await page.evaluate(async (id) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const caps = await probeCapabilities();
    if (!caps.webp) return { skipped: true };
    const { exportSingle } = await import('/js/exporter.js');
    const { update } = await import('/js/state.js');
    update(s => { s.export.format = 'webp'; s.export.quality = 0.9; });
    const blob = await exportSingle(id);
    const { hasMetadata } = await import('/js/exif.js');
    const check = await hasMetadata(blob);
    return { skipped: false, check };
  }, id);

  if (result.skipped) {
    test.skip();
    return;
  }
  expect(result.check.format).toBe('webp');
  expect(result.check.exif).toBe(false);
  expect(result.check.xmp).toBe(false);
  expect(result.check.gps).toBe(false);
});

// --- 2) OPT-IN path: stripMetadata=false preserves JPEG→JPEG EXIF -------

test('JPG export with stripMetadata=false: EXIF + GPS survive (v1.1.2)', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);

  const check = await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    const { update } = await import('/js/state.js');
    update(s => {
      s.export.format = 'jpeg';
      s.export.quality = 0.9;
      s.export.stripMetadata = false;
    });
    const blob = await exportSingle(id);
    const { hasMetadata } = await import('/js/exif.js');
    return await hasMetadata(blob);
  }, id);

  expect(check.format).toBe('jpeg');
  expect(check.exif).toBe(true);
  expect(check.gps).toBe(true);
});

test('PNG export with stripMetadata=false: still strips (cross-format preservation not supported)', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);

  const check = await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    const { update } = await import('/js/state.js');
    update(s => {
      s.export.format = 'png';
      s.export.stripMetadata = false;
    });
    const blob = await exportSingle(id);
    const { hasMetadata } = await import('/js/exif.js');
    return await hasMetadata(blob);
  }, id);

  // Even with the toggle off, PNG output doesn't get metadata back —
  // EXIF preservation only fires for JPEG → JPEG in v1.1.2.
  expect(check.format).toBe('png');
  expect(check.exif).toBe(false);
  expect(check.gps).toBe(false);
});

// --- 3) Export panel UI (v1.1.2 toggle, no Verify button) ---------------

test('export panel: shows Strip-metadata checkbox + label', async ({ page }) => {
  await resetApp(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);
  await ensureExportPanelVisible(page);

  await expect(page.locator('#panel-export .exif-status')).toHaveCount(1);
  await expect(page.locator('#panel-export .strip-metadata')).toHaveCount(1);
  await expect(page.locator('#panel-export .strip-metadata')).toBeChecked();
  await expect(page.locator('#panel-export .exif-label')).toHaveText(/Strip metadata/);
});

test('export panel: unchecking Strip metadata reveals the hint', async ({ page }) => {
  await resetApp(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);
  await ensureExportPanelVisible(page);

  // Hint hidden by default.
  await expect(page.locator('#panel-export .strip-metadata-hint')).toBeHidden();
  await page.locator('#panel-export .strip-metadata').uncheck();
  await expect(page.locator('#panel-export .strip-metadata-hint')).toBeVisible();
});

test('export panel: no Verify button anymore (v1.1.2 removed it)', async ({ page }) => {
  await resetApp(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);
  await ensureExportPanelVisible(page);

  await expect(page.locator('#panel-export .exif-verify-btn')).toHaveCount(0);
});
