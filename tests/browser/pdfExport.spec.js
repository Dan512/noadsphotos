import { test, expect } from '@playwright/test';

// v1.1 Feature 4: Image → PDF export.
//
// The PDF byte stream is built by the vendored jsPDF UMD bundle, loaded
// lazily on first PDF export. Tests run against real browser APIs because
// the bundle wants document / window and FileReader.

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
      s.export = {
        format: 'png',
        quality: 0.92,
        filenameTemplate: '{base}-edited',
        pdf: { pageSize: 'fit', orientation: 'auto', margins: undefined, fitMode: 'contain' },
      };
    });
    const m = await import('/js/exporter.js');
    if (typeof m._resetForTest === 'function') m._resetForTest();
    document.querySelectorAll('dialog').forEach(d => d.remove());
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

async function setupEditorWithImage(page, w = 80, h = 60, name = 'snap.png') {
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
    ctx.fillStyle = '#33aaff';
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
  // On mobile, only the active tab's panel section is visible. Switch to the
  // export tab so `#panel-export` is on screen for the format-chip clicks.
  // No-op on desktop — the click is just a no-op against an inert tab strip
  // hidden by the desktop CSS.
  await page.evaluate(() => {
    const tab = document.querySelector('.editor-panel-tab[data-tab="export"]');
    if (tab) tab.click();
  });
  return id;
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
      c.width = 60; c.height = 40;
      const ctx = c.getContext('2d');
      ctx.fillStyle = `hsl(${i * 80}, 70%, 50%)`;
      ctx.fillRect(0, 0, 60, 40);
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
    };
    window.__restoreSpy = () => {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    };
  });
}

// Helper: read the first N bytes of a Blob via FileReader (text). PDF files
// start with '%PDF-' — quickest sanity-check on the output.
async function blobHeader(page, blobHandle = '__lastDownloadBlob', byteCount = 8) {
  return await page.evaluate(async (n) => {
    const b = window.__lastDownloadBlob;
    if (!b) return null;
    const buf = await b.slice(0, n).arrayBuffer();
    return new TextDecoder('latin1').decode(new Uint8Array(buf));
  }, byteCount);
}

// Helper: parse the page count from a PDF byte stream. We don't need a real
// PDF parser — counting occurrences of "/Type /Page" (with at least one
// space; "/Pages" doesn't match this strict form due to no trailing space).
async function countPdfPages(page) {
  return await page.evaluate(async () => {
    const b = window.__lastDownloadBlob;
    if (!b) return 0;
    const buf = await b.arrayBuffer();
    // Decode as latin1 so binary bytes round-trip without UTF surrogate issues.
    const txt = new TextDecoder('latin1').decode(new Uint8Array(buf));
    // Match `/Type /Page` followed by whitespace OR a slash (catches "/Type /Page>>")
    // but NOT "/Pages" (the parent node). PDFs may write "/Type/Page" without
    // a space too, so we accept either.
    const re = /\/Type\s*\/Page(?![s])/g;
    const matches = txt.match(re);
    return matches ? matches.length : 0;
  });
}

// --- Single-image PDF tests ---------------------------------------------

test('PDF export: format chip exists in the editor export panel', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await expect(page.locator('#panel-export .format-chip[data-format="pdf"]')).toHaveCount(1);
});

test('PDF export: clicking PDF chip reveals page-size / orientation / margins / fit controls', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  // Quality is visible (PNG → JPG) only when JPG/WebP; default PNG hides it.
  // Click the PDF chip and verify PDF options surface.
  await page.locator('#panel-export .format-chip[data-format="pdf"]').click();
  await expect(page.locator('#panel-export .format-chip[data-format="pdf"]')).toHaveClass(/is-active/);
  await expect(page.locator('#panel-export .pdf-pagesize-select')).toBeVisible();
  await expect(page.locator('#panel-export .pdf-orientation-select')).toBeVisible();
  await expect(page.locator('#panel-export .pdf-margin-input')).toBeVisible();
  // The quality row should be hidden (PDF uses a fixed embed quality).
  await expect(page.locator('#panel-export .quality-row')).toBeHidden();
});

test('PDF export: clicking PDF chip updates state.export.format', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await page.locator('#panel-export .format-chip[data-format="pdf"]').click();
  const fmt = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.format;
  });
  expect(fmt).toBe('pdf');
});

test('PDF export: setting page size to A4 writes to state.export.pdf', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);
  await page.locator('#panel-export .format-chip[data-format="pdf"]').click();
  await page.evaluate(() => {
    const sel = document.querySelector('#panel-export .pdf-pagesize-select');
    sel.value = 'a4';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const ps = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().export.pdf.pageSize;
  });
  expect(ps).toBe('a4');
});

test('PDF export: Download produces a Blob with type application/pdf and %PDF- header', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await setupEditorWithImage(page, 80, 60, 'photo.png');

  // Switch to PDF format + A4 page size.
  await page.locator('#panel-export .format-chip[data-format="pdf"]').click();
  await page.evaluate(() => {
    const sel = document.querySelector('#panel-export .pdf-pagesize-select');
    sel.value = 'a4';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Click Download.
  await page.locator('#panel-export .download-btn').click();

  // Wait for download to occur (PDF build is async — jsPDF loads, then
  // image gets baked + embedded).
  await expect.poll(async () => {
    return await page.evaluate(() => window.__lastDownload?.download || null);
  }, { timeout: 15000 }).toBe('photo-edited.pdf');

  const dl = await page.evaluate(() => window.__lastDownload);
  expect(dl).toBeTruthy();
  expect(dl.type).toBe('application/pdf');
  expect(dl.size).toBeGreaterThan(100);

  // Header bytes must start with %PDF-.
  const header = await blobHeader(page);
  expect(header.startsWith('%PDF-')).toBe(true);
});

test('PDF export: jsPDF not loaded on initial page visit (lazy)', async ({ page }) => {
  await resetApp(page);
  const loaded = await page.evaluate(() => !!(window.jspdf && window.jspdf.jsPDF));
  expect(loaded).toBe(false);
});

test('PDF export: after a PDF export, jsPDF is loaded (lazy hydration)', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await setupEditorWithImage(page, 60, 60, 'pix.png');
  await page.locator('#panel-export .format-chip[data-format="pdf"]').click();
  await page.locator('#panel-export .download-btn').click();
  await expect.poll(async () => {
    return await page.evaluate(() => window.__lastDownload?.download || null);
  }, { timeout: 15000 }).toBe('pix-edited.pdf');
  const loaded = await page.evaluate(() => !!(window.jspdf && window.jspdf.jsPDF));
  expect(loaded).toBe(true);
});

// --- Batch PDF tests -----------------------------------------------------

test('PDF batch: batch panel reveals Export queue (single PDF) button when PDF selected', async ({ page }) => {
  await resetApp(page);
  await importImages(page, ['a.png', 'b.png', 'c.png']);
  // Click PDF format chip in batch panel.
  await page.locator('.batch-format-chip[data-format="pdf"]').click();
  await expect(page.locator('.batch-panel .export-pdf-btn')).toBeVisible();
  // The ZIP / each buttons should be hidden when PDF is active.
  await expect(page.locator('.batch-panel .export-queue-btn')).toBeHidden();
  await expect(page.locator('.batch-panel .export-each-btn')).toBeHidden();
});

test('PDF batch: 3 images → single PDF with 3 pages, %PDF- header', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);
  await importImages(page, ['a.png', 'b.png', 'c.png']);

  // Trigger batch PDF export directly (skip clicking through the UI; the
  // wiring is covered by the visibility test above).
  await page.evaluate(async () => {
    const { exportBatchPdf } = await import('/js/exporter.js');
    return await exportBatchPdf();
  });

  // Wait for the download spy to record the PDF.
  await expect.poll(async () => {
    return await page.evaluate(() => window.__lastDownload?.download || null);
  }, { timeout: 30000 }).toMatch(/^noadsphotos-.+\.pdf$/);

  const dl = await page.evaluate(() => window.__lastDownload);
  expect(dl.type).toBe('application/pdf');
  // Header sanity-check.
  const header = await blobHeader(page);
  expect(header.startsWith('%PDF-')).toBe(true);
  // 3 images → 3 pages.
  const pages = await countPdfPages(page);
  expect(pages).toBe(3);
});

test('PDF batch: empty queue produces no download, warn toast', async ({ page }) => {
  await resetApp(page);
  await installDownloadSpy(page);

  // Establish export context (without images, the exporter short-circuits).
  await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { setExportContext } = await import('/js/exporter.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({ decoder: createImageBitmap, closer: bm => bm.close() });
    setExportContext({ lifecycle, caps });
  });

  const result = await page.evaluate(async () => {
    const { exportBatchPdf } = await import('/js/exporter.js');
    return await exportBatchPdf();
  });
  expect(result).toBeNull();

  await expect(page.locator('#toast-root .toast-warn').first()).toBeVisible();
  const dl = await page.evaluate(() => window.__lastDownload);
  expect(dl).toBeNull();
});
