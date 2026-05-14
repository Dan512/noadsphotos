// tests/browser/bgremove-realrun.spec.js — slow end-to-end real-model smoke.
//
// Unlike bgremove.spec.js (which uses a fake impl), this spec actually runs
// the REAL @imgly bundle on a tiny synthetic image to verify the entire
// stack — vendored assets + ORT runtime + ONNX model + output decoding —
// works end-to-end. We keep the image tiny (32x32) so the ~88 MB model
// only has to do trivial work. The test is tagged @slow so it can be
// skipped during quick test cycles.
//
// What this catches that the fake-impl spec doesn't:
//   - WebGPU/CPU runtime actually executes without runtime errors.
//   - The `image/x-rgba8` output path returns a blob we can drain into
//     a Uint8Array of W*H*4 bytes.
//   - The alpha-channel extraction yields a Uint8Array sized W*H.
//   - The bundle's progress callback fires the expected stage names.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('real bg-remove end-to-end produces a W*H mask via image/x-rgba8', async ({ page }) => {
  test.slow(); // model + WASM warm-up takes a while on cold cache
  // Some browsers (webkit) have trouble with the worker proxy used by the
  // bundle on slow CI. Limit this test to chromium for now; webkit/firefox
  // are still covered by the fake-impl spec.
  test.skip(test.info().project.name !== 'chromium', 'real-run smoke targets chromium only');

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

  // Pre-seed consent so the consent modal doesn't block the run.
  await page.evaluate(async () => {
    const { CONSENT_KEY, MODEL_HASH } = await import('/js/ops/bgremove.js');
    localStorage.setItem(CONSENT_KEY, MODEL_HASH);
  });

  // Synthesize a 32x32 red-square-on-black image, import it, then invoke
  // runBgRemove directly (skipping the editor UI to keep the spec focused).
  const result = await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle }   = await import('/js/lifecycle.js');
    const { importFiles }       = await import('/js/importer.js');
    const { getState }          = await import('/js/state.js');
    const { runBgRemove }       = await import('/js/ops/bgremove.js');

    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });

    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = '#f00'; ctx.fillRect(8, 8, 16, 16);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'subject.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const id = getState().queue[0];

    // Track the unique stages we see fire so we can assert at least one
    // of the documented ones is emitted.
    const stages = new Set();
    let mask;
    try {
      mask = await runBgRemove(id, (stage) => stages.add(String(stage).split(':')[0]));
    } catch (err) {
      const root = err && err.cause ? `${err.message}: ${String(err.cause)}` : String(err);
      return { ok: false, err: root, stages: Array.from(stages).sort() };
    }

    return {
      ok: true,
      caps: { webGPU: caps.webGPU },
      maskType: mask ? mask.constructor.name : null,
      maskLen: mask ? mask.length : 0,
      expected: 32 * 32,
      stages: Array.from(stages).sort(),
    };
  });

  if (!result.ok) {
    // Surface the model error to help diagnose ORT/WASM compatibility issues.
    console.error('real-run failed:', result.err);
  }
  expect(result.ok).toBe(true);
  expect(result.maskType).toBe('Uint8Array');
  expect(result.maskLen).toBe(result.expected);
  // The bundle emits at least one of these stage prefixes during a run.
  // We only assert presence (not order) because progress timing varies.
  const expectedAny = ['fetch', 'compute'];
  expect(expectedAny.some(s => result.stages.includes(s))).toBe(true);
});
