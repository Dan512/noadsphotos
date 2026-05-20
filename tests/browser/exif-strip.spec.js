import { test, expect } from '@playwright/test';

// v1.1 EXIF/GPS strip feature.
//
// Two halves to verify:
//   1) Exports are CLEAN — every format we emit (PNG, JPG, WebP) should
//      contain NO EXIF, NO XMP, NO GPS even when the source did. Canvas
//      re-encoding strips this naturally; these tests are the regression
//      guard so we'd notice if a code path ever started preserving it.
//   2) The Verify UI in the Export panel works — clicking with no export
//      yet toasts "export first"; clicking after an export toasts "no
//      metadata found".
//
// Fixtures are SYNTHESIZED inside the browser context rather than committed
// as binary files. The strategy: build a JPEG byte array in JS that
// contains a real EXIF + GPS APP1 segment, wrap it in a File, import it
// through the normal pipeline. After export, decode the exported Blob's
// bytes with js/exif.js#hasMetadata and assert nothing leaked through.

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
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

// Build a JPEG containing real EXIF + GPS APP1 plus a single 1×1 pixel,
// then import it. We construct the byte array entirely inside the page so
// no fixture file is needed on disk — keeps the test self-contained and
// portable to any CI environment.
//
// The JPEG body (after our injected APP1) is the minimal 1×1 white JPEG
// produced via canvas.toBlob, with our EXIF segment spliced AFTER the SOI
// and BEFORE the original APP0/JFIF marker. This keeps it decodable by
// every JPEG decoder we'd run against, while ensuring the EXIF survives
// importing.
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
    // 1) Render a small color image to a JPEG via canvas.
    const c = document.createElement('canvas');
    c.width = 100; c.height = 100;
    const cx = c.getContext('2d');
    cx.fillStyle = '#aa3355';
    cx.fillRect(0, 0, 100, 100);
    const baseBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    const baseBytes = new Uint8Array(await baseBlob.arrayBuffer());

    // 2) Build an EXIF APP1 with a GPSInfo tag in IFD0. Lifted from the
    // unit-test fixture builder, inline for self-containment.
    function buildExifApp1() {
      const entries = [];
      // Orientation (0x0112) short=3 count=1 value=1
      entries.push([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
      // GPSInfo (0x8825) long=4 count=1 value=0 — pointer sentinel
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

    // 3) Splice the APP1 in after the SOI (first 2 bytes).
    const out = new Uint8Array(baseBytes.length + exifSegment.length);
    out.set(baseBytes.subarray(0, 2), 0);
    out.set(exifSegment, 2);
    out.set(baseBytes.subarray(2), 2 + exifSegment.length);

    const blob = new Blob([out], { type: 'image/jpeg' });
    const file = new File([blob], 'gps-photo.jpg', { type: 'image/jpeg' });

    // Confirm the bytes WE constructed actually look like EXIF+GPS to the
    // detector — sanity check before importing/exporting.
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

// On mobile viewports the editor uses tabbed panels (only one panel visible
// at a time), so the Export panel's children aren't clickable until we
// activate that tab. On desktop the tab strip exists in the DOM but is
// hidden via CSS, so we check visibility (not just count) before clicking.
async function ensureExportPanelVisible(page) {
  const exportTab = page.locator('.editor-panel-tab[data-tab="export"]');
  if (await exportTab.isVisible().catch(() => false)) {
    await exportTab.click();
    await expect(page.locator('#panel-export')).toHaveClass(/is-active-tab/);
  }
  // Either way, the export panel's section should now be visible. On
  // desktop it's always visible (no tabs); on mobile we just activated it.
}

async function installDownloadSpy(page) {
  await page.evaluate(() => {
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      // Suppress actual download to keep tests headless.
    };
  });
}

// --- 1) Real strip verification ----------------------------------------

test('source fixture has EXIF + GPS before import', async ({ page }) => {
  await resetApp(page);
  const { sourceCheck } = await importJpegWithExif(page);
  // The synthesized fixture must actually contain what we say it does,
  // otherwise the "exports are clean" assertions below are meaningless.
  expect(sourceCheck.exif).toBe(true);
  expect(sourceCheck.gps).toBe(true);
});

test('PNG export: contains NO EXIF, NO XMP, NO GPS', async ({ page }) => {
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

test('JPG export: contains NO EXIF, NO XMP, NO GPS', async ({ page }) => {
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

test('WebP export: contains NO EXIF, NO XMP, NO GPS (where supported)', async ({ page }) => {
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
    // WebKit / older Safari may not support WebP encoding — that's fine,
    // we just skip the assertion on those projects.
    test.skip();
    return;
  }
  expect(result.check.format).toBe('webp');
  expect(result.check.exif).toBe(false);
  expect(result.check.xmp).toBe(false);
  expect(result.check.gps).toBe(false);
});

// --- 2) Verify UI in the Export panel ------------------------------------

test('export panel: EXIF status badge and Verify button are present', async ({ page }) => {
  await resetApp(page);
  // Need an image so the panel is fully visible.
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);
  await ensureExportPanelVisible(page);

  await expect(page.locator('#panel-export .exif-status')).toHaveCount(1);
  await expect(page.locator('#panel-export .exif-badge')).toHaveCount(1);
  await expect(page.locator('#panel-export .exif-label')).toHaveText(/Metadata stripped on export/);
  await expect(page.locator('#panel-export .exif-verify-btn')).toHaveCount(1);
  await expect(page.locator('#panel-export .exif-verify-btn')).toHaveText(/Verify last export/);
});

test('Verify button with no prior export: toasts "Export a file first"', async ({ page }) => {
  await resetApp(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);
  await ensureExportPanelVisible(page);

  await page.locator('#panel-export .exif-verify-btn').click();

  const toastText = await page.evaluate(() => {
    const el = document.querySelector('#toast-root .toast');
    return el ? el.textContent : '';
  });
  expect(toastText).toMatch(/Export a file first/);
});

test('Verify button after export: toasts "No EXIF, XMP, or GPS data found"', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);
  await ensureExportPanelVisible(page);

  // Trigger an export programmatically.
  await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    await exportSingle(id);
  }, id);

  // Clear any prior export-success toast before clicking Verify so the
  // assertion below picks up the verify toast specifically.
  await page.evaluate(() => {
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });

  await page.locator('#panel-export .exif-verify-btn').click();

  // The verify handler runs hasMetadata() async (reads blob.arrayBuffer),
  // so the toast appears a tick after the click. Poll until it shows up.
  await expect.poll(async () => {
    return await page.evaluate(() => {
      const el = document.querySelector('#toast-root .toast');
      return el ? el.textContent : '';
    });
  }, { timeout: 3000 }).toMatch(/No EXIF, XMP, or GPS data found/);
});

test('Verify button label uses i18n string', async ({ page }) => {
  await resetApp(page);
  const { id } = await importJpegWithExif(page);
  await selectImage(page, id);
  await ensureExportPanelVisible(page);
  // English wording — covered by the i18n-coverage test for the dict but
  // verified live in the rendered DOM here.
  await expect(page.locator('#panel-export .exif-label')).toHaveText('Metadata stripped on export');
  await expect(page.locator('#panel-export .exif-verify-btn')).toHaveText('Verify last export');
});
