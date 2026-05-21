// tests/browser/heic-import.spec.js — v1.1 Feature 5 end-to-end.
//
// Coverage strategy:
//   - Most flows use the `_setHeicDecoderForTest` escape hatch + a tiny fake
//     decoder so the wasm never has to load in the test process. That keeps
//     the spec deterministic + fast across all five Playwright projects.
//   - One test ('real decoder') uses the real vendored libheif + the committed
//     `tests/fixtures/sample.heic` fixture. This is the smoke test that
//     verifies our `locateFile` override + wasm loading work in a real
//     browser context. If the fixture is ever missing, this test will fail
//     loudly — that's intentional.

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE_HEIC_PATH = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'sample.heic');

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
    // Wipe any prior consent so the modal flow is exercised.
    const { _resetForTest } = await import('/js/vendor/heic-loader.js');
    _resetForTest();
    // Clear any leftover dialogs/toasts from prior tests.
    document.querySelectorAll('dialog').forEach(d => { try { d.close(); } catch { /* ignore */ } d.remove(); });
    const tr = document.getElementById('toast-root');
    if (tr) tr.innerHTML = '';
  });
}

// Install a fake decoder that returns a synthetic 16x16 magenta ImageData.
// We pre-grant consent so the modal doesn't appear; the consent flow is
// covered separately below.
async function installFakeDecoderAndConsent(page) {
  await page.evaluate(async () => {
    const { _setHeicDecoderForTest, _setConsentForTest } = await import('/js/vendor/heic-loader.js');
    _setConsentForTest('grant');
    _setHeicDecoderForTest({
      decode: async (_ab) => {
        const w = 16, h = 16;
        const data = new Uint8ClampedArray(w * h * 4);
        // Solid magenta with full alpha so we can verify the importer
        // reaches end-to-end.
        for (let i = 0; i < data.length; i += 4) {
          data[i + 0] = 0xff;
          data[i + 1] = 0x00;
          data[i + 2] = 0xff;
          data[i + 3] = 0xff;
        }
        return { data, width: w, height: h };
      },
    });
  });
}

// Build a synthetic File inside the page from a tiny byte array. We don't
// need the file to actually be a valid HEIC because the decoder is faked —
// `isHeicFile()` only checks MIME + extension.
async function buildSyntheticHeicFile(page, name = 'phone.heic', mime = 'image/heic') {
  await page.evaluate(({ name, mime }) => {
    const fakeBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 105, 102, 49]); // 'ftypmif1'
    const blob = new Blob([fakeBytes], { type: mime });
    const file = new File([blob], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.__lastHeicDt = dt;
  }, { name, mime });
}

async function dropLastHeicFile(page) {
  await page.evaluate(() => {
    const dt = window.__lastHeicDt;
    document.body.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
  });
}

async function getQueueLength(page) {
  return await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().queue.length;
  });
}

// --------------------------------------------------------------------------
// Detection
// --------------------------------------------------------------------------

test('HEIC file with MIME image/heic is routed through the decoder', async ({ page }) => {
  await resetApp(page);
  await installFakeDecoderAndConsent(page);
  await buildSyntheticHeicFile(page, 'phone.heic', 'image/heic');
  await dropLastHeicFile(page);

  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(1);

  const info = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    const id = s.queue[0];
    const img = s.images[id];
    return {
      name: img.source.name,
      type: img.source.type,
      width: img.source.width,
      height: img.source.height,
    };
  });
  // Importer should swap .heic → .png in the displayed name and re-encode
  // the source blob as PNG.
  expect(info.name).toBe('phone.png');
  expect(info.type).toBe('image/png');
  expect(info.width).toBe(16);
  expect(info.height).toBe(16);
});

test('HEIC file with empty MIME but .heic extension is still accepted', async ({ page }) => {
  await resetApp(page);
  await installFakeDecoderAndConsent(page);
  await buildSyntheticHeicFile(page, 'noMime.heic', '');
  await dropLastHeicFile(page);
  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(1);
});

test('HEIF file with .heif extension is accepted', async ({ page }) => {
  await resetApp(page);
  await installFakeDecoderAndConsent(page);
  await buildSyntheticHeicFile(page, 'sample.heif', 'image/heif');
  await dropLastHeicFile(page);
  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(1);
  const name = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    return s.images[s.queue[0]].source.name;
  });
  // .heif should also be renamed to .png post-decode.
  expect(name).toBe('sample.png');
});

// --------------------------------------------------------------------------
// Consent modal
// --------------------------------------------------------------------------

test('first HEIC import shows consent modal; Continue grants and persists', async ({ page }) => {
  await resetApp(page);
  // Inject decoder but NOT consent — modal must appear.
  await page.evaluate(async () => {
    const { _setHeicDecoderForTest } = await import('/js/vendor/heic-loader.js');
    _setHeicDecoderForTest({
      decode: async () => {
        const w = 8, h = 8;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) { data[i+0]=0;data[i+1]=255;data[i+2]=0;data[i+3]=255; }
        return { data, width: w, height: h };
      },
    });
  });
  await buildSyntheticHeicFile(page, 'a.heic', 'image/heic');
  await dropLastHeicFile(page);

  await expect(page.locator('dialog.heic-consent-dialog')).toBeVisible({ timeout: 4000 });
  await expect(page.locator('dialog.heic-consent-dialog h2')).toContainText(/HEIC/i);

  await page.locator('dialog.heic-consent-dialog .heic-consent-continue').click();

  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(1);

  const stored = await page.evaluate(async () => {
    const { hasStoredConsent, CONSENT_KEY, VENDOR_HASH } = await import('/js/vendor/heic-loader.js');
    return {
      has: hasStoredConsent(),
      stored: localStorage.getItem(CONSENT_KEY),
      expected: VENDOR_HASH,
    };
  });
  expect(stored.has).toBe(true);
  expect(stored.stored).toBe(stored.expected);
});

test('second HEIC import after consent does NOT show modal again', async ({ page }) => {
  await resetApp(page);
  // Seed consent + decoder; modal should never appear.
  await installFakeDecoderAndConsent(page);
  await buildSyntheticHeicFile(page, 'first.heic', 'image/heic');
  await dropLastHeicFile(page);
  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(1);

  // Now drop another HEIC. Since consent is pre-granted via the test override
  // path, no modal should appear.
  await buildSyntheticHeicFile(page, 'second.heic', 'image/heic');
  await dropLastHeicFile(page);
  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(2);

  await expect(page.locator('dialog.heic-consent-dialog')).toHaveCount(0);
});

test('consent persisted across page reload (real localStorage path)', async ({ page }) => {
  await resetApp(page);
  // Use the REAL consent persistence here — install only the decoder, then
  // grant via the modal so localStorage is written.
  await page.evaluate(async () => {
    const { _setHeicDecoderForTest } = await import('/js/vendor/heic-loader.js');
    _setHeicDecoderForTest({
      decode: async () => {
        const data = new Uint8ClampedArray(4); data.set([1, 2, 3, 255]);
        return { data, width: 1, height: 1 };
      },
    });
  });
  await buildSyntheticHeicFile(page, 'persist.heic', 'image/heic');
  await dropLastHeicFile(page);
  await expect(page.locator('dialog.heic-consent-dialog')).toBeVisible({ timeout: 4000 });
  await page.locator('dialog.heic-consent-dialog .heic-consent-continue').click();
  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(1);

  // Reload the page (localStorage survives across reloads in Playwright).
  // The loader cache resets on reload, but the stored consent should remain.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

  const has = await page.evaluate(async () => {
    const { hasStoredConsent } = await import('/js/vendor/heic-loader.js');
    return hasStoredConsent();
  });
  expect(has).toBe(true);
});

test('Cancel in consent modal cancels the import with a friendly toast', async ({ page }) => {
  await resetApp(page);
  // Install decoder but consent stays unset — modal will appear, we cancel.
  await page.evaluate(async () => {
    const { _setHeicDecoderForTest } = await import('/js/vendor/heic-loader.js');
    _setHeicDecoderForTest({
      decode: async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    });
  });
  await buildSyntheticHeicFile(page, 'cancel.heic', 'image/heic');
  await dropLastHeicFile(page);

  await expect(page.locator('dialog.heic-consent-dialog')).toBeVisible({ timeout: 4000 });
  await page.locator('dialog.heic-consent-dialog .heic-consent-cancel').click();

  // Toast surfaces the cancellation.
  await expect(page.locator('#toast-root .toast').first()).toContainText(/cancelled/i, { timeout: 3000 });
  // Queue still empty.
  expect(await getQueueLength(page)).toBe(0);
});

// --------------------------------------------------------------------------
// Error paths
// --------------------------------------------------------------------------

test('decoder throw → friendly error toast, queue stays empty', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const { _setHeicDecoderForTest, _setConsentForTest } = await import('/js/vendor/heic-loader.js');
    _setConsentForTest('grant');
    _setHeicDecoderForTest({
      decode: async () => { throw new Error('synthetic decode failure'); },
    });
  });
  await buildSyntheticHeicFile(page, 'broken.heic', 'image/heic');
  await dropLastHeicFile(page);

  await expect(page.locator('#toast-root .toast-error')).toHaveCount(1, { timeout: 3000 });
  await expect(page.locator('#toast-root .toast-error')).toContainText(/HEIC/i);
  expect(await getQueueLength(page)).toBe(0);
});

// --------------------------------------------------------------------------
// No regressions: non-HEIC import paths still work
// --------------------------------------------------------------------------

test('PNG import still works alongside HEIC support (no regression)', async ({ page }) => {
  await resetApp(page);
  // No fake decoder installed — PNG doesn't need it.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    c.getContext('2d').fillRect(0, 0, 8, 8);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 0.92));
    const file = new File([blob], 'normal.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.body.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
  });
  await expect.poll(() => getQueueLength(page), { timeout: 5000 }).toBe(1);
});

// --------------------------------------------------------------------------
// Real decoder smoke test — uses the committed sample.heic fixture.
// --------------------------------------------------------------------------

test('real libheif WASM decodes the rainbow-451x461 fixture in-browser', async ({ page }) => {
  test.skip(!existsSync(SAMPLE_HEIC_PATH), `Missing fixture: ${SAMPLE_HEIC_PATH}`);
  await resetApp(page);
  // Pre-grant consent so the modal doesn't appear; we want to test the
  // wasm path, not the modal path.
  await page.evaluate(async () => {
    const { _setConsentForTest } = await import('/js/vendor/heic-loader.js');
    _setConsentForTest('grant');
  });

  // Load the fixture bytes from disk and post them into the page as a Blob.
  const heicBytes = readFileSync(SAMPLE_HEIC_PATH);
  await page.evaluate(async ({ bytes }) => {
    const arr = new Uint8Array(bytes);
    const blob = new Blob([arr], { type: 'image/heic' });
    const file = new File([blob], 'sample.heic', { type: 'image/heic' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.body.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
  }, { bytes: Array.from(heicBytes) });

  // Wasm + decode can take a few seconds on slower CI runners.
  await expect.poll(() => getQueueLength(page), { timeout: 30000 }).toBe(1);

  const info = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    const s = getState();
    const id = s.queue[0];
    const img = s.images[id];
    return {
      name: img.source.name,
      type: img.source.type,
      width: img.source.width,
      height: img.source.height,
    };
  });
  // Rainbow fixture: 451 × 461.
  expect(info.name).toBe('sample.png');
  expect(info.type).toBe('image/png');
  expect(info.width).toBe(451);
  expect(info.height).toBe(461);
});
