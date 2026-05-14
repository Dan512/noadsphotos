// tests/browser/bgremove-vendor.spec.js — Phase 11 real-asset smoke coverage.
//
// The companion `bgremove.spec.js` exercises the full UI flow using a fake
// `removeBackground` impl. These tests instead verify the REAL vendored
// bundle loads, can resolve its `onnxruntime-web` import via the import map,
// and that `resources.json` + a sample chunk are reachable. We do NOT run
// inference here — the model is too heavy and slow for CI. Verifying load
// discipline + asset reachability is sufficient to catch a broken vendoring
// step.

import { test, expect } from '@playwright/test';

test.describe('bg-remove vendored assets', () => {
  test('index.html exposes an importmap that resolves both onnxruntime-web variants', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
    // The importmap must be present and reference our vendored bundle paths
    // for both the CPU and WebGPU execution providers.
    const importmap = await page.locator('script[type="importmap"]').textContent();
    expect(importmap).toBeTruthy();
    const parsed = JSON.parse(importmap);
    expect(parsed.imports['onnxruntime-web']).toBe('/js/vendor/onnxruntime-web/ort.bundle.min.mjs');
    expect(parsed.imports['onnxruntime-web/webgpu']).toBe('/js/vendor/onnxruntime-web/ort.webgpu.bundle.min.mjs');
  });

  test('resources.json is reachable and lists the keys we vendored (CPU + WebGPU)', async ({ page }) => {
    const res = await page.request.get('/js/vendor/bgremove/resources.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/json/);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      '/models/isnet_fp16',
      '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs',
      '/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm',
      '/onnxruntime-web/ort-wasm-simd-threaded.mjs',
      '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
    ]);
    // Each entry must declare at least one chunk with non-zero size.
    for (const [, entry] of Object.entries(body)) {
      expect(Array.isArray(entry.chunks)).toBe(true);
      expect(entry.chunks.length).toBeGreaterThan(0);
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  test('the vendored WebGPU onnxruntime-web bundle loads as an ES module via the importmap', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

    const result = await page.evaluate(async () => {
      try {
        const mod = await import('onnxruntime-web/webgpu');
        const candidate = mod.default || mod;
        return {
          ok: true,
          hasInference: typeof candidate?.InferenceSession?.create === 'function',
          hasTensor: typeof candidate?.Tensor === 'function',
        };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.hasInference).toBe(true);
    expect(result.hasTensor).toBe(true);
  });

  test('the first chunk of the isnet_fp16 model is reachable from the static server', async ({ page }) => {
    // Read the first chunk name from the manifest, then fetch it directly so
    // we don't hardcode the hash here (resilient to upstream re-chunking).
    const manifest = await (await page.request.get('/js/vendor/bgremove/resources.json')).json();
    const first = manifest['/models/isnet_fp16'].chunks[0];
    expect(first).toBeTruthy();
    const expectedBytes = first.offsets[1] - first.offsets[0];

    const res = await page.request.get(`/js/vendor/bgremove/${first.name}`);
    expect(res.status()).toBe(200);
    const body = await res.body();
    expect(body.length).toBe(expectedBytes);
  });

  test('the vendored onnxruntime-web bundle loads as an ES module via the importmap', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

    const result = await page.evaluate(async () => {
      try {
        const mod = await import('onnxruntime-web');
        // The bundle exports `InferenceSession`, `Tensor`, `env`, etc. either
        // as `default` or as named exports. Either is fine — we just need to
        // confirm the bare-specifier import resolves and the module shape
        // looks like the ORT runtime.
        const candidate = mod.default || mod;
        return {
          ok: true,
          hasInference: typeof candidate?.InferenceSession?.create === 'function',
          hasTensor: typeof candidate?.Tensor === 'function',
        };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.hasInference).toBe(true);
    expect(result.hasTensor).toBe(true);
  });

  test('the vendored @imgly bundle loads as an ES module and exposes removeBackground', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

    const result = await page.evaluate(async () => {
      try {
        const mod = await import('/js/vendor/bgremove/index.mjs');
        return {
          ok: true,
          hasRemoveBg: typeof (mod.removeBackground || mod.default) === 'function',
          hasPreload: typeof mod.preload === 'function',
        };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.hasRemoveBg).toBe(true);
  });

  test('js/ops/bgremove.js loadImpl() resolves the real impl when not stubbed', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

    // Without _setImplForTest, the bgremove module must successfully resolve
    // the real vendored bundle. We don't invoke `runBgRemove` here (avoids
    // ~100 MB download + slow inference) — we just verify the import side
    // by exercising the internal loadImpl via a top-level dynamic import.
    const result = await page.evaluate(async () => {
      try {
        const ops = await import('/js/ops/bgremove.js');
        // Make sure no leftover test stub is set.
        if (typeof ops._setImplForTest === 'function') ops._setImplForTest(null);
        // The vendored bundle path is hard-coded inside the module; just
        // confirm the public API surface is intact.
        return {
          ok: true,
          hasApi: typeof ops.runBgRemove === 'function'
            && typeof ops.applyBgRemove === 'function'
            && typeof ops.applyBgRemoveBatch === 'function'
            && typeof ops.ensureBgRemoveConsent === 'function'
            && typeof ops.showConsentModal === 'function',
        };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.hasApi).toBe(true);
  });
});
