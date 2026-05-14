import { test, expect } from '@playwright/test';

// Reset the in-page state between tests so each test starts clean.
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
    // Clear any leftover dialogs/toasts from prior tests.
    document.querySelectorAll('dialog.oversize-dialog').forEach(d => d.remove());
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

// Make a real image Blob inside the page (so the actual decoder runs).
async function makeImageBlob(page, width, height, color = '#1188cc', type = 'image/png') {
  return await page.evaluate(async ({ width, height, color, type }) => {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    const blob = await new Promise(r => c.toBlob(r, type, 0.92));
    // Store on window so other evaluates can use the same data.
    window.__lastBlob = blob;
    return { size: blob.size, type: blob.type };
  }, { width, height, color, type });
}

// Drop a list of files (built inside the page) onto document.body.
async function dropFilesIntoPage(page, files) {
  await page.evaluate(async (specs) => {
    const dt = new DataTransfer();
    for (const spec of specs) {
      const c = document.createElement('canvas');
      c.width = spec.width; c.height = spec.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = spec.color;
      ctx.fillRect(0, 0, spec.width, spec.height);
      const blob = await new Promise(r => c.toBlob(r, spec.type, 0.92));
      const file = new File([blob], spec.name, { type: spec.type });
      dt.items.add(file);
    }
    document.body.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    }));
  }, files);
}

test('drop a small PNG → thumbnail appears in state.queue with Blob source.thumbnail', async ({ page }) => {
  await resetApp(page);
  await dropFilesIntoPage(page, [
    { name: 'a.png', type: 'image/png', width: 8, height: 8, color: '#1188cc' },
  ]);

  // Wait for the image to be added.
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      return getState().queue.length;
    });
  }, { timeout: 5000 }).toBe(1);

  const result = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    const id = s.queue[0];
    const img = s.images[id];
    return {
      hasImg: !!img,
      thumbIsBlob: img.source.thumbnail instanceof Blob,
      thumbType: img.source.thumbnail?.type,
      width: img.source.width,
      height: img.source.height,
      name: img.source.name,
      bitmap: img.source.bitmap !== null,
    };
  });
  expect(result.hasImg).toBe(true);
  expect(result.thumbIsBlob).toBe(true);
  expect(result.thumbType).toBe('image/jpeg');
  expect(result.width).toBe(8);
  expect(result.height).toBe(8);
  expect(result.name).toBe('a.png');
});

test('paste a PNG → image added to queue', async ({ page }) => {
  await resetApp(page);

  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    c.getContext('2d').fillRect(0, 0, 16, 16);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.92));
    const file = new File([blob], 'pasted.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    // Firefox ignores `clipboardData` in the ClipboardEvent constructor, so
    // construct then forcibly attach the DataTransfer for cross-browser parity.
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    try {
      Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true });
    } catch { /* already settable in some engines */ }
    document.dispatchEvent(ev);
  });

  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      return getState().queue.length;
    });
  }, { timeout: 5000 }).toBe(1);
});

test('drop two images → both appear in queue', async ({ page }) => {
  await resetApp(page);
  await dropFilesIntoPage(page, [
    { name: 'a.png', type: 'image/png', width: 8, height: 8, color: '#cc1188' },
    { name: 'b.png', type: 'image/png', width: 16, height: 16, color: '#88cc11' },
  ]);

  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      return getState().queue.length;
    });
  }, { timeout: 5000 }).toBe(2);

  const names = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return s.queue.map(id => s.images[id].source.name);
  });
  expect(names).toEqual(['a.png', 'b.png']);
});

test('drop a .txt file → rejected with error toast, no image added', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const txtBlob = new Blob(['hello world'], { type: 'text/plain' });
    const file = new File([txtBlob], 'note.txt', { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.body.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    }));
  });

  // Toast should appear.
  await expect(page.locator('#toast-root .toast-error')).toHaveCount(1, { timeout: 3000 });
  const queueLen = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.length;
  });
  expect(queueLen).toBe(0);
});

test('drop oversized image → modal appears; Downscale → image added with reduced dimensions', async ({ page }) => {
  await resetApp(page);

  // Make caps.maxCanvasSize small so we can simulate oversize without a giant canvas.
  // We do this by drag-dropping a 400×300 image but spoofing caps.maxCanvasSize=200
  // via wiring our own initImporter call on a fresh setup. Simpler: directly call
  // the importer with a custom caps.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#abcdef';
    ctx.fillRect(0, 0, 400, 300);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.92));
    const file = new File([blob], 'big.png', { type: 'image/png' });

    const importer = await import('/js/importer.js');
    const fakeCaps = { maxCanvasSize: 200, webp: true };
    const fakeLifecycle = { setWindow: async () => {} };
    // Fire importFiles WITHOUT awaiting so the dialog is open for inspection.
    window.__importPromise = importer.importFiles([file], fakeCaps, fakeLifecycle);
  });

  // Dialog should appear.
  const dialog = page.locator('dialog.oversize-dialog');
  await expect(dialog).toBeVisible({ timeout: 3000 });
  await expect(dialog).toContainText('Image too large');
  await expect(dialog).toContainText('big.png');
  await expect(dialog).toContainText('400×300');

  // Click Downscale.
  await dialog.locator('.oversize-downscale').click();

  await page.evaluate(() => window.__importPromise);

  const dims = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    const id = s.queue[0];
    if (!id) return null;
    const img = s.images[id];
    return { width: img.source.width, height: img.source.height };
  });
  expect(dims).not.toBeNull();
  expect(dims.width).toBeLessThanOrEqual(200);
  expect(dims.height).toBeLessThanOrEqual(200);
  // The long side should equal maxCanvasSize (or very close to it).
  expect(Math.max(dims.width, dims.height)).toBe(200);
});

test('drop oversized image → Skip leaves queue empty', async ({ page }) => {
  await resetApp(page);

  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    c.getContext('2d').fillRect(0, 0, 400, 300);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.92));
    const file = new File([blob], 'big2.png', { type: 'image/png' });

    const importer = await import('/js/importer.js');
    const fakeCaps = { maxCanvasSize: 200, webp: true };
    const fakeLifecycle = { setWindow: async () => {} };
    window.__importPromise = importer.importFiles([file], fakeCaps, fakeLifecycle);
  });

  const dialog = page.locator('dialog.oversize-dialog');
  await expect(dialog).toBeVisible({ timeout: 3000 });
  await dialog.locator('.oversize-skip').click();

  await page.evaluate(() => window.__importPromise);

  const queueLen = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.length;
  });
  expect(queueLen).toBe(0);
});

test('generated thumbnail is JPEG ≤ 200px long side', async ({ page }) => {
  await resetApp(page);
  await dropFilesIntoPage(page, [
    { name: 'tall.png', type: 'image/png', width: 600, height: 400, color: '#552288' },
  ]);

  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      return getState().queue.length;
    });
  }, { timeout: 5000 }).toBe(1);

  const info = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const id = getState().queue[0];
    const blob = getState().images[id].source.thumbnail;
    const bm = await createImageBitmap(blob);
    return { type: blob.type, w: bm.width, h: bm.height };
  });
  expect(info.type).toBe('image/jpeg');
  expect(Math.max(info.w, info.h)).toBeLessThanOrEqual(200);
  // Long side should equal 200 (since source long side 600 > 200).
  expect(Math.max(info.w, info.h)).toBe(200);
});
