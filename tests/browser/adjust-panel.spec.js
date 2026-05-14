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
      s.ui.activeTool = 'select';
      s.ui.zoom = 'fit';
    });
  });
}

async function setupEditorWithImage(page, w = 400, h = 200) {
  const id = await page.evaluate(async ({ w, h }) => {
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
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'gray.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h });

  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  // Wait for the base canvas to be sized so previewRenderer is alive.
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
  return id;
}

// --------------------------------------------------------------------------
// Structural tests — panel populated with the right controls.
// --------------------------------------------------------------------------

test('adjust panel: section contains 4 sliders + preset select + reset all', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  await expect(page.locator('#panel-adjust .adjust-slider.adjust-brightness')).toHaveCount(1);
  await expect(page.locator('#panel-adjust .adjust-slider.adjust-contrast')).toHaveCount(1);
  await expect(page.locator('#panel-adjust .adjust-slider.adjust-saturation')).toHaveCount(1);
  await expect(page.locator('#panel-adjust .adjust-slider.adjust-blur')).toHaveCount(1);
  await expect(page.locator('#panel-adjust .adjust-preset')).toHaveCount(1);
  await expect(page.locator('#panel-adjust .adjust-reset-all')).toHaveCount(1);
});

test('adjust panel: filter preset select offers None/Grayscale/Sepia/Invert', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  const opts = await page.locator('#panel-adjust .adjust-preset option').evaluateAll(els =>
    els.map(o => o.value),
  );
  expect(opts).toEqual(['none', 'grayscale', 'sepia', 'invert']);
});

test('adjust panel: brightness slider has range [-100, 100], blur has [0, 50]', async ({ page }) => {
  await resetApp(page);
  await setupEditorWithImage(page);

  const ranges = await page.evaluate(() => {
    const b = document.querySelector('#panel-adjust .adjust-brightness');
    const blur = document.querySelector('#panel-adjust .adjust-blur');
    return {
      brightnessMin: b.min, brightnessMax: b.max,
      blurMin: blur.min, blurMax: blur.max,
    };
  });
  expect(ranges.brightnessMin).toBe('-100');
  expect(ranges.brightnessMax).toBe('100');
  expect(ranges.blurMin).toBe('0');
  expect(ranges.blurMax).toBe('50');
});

// --------------------------------------------------------------------------
// Interaction tests — slider changes propagate to state + canvas filter.
// --------------------------------------------------------------------------

test('adjust panel: dragging Brightness updates state.adjust.brightness AND base-canvas filter', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.evaluate(() => {
    const input = document.querySelector('#panel-adjust .adjust-brightness');
    input.value = '50';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // State updates after the next rAF (debounced).
  await expect.poll(async () => {
    return await page.evaluate((id) => {
      const { getState } = window;
      return null;
    }, id).catch(() => null) ?? await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return getState().images[id].adjust.brightness;
    }, id);
  }, { timeout: 1500 }).toBe(50);

  // Canvas filter string includes "brightness(...)".
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas').style.filter);
  }, { timeout: 1500 }).toMatch(/brightness\(/);
});

test('adjust panel: filter preset → Grayscale sets state + canvas filter contains grayscale(1)', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.locator('#panel-adjust .adjust-preset').selectOption('grayscale');

  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return getState().images[id].filterPreset;
    }, id);
  }, { timeout: 1500 }).toBe('grayscale');

  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas').style.filter);
  }, { timeout: 1500 }).toContain('grayscale(1)');
});

test('adjust panel: changing blur from 0 to 10 puts blur(...) into canvas filter', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.evaluate(() => {
    const input = document.querySelector('#panel-adjust .adjust-blur');
    input.value = '10';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // State updates.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return getState().images[id].adjust.blur;
    }, id);
  }, { timeout: 1500 }).toBe(10);

  // Canvas filter includes blur(...). Exact px depends on display scaling.
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas').style.filter);
  }, { timeout: 1500 }).toMatch(/blur\([\d.]+px\)/);
});

test('adjust panel: Reset all zeroes everything and clears the canvas filter', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // Set some values first.
  await page.evaluate(() => {
    const set = (sel, v) => {
      const input = document.querySelector(sel);
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#panel-adjust .adjust-brightness', '40');
    set('#panel-adjust .adjust-contrast', '-20');
    set('#panel-adjust .adjust-blur', '5');
  });
  await page.locator('#panel-adjust .adjust-preset').selectOption('sepia');

  // Wait for the rAF flush to land in state.
  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      const img = getState().images[id];
      return img.adjust.brightness !== 0 && img.filterPreset === 'sepia';
    }, id);
  }, { timeout: 1500 }).toBe(true);

  // Reset.
  await page.locator('#panel-adjust .adjust-reset-all').click();

  const after = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    const img = getState().images[id];
    return { adjust: { ...img.adjust }, preset: img.filterPreset };
  }, id);
  expect(after.adjust.brightness).toBe(0);
  expect(after.adjust.contrast).toBe(0);
  expect(after.adjust.saturation).toBe(0);
  expect(after.adjust.blur).toBe(0);
  expect(after.preset).toBe('none');

  // After reset, the next rAF should set the canvas filter back to "none".
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas').style.filter);
  }, { timeout: 1500 }).toBe('none');
});

test('adjust panel: per-slider Reset button zeroes only that slider', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  await page.evaluate(() => {
    const set = (sel, v) => {
      const input = document.querySelector(sel);
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#panel-adjust .adjust-brightness', '40');
    set('#panel-adjust .adjust-contrast', '-30');
  });

  await expect.poll(async () => {
    return await page.evaluate(async (id) => {
      const { getState } = await import('/js/state.js');
      return getState().images[id].adjust.brightness;
    }, id);
  }, { timeout: 1500 }).toBe(40);

  await page.locator('#panel-adjust .adjust-brightness-reset').click();

  const adjustAfter = await page.evaluate(async (id) => {
    const { getState } = await import('/js/state.js');
    return { ...getState().images[id].adjust };
  }, id);
  expect(adjustAfter.brightness).toBe(0);
  expect(adjustAfter.contrast).toBe(-30);
});

// --------------------------------------------------------------------------
// Renderer-side test: applies CSS filter every frame an image is active.
// --------------------------------------------------------------------------

test('preview renderer: applies cssFilter to base-canvas even without baseDirty', async ({ page }) => {
  await resetApp(page);
  const id = await setupEditorWithImage(page);

  // Programmatically set adjust.brightness without going through the slider.
  // baseDirty is intentionally NOT flipped — the filter should still apply.
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    update(s => {
      s.images[id].adjust.brightness = 30;
      // Make sure baseDirty stays false (the preview tick has likely set it
      // back to false during initial render; we still re-clear it to be safe).
      s.images[id].baseDirty = false;
    });
  }, id);

  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas').style.filter);
  }, { timeout: 1500 }).toMatch(/brightness\(1\.3\)/);
});
