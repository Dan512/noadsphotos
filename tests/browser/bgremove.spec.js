// tests/browser/bgremove.spec.js — Phase 11 end-to-end coverage.
//
// The real @imgly model is far too slow + heavy to run in CI, so every test
// here uses the `_setImplForTest` escape hatch to swap in a fake
// `removeBackground` that returns a predictable PNG (a 32x32 image with a
// solid-colored centre on a different background). The fake is registered
// inline via page.evaluate so it runs in the same realm as the editor.

import { test, expect } from '@playwright/test';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

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
      s.ui.activeTool = 'select';
      s.ui.selectedOverlayId = null;
      s.ui.zoom = 'fit';
    });
    // Wipe any prior consent so the modal flow is exercised.
    const { _resetForTest } = await import('/js/ops/bgremove.js');
    _resetForTest();
    // Clear any leftover dialogs from prior tests.
    document.querySelectorAll('dialog').forEach(d => { try { d.close(); } catch { /* ignore */ } d.remove(); });
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

// Install a fake bg-removal impl that returns a raw RGBA Blob (image/x-rgba8)
// whose alpha is full where r > 128 and 0 elsewhere — i.e. an alpha mask is
// derived from the red channel of the source. With a synthetic source where
// the centre is red on a black background, the resulting mask isolates the
// centre. The fake matches the shape of what the real @imgly bundle returns
// when configured with `output.format: 'image/x-rgba8'`: a Blob whose bytes
// are the raw RGBA tensor at source dimensions and whose MIME encodes the
// dimensions in its parameters.
async function installFakeImpl(page) {
  await page.evaluate(async () => {
    const { _setImplForTest } = await import('/js/ops/bgremove.js');
    _setImplForTest({
      removeBackground: async (blob, _config) => {
        // Decode the source so the fake mask size matches.
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
        // Make alpha 255 where R > 128, else 0. The synthetic image has
        // a red centre on black, so the centre becomes opaque, edges
        // transparent — a stand-in mask.
        for (let i = 0; i < px.length; i += 4) {
          px[i + 3] = px[i] > 128 ? 255 : 0;
        }
        try { bitmap.close(); } catch { /* ignore */ }
        // Return a raw RGBA blob, matching what @imgly returns for x-rgba8.
        return new Blob([new Uint8Array(px.buffer, px.byteOffset, px.byteLength)], {
          type: `image/x-rgba8;width=${w};height=${h}`,
        });
      },
    });
  });
}

// Import a synthetic image with a red square at the centre on a black
// background. Returns the assigned imageId.
async function importTestImage(page, name = 'subject.png', w = 32, h = 32) {
  return await page.evaluate(async ({ name, w, h }) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], name, { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { name, w, h });
}

async function importNTestImages(page, count) {
  const names = Array.from({ length: count }, (_, i) => `img-${i + 1}.png`);
  for (const n of names) await importTestImage(page, n);
  return await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.slice();
  });
}

async function openEditorForImage(page, id) {
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
}

async function activateBgRemoveTool(page) {
  await page.locator('#editor-view .editor-toolbar button[data-tool="bg-remove"]').click();
  await expect(page.locator('#panel-tool .bg-remove-panel')).toBeVisible();
}

// --------------------------------------------------------------------------
// Tests — editor flow
// --------------------------------------------------------------------------

test('bg-remove tool: panel shows Apply button and explanatory copy', async ({ page }) => {
  await resetApp(page);
  await installFakeImpl(page);
  const id = await importTestImage(page);
  await openEditorForImage(page, id);
  await activateBgRemoveTool(page);

  await expect(page.locator('#panel-tool .bg-remove-help')).toBeVisible();
  await expect(page.locator('#panel-tool .bg-remove-apply')).toBeVisible();
  await expect(page.locator('#panel-tool .bg-remove-apply')).toHaveText(/Apply/);
});

test('bg-remove: first click shows consent modal; clicking Continue persists consent', async ({ page }) => {
  await resetApp(page);
  await installFakeImpl(page);
  const id = await importTestImage(page);
  await openEditorForImage(page, id);
  await activateBgRemoveTool(page);

  // No stored consent yet.
  const before = await page.evaluate(async () => {
    const { hasStoredConsent } = await import('/js/ops/bgremove.js');
    return hasStoredConsent();
  });
  expect(before).toBe(false);

  await page.locator('#panel-tool .bg-remove-apply').click();

  // Modal appears.
  await expect(page.locator('dialog.bgremove-consent-dialog')).toBeVisible();
  await page.locator('dialog.bgremove-consent-dialog .bgremove-consent-continue').click();

  // Modal closes immediately after Continue.
  await expect(page.locator('dialog.bgremove-consent-dialog')).toHaveCount(0);

  // The fake removeBackground runs async — wait for the mask to land.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      const img = getState().images[id];
      return !!(img && img.bgRemoved);
    }, id);
  }, { timeout: 5000 }).toBe(true);

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const { hasStoredConsent } = await import('/js/ops/bgremove.js');
    const img = getState().images[id];
    return {
      consent:   hasStoredConsent(),
      bgRemoved: !!(img && img.bgRemoved),
      maskLen:   img && img.bgMask ? img.bgMask.length : 0,
      maskType:  img && img.bgMask ? img.bgMask.constructor.name : null,
    };
  }, id);
  expect(after.consent).toBe(true);
  expect(after.bgRemoved).toBe(true);
  expect(after.maskType).toBe('Uint8Array');
  expect(after.maskLen).toBe(32 * 32);

  // Toast surfaces success.
  await expect(page.locator('#toast-root .toast').first()).toContainText('Background removed');
});

test('bg-remove: clicking Cancel in modal does NOT persist consent and leaves state unchanged', async ({ page }) => {
  await resetApp(page);
  await installFakeImpl(page);
  const id = await importTestImage(page);
  await openEditorForImage(page, id);
  await activateBgRemoveTool(page);

  await page.locator('#panel-tool .bg-remove-apply').click();
  await expect(page.locator('dialog.bgremove-consent-dialog')).toBeVisible();
  await page.locator('dialog.bgremove-consent-dialog .bgremove-consent-cancel').click();
  await expect(page.locator('dialog.bgremove-consent-dialog')).toHaveCount(0);

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const { hasStoredConsent } = await import('/js/ops/bgremove.js');
    const img = getState().images[id];
    return {
      consent:   hasStoredConsent(),
      bgRemoved: !!(img && img.bgRemoved),
      maskLen:   img && img.bgMask ? img.bgMask.length : 0,
    };
  }, id);
  expect(after.consent).toBe(false);
  expect(after.bgRemoved).toBe(false);
  expect(after.maskLen).toBe(0);
});

test('bg-remove: consent persists — second click does NOT re-prompt', async ({ page }) => {
  await resetApp(page);
  await installFakeImpl(page);
  const id = await importTestImage(page);
  await openEditorForImage(page, id);
  await activateBgRemoveTool(page);

  // Seed consent so we go straight to processing without a modal.
  await page.evaluate(async () => {
    const { CONSENT_KEY, MODEL_HASH } = await import('/js/ops/bgremove.js');
    localStorage.setItem(CONSENT_KEY, MODEL_HASH);
  });

  await page.locator('#panel-tool .bg-remove-apply').click();
  // The modal should never appear.
  await expect(page.locator('dialog.bgremove-consent-dialog')).toHaveCount(0);

  // Wait for the mask to land.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      const img = getState().images[id];
      return !!(img && img.bgRemoved);
    }, id);
  }, { timeout: 4000 }).toBe(true);

  // Button text reflects the "already removed" state.
  await expect(page.locator('#panel-tool .bg-remove-apply')).toHaveText(/Run again/);
});

test('bg-remove: stored consent for a DIFFERENT hash → modal re-prompts', async ({ page }) => {
  await resetApp(page);
  await installFakeImpl(page);
  const id = await importTestImage(page);
  await openEditorForImage(page, id);
  await activateBgRemoveTool(page);

  // Seed consent with a STALE hash.
  await page.evaluate(async () => {
    const { CONSENT_KEY } = await import('/js/ops/bgremove.js');
    localStorage.setItem(CONSENT_KEY, 'stale-model-hash-v0');
  });

  await page.locator('#panel-tool .bg-remove-apply').click();
  // Modal SHOULD appear because the stored hash doesn't match.
  await expect(page.locator('dialog.bgremove-consent-dialog')).toBeVisible();
});

test('bg-remove: undo restores the pre-bgmask state', async ({ page }) => {
  await resetApp(page);
  await installFakeImpl(page);
  const id = await importTestImage(page);
  await openEditorForImage(page, id);
  await activateBgRemoveTool(page);

  // Pre-seed consent so we skip the modal.
  await page.evaluate(async () => {
    const { CONSENT_KEY, MODEL_HASH } = await import('/js/ops/bgremove.js');
    localStorage.setItem(CONSENT_KEY, MODEL_HASH);
  });

  await page.locator('#panel-tool .bg-remove-apply').click();
  // Wait for the mask to land.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return !!(getState().images[id] && getState().images[id].bgRemoved);
    }, id);
  }, { timeout: 4000 }).toBe(true);

  // Undo.
  const undid = await page.evaluate(async () => {
    const { undo } = await import('/js/history.js');
    return undo();
  });
  expect(undid).toBe(true);

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    return { bgRemoved: !!(img && img.bgRemoved), maskNull: img && img.bgMask == null };
  }, id);
  expect(after.bgRemoved).toBe(false);
  expect(after.maskNull).toBe(true);
});

// --------------------------------------------------------------------------
// Tests — batch flow
// --------------------------------------------------------------------------

test('batch bg-remove: queue panel shows enabled Run button (not "v1.1 placeholder")', async ({ page }) => {
  await resetApp(page);
  await importTestImage(page); // need at least one to render the panel
  // Make sure we're back on the queue view (importTestImage doesn't switch).
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.ui.view = 'queue'; });
  });
  // The bg section is a <details> that starts closed — expand it so the
  // button is visible.
  await page.locator('.batch-bg-section').evaluate(d => d.open = true);
  await expect(page.locator('.batch-bg-apply')).toBeVisible();
  await expect(page.locator('.batch-bg-apply')).toBeEnabled();
  await expect(page.locator('.batch-bg-apply')).toHaveText(/Run on all queue images/);
});

test('batch bg-remove: 3 images → all get bgMask populated after Continue', async ({ page }) => {
  await resetApp(page);
  await installFakeImpl(page);
  const ids = await importNTestImages(page, 3);
  expect(ids.length).toBe(3);

  // Make sure we're on the queue view.
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.ui.view = 'queue'; });
  });

  // Pre-seed consent so we skip the modal.
  await page.evaluate(async () => {
    const { CONSENT_KEY, MODEL_HASH } = await import('/js/ops/bgremove.js');
    localStorage.setItem(CONSENT_KEY, MODEL_HASH);
  });

  // Open the batch panel section so the button is in view (the <details>
  // wrapper is closed by default).
  await page.locator('.batch-bg-section').evaluate(d => d.open = true);
  await page.locator('.batch-bg-apply').click();

  // The batch progress modal opens, processes 3 trivial fakes, and closes,
  // all of which can complete in a single rAF tick on a fast machine.
  // Rather than racing the dialog's visibility, just wait for the dialog
  // to disappear and confirm the side-effects landed.
  await expect(page.locator('dialog.bgremove-progress-dialog')).toHaveCount(0, { timeout: 6000 });

  // All three images now have bgMask.
  const state = await page.evaluate(async (ids) => {
    const { getState } = await import('/js/state.js');
    const out = [];
    for (const id of ids) {
      const img = getState().images[id];
      out.push({ id, bgRemoved: !!(img && img.bgRemoved), maskLen: img && img.bgMask ? img.bgMask.length : 0 });
    }
    return out;
  }, ids);
  for (const entry of state) {
    expect(entry.bgRemoved).toBe(true);
    expect(entry.maskLen).toBeGreaterThan(0);
  }
});

test('batch bg-remove: empty queue does NOT crash and the button is hidden when queue empty', async ({ page }) => {
  await resetApp(page);
  // No images imported. The whole batch panel is hidden in this case.
  await expect(page.locator('.batch-bg-apply')).toHaveCount(0);
});

// --------------------------------------------------------------------------
// Tests — module load discipline
// --------------------------------------------------------------------------

test('bg-remove: vendored bundle is NOT loaded on initial page visit (lazy import discipline)', async ({ page }) => {
  await resetApp(page);
  // Capture network requests so we can assert no /js/vendor/bgremove/index.mjs
  // fetch fires before user interaction.
  const bgRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/js/vendor/bgremove/')) bgRequests.push(url);
  });
  // Idle for a moment so any straggling boot fetches settle.
  await page.waitForLoadState('networkidle');
  expect(bgRequests).toEqual([]);
});

test('bg-remove: importing js/ops/bgremove.js does NOT pull the vendored bundle', async ({ page }) => {
  await resetApp(page);
  // Now grab the bg-remove module from ops/ — this should NOT pull
  // the vendored bundle because the vendor import is wrapped in a dynamic
  // import() call inside loadImpl, which we don't trigger.
  const bgRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/js/vendor/bgremove/')) bgRequests.push(url);
  });
  await page.evaluate(async () => {
    await import('/js/ops/bgremove.js');
  });
  await page.waitForTimeout(100); // settle
  expect(bgRequests).toEqual([]);
});
