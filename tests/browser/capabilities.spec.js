import { test, expect } from '@playwright/test';

test('probeCapabilities returns an object with all expected keys', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const m = await import('/js/capabilities.js');
    m._resetForTest();
    const r = await m.probeCapabilities();
    return {
      keys: Object.keys(r).sort(),
      types: {
        ctxFilter: typeof r.ctxFilter,
        webp: typeof r.webp,
        jpeg: typeof r.jpeg,
        png: typeof r.png,
        offscreenCanvas: typeof r.offscreenCanvas,
        webWorker: typeof r.webWorker,
        imageOrientation: typeof r.imageOrientation,
        maxCanvasSize: typeof r.maxCanvasSize,
        webGPU: typeof r.webGPU,
      },
    };
  });
  const expectedKeys = [
    'ctxFilter', 'imageOrientation', 'jpeg', 'maxCanvasSize',
    'offscreenCanvas', 'png', 'webGPU', 'webWorker', 'webp',
  ];
  expect(result.keys).toEqual(expectedKeys);
  expect(result.types.ctxFilter).toBe('boolean');
  expect(result.types.webp).toBe('boolean');
  expect(result.types.jpeg).toBe('boolean');
  expect(result.types.png).toBe('boolean');
  expect(result.types.offscreenCanvas).toBe('boolean');
  expect(result.types.webWorker).toBe('boolean');
  expect(result.types.imageOrientation).toBe('boolean');
  expect(result.types.maxCanvasSize).toBe('number');
  expect(result.types.webGPU).toBe('boolean');
});

test('webGPU is a boolean reflecting navigator.gpu presence', async ({ page }) => {
  await page.goto('/');
  const probed = await page.evaluate(async () => {
    const m = await import('/js/capabilities.js');
    m._resetForTest();
    const r = await m.probeCapabilities();
    return { webGPU: r.webGPU, hasNavGpu: typeof navigator.gpu === 'object' && navigator.gpu !== null };
  });
  expect(typeof probed.webGPU).toBe('boolean');
  // The probe should match navigator.gpu presence exactly.
  expect(probed.webGPU).toBe(probed.hasNavGpu);
});

test('png and jpeg are always true (universal support)', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const m = await import('/js/capabilities.js');
    m._resetForTest();
    const r = await m.probeCapabilities();
    return { png: r.png, jpeg: r.jpeg };
  });
  expect(result.png).toBe(true);
  expect(result.jpeg).toBe(true);
});

test('maxCanvasSize is at least 4096 on desktop projects', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile-chrome' || testInfo.project.name === 'mobile-safari',
    'mobile projects may have smaller canvas limits',
  );
  await page.goto('/');
  const maxCanvasSize = await page.evaluate(async () => {
    const m = await import('/js/capabilities.js');
    m._resetForTest();
    const r = await m.probeCapabilities();
    return r.maxCanvasSize;
  });
  expect(maxCanvasSize).toBeGreaterThanOrEqual(4096);
});

test('second call returns cached result (same object reference)', async ({ page }) => {
  await page.goto('/');
  const sameRef = await page.evaluate(async () => {
    const m = await import('/js/capabilities.js');
    m._resetForTest();
    const a = await m.probeCapabilities();
    const b = await m.probeCapabilities();
    return a === b;
  });
  expect(sameRef).toBe(true);
});

test('_resetForTest clears cache so next call re-probes', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const m = await import('/js/capabilities.js');
    m._resetForTest();
    const a = await m.probeCapabilities();
    m._resetForTest();
    const b = await m.probeCapabilities();
    return {
      sameRef: a === b,
      sameShape: JSON.stringify(a) === JSON.stringify(b),
    };
  });
  expect(result.sameRef).toBe(false); // new object after reset
  expect(result.sameShape).toBe(true); // but same probed values
});

test('ctxFilter and webp are booleans (values vary by browser)', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const m = await import('/js/capabilities.js');
    m._resetForTest();
    const r = await m.probeCapabilities();
    return { ctxFilter: r.ctxFilter, webp: r.webp };
  });
  expect(typeof result.ctxFilter).toBe('boolean');
  expect(typeof result.webp).toBe('boolean');
});
