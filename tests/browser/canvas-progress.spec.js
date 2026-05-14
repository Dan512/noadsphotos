// tests/browser/canvas-progress.spec.js — canvas-overlay progress indicator
// for long-running canvas-bound ops (bg-remove). Verifies the lifecycle
// (show → update → hide), the DOM scaffolding lives inside .canvas-frame,
// and the progress bar width tracks the percent argument.

import { test, expect } from '@playwright/test';

async function resetApp(page, view = 'editor') {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.evaluate(async (v) => {
    const { update } = await import('/js/state.js');
    update(s => {
      s.queue = [];
      s.images = Object.create(null);
      s.ui.activeImageId = null;
      s.ui.view = v;
      s.ui.activeTool = 'select';
    });
    // Clear any lingering bg-remove consent / impl from prior tests.
    const { _resetForTest } = await import('/js/ops/bgremove.js');
    _resetForTest();
    document.querySelectorAll('dialog').forEach(d => { try { d.close(); } catch { /* ignore */ } d.remove(); });
  }, view);
}

test('canvas progress overlay exists inside .canvas-frame and starts hidden', async ({ page }) => {
  await resetApp(page);
  const overlayInFrame = await page.evaluate(() => {
    const frame = document.querySelector('.canvas-frame');
    const overlay = document.getElementById('canvas-progress-overlay');
    return !!(frame && overlay && frame.contains(overlay));
  });
  expect(overlayInFrame).toBe(true);
  // Hidden by default.
  await expect(page.locator('#canvas-progress-overlay')).toBeHidden();
});

test('canvas progress overlay: show() reveals the card and populates content', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const cp = await import('/js/canvasProgress.js');
    cp.show({ title: 'Removing background…', stage: 'Loading model', percent: 25 });
  });
  await expect(page.locator('#canvas-progress-overlay')).toBeVisible();
  await expect(page.locator('.canvas-progress-title')).toHaveText('Removing background…');
  await expect(page.locator('.canvas-progress-stage')).toHaveText('Loading model');
  await expect(page.locator('.canvas-progress-percent')).toHaveText('25%');
  // The progressbar role is correctly applied with the right valuenow.
  const valueNow = await page.locator('.canvas-progress-bar').getAttribute('aria-valuenow');
  expect(valueNow).toBe('25');
});

test('canvas progress overlay: update() changes stage + percent without re-show', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const cp = await import('/js/canvasProgress.js');
    cp.show({ title: 'Removing background…', stage: 'Loading model', percent: 10 });
    cp.update({ stage: 'Running inference', percent: 75 });
  });
  await expect(page.locator('#canvas-progress-overlay')).toBeVisible();
  await expect(page.locator('.canvas-progress-stage')).toHaveText('Running inference');
  await expect(page.locator('.canvas-progress-percent')).toHaveText('75%');
});

test('canvas progress overlay: hide() removes the overlay from view', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const cp = await import('/js/canvasProgress.js');
    cp.show({ title: 'Hi', stage: 'x', percent: 30 });
    cp.hide();
  });
  await expect(page.locator('#canvas-progress-overlay')).toBeHidden();
  // Content is cleared so it can't leak into the next show.
  const stage = await page.locator('.canvas-progress-stage').textContent();
  expect(stage).toBe('');
});

test('canvas progress overlay: progress bar fill (via --progress CSS var) tracks percent', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const cp = await import('/js/canvasProgress.js');
    cp.show({ title: 'x', stage: 'x', percent: 42 });
  });
  const progress = await page.evaluate(() => {
    const bar = document.querySelector('.canvas-progress-bar');
    return bar.style.getPropertyValue('--progress');
  });
  expect(progress).toBe('42%');
});

test('canvas progress overlay: percent values outside [0, 100] are clamped', async ({ page }) => {
  await resetApp(page);
  const probes = await page.evaluate(async () => {
    const cp = await import('/js/canvasProgress.js');
    cp.show({ title: 'x', stage: 'x', percent: -10 });
    const lo = document.querySelector('.canvas-progress-bar').getAttribute('aria-valuenow');
    cp.update({ percent: 250 });
    const hi = document.querySelector('.canvas-progress-bar').getAttribute('aria-valuenow');
    return { lo, hi };
  });
  expect(probes.lo).toBe('0');
  expect(probes.hi).toBe('100');
});

test('canvas progress overlay shows during bg-remove run on the active image', async ({ page }, testInfo) => {
  // Mobile projects route the side panel through a bottom-sheet UX whose
  // "Apply" button isn't auto-scrolled into view by the click helper. The
  // overlay lifecycle itself is exercised by the six tests above; this
  // integration smoke focuses on desktop layouts.
  test.skip(
    testInfo.project.name === 'mobile-chrome' || testInfo.project.name === 'mobile-safari',
    'desktop integration smoke; mobile bottom-sheet UX is covered separately',
  );
  // Reuse the same fake-impl strategy as bgremove.spec.js so this stays fast.
  await resetApp(page, 'queue');
  await page.evaluate(async () => {
    const { _setImplForTest } = await import('/js/ops/bgremove.js');
    _setImplForTest({
      // Slow-roll the fake so we have a window where the overlay is visible.
      removeBackground: async (blob, config) => {
        const bitmap = await createImageBitmap(blob);
        const w = bitmap.width;
        const h = bitmap.height;
        const c = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(w, h)
          : Object.assign(document.createElement('canvas'), { width: w, height: h });
        const ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const id = ctx.getImageData(0, 0, w, h);
        const px = id.data;
        // Fire progress callbacks so the overlay updates.
        if (config && typeof config.progress === 'function') {
          config.progress('fetch:/models/isnet_fp16', 25, 100);
          config.progress('compute:inference', 1, 4);
        }
        await new Promise(r => setTimeout(r, 80));
        try { bitmap.close(); } catch { /* ignore */ }
        return new Blob([new Uint8Array(px.buffer, px.byteOffset, px.byteLength)], {
          type: `image/x-rgba8;width=${w};height=${h}`,
        });
      },
    });
  });

  // Import a small test image.
  const id = await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#f00';
    ctx.fillRect(4, 4, 8, 8);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 't.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  });

  // Open editor and activate bg-remove tool.
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await page.locator('#editor-view .editor-toolbar button[data-tool="bg-remove"]').click();
  await expect(page.locator('#panel-tool .bg-remove-panel')).toBeVisible();

  // Pre-seed consent so we skip the modal.
  await page.evaluate(async () => {
    const { CONSENT_KEY, MODEL_HASH } = await import('/js/ops/bgremove.js');
    localStorage.setItem(CONSENT_KEY, MODEL_HASH);
  });

  // Fire the apply click; the overlay should appear within a tick.
  await page.locator('#panel-tool .bg-remove-apply').click();
  // It pops up fast — give Playwright a chance to catch it visible.
  await expect(page.locator('#canvas-progress-overlay')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.canvas-progress-title')).toContainText(/Removing/);

  // Wait for the run to finish; overlay should disappear.
  await expect(page.locator('#canvas-progress-overlay')).toBeHidden({ timeout: 5000 });
});
