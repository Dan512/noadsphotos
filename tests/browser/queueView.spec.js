import { test, expect } from '@playwright/test';

async function resetApp(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  await page.evaluate(async () => {
    const { getState, update } = await import('/js/state.js');
    update(s => {
      s.queue = [];
      s.images = Object.create(null);
      s.ui.activeImageId = null;
      s.ui.view = 'queue';
    });
    document.querySelectorAll('dialog.oversize-dialog').forEach(d => d.remove());
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

// Import N images programmatically (bypass drop, hit the function directly).
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
      c.width = 32; c.height = 32;
      const ctx = c.getContext('2d');
      ctx.fillStyle = `hsl(${i * 60}, 70%, 50%)`;
      ctx.fillRect(0, 0, 32, 32);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.92));
      files.push(new File([blob], `img-${i}.png`, { type: 'image/png' }));
    }
    await importFiles(files, caps, lifecycle);
  }, count);
}

test('initial state shows the empty drop zone', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#queue-view .queue-empty')).toBeVisible();
  await expect(page.locator('#queue-view .queue-grid')).toHaveCount(0);
  await expect(page.locator('#queue-view .queue-empty')).toContainText('Drag images here');
});

test('after importing N images, N thumbnails appear in the grid', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 3);
  await expect(page.locator('#queue-view .queue-grid .queue-thumb')).toHaveCount(3);
  await expect(page.locator('#queue-view .queue-empty')).toHaveCount(0);
});

test('clicking a thumbnail sets activeImageId and switches view to editor', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);
  await expect(page.locator('#queue-view .queue-thumb')).toHaveCount(2);

  // Capture first image id.
  const targetId = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${targetId}"]`).click();

  const result = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return { active: s.ui.activeImageId, view: s.ui.view };
  });
  expect(result.active).toBe(targetId);
  expect(result.view).toBe('editor');
});

test('clicking the × button removes the image (and stops propagation)', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 2);
  await expect(page.locator('#queue-view .queue-thumb')).toHaveCount(2);

  const before = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.slice();
  });
  const removeId = before[0];

  // The remove × is hidden until hover; click via JS to bypass hover requirement.
  await page.evaluate((id) => {
    const thumb = document.querySelector(`#queue-view .queue-thumb[data-image-id="${id}"]`);
    const rm = thumb.querySelector('.queue-thumb-remove');
    rm.click();
  }, removeId);

  await expect(page.locator('#queue-view .queue-thumb')).toHaveCount(1);
  const result = await page.evaluate(async ({ id }) => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return { queueLen: s.queue.length, hasImage: id in s.images, view: s.ui.view };
  }, { id: removeId });
  expect(result.queueLen).toBe(1);
  expect(result.hasImage).toBe(false);
  // View should NOT have switched to editor (stopPropagation worked).
  expect(result.view).toBe('queue');
});

test('the currently active image has .is-active class; switching updates it', async ({ page }) => {
  await resetApp(page);
  await importImages(page, 3);
  await expect(page.locator('#queue-view .queue-thumb')).toHaveCount(3);

  const ids = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.slice();
  });

  // Set first active manually.
  await page.evaluate(async (id) => {
    const { setActive } = await import('/js/queue.js');
    setActive(id);
  }, ids[0]);

  await expect(page.locator(`#queue-view .queue-thumb[data-image-id="${ids[0]}"]`)).toHaveClass(/is-active/);
  await expect(page.locator(`#queue-view .queue-thumb[data-image-id="${ids[1]}"]`)).not.toHaveClass(/is-active/);

  // Switch to second.
  await page.evaluate(async (id) => {
    const { setActive } = await import('/js/queue.js');
    setActive(id);
  }, ids[1]);

  await expect(page.locator(`#queue-view .queue-thumb[data-image-id="${ids[0]}"]`)).not.toHaveClass(/is-active/);
  await expect(page.locator(`#queue-view .queue-thumb[data-image-id="${ids[1]}"]`)).toHaveClass(/is-active/);
});

test('empty state browse link dispatches noadsimages:openFileBrowser', async ({ page }) => {
  await resetApp(page);
  const fired = await page.evaluate(async () => {
    return new Promise(resolve => {
      document.addEventListener('noadsimages:openFileBrowser', () => resolve(true), { once: true });
      document.querySelector('#queue-view .queue-empty .queue-browse').click();
      setTimeout(() => resolve(false), 1000);
    });
  });
  expect(fired).toBe(true);
});
