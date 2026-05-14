import { test, expect } from '@playwright/test';

async function encode(page, mime, quality = 0.9) {
  return await page.evaluate(async ({ mime, quality }) => {
    const m = await import('/js/codec.js');
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    c.getContext('2d').fillRect(0, 0, 4, 4);
    try {
      const blob = await m.encodeCanvas(c, mime, quality);
      return { ok: true, type: blob.type, size: blob.size };
    } catch (e) {
      return {
        ok: false,
        code: e.code,
        requested: e.requested,
        actual: e.actual,
        name: e.name,
        message: e.message,
        isEncodeError: e instanceof m.EncodeError,
        isError: e instanceof Error,
      };
    }
  }, { mime, quality });
}

test('encodeCanvas as image/png returns a PNG Blob with non-zero size', async ({ page }) => {
  await page.goto('/');
  const result = await encode(page, 'image/png');
  expect(result.ok).toBe(true);
  expect(result.type).toBe('image/png');
  expect(result.size).toBeGreaterThan(0);
});

test('encodeCanvas as image/jpeg returns a JPEG Blob', async ({ page }) => {
  await page.goto('/');
  const result = await encode(page, 'image/jpeg', 0.9);
  expect(result.ok).toBe(true);
  expect(result.type).toBe('image/jpeg');
  expect(result.size).toBeGreaterThan(0);
});

test('encodeCanvas as image/webp either succeeds or throws EncodeError(format_unsupported)', async ({ page }) => {
  await page.goto('/');
  const result = await encode(page, 'image/webp', 0.9);
  if (result.ok) {
    expect(result.type).toBe('image/webp');
    expect(result.size).toBeGreaterThan(0);
  } else {
    expect(result.code).toBe('format_unsupported');
    expect(result.requested).toBe('image/webp');
    expect(result.name).toBe('EncodeError');
    expect(result.isEncodeError).toBe(true);
    expect(result.isError).toBe(true);
  }
});

test('EncodeError has correct shape when format_unsupported is thrown', async ({ page }) => {
  await page.goto('/');
  // Force a mismatch: request a mime that the browser will silently fall back from.
  // We use a bogus mime that browsers normalize to PNG.
  const result = await page.evaluate(async () => {
    const m = await import('/js/codec.js');
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    c.getContext('2d').fillRect(0, 0, 4, 4);
    try {
      // 'image/bogus-unsupported-mime' falls back to PNG silently in all browsers
      const blob = await m.encodeCanvas(c, 'image/bogus-unsupported-mime', 0.9);
      return { ok: true, type: blob.type };
    } catch (e) {
      return {
        ok: false,
        code: e.code,
        requested: e.requested,
        actual: e.actual,
        name: e.name,
        isEncodeError: e instanceof m.EncodeError,
        isError: e instanceof Error,
        hasMessage: typeof e.message === 'string' && e.message.length > 0,
      };
    }
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('format_unsupported');
  expect(result.requested).toBe('image/bogus-unsupported-mime');
  expect(result.actual).toBe('image/png'); // browser fell back to PNG
  expect(result.name).toBe('EncodeError');
  expect(result.isEncodeError).toBe(true);
  expect(result.isError).toBe(true);
  expect(result.hasMessage).toBe(true);
});

test('EncodeError instance is both EncodeError and Error', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const m = await import('/js/codec.js');
    const err = new m.EncodeError('format_unsupported', 'image/webp', 'image/png');
    return {
      isEncodeError: err instanceof m.EncodeError,
      isError: err instanceof Error,
      name: err.name,
      code: err.code,
      requested: err.requested,
      actual: err.actual,
    };
  });
  expect(result.isEncodeError).toBe(true);
  expect(result.isError).toBe(true);
  expect(result.name).toBe('EncodeError');
  expect(result.code).toBe('format_unsupported');
  expect(result.requested).toBe('image/webp');
  expect(result.actual).toBe('image/png');
});
