import { test, expect } from '@playwright/test';

// Phase 10: batch panel UI in the queue view.

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

// Import N images programmatically.
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
      ctx.fillStyle = i % 2 === 0 ? '#000000' : `hsl(${i * 60}, 70%, 50%)`;
      ctx.fillRect(0, 0, 64, 64);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
      files.push(new File([blob], `img-${i}.png`, { type: 'image/png' }));
    }
    await importFiles(files, caps, lifecycle);
  }, count);
}

// --- Structural tests -----------------------------------------------------

test('batch panel: hidden in empty queue, visible after import', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#queue-view .batch-panel')).toHaveCount(0);
  await importImages(page, 2);
  await expect(page.locator('#queue-view .batch-panel')).toBeVisible();
});

test('batch panel: contains all expected sections', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 1);
  await expect(page.locator('.batch-panel .batch-resize-section')).toHaveCount(1);
  await expect(page.locator('.batch-panel .batch-rotate-section')).toHaveCount(1);
  await expect(page.locator('.batch-panel .batch-adjust-section')).toHaveCount(1);
  await expect(page.locator('.batch-panel .batch-chroma-section')).toHaveCount(1);
  await expect(page.locator('.batch-panel .batch-trim-section')).toHaveCount(1);
  await expect(page.locator('.batch-panel .batch-bg-section')).toHaveCount(1);
  await expect(page.locator('.batch-panel .batch-export-section')).toHaveCount(1);
});

test('batch panel: bg-remove button is enabled (Phase 11 ships background removal)', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 1);
  await expect(page.locator('.batch-bg-apply')).toBeEnabled();
  await expect(page.locator('.batch-bg-apply')).toHaveText(/Run on all queue images/);
});

test('batch panel: Export queue button is visible and not disabled when queue has images', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);
  await expect(page.locator('.export-queue-btn')).toBeVisible();
  await expect(page.locator('.export-queue-btn')).not.toBeDisabled();
});

// --- Apply-to-all behavior -----------------------------------------------

test('batch resize: longestSide 800 applies to every image', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 3);

  await page.evaluate(() => {
    document.querySelector('.batch-resize-section').open = true;
  });
  await page.locator('.batch-resize-mode').selectOption('longestSide');
  await page.locator('.batch-resize-value').fill('800');
  await page.locator('.batch-resize-apply').click();

  const result = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return s.queue.map(id => ({
      id,
      resize: s.images[id].transforms.resize,
      isBatch: !!s.images[id]._isBatch,
    }));
  });
  expect(result.length).toBe(3);
  for (const r of result) {
    expect(r.resize).toEqual({ mode: 'longestSide', value: 800 });
    expect(r.isBatch).toBe(true);
  }
});

test('batch resize: one Ctrl+Z reverts all images', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 3);

  await page.evaluate(() => {
    document.querySelector('.batch-resize-section').open = true;
  });
  await page.locator('.batch-resize-mode').selectOption('longestSide');
  await page.locator('.batch-resize-value').fill('500');
  await page.locator('.batch-resize-apply').click();

  // Verify applied.
  let after = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.map(id => getState().images[id].transforms.resize);
  });
  for (const r of after) expect(r).toEqual({ mode: 'longestSide', value: 500 });

  // Undo.
  await page.evaluate(async () => {
    const { undo } = await import('/js/history.js');
    undo();
  });

  const reverted = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.map(id => getState().images[id].transforms.resize);
  });
  for (const r of reverted) expect(r).toBeNull();
});

test('batch rotate: clicking +90° applies immediately to all', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);

  await page.evaluate(() => {
    document.querySelector('.batch-rotate-section').open = true;
  });
  await page.locator('.batch-rotate-right').click();

  const result = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.map(id => getState().images[id].transforms.rotate);
  });
  for (const r of result) expect(r).toBe(90);
});

test('batch flip H: applies to every image', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);

  await page.evaluate(() => {
    document.querySelector('.batch-rotate-section').open = true;
  });
  await page.locator('.batch-flip-h').click();

  const result = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.map(id => getState().images[id].transforms.flipH);
  });
  for (const r of result) expect(r).toBe(true);
});

test('batch adjust: brightness 40 + filter sepia applies to all', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);

  await page.evaluate(() => {
    document.querySelector('.batch-adjust-section').open = true;
  });
  await page.evaluate(() => {
    const slider = document.querySelector('.batch-adjust-brightness');
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('.batch-adjust-preset').selectOption('sepia');
  await page.locator('.batch-adjust-apply').click();

  const result = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.map(id => ({
      brightness: getState().images[id].adjust.brightness,
      filterPreset: getState().images[id].filterPreset,
    }));
  });
  for (const r of result) {
    expect(r.brightness).toBe(40);
    expect(r.filterPreset).toBe('sepia');
  }
});

test('batch chromakey: color #000000 tolerance 40 applies a mask to every image', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);

  await page.evaluate(() => {
    document.querySelector('.batch-chroma-section').open = true;
  });
  await page.evaluate(() => {
    const c = document.querySelector('.batch-chroma-color');
    c.value = '#000000';
    c.dispatchEvent(new Event('input', { bubbles: true }));
    const t = document.querySelector('.batch-chroma-tol');
    t.value = '40';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('.batch-chroma-apply').click();

  // Mask building is async — wait for the chromakey field to populate.
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      return getState().queue.every(id => {
        const img = getState().images[id];
        return img.chromakey && img.chromakey.hex === '#000000' && img.chromakeyMask;
      });
    });
  }, { timeout: 5000 }).toBe(true);
});

// --- (batch) badge -------------------------------------------------------

test('batch badge appears on thumbnails after Apply to all', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 3);

  await page.evaluate(() => {
    document.querySelector('.batch-rotate-section').open = true;
  });
  await page.locator('.batch-rotate-right').click();

  // All thumbs should show the batch badge.
  await expect(page.locator('#queue-view .queue-thumb-batch-badge')).toHaveCount(3);
});

test('batch badge clears when user edits the image in the editor', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);

  await page.evaluate(() => {
    document.querySelector('.batch-rotate-section').open = true;
  });
  await page.locator('.batch-rotate-right').click();

  await expect(page.locator('#queue-view .queue-thumb-batch-badge')).toHaveCount(2);

  // Now open the first image in the editor and make a per-image edit.
  const firstId = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  });

  // Simulate a per-image edit via state.update — same call path as the editor.
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    const { applyAdjust } = await import('/js/ops/adjust.js');
    update(s => { applyAdjust(s.images[id], 'brightness', 30); });
  }, firstId);

  // First thumb's badge should have cleared, second's should remain.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return !!getState().images[id]._isBatch;
    }, firstId);
  }, { timeout: 1500 }).toBe(false);
  await expect(page.locator('#queue-view .queue-thumb-batch-badge')).toHaveCount(1);
});
