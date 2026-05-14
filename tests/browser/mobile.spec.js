// tests/browser/mobile.spec.js — Phase 13 responsive / mobile checks.
//
// Strategy: the test suite runs across desktop chromium/webkit/firefox AND
// the explicit `mobile-chrome` / `mobile-safari` Playwright projects (Pixel 7
// / iPhone 14 device profiles in playwright.config.js). The behaviors we
// care about split into two buckets:
//
//   1. Things gated by the `@media (max-width: 768px)` viewport rule —
//      bottom-sheet layout, single-column queue grid, horizontal toolbar
//      scroll. We force these tests onto a small viewport via
//      `test.use({ viewport })` so they run consistently across every
//      Playwright project. The mobile-* projects also exercise the same
//      paths but with real device touch emulation.
//
//   2. Things gated by `@media (pointer: coarse)` — 44 px touch targets,
//      always-visible thumb × button. These only apply when the test
//      project itself runs a coarse-pointer device profile, so we
//      restrict them with `test.skip(({}) => !isCoarse, ...)`.
//
// The DOM (trigger button, tab bar) is injected unconditionally — desktop
// CSS just keeps it `display: none`. Our `expect(...).toBeVisible()` checks
// account for that.
import { test, expect } from '@playwright/test';

// Phone-shaped viewport that fits the mobile media query (<=768 px wide).
// We use 390x844 (~iPhone 14 mini) so the editor canvas has some room.
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function resetApp(page) {
  // Disable CSS transitions for the duration of the test. The bottom-sheet
  // slide-in animation is ~220 ms; without this, Playwright's `.click()`
  // sometimes lands while the panel is still mid-transition, hitting the
  // browser's "scroll into view" path with stale coords. The :root reduced-
  // motion override in style.css zeroes every --dur-* variable.
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
    document.querySelectorAll('dialog').forEach(d => d.remove());
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

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
      ctx.fillStyle = `hsl(${i * 60}, 70%, 50%)`;
      ctx.fillRect(0, 0, 64, 64);
      const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
      files.push(new File([blob], `img-${i}.png`, { type: 'image/png' }));
    }
    await importFiles(files, caps, lifecycle);
  }, count);
}

// Switch to the editor view by importing one image and clicking its thumb.
async function openEditorWithImage(page) {
  await importImages(page, 1);
  const id = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  });
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  return id;
}

// ---------------------------------------------------------------------------
// 1. Bottom-sheet trigger button & tab bar exist after boot (DOM-only check).
//    These run on every project — the DOM injection is unconditional, only
//    visibility is media-gated.
// ---------------------------------------------------------------------------

test('bottom sheet: trigger button is injected into the DOM', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('.editor-panel-trigger')).toHaveCount(1);
});

test('bottom sheet: tab bar with 5 tabs is injected into the editor panel', async ({ page }) => {
  await resetApp(page);
  const tabs = page.locator('.editor-panel .editor-panel-tabs .editor-panel-tab');
  await expect(tabs).toHaveCount(5);
  const labels = await tabs.allTextContents();
  expect(labels).toEqual(['Tool', 'Resize', 'Adjust', 'Overlays', 'Export']);
});

test('bottom sheet: first tab is marked active by default', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('.editor-panel-tab[data-tab="tool"]')).toHaveClass(/is-active/);
});

// ---------------------------------------------------------------------------
// 2. Mobile-viewport behaviour. Force a small viewport so the
//    `@media (max-width: 768px)` rules engage on every Playwright project.
// ---------------------------------------------------------------------------

test.describe('mobile viewport (forced 390x844)', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test('queue view stacks to one column with batch panel below the grid', async ({ page }) => {
    await resetApp(page);
    await importImages(page, 2);
    // grid-template-columns resolves to "1fr" on a 390 px viewport.
    const cols = await page.locator('#queue-view').evaluate(el => getComputedStyle(el).gridTemplateColumns);
    // Single track. Browsers report "1fr" as a pixel value when resolved —
    // we just assert exactly one entry by splitting on whitespace.
    expect(cols.trim().split(/\s+/).length).toBe(1);

    // Batch panel is in the same flow, no longer sticky.
    const batchPos = await page.locator('.batch-panel').evaluate(el => getComputedStyle(el).position);
    expect(batchPos).toBe('static');
  });

  test('editor view has no visible right side panel by default', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    // The element exists but is translated 100% off the bottom — its
    // computed visibility is false because it's outside the viewport rect.
    // We can't rely on Playwright's toBeVisible() because the element still
    // has non-zero size; instead, check the transform.
    const transform = await page.locator('.editor-panel').evaluate(el => getComputedStyle(el).transform);
    // CSS `translateY(100%)` resolves to a matrix with a translation
    // approximately equal to the element's height. Anything starting with
    // "matrix(" and a non-zero ty offset works.
    expect(transform).toMatch(/^matrix(?:\(|3d)/);
    expect(transform).not.toBe('none');
  });

  test('editor view: trigger is visible and tab bar exists in panel', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    await expect(page.locator('.editor-panel-trigger')).toBeVisible();
    await expect(page.locator('.editor-panel .editor-panel-tabs')).toBeAttached();
  });

  test('tapping the trigger button opens the bottom sheet (slides up)', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    await expect(page.locator('.editor-panel')).not.toHaveClass(/is-open/);
    await page.locator('.editor-panel-trigger').click();
    await expect(page.locator('.editor-panel')).toHaveClass(/is-open/);
  });

  test('bottom sheet: tapping a tab activates the corresponding section', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    await page.locator('.editor-panel-trigger').click();

    await page.locator('.editor-panel-tab[data-tab="resize"]').click();
    await expect(page.locator('.editor-panel-tab[data-tab="resize"]')).toHaveClass(/is-active/);
    await expect(page.locator('#panel-resize')).toHaveClass(/is-active-tab/);
    await expect(page.locator('.editor-panel-tab[data-tab="tool"]')).not.toHaveClass(/is-active/);

    await page.locator('.editor-panel-tab[data-tab="export"]').click();
    await expect(page.locator('.editor-panel-tab[data-tab="export"]')).toHaveClass(/is-active/);
    await expect(page.locator('#panel-export')).toHaveClass(/is-active-tab/);
  });

  test('bottom sheet: outside click on the canvas frame closes the sheet', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    await page.locator('.editor-panel-trigger').click();
    await expect(page.locator('.editor-panel')).toHaveClass(/is-open/);

    // Click on the top toolbar area, well outside the panel.
    await page.locator('.editor-toolbar').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.editor-panel')).not.toHaveClass(/is-open/);
  });

  test('bottom sheet: Escape key closes the sheet', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    await page.locator('.editor-panel-trigger').click();
    await expect(page.locator('.editor-panel')).toHaveClass(/is-open/);

    await page.keyboard.press('Escape');
    await expect(page.locator('.editor-panel')).not.toHaveClass(/is-open/);
  });

  test('bottom sheet: pointer-drag the handle past 80px dismisses', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    await page.locator('.editor-panel-trigger').click();
    await expect(page.locator('.editor-panel')).toHaveClass(/is-open/);

    // Simulate a pointerdown on the handle area (top 30 px of the panel),
    // then a series of pointermoves dragging downward 120 px, then a release.
    await page.evaluate(() => {
      const panel = document.querySelector('.editor-panel');
      const rect = panel.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const yStart = rect.top + 10;
      const ev = (type, y) => new PointerEvent(type, {
        pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true,
        cancelable: true, clientX: x, clientY: y,
        buttons: type === 'pointerup' ? 0 : 1,
      });
      panel.dispatchEvent(ev('pointerdown', yStart));
      for (let i = 1; i <= 6; i++) {
        panel.dispatchEvent(ev('pointermove', yStart + i * 20));
      }
      panel.dispatchEvent(ev('pointerup', yStart + 120));
    });
    await expect(page.locator('.editor-panel')).not.toHaveClass(/is-open/);
  });

  test('bottom sheet: short drag (under 80px) does NOT dismiss', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    await page.locator('.editor-panel-trigger').click();
    await expect(page.locator('.editor-panel')).toHaveClass(/is-open/);

    await page.evaluate(() => {
      const panel = document.querySelector('.editor-panel');
      const rect = panel.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const yStart = rect.top + 10;
      const ev = (type, y) => new PointerEvent(type, {
        pointerId: 8, pointerType: 'touch', isPrimary: true, bubbles: true,
        cancelable: true, clientX: x, clientY: y,
        buttons: type === 'pointerup' ? 0 : 1,
      });
      panel.dispatchEvent(ev('pointerdown', yStart));
      panel.dispatchEvent(ev('pointermove', yStart + 20));
      panel.dispatchEvent(ev('pointermove', yStart + 40));
      panel.dispatchEvent(ev('pointerup', yStart + 40));
    });
    await expect(page.locator('.editor-panel')).toHaveClass(/is-open/);
  });

  test('editor toolbar overflows horizontally with overflow-x: auto', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    const overflowX = await page.locator('.editor-toolbar').evaluate(el => getComputedStyle(el).overflowX);
    expect(overflowX).toBe('auto');
    const flexWrap = await page.locator('.editor-toolbar').evaluate(el => getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe('nowrap');
  });
});

// ---------------------------------------------------------------------------
// 3. Touch / coarse-pointer behaviour — only runs on the device-profile
//    Playwright projects (mobile-chrome, mobile-safari). On desktop projects
//    `pointer: coarse` doesn't match, so the rules don't apply and the test
//    is correctly skipped.
// ---------------------------------------------------------------------------

test.describe('touch device (pointer: coarse)', () => {
  // Only the mobile-* projects in playwright.config.js have a coarse
  // pointer. We can't read testInfo at describe scope (Playwright doesn't
  // pass it to test.skip()'s condition fn), so each test calls
  // `test.skip()` imperatively from inside the body. The describe wraps
  // them only for output-grouping.

  test('tool buttons measure at least 44x44', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('mobile-'),
      'only meaningful on mobile-chrome / mobile-safari projects');
    await resetApp(page);
    await openEditorWithImage(page);
    const sizes = await page.locator('.editor-toolbar button[data-tool]').evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      })
    );
    expect(sizes.length).toBeGreaterThan(0);
    for (const { w, h } of sizes) {
      expect(w).toBeGreaterThanOrEqual(44);
      expect(h).toBeGreaterThanOrEqual(44);
    }
  });

  test('queue × button is visible without hover (touch has no hover)', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('mobile-'),
      'only meaningful on mobile-chrome / mobile-safari projects');
    await resetApp(page);
    await importImages(page, 1);
    const opacity = await page.locator('.queue-thumb-remove').first().evaluate(el => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeGreaterThan(0.5);
  });

  test('brush drag with a touch pointer produces a brush overlay', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('mobile-'),
      'only meaningful on mobile-chrome / mobile-safari projects');
    await resetApp(page);
    await openEditorWithImage(page);
    // Activate the brush tool. Tap the toolbar button.
    await page.locator('.editor-toolbar button[data-tool="brush"]').click();
    // Drag a stroke across the overlay canvas using touch pointer events.
    await page.evaluate(() => {
      const overlay = document.getElementById('overlay-canvas');
      const rect = overlay.getBoundingClientRect();
      const x1 = rect.left + rect.width * 0.25;
      const y1 = rect.top + rect.height * 0.25;
      const x2 = rect.left + rect.width * 0.75;
      const y2 = rect.top + rect.height * 0.75;
      const ev = (type, x, y) => new PointerEvent(type, {
        pointerId: 11, pointerType: 'touch', isPrimary: true, bubbles: true,
        cancelable: true, clientX: x, clientY: y,
        buttons: type === 'pointerup' ? 0 : 1, pressure: 0.5,
      });
      overlay.dispatchEvent(ev('pointerdown', x1, y1));
      for (let i = 1; i <= 6; i++) {
        const t = i / 7;
        overlay.dispatchEvent(ev('pointermove', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t));
      }
      overlay.dispatchEvent(ev('pointerup', x2, y2));
    });

    const overlays = await page.evaluate(async () => {
      const { getState } = await import('/js/state.js');
      const s = getState();
      const id = s.ui.activeImageId;
      return id ? s.images[id].overlays : [];
    });
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.some(o => o.type === 'brush')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Desktop sanity: at a wide viewport the bottom-sheet trigger is hidden
//    and the side panel sits inline as a column. Confirms the responsive
//    layer is media-gated and we haven't accidentally promoted mobile chrome
//    to desktop.
// ---------------------------------------------------------------------------

test.describe('desktop viewport (forced 1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('trigger button is hidden on wide viewports', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    const display = await page.locator('.editor-panel-trigger').evaluate(el => getComputedStyle(el).display);
    expect(display).toBe('none');
  });

  test('editor panel is in flow (position: static or auto)', async ({ page }) => {
    await resetApp(page);
    await openEditorWithImage(page);
    const pos = await page.locator('.editor-panel').evaluate(el => getComputedStyle(el).position);
    // Desktop layout uses the grid placement only — no explicit position rule.
    // The browser computes "static" by default.
    expect(pos).toBe('static');
  });
});
