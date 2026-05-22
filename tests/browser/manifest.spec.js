// tests/browser/manifest.spec.js — PWA manifest sanity (Phase 14.5).
//
// Verifies the manifest:
//   - parses as valid JSON
//   - declares at least one icon with a real, resolvable URL
//   - has both an SVG icon (vector PWA installers) and a 512px PNG (older /
//     mobile PWA installers that require a raster bitmap)
//   - includes a maskable variant (Android adaptive icons need this)
import { test, expect } from '@playwright/test';

test('manifest: parses and lists at least one icon', async ({ page, request }) => {
  await page.goto('/');
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toBeTruthy();
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    expect(typeof icon.src).toBe('string');
    expect(icon.src.length).toBeGreaterThan(0);
  }
});

test('manifest: every icon URL resolves with 200 OK', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  const manifest = await res.json();
  for (const icon of manifest.icons) {
    const head = await request.get(icon.src);
    expect(head.ok(), `icon ${icon.src} not reachable`).toBe(true);
  }
});

test('manifest: declares PNG icons (vector source dropped in v1.1.2)', async ({ request }) => {
  // Pre-v1.1.2 the manifest included an `image/svg+xml` entry pointing at
  // img/logo.svg (the old green "n." mark). The brand mark switched to a
  // PNG-authored "🚫 Ads" design with no SVG counterpart, so the manifest
  // is now PNG-only. Browser PWA installers all accept PNG fallbacks.
  const res = await request.get('/manifest.webmanifest');
  const manifest = await res.json();
  const types = manifest.icons.map(i => i.type || '');
  expect(types).toContain('image/png');
});

test('manifest: includes a 512px maskable icon for Android adaptive', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  const manifest = await res.json();
  const maskable = manifest.icons.find(i => (i.purpose || '').includes('maskable'));
  expect(maskable, 'manifest should declare a maskable icon').toBeTruthy();
  expect(maskable.sizes).toBe('512x512');
});

test('manifest: theme_color and background_color are set', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  const manifest = await res.json();
  expect(typeof manifest.theme_color).toBe('string');
  expect(typeof manifest.background_color).toBe('string');
});

test('index.html declares the manifest link', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
});

test('index.html declares apple-touch-icon for iOS Add to Home Screen', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await request.get(href);
  expect(res.ok()).toBe(true);
});
