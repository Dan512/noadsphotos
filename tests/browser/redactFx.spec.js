import { test, expect } from '@playwright/test';

// redactFx.spec.js — verify the redact effect is actually applied to the
// base canvas (live preview) and baked into the export blob.

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
      s.ui.activeTool = 'select';
      s.ui.selectedOverlayId = null;
      s.ui.zoom = 'fit';
    });
  });
}

// Import a synthetic image with two color halves: left half = leftColor,
// right half = rightColor. Used so we can place a redact across the seam
// and verify the high-frequency edge is destroyed by the effect.
async function importTwoHalves(page, w, h, leftColor, rightColor) {
  return await page.evaluate(async ({ w, h, leftColor, rightColor }) => {
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
    ctx.fillStyle = leftColor;
    ctx.fillRect(0, 0, w / 2, h);
    ctx.fillStyle = rightColor;
    ctx.fillRect(w / 2, 0, w / 2, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    const file = new File([blob], 'two-halves.png', { type: 'image/png' });
    await importFiles([file], caps, lifecycle);
    const { getState } = await import('/js/state.js');
    return getState().queue[0];
  }, { w, h, leftColor, rightColor });
}

// Open the image in the editor and wait for the base canvas to render.
async function openInEditor(page, id) {
  await page.locator(`#queue-view .queue-thumb[data-image-id="${id}"]`).click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 2000 }).toBeGreaterThan(0);
}

// Push a redact overlay directly into state and let the preview re-render.
async function addRedact(page, id, x, y, w, h, mode, strength) {
  await page.evaluate(async ({ id, x, y, w, h, mode, strength }) => {
    const { update } = await import('/js/state.js');
    const { addOverlay } = await import('/js/overlays.js');
    const { newRedactOverlay } = await import('/js/ops/redact.js');
    const o = newRedactOverlay(x, y, w, h, { mode, strength });
    update(s => addOverlay(s.images[id], o));
  }, { id, x, y, w, h, mode, strength });
  // Wait for the rAF tick to actually paint the redact into the base canvas.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Sample a pixel from the base canvas at the given CSS coordinate (mapped to
// internal-pixel via the canvas's width/styleWidth ratio).
async function sampleBaseCanvas(page, points) {
  return await page.evaluate((points) => {
    const c = document.getElementById('base-canvas');
    if (!c) return null;
    const ctx = c.getContext('2d');
    const out = {};
    for (const [name, pt] of Object.entries(points)) {
      const x = Math.max(0, Math.min(c.width - 1, Math.round(pt.x)));
      const y = Math.max(0, Math.min(c.height - 1, Math.round(pt.y)));
      const d = ctx.getImageData(x, y, 1, 1).data;
      out[name] = { r: d[0], g: d[1], b: d[2], a: d[3] };
    }
    return out;
  }, points);
}

// --- Tests ----------------------------------------------------------------

// Helper: compute the redact's AABB in canvas-internal pixels for the
// active image. Mirrors the renderer's sourceToCanvasInternal forward
// transform but uses the canvas's actual current internal dims so the
// sample math accounts for letterboxing and DPR.
async function redactRectInCanvasPx(page, id, src) {
  return await page.evaluate(({ id, src }) => {
    const { getState } = window;
    return (async () => {
      const { getState } = await import('/js/state.js');
      const c = document.getElementById('base-canvas');
      const img = getState().images[id];
      const t = img.transforms || {};
      const cropT = t.crop;
      const srcRect = cropT && cropT.w > 0 && cropT.h > 0
        ? cropT
        : { x: 0, y: 0, w: img.source.width, h: img.source.height };
      const rot = ((t.rotate || 0) % 360 + 360) % 360;
      const flipH = !!t.flipH;
      const flipV = !!t.flipV;
      // Compute the renderer's drawScale: the renderer letterboxes inside the
      // base canvas so the source fits without distortion.
      const rad = rot * Math.PI / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const outW = srcRect.w * cos + srcRect.h * sin;
      const outH = srcRect.w * sin + srcRect.h * cos;
      const drawScale = Math.min(c.width / outW, c.height / outH);
      const forward = (sx, sy) => {
        let x = sx - srcRect.x - srcRect.w / 2;
        let y = sy - srcRect.y - srcRect.h / 2;
        if (flipH) x = -x;
        if (flipV) y = -y;
        x *= drawScale; y *= drawScale;
        if (rot) {
          const cs = Math.cos(rad); const sn = Math.sin(rad);
          const rx = x * cs - y * sn;
          const ry = x * sn + y * cs;
          x = rx; y = ry;
        }
        x += c.width / 2;
        y += c.height / 2;
        return { x, y };
      };
      const corners = [
        forward(src.x, src.y),
        forward(src.x + src.w, src.y),
        forward(src.x + src.w, src.y + src.h),
        forward(src.x, src.y + src.h),
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of corners) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return {
        x: Math.max(0, Math.floor(minX)),
        y: Math.max(0, Math.floor(minY)),
        w: Math.max(1, Math.ceil(maxX - minX)),
        h: Math.max(1, Math.ceil(maxY - minY)),
      };
    })();
  }, { id, src });
}

test('preview: pixelate creates per-block uniformity inside the redact region', async ({ page }) => {
  await resetApp(page);
  // 200×100 with a sharp red/blue boundary at x=100. After pixelate with
  // strength=8, each ~8x8 block should be a single uniform color — even
  // though the underlying region had a high-contrast seam.
  const id = await importTwoHalves(page, 200, 100, '#ff0000', '#0000ff');
  await openInEditor(page, id);

  const srcRect = { x: 70, y: 30, w: 60, h: 40 };
  const sampleRect = await redactRectInCanvasPx(page, id, srcRect);

  await addRedact(page, id, srcRect.x, srcRect.y, srcRect.w, srcRect.h, 'pixelate', 8);

  // Verify two close-together pixels (within 2px of each other) inside the
  // redact region are identical — they must fall within the same block,
  // since each block is ~8px wide on the canvas.
  // Also verify a pixel CLOSE to the seam is no longer pure red/blue: at
  // least one block straddling the seam must blend to an intermediate
  // color.
  const samples = await page.evaluate(({ sr }) => {
    const c = document.getElementById('base-canvas');
    const ctx = c.getContext('2d');
    const px = (x, y) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    // Two pixels 1px apart in the top-left corner of the redact rect.
    const a1 = px(sr.x + 2, sr.y + 2);
    const a2 = px(sr.x + 3, sr.y + 3);
    // Scan blocks across the rect's middle row for any intermediate r/b
    // values (no longer pure red or pure blue).
    let foundBlend = false;
    for (let dx = 4; dx < sr.w - 4; dx += 2) {
      const p = px(sr.x + dx, sr.y + Math.floor(sr.h / 2));
      const isPureRed = p[0] > 240 && p[2] < 30;
      const isPureBlue = p[2] > 240 && p[0] < 30;
      if (!isPureRed && !isPureBlue) { foundBlend = true; break; }
    }
    return { a1, a2, foundBlend };
  }, { sr: sampleRect });

  // Same-block uniformity check.
  expect(samples.a1).toEqual(samples.a2);
  // Blend check — some block on the seam must be an averaged color.
  expect(samples.foundBlend).toBe(true);
});

test('preview: blur destroys the high-frequency edge between two colors', async ({ page }) => {
  await resetApp(page);
  const id = await importTwoHalves(page, 200, 100, '#ff0000', '#0000ff');
  await openInEditor(page, id);

  const srcRect = { x: 70, y: 30, w: 60, h: 40 };
  const sampleRect = await redactRectInCanvasPx(page, id, srcRect);

  await addRedact(page, id, srcRect.x, srcRect.y, srcRect.w, srcRect.h, 'blur', 12);

  // Sample the center of the redact rect — after blur it should be a
  // blend of red and blue (purple-ish) rather than pure red or pure blue.
  const center = await page.evaluate(({ sr }) => {
    const c = document.getElementById('base-canvas');
    const ctx = c.getContext('2d');
    const cx = Math.round(sr.x + sr.w / 2);
    const cy = Math.round(sr.y + sr.h / 2);
    const d = ctx.getImageData(cx, cy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, { sr: sampleRect });

  // After blur, the center pixel is on the seam — both channels must be
  // pulled away from their extremes.
  expect(center[0]).toBeGreaterThan(20);
  expect(center[0]).toBeLessThan(220);
  expect(center[2]).toBeGreaterThan(20);
  expect(center[2]).toBeLessThan(220);
});

test('export: pixelate is baked into the output PNG', async ({ page }) => {
  await resetApp(page);
  const id = await importTwoHalves(page, 200, 100, '#ff0000', '#0000ff');
  await openInEditor(page, id);
  await addRedact(page, id, 70, 30, 60, 40, 'pixelate', 8);

  // Export and decode the PNG; sample three points within the redact
  // region. With pixelate strength 8 over a 60×40 rect we get ~7×5 blocks;
  // samples 8px apart within the region should hit DIFFERENT blocks and
  // thus mix red/blue/purple, but two samples WITHIN the same ~8x8 block
  // must be identical.
  const result = await page.evaluate(async (id) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { getState } = await import('/js/state.js');
    const { renderForExport } = await import('/js/render/exportRenderer.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    await lifecycle.ensureBitmap(id);
    const blob = await renderForExport(getState().images[id], { format: 'image/png', quality: 1 }, caps, lifecycle);
    const decoded = await createImageBitmap(blob);
    const dc = document.createElement('canvas');
    dc.width = decoded.width;
    dc.height = decoded.height;
    const dctx = dc.getContext('2d');
    dctx.drawImage(decoded, 0, 0);
    // Sample two pairs inside the redact rect (x:70..130, y:30..70).
    // Pair A is within a single ~8x8 block; pair B straddles two blocks.
    // Block coords are anchored at the rect's top-left (70, 30).
    const samplePixel = (x, y) => {
      const d = dctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    };
    // Sample three internal points + one outside-the-redact point.
    const inA1 = samplePixel(72, 32);
    const inA2 = samplePixel(73, 33);  // same ~8x8 block as inA1
    const inB  = samplePixel(125, 65); // far corner of the redact rect
    const outsideLeft  = samplePixel(20, 50);  // far left, untouched red
    const outsideRight = samplePixel(180, 50); // far right, untouched blue
    decoded.close && decoded.close();
    return { inA1, inA2, inB, outsideLeft, outsideRight, w: dc.width, h: dc.height };
  }, id);

  // Outside the redact region: untouched red and blue.
  expect(result.outsideLeft.r).toBeGreaterThan(200);
  expect(result.outsideLeft.b).toBeLessThan(60);
  expect(result.outsideRight.b).toBeGreaterThan(200);
  expect(result.outsideRight.r).toBeLessThan(60);

  // Within the redact region: pixels in the SAME block must match each
  // other byte-for-byte.
  expect(result.inA1.r).toBe(result.inA2.r);
  expect(result.inA1.g).toBe(result.inA2.g);
  expect(result.inA1.b).toBe(result.inA2.b);

  // The far-corner pixel inside the redact must be different from the
  // top-left-corner pixel of the redact (different block within the
  // pixelation grid).
  const sameAllChannels = (a, b) => a.r === b.r && a.g === b.g && a.b === b.b;
  expect(sameAllChannels(result.inA1, result.inB)).toBe(false);
});

test('export: blur is baked into the output PNG', async ({ page }) => {
  await resetApp(page);
  const id = await importTwoHalves(page, 200, 100, '#ff0000', '#0000ff');
  await openInEditor(page, id);
  await addRedact(page, id, 70, 30, 60, 40, 'blur', 12);

  const result = await page.evaluate(async (id) => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { getState } = await import('/js/state.js');
    const { renderForExport } = await import('/js/render/exportRenderer.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    await lifecycle.ensureBitmap(id);
    const blob = await renderForExport(getState().images[id], { format: 'image/png', quality: 1 }, caps, lifecycle);
    const decoded = await createImageBitmap(blob);
    const dc = document.createElement('canvas');
    dc.width = decoded.width;
    dc.height = decoded.height;
    const dctx = dc.getContext('2d');
    dctx.drawImage(decoded, 0, 0);
    const samplePixel = (x, y) => {
      const d = dctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    };
    // Center of the redact rect — should be blurred purple (NOT pure red
    // or pure blue).
    const center = samplePixel(100, 50);
    // Outside the redact, far from the seam.
    const farLeft = samplePixel(20, 50);
    const farRight = samplePixel(180, 50);
    decoded.close && decoded.close();
    return { center, farLeft, farRight };
  }, id);

  // The blurred center pixel sits on the seam. After ctx.filter blur it
  // mixes red and blue → roughly purple. Neither channel should be at
  // its untouched extreme: red should be well below 255, and blue should
  // be well above 0.
  expect(result.center.r).toBeLessThan(220);
  expect(result.center.b).toBeGreaterThan(35);
  // The non-redact sides remain saturated red / saturated blue.
  expect(result.farLeft.r).toBeGreaterThan(200);
  expect(result.farLeft.b).toBeLessThan(60);
  expect(result.farRight.b).toBeGreaterThan(200);
  expect(result.farRight.r).toBeLessThan(60);
});

test('preview: changing mode/strength on a selected redact updates live', async ({ page }) => {
  await resetApp(page);
  const id = await importTwoHalves(page, 200, 100, '#ff0000', '#0000ff');
  await openInEditor(page, id);

  // Add an initial redact and select it.
  await addRedact(page, id, 70, 30, 60, 40, 'pixelate', 4);
  await page.evaluate(async (id) => {
    const { update, getState } = await import('/js/state.js');
    const o = getState().images[id].overlays[0];
    update(s => { s.ui.selectedOverlayId = o.id; });
  }, id);

  // Sample two points within the redact rect that fell in different blocks
  // at strength 4 but should fall in the SAME block at strength 40.
  const baseDims = await page.evaluate(() => {
    const c = document.getElementById('base-canvas');
    return { w: c.width, h: c.height };
  });
  // Pick canvas-pixel sample points inside the rect.
  const samples = {
    p1: { x: baseDims.w * 0.45, y: baseDims.h * 0.45 },
    p2: { x: baseDims.w * 0.55, y: baseDims.h * 0.55 },
  };

  // Bump strength to 40 — this should make the whole region one block.
  await page.evaluate(async (id) => {
    const { update } = await import('/js/state.js');
    const { updateOverlay } = await import('/js/overlays.js');
    update(s => {
      const img = s.images[id];
      updateOverlay(img, img.overlays[0].id, { strength: 40 });
    });
  }, id);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  const after = await sampleBaseCanvas(page, samples);
  // At strength 40 the rect is collapsed into ~1-2 blocks; both samples
  // should be identical.
  expect(after.p1.r).toBe(after.p2.r);
  expect(after.p1.g).toBe(after.p2.g);
  expect(after.p1.b).toBe(after.p2.b);
});
