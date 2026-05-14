// tests/browser/intro.spec.js — empty-state intro landing copy + SEO head.
//
// Verifies:
//   - The queue intro section renders when state.queue is empty and the view
//     is the queue (which is the boot default).
//   - The intro disappears once at least one image is imported, leaving just
//     the thumbnail grid + batch panel (drop zone also gone — covered in
//     queueView.spec).
//   - The intro <h1> matches the EN string, and there is exactly one <h1> in
//     the document (topbar wordmark was demoted to <p class="wordmark">).
//   - The feature list has 5 items.
//   - <link rel="canonical"> points at https://noadsphotos.com/.
//   - The application/ld+json block exists and parses as JSON with the
//     expected `@type`.
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
    });
    document.querySelectorAll('dialog.oversize-dialog').forEach(d => d.remove());
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

test('intro section renders above the drop zone when the queue is empty', async ({ page }) => {
  await resetApp(page);
  const intro = page.locator('#queue-view .queue-intro');
  await expect(intro).toBeVisible();
  // Drop zone also still visible — intro sits above it.
  await expect(page.locator('#queue-view .queue-empty')).toBeVisible();
});

test('intro h1 text matches the EN string', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#queue-view .queue-intro .intro-title'))
    .toHaveText('Batch image editing in your browser.');
});

test('document has exactly one h1 (the intro title)', async ({ page }) => {
  await resetApp(page);
  // Topbar was demoted to <p class="wordmark"> so only the intro h1 should
  // remain in the empty-queue state.
  await expect(page.locator('h1')).toHaveCount(1);
});

test('feature list contains 5 items', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#queue-view .queue-intro .intro-features li')).toHaveCount(5);
});

test('intro section is removed once at least one image is imported', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#queue-view .queue-intro')).toBeVisible();
  await importImages(page, 1);
  await expect(page.locator('#queue-view .queue-intro')).toHaveCount(0);
  // And the drop zone is also gone — the thumbnail grid takes over.
  await expect(page.locator('#queue-view .queue-empty')).toHaveCount(0);
  await expect(page.locator('#queue-view .queue-grid .queue-thumb')).toHaveCount(1);
});

test('canonical link tag points to the production URL', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(href).toBe('https://noadsphotos.com/');
});

test('JSON-LD WebApplication block is present and parses as valid JSON', async ({ page }) => {
  await page.goto('/');
  const text = await page.locator('script[type="application/ld+json"]').textContent();
  expect(text).not.toBeNull();
  // Parse — would throw on malformed JSON.
  const parsed = JSON.parse(text);
  expect(parsed['@context']).toBe('https://schema.org');
  expect(parsed['@type']).toBe('WebApplication');
  expect(parsed.name).toBe('NoAdsPhotos');
});

test('topbar wordmark is a <p class="wordmark">, not an <h1>', async ({ page }) => {
  await page.goto('/');
  const tag = await page.locator('.topbar .wordmark').evaluate(el => el.tagName.toLowerCase());
  expect(tag).toBe('p');
  await expect(page.locator('.topbar .wordmark')).toHaveText('NoAdsPhotos');
});
