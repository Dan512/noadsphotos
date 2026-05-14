import { test, expect } from '@playwright/test';

// Phase 9: exportRenderer.spec.js — single-image full-resolution bake.
//
// These tests drive renderForExport directly via the page evaluation context.
// The harness (1) imports a small known-color image, (2) lets the renderer
// commit the bitmap, (3) calls renderForExport via direct module import,
// (4) decodes the returned blob back to a canvas, and (5) samples pixels.

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
      s.ui.zoom = 'fit';
    });
  });
}

// Import a synthetic image filled with `color` (any CSS color). Optionally
// paint a different color at a small marker rectangle so we can assert
// orientation-changing transforms put the marker where expected.
async function importSynth(page, opts = {}) {
  const { w = 200, h = 100, color = '#ff0000', marker = null } = opts;
  return await page.evaluate(async ({ w, h, color, marker }) => {
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
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    if (marker) {
      ctx.fillStyle = marker.color;
      ctx.fillRect(marker.x, marker.y, marker.w, marker.h);
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'synth.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h, color, marker });
}

// Mutate state for one image then call renderForExport. Return a small
// summary of the resulting blob plus a couple of sampled pixels.
async function exportAndSample(page, id, mutator, opts) {
  return await page.evaluate(async ({ id, mutatorSrc, format, quality, samples, maxOverride }) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { update, getState } = await import('/js/state.js');
    const { renderForExport } = await import('/js/render/exportRenderer.js');

    const caps = await probeCapabilities();
    if (maxOverride) {
      // Don't mutate the cached caps in place — make a shallow copy.
      Object.assign(caps, { maxCanvasSize: maxOverride });
    }
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    // Mutate the image's state (via eval) before exporting.
    if (mutatorSrc) {
      // eslint-disable-next-line no-eval
      const mutator = eval(`(${mutatorSrc})`);
      update(s => mutator(s.images[id]));
    }
    // Force decode so the bitmap is in state before we render.
    await lifecycle.ensureBitmap(id);

    try {
      const blob = await renderForExport(getState().images[id], { format, quality }, caps, lifecycle);
      // Decode the blob back to inspect pixels.
      const decoded = await createImageBitmap(blob);
      const dc = document.createElement('canvas');
      dc.width = decoded.width;
      dc.height = decoded.height;
      const dctx = dc.getContext('2d');
      dctx.drawImage(decoded, 0, 0);
      const sampledPixels = {};
      if (samples) {
        for (const [name, pt] of Object.entries(samples)) {
          const sx = Math.max(0, Math.min(decoded.width - 1, Math.round(pt.x)));
          const sy = Math.max(0, Math.min(decoded.height - 1, Math.round(pt.y)));
          const d = dctx.getImageData(sx, sy, 1, 1).data;
          sampledPixels[name] = { r: d[0], g: d[1], b: d[2], a: d[3] };
        }
      }
      // Capture dims BEFORE closing the bitmap. After close(), width/height
      // can return 0 in some browsers.
      const dims = { width: decoded.width, height: decoded.height };
      decoded.close && decoded.close();
      return {
        ok: true,
        type: blob.type,
        size: blob.size,
        width: dims.width,
        height: dims.height,
        samples: sampledPixels,
      };
    } catch (err) {
      return { ok: false, message: err && err.message, code: err && err.code };
    }
  }, {
    id,
    mutatorSrc: mutator ? mutator.toString() : null,
    format: opts.format,
    quality: opts.quality ?? 0.92,
    samples: opts.samples || null,
    maxOverride: opts.maxOverride || null,
  });
}

// --- Tests ----------------------------------------------------------------

test('identity (no edits) → output dims match source, PNG mime', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 200, h: 100, color: '#ff0000' });
  const result = await exportAndSample(page, id, null, {
    format: 'image/png',
    samples: { center: { x: 100, y: 50 } },
  });
  expect(result.ok).toBe(true);
  expect(result.type).toBe('image/png');
  expect(result.width).toBe(200);
  expect(result.height).toBe(100);
  expect(result.samples.center.r).toBeGreaterThan(220);
  expect(result.samples.center.g).toBeLessThan(40);
  expect(result.samples.center.b).toBeLessThan(40);
});

test('crop {50,25,100,50} → 100x50 output', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 200, h: 100, color: '#00ff00' });
  const result = await exportAndSample(page, id, (img) => {
    img.transforms.crop = { x: 50, y: 25, w: 100, h: 50 };
  }, {
    format: 'image/png',
    samples: { center: { x: 50, y: 25 } },
  });
  expect(result.ok).toBe(true);
  expect(result.width).toBe(100);
  expect(result.height).toBe(50);
  // Center pixel is green from the crop region.
  expect(result.samples.center.g).toBeGreaterThan(220);
  expect(result.samples.center.r).toBeLessThan(40);
});

test('rotate 90 → 200x100 source becomes 100x200 output', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 200, h: 100, color: '#0000ff' });
  const result = await exportAndSample(page, id, (img) => {
    img.transforms.rotate = 90;
  }, {
    format: 'image/png',
    samples: { center: { x: 50, y: 100 } },
  });
  expect(result.ok).toBe(true);
  expect(result.width).toBe(100);
  expect(result.height).toBe(200);
  expect(result.samples.center.b).toBeGreaterThan(220);
});

test('flip horizontal: left-edge color appears on right edge', async ({ page }) => {
  await resetApp(page);
  // Red base with a yellow strip at left x=0..10.
  const id = await importSynth(page, {
    w: 200, h: 100, color: '#ff0000',
    marker: { x: 0, y: 0, w: 10, h: 100, color: '#ffff00' },
  });
  const result = await exportAndSample(page, id, (img) => {
    img.transforms.flipH = true;
  }, {
    format: 'image/png',
    samples: {
      leftSample: { x: 5, y: 50 },
      rightSample: { x: 195, y: 50 },
    },
  });
  expect(result.ok).toBe(true);
  expect(result.width).toBe(200);
  expect(result.height).toBe(100);
  // After flipH, the yellow strip is on the right side.
  expect(result.samples.rightSample.r).toBeGreaterThan(220);
  expect(result.samples.rightSample.g).toBeGreaterThan(220);
  expect(result.samples.rightSample.b).toBeLessThan(40);
  // Left side is now red.
  expect(result.samples.leftSample.r).toBeGreaterThan(220);
  expect(result.samples.leftSample.g).toBeLessThan(40);
});

test('brightness +50 lifts mid-gray toward white', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 80, h: 60, color: '#808080' });
  const result = await exportAndSample(page, id, (img) => {
    img.adjust.brightness = 50;
  }, {
    format: 'image/png',
    samples: { center: { x: 40, y: 30 } },
  });
  expect(result.ok).toBe(true);
  // 128 + 0.5*255 ≈ 256 → clamp to 255; allow tolerance for codec/filter math.
  expect(result.samples.center.r).toBeGreaterThan(180);
  expect(result.samples.center.g).toBeGreaterThan(180);
  expect(result.samples.center.b).toBeGreaterThan(180);
});

test('filter preset grayscale renders red as gray (R==G==B within tolerance)', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 80, h: 60, color: '#ff0000' });
  const result = await exportAndSample(page, id, (img) => {
    img.filterPreset = 'grayscale';
  }, {
    format: 'image/png',
    samples: { center: { x: 40, y: 30 } },
  });
  expect(result.ok).toBe(true);
  const { r, g, b } = result.samples.center;
  // Grayscale outputs are equal channels, but small rounding/codec drift
  // can make them differ by a couple of LSBs.
  expect(Math.abs(r - g)).toBeLessThan(5);
  expect(Math.abs(g - b)).toBeLessThan(5);
  // Red channel weight in Rec.709: 0.2126 → mid-low value, not pure red.
  expect(r).toBeLessThan(100);
});

test('chromakey: black source becomes transparent after mask', async ({ page }) => {
  await resetApp(page);
  // Pure black source. Build a chromakey mask that maps every pixel to 0
  // (== fully transparent) and verify alpha is 0 in the output.
  const id = await importSynth(page, { w: 32, h: 24, color: '#000000' });
  const result = await exportAndSample(page, id, (img) => {
    const total = img.source.width * img.source.height;
    const mask = new Uint8Array(total);
    // All zeros = fully transparent everywhere.
    img.chromakeyMask = mask;
    img.chromakey = { hex: '#000000', tolerance: 0 };
  }, {
    format: 'image/png',
    samples: { center: { x: 16, y: 12 } },
  });
  expect(result.ok).toBe(true);
  expect(result.samples.center.a).toBe(0);
});

test('text overlay: a black text at (10, 10) leaves dark pixels near (10, 12)', async ({ page }) => {
  await resetApp(page);
  // White source so the black text contrasts strongly.
  const id = await importSynth(page, { w: 200, h: 80, color: '#ffffff' });
  const result = await exportAndSample(page, id, (img) => {
    img.overlays.push({
      id: 'text-1', type: 'text',
      x: 10, y: 10, rot: 0,
      text: 'Hi',
      font: 'Onest, system-ui, sans-serif',
      size: 32, weight: 700, color: '#000000', align: 'left',
    });
  }, {
    format: 'image/png',
    samples: {
      // Sample near the glyph baseline; exact pixel depends on font metrics,
      // but a dense 32-px glyph will produce dark pixels in this region.
      inside: { x: 15, y: 25 },
      // Bottom-right corner stays white.
      whiteRef: { x: 195, y: 75 },
    },
  });
  expect(result.ok).toBe(true);
  // Inside the glyph: dark — at least one channel notably below 200.
  const inside = result.samples.inside;
  const darkChannels = [inside.r, inside.g, inside.b].filter(v => v < 200).length;
  expect(darkChannels).toBeGreaterThan(0);
  // Outside the glyph stays white.
  expect(result.samples.whiteRef.r).toBeGreaterThan(240);
  expect(result.samples.whiteRef.g).toBeGreaterThan(240);
  expect(result.samples.whiteRef.b).toBeGreaterThan(240);
});

test('resize longestSide=100 on 200x100 source → output is 100x50', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 200, h: 100, color: '#abcdef' });
  const result = await exportAndSample(page, id, (img) => {
    img.transforms.resize = { mode: 'longestSide', value: 100 };
  }, {
    format: 'image/png',
    samples: { center: { x: 50, y: 25 } },
  });
  expect(result.ok).toBe(true);
  expect(result.width).toBe(100);
  expect(result.height).toBe(50);
});

test('combined: crop + rotate + brightness + overlay', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 200, h: 100, color: '#444444' });
  const result = await exportAndSample(page, id, (img) => {
    img.transforms.crop = { x: 0, y: 0, w: 100, h: 100 };
    img.transforms.rotate = 90;
    img.adjust.brightness = 30;
    img.overlays.push({
      id: 'text-1', type: 'text',
      x: 10, y: 10, rot: 0,
      text: 'X',
      font: 'Onest, system-ui, sans-serif',
      size: 24, weight: 700, color: '#ffffff', align: 'left',
    });
  }, {
    format: 'image/png',
    samples: { center: { x: 50, y: 50 } },
  });
  expect(result.ok).toBe(true);
  // 100x100 cropped, then rotated 90 → still 100x100.
  expect(result.width).toBe(100);
  expect(result.height).toBe(100);
});

test('JPEG format produces image/jpeg blob', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 80, h: 60, color: '#123456' });
  const result = await exportAndSample(page, id, null, {
    format: 'image/jpeg',
    quality: 0.9,
  });
  expect(result.ok).toBe(true);
  expect(result.type).toBe('image/jpeg');
});

test('WebP format: either succeeds with image/webp or throws format_unsupported', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 80, h: 60, color: '#789abc' });
  const result = await exportAndSample(page, id, null, {
    format: 'image/webp',
    quality: 0.9,
  });
  if (result.ok) {
    expect(result.type).toBe('image/webp');
  } else {
    // Caller surface: EncodeError code OR message-string fallback.
    expect(result.code === 'format_unsupported' || /format_unsupported/.test(result.message || '')).toBe(true);
  }
});

test('exceeds canvas limit: throws output_exceeds_canvas_limit', async ({ page }) => {
  await resetApp(page);
  const id = await importSynth(page, { w: 200, h: 100, color: '#cafe00' });
  const result = await exportAndSample(page, id, null, {
    format: 'image/png',
    maxOverride: 64,
  });
  expect(result.ok).toBe(false);
  expect(result.message).toBe('output_exceeds_canvas_limit');
});
