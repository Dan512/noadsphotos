// tests/browser/bgremove-device.spec.js — verifies device selection in
// js/ops/bgremove.js follows caps.webGPU.
//
// We intercept the call into the @imgly bundle with `_setImplForTest` and
// just record the config object so we can assert on its shape. No real
// model is run.

import { test, expect } from '@playwright/test';

test.describe('bg-remove device selection', () => {
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
      const { _resetForTest } = await import('/js/ops/bgremove.js');
      _resetForTest();
      const caps = await import('/js/capabilities.js');
      caps._resetForTest();
      document.querySelectorAll('dialog').forEach(d => { try { d.close(); } catch { /* ignore */ } d.remove(); });
    });
  }

  test('passes device:"gpu" when caps.webGPU is true and proxyToWorker is always set', async ({ page }) => {
    await resetApp(page);
    const captured = await page.evaluate(async () => {
      const ops = await import('/js/ops/bgremove.js');
      // Force caps.webGPU to true via _resetForTest + monkey-patch on the
      // capabilities cache. The simplest way is to seed navigator.gpu so
      // the probe returns true on the next call.
      const captured = { config: null };
      ops._setImplForTest({
        removeBackground: async (blob, config) => {
          captured.config = {
            device: config.device,
            proxyToWorker: config.proxyToWorker,
            outputFormat: config.output && config.output.format,
          };
          // Return a tiny rgba8 blob so post-processing doesn't throw.
          const w = 4, h = 4;
          const bytes = new Uint8Array(w * h * 4);
          for (let i = 0; i < w * h; i++) bytes[i * 4 + 3] = 200;
          return new Blob([bytes], { type: `image/x-rgba8;width=${w};height=${h}` });
        },
      });
      // Seed consent.
      const { CONSENT_KEY, MODEL_HASH } = ops;
      localStorage.setItem(CONSENT_KEY, MODEL_HASH);

      // Force webGPU: true by reinitializing capabilities then patching.
      const caps = await import('/js/capabilities.js');
      caps._resetForTest();
      // Seed a fake navigator.gpu so the probe picks it up. We do this on a
      // separate object the probe can detect.
      const originalGpu = navigator.gpu;
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
      try {
        // Synthetic image so the importer creates a state slot.
        const { probeCapabilities } = caps;
        const { createLifecycle } = await import('/js/lifecycle.js');
        const { importFiles } = await import('/js/importer.js');
        const probedCaps = await probeCapabilities();
        const lifecycle = createLifecycle({
          decoder: (b, o) => createImageBitmap(b, o),
          closer: bm => bm.close(),
        });
        const c = document.createElement('canvas');
        c.width = 4; c.height = 4;
        c.getContext('2d').fillRect(0, 0, 4, 4);
        const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
        const file = new File([blob], 'x.png', { type: 'image/png' });
        await importFiles([file], probedCaps, lifecycle);
        const { getState } = await import('/js/state.js');
        const id = getState().queue[0];
        await ops.runBgRemove(id);
      } finally {
        // Restore navigator.gpu so other tests aren't affected.
        if (originalGpu === undefined) {
          delete navigator.gpu;
        } else {
          Object.defineProperty(navigator, 'gpu', { configurable: true, value: originalGpu });
        }
        ops._setImplForTest(null);
      }
      return captured;
    });

    expect(captured.config).not.toBeNull();
    expect(captured.config.device).toBe('gpu');
    expect(captured.config.proxyToWorker).toBe(true);
    expect(captured.config.outputFormat).toBe('image/x-rgba8');
  });

  test('falls back to device:"cpu" when caps.webGPU is false', async ({ page }) => {
    await resetApp(page);
    const captured = await page.evaluate(async () => {
      const ops = await import('/js/ops/bgremove.js');
      const captured = { config: null };
      ops._setImplForTest({
        removeBackground: async (blob, config) => {
          captured.config = {
            device: config.device,
            proxyToWorker: config.proxyToWorker,
            outputFormat: config.output && config.output.format,
          };
          const w = 4, h = 4;
          const bytes = new Uint8Array(w * h * 4);
          return new Blob([bytes], { type: `image/x-rgba8;width=${w};height=${h}` });
        },
      });
      const { CONSENT_KEY, MODEL_HASH } = ops;
      localStorage.setItem(CONSENT_KEY, MODEL_HASH);

      const caps = await import('/js/capabilities.js');
      caps._resetForTest();
      // Force webGPU absent.
      const originalGpu = Object.getOwnPropertyDescriptor(Navigator.prototype, 'gpu') || null;
      const originalInstanceGpu = navigator.gpu;
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
      try {
        const { probeCapabilities } = caps;
        const { createLifecycle } = await import('/js/lifecycle.js');
        const { importFiles } = await import('/js/importer.js');
        const probedCaps = await probeCapabilities();
        const lifecycle = createLifecycle({
          decoder: (b, o) => createImageBitmap(b, o),
          closer: bm => bm.close(),
        });
        const c = document.createElement('canvas');
        c.width = 4; c.height = 4;
        c.getContext('2d').fillRect(0, 0, 4, 4);
        const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
        const file = new File([blob], 'y.png', { type: 'image/png' });
        await importFiles([file], probedCaps, lifecycle);
        const { getState } = await import('/js/state.js');
        const id = getState().queue[0];
        await ops.runBgRemove(id);
      } finally {
        // Restore navigator.gpu so other tests aren't affected.
        if (originalInstanceGpu === undefined) {
          delete navigator.gpu;
        } else {
          Object.defineProperty(navigator, 'gpu', { configurable: true, value: originalInstanceGpu });
        }
        ops._setImplForTest(null);
      }
      return captured;
    });

    expect(captured.config).not.toBeNull();
    expect(captured.config.device).toBe('cpu');
    expect(captured.config.proxyToWorker).toBe(true);
    expect(captured.config.outputFormat).toBe('image/x-rgba8');
  });
});
