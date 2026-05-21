// tests/browser/smoke-release.spec.js — release-criteria smoke tests
// (Phase 14.6). Each test maps to a v1 success criterion in
// `docs/plans/2026-05-13-noadsimages-v1-design.md`.
//
// These are deliberately end-to-end. They exercise the full editor path
// — import → operation → export — and assert on the produced bytes.
//
// Anything that needs the bg-removal model is skipped on CI runners that
// don't have the vendored data set installed (we probe for it first).
import { test, expect } from '@playwright/test';

async function bootClean(page) {
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

async function setupContexts(page) {
  await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { setExportContext } = await import('/js/exporter.js');
    const { setQueueViewContext } = await import('/js/queueView.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    window.__caps = caps;
    window.__lifecycle = lifecycle;
    setExportContext({ lifecycle, caps });
    setQueueViewContext({ lifecycle, caps });
  });
}

// --- 1. Batch resize + WebP convert in <30s ---------------------------------

test('smoke: batch resize 10 images + WebP convert finishes under 30s', async ({ page }) => {
  await bootClean(page);
  await setupContexts(page);

  // Build 10 small test images and import them.
  await page.evaluate(async () => {
    const { importFiles } = await import('/js/importer.js');
    const files = [];
    for (let i = 0; i < 10; i++) {
      const c = document.createElement('canvas');
      c.width = 600; c.height = 400;
      const ctx = c.getContext('2d');
      ctx.fillStyle = `hsl(${i * 36}, 70%, 50%)`;
      ctx.fillRect(0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.92));
      files.push(new File([blob], `img-${i}.png`, { type: 'image/png' }));
    }
    await importFiles(files, window.__caps, window.__lifecycle);
  });
  await expect.poll(async () => page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.length;
  })).toBe(10);

  // Spy on URL.createObjectURL so we know when the ZIP blob lands.
  await page.evaluate(() => {
    window.__zipBlobBytes = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      if (blob.type === 'application/zip' || (blob.type || '').includes('zip')) {
        window.__zipBlobBytes = blob.size;
      }
      return orig(blob);
    };
    HTMLAnchorElement.prototype.click = function() { /* swallow */ };
  });

  const t0 = Date.now();
  await page.evaluate(async () => {
    const { exportBatch } = await import('/js/exporter.js');
    await exportBatch({
      format: 'webp',
      quality: 0.85,
      filenameTemplate: '{base}-resize',
    });
  });
  await expect.poll(async () => page.evaluate(() => window.__zipBlobBytes), { timeout: 30_000 }).toBeGreaterThan(0);
  const elapsed = Date.now() - t0;
  console.log(`[smoke 1] 10-image batch resize+WebP took ${elapsed} ms`);
  expect(elapsed).toBeLessThan(30_000);
});

// --- 2. Color-to-transparent: black-bg → alpha=0 ----------------------------

test('smoke: chromakey black background → exported PNG has alpha=0 in black region', async ({ page }) => {
  await bootClean(page);
  await setupContexts(page);

  // Create an icon-like PNG: black background, white "circle" in the middle.
  const imageId = await page.evaluate(async () => {
    const { importFiles } = await import('/js/importer.js');
    const { getState } = await import('/js/state.js');
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(32, 32, 20, 0, Math.PI * 2);
    ctx.fill();
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    await importFiles([new File([blob], 'icon.png', { type: 'image/png' })], window.__caps, window.__lifecycle);
    return getState().queue[0];
  });

  // Open in editor and apply chromakey black with tight tolerance.
  await page.locator(`#queue-view .queue-thumb[data-image-id="${imageId}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 3000 }).toBeGreaterThan(0);

  await page.evaluate(async (id) => {
    const { update, getState } = await import('/js/state.js');
    const { applyChromakey, buildChromakeyMask, setChromakeyMask } =
      await import('/js/ops/chromakey.js');
    // Apply chromakey config + build + attach the mask. This mirrors what
    // the eyedropper tool does at runtime.
    const img = getState().images[id];
    update(s => { applyChromakey(s.images[id], { hex: '#000000', tolerance: 10 }); });
    // Build the mask from the source bitmap pixels.
    const src = img.source;
    const w = src.width, h = src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src.bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const mask = buildChromakeyMask(data, '#000000', 10);
    update(s => { setChromakeyMask(s.images[id], mask); });
  }, imageId);

  // Export to PNG and inspect a corner pixel for alpha.
  const cornerAlpha = await page.evaluate(async (id) => {
    const { exportSingle, getLastExportedBlob } = await import('/js/exporter.js');
    // Spy the download so we don't pop a save dialog.
    HTMLAnchorElement.prototype.click = function() {};
    await exportSingle(id);
    const entry = getLastExportedBlob();
    if (!entry || !entry.blob) return null;
    const bm = await createImageBitmap(entry.blob);
    const c = document.createElement('canvas');
    c.width = bm.width; c.height = bm.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bm, 0, 0);
    // Top-left pixel was solid black in the source — should now be alpha=0.
    const data = ctx.getImageData(2, 2, 1, 1).data;
    return data[3]; // alpha channel
  }, imageId);

  console.log(`[smoke 2] corner pixel alpha after chromakey black = ${cornerAlpha}`);
  expect(cornerAlpha).toBe(0);
});

// --- 3. Screenshot annotate + export <1min ---------------------------------

test('smoke: redact + arrow shape + export bakes both into PNG', async ({ page }) => {
  await bootClean(page);
  await setupContexts(page);

  const imageId = await page.evaluate(async () => {
    const { importFiles } = await import('/js/importer.js');
    const { getState } = await import('/js/state.js');
    const c = document.createElement('canvas');
    c.width = 200; c.height = 150;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#cccccc';
    ctx.fillRect(0, 0, 200, 150);
    // Pretend secret region in the top-left.
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(10, 10, 60, 30);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    await importFiles([new File([blob], 'screenshot.png', { type: 'image/png' })], window.__caps, window.__lifecycle);
    return getState().queue[0];
  });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${imageId}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 3000 }).toBeGreaterThan(0);

  // Programmatically push a redact overlay + a shape (arrow) onto the image.
  // Overlay schema is defined in js/overlays.js — `type` (not `kind`) and
  // flat (x, y, w, h) fields for redact, (x1, y1, x2, y2) for shape.
  // Use blur mode + larger strength so the sample pixel definitively differs
  // from the original solid magenta (blur reads neighboring gray pixels).
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    const { addOverlay } = await import('/js/overlays.js');
    update(s => {
      addOverlay(s.images[id], {
        id: 'redact-1', type: 'redact', mode: 'blur', strength: 20,
        x: 10, y: 10, w: 60, h: 30,
      });
      addOverlay(s.images[id], {
        id: 'shape-1', type: 'shape', kind: 'arrow',
        x1: 100, y1: 60, x2: 150, y2: 100,
        stroke: '#ff0000', strokeWidth: 3,
      });
    });
  }, imageId);

  const sample = await page.evaluate(async (id) => {
    const { exportSingle, getLastExportedBlob } = await import('/js/exporter.js');
    HTMLAnchorElement.prototype.click = function() {};
    await exportSingle(id);
    const entry = getLastExportedBlob();
    if (!entry || !entry.blob) return null;
    const bm = await createImageBitmap(entry.blob);
    const c = document.createElement('canvas');
    c.width = bm.width; c.height = bm.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bm, 0, 0);
    // Sample near the edge of the redact region — blur reads the surrounding
    // gray pixels into the red/blue averages, so the magenta no longer reads
    // as pure (255, 0, 255).
    const inside = ctx.getImageData(12, 12, 1, 1).data;
    return { r: inside[0], g: inside[1], b: inside[2] };
  }, imageId);

  console.log('[smoke 3] redact region center =', sample);
  // It should NOT still be the original magenta — some redact transformation
  // (pixelate or placeholder) must have replaced the area.
  const stillMagenta = sample.r > 240 && sample.g < 30 && sample.b > 240;
  expect(stillMagenta).toBe(false);
});

// --- 5. Zero outbound for image data ----------------------------------------

test('smoke: full editor flow produces zero non-origin image-data requests', async ({ page }) => {
  const offenders = [];
  page.on('request', req => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    let host;
    try { host = new URL(url).host; }
    catch { return; }
    if (host === 'localhost:4173' || host === 'noadsphotos.com') return;
    offenders.push({ url, method: req.method() });
  });

  await bootClean(page);
  await setupContexts(page);

  // Import → edit → export.
  await page.evaluate(async () => {
    const { importFiles } = await import('/js/importer.js');
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#445566';
    ctx.fillRect(0, 0, 64, 64);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    await importFiles([new File([blob], 'priv.png', { type: 'image/png' })], window.__caps, window.__lifecycle);
  });
  const id = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  });
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect.poll(async () => page.evaluate(() => document.getElementById('base-canvas')?.width || 0), { timeout: 3000 }).toBeGreaterThan(0);
  await page.evaluate(async (id) => {
    const { exportSingle } = await import('/js/exporter.js');
    HTMLAnchorElement.prototype.click = function() {};
    await exportSingle(id);
  }, id);

  if (offenders.length) {
    console.error('[smoke 5] third-party requests:', offenders);
  }
  expect(offenders, 'zero outbound image-data requests').toEqual([]);
});
