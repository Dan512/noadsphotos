// tests/browser/batchThumbnailRefresh.spec.js — auto-refresh queue thumbnails after batch ops.
//
// Covers the `autoRefreshThumbnails` setting (default true). When ON, each
// thumbnail's underlying Blob reference changes after an Apply-to-all
// triggers a sequential per-image refresh. When OFF, thumbnails are
// untouched.
import { test, expect } from '@playwright/test';

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
    document.querySelectorAll('dialog').forEach(d => d.remove());
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

// Import N test images programmatically. Same pattern as batchPanel.spec.js.
async function importImages(page, count) {
  await page.evaluate(async (n) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    const files = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = `hsl(${i * 80}, 70%, 50%)`;
      ctx.fillRect(0, 0, 64, 64);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
      files.push(new File([blob], `img-${i}.png`, { type: 'image/png' }));
    }
    await importFiles(files, caps, lifecycle);
  }, count);
}

// Capture each thumbnail's Blob size as a stable identity proxy. Blob size
// changes whenever the rendered output changes (different resize, filter,
// rotation, etc.). Two distinct renders of the same image will almost
// certainly produce different sizes since JPEG encoding is content-sensitive.
async function readThumbBlobSizes(page) {
  return await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return Promise.all(s.queue.map(async id => {
      const blob = s.images[id].source.thumbnail;
      return { id, size: blob ? blob.size : 0 };
    }));
  });
}

test('with auto-refresh ON, batch resize updates every thumbnail blob', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 3);

  const before = await readThumbBlobSizes(page);
  expect(before.length).toBe(3);
  // All initial thumbnails come from the importer — same source size.
  for (const r of before) expect(r.size).toBeGreaterThan(0);

  // Apply a 50% percent resize to every image.
  await page.evaluate(() => {
    document.querySelector('.batch-resize-section').open = true;
  });
  await page.locator('.batch-resize-mode').selectOption('percent');
  await page.locator('.batch-resize-value').fill('50');
  await page.locator('.batch-resize-apply').click();

  // Wait for the auto-refresh pass to swap each thumbnail's blob. We poll
  // until the per-id sizes change relative to the importer baseline.
  await expect.poll(async () => {
    const after = await readThumbBlobSizes(page);
    // Every thumb's blob should have been replaced by a re-render (so the
    // size will almost certainly differ).
    const byId = new Map(before.map(r => [r.id, r.size]));
    return after.every(r => byId.get(r.id) !== r.size);
  }, { timeout: 5000 }).toBe(true);
});

test('with auto-refresh OFF, batch resize does NOT update thumbnails', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 3);

  // Flip the setting off.
  await page.evaluate(async () => {
    const { setSetting } = await import('/js/settings.js');
    setSetting('autoRefreshThumbnails', false);
  });

  const before = await readThumbBlobSizes(page);

  await page.evaluate(() => {
    document.querySelector('.batch-resize-section').open = true;
  });
  await page.locator('.batch-resize-mode').selectOption('percent');
  await page.locator('.batch-resize-value').fill('50');
  await page.locator('.batch-resize-apply').click();

  // Give the auto-refresh path a chance to run — if it were going to run,
  // 1.5s is more than enough for three tiny 64x64 thumbs.
  await page.waitForTimeout(1500);

  const after = await readThumbBlobSizes(page);
  const byId = new Map(before.map(r => [r.id, r.size]));
  for (const r of after) {
    expect(r.size).toBe(byId.get(r.id));
  }
});

test('auto-refresh: <img> src updates after batch rotate', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);

  // Snapshot every <img> src in the grid.
  const srcsBefore = await page.locator('#queue-view .queue-thumb img').evaluateAll(
    els => els.map(el => el.src),
  );
  expect(srcsBefore.length).toBe(2);

  await page.evaluate(() => {
    document.querySelector('.batch-rotate-section').open = true;
  });
  await page.locator('.batch-rotate-right').click();

  // After the sequential refresh, each <img> should have a NEW object URL.
  await expect.poll(async () => {
    const after = await page.locator('#queue-view .queue-thumb img').evaluateAll(
      els => els.map(el => el.src),
    );
    return after.every((s, i) => s !== srcsBefore[i]);
  }, { timeout: 5000 }).toBe(true);
});
