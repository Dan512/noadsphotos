// tests/browser/a11y.spec.js — axe-core accessibility scans (Phase 14).
//
// Runs axe against:
//   1. The empty-state landing (intro + drop zone visible, no images loaded).
//   2. The editor view with a test image loaded and the side panel open.
//   3. The privacy modal opened.
//   4. The settings popover opened.
//
// We fail the run on `serious` + `critical` violations. Moderate/minor issues
// are logged via console.log so a future cleanup pass can pick them up but
// they don't gate releases — the editor canvas + native scrollbars sometimes
// produce moderate-level warnings that don't reflect real-user impact.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const FAIL_IMPACTS = new Set(['critical', 'serious']);

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

async function importTestImage(page) {
  await page.evaluate(async () => {
    const { probeCapabilities } = await import('/js/capabilities.js');
    const { createLifecycle } = await import('/js/lifecycle.js');
    const { importFiles } = await import('/js/importer.js');
    const { setExportContext } = await import('/js/exporter.js');
    const { setQueueViewContext } = await import('/js/queueView.js');
    const caps = await probeCapabilities();
    const lifecycle = createLifecycle({
      decoder: (b, o) => createImageBitmap(b, o),
      closer: bm => bm.close(),
    });
    setExportContext({ lifecycle, caps });
    setQueueViewContext({ lifecycle, caps });
    const c = document.createElement('canvas');
    c.width = 120; c.height = 90;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#445566';
    ctx.fillRect(0, 0, 120, 90);
    const blob = await new Promise(r => c.toBlob(r, 'image/png', 1));
    await importFiles([new File([blob], 'test.png', { type: 'image/png' })], caps, lifecycle);
  });
}

function summarize(results) {
  const blockers = results.violations.filter(v => FAIL_IMPACTS.has(v.impact || ''));
  const lower = results.violations.filter(v => !FAIL_IMPACTS.has(v.impact || ''));
  return { blockers, lower };
}

test('a11y: empty state has no critical or serious violations', async ({ page }) => {
  await boot(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const { blockers, lower } = summarize(results);
  if (lower.length) {
    console.log('[a11y empty] non-blocking violations:', lower.map(v => `${v.id} (${v.impact})`));
  }
  if (blockers.length) {
    console.error('[a11y empty] blocking violations:');
    for (const v of blockers) {
      console.error(`  ${v.id} (${v.impact}): ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) console.error(`    ${n.target.join(' ')}`);
    }
  }
  expect(blockers).toEqual([]);
});

test('a11y: editor view with image loaded has no critical or serious violations', async ({ page }) => {
  await boot(page);
  await importTestImage(page);
  // Click the first thumbnail to open the editor.
  await page.locator('#queue-view .queue-thumb').first().click();
  await expect(page.locator('#editor-view')).toBeVisible();
  await expect.poll(async () => {
    return await page.evaluate(() => document.getElementById('base-canvas')?.width || 0);
  }, { timeout: 3000 }).toBeGreaterThan(0);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // The canvases are inherently opaque to AT — they're application graphics
    // that have keyboard pointer alternatives via the tool panel. Exclude
    // them from axe scans rather than fight false positives.
    .exclude('#base-canvas')
    .exclude('#overlay-canvas')
    .analyze();
  const { blockers, lower } = summarize(results);
  if (lower.length) {
    console.log('[a11y editor] non-blocking violations:', lower.map(v => `${v.id} (${v.impact})`));
  }
  if (blockers.length) {
    console.error('[a11y editor] blocking violations:');
    for (const v of blockers) {
      console.error(`  ${v.id} (${v.impact}): ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) console.error(`    ${n.target.join(' ')}`);
    }
  }
  expect(blockers).toEqual([]);
});

test('a11y: privacy modal has no critical or serious violations', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  await expect(page.locator('#privacy-panel')).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const { blockers, lower } = summarize(results);
  if (lower.length) {
    console.log('[a11y privacy] non-blocking violations:', lower.map(v => `${v.id} (${v.impact})`));
  }
  if (blockers.length) {
    console.error('[a11y privacy] blocking violations:');
    for (const v of blockers) {
      console.error(`  ${v.id} (${v.impact}): ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) console.error(`    ${n.target.join(' ')}`);
    }
  }
  expect(blockers).toEqual([]);
});

test('a11y: settings popover has no critical or serious violations', async ({ page }) => {
  await boot(page);
  await page.locator('#settings-toggle').click();
  // The popover renders into the body — find it.
  await expect(page.locator('.settings-popover, #settings-popover, [data-settings-popover]').first()).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const { blockers, lower } = summarize(results);
  if (lower.length) {
    console.log('[a11y settings] non-blocking violations:', lower.map(v => `${v.id} (${v.impact})`));
  }
  if (blockers.length) {
    console.error('[a11y settings] blocking violations:');
    for (const v of blockers) {
      console.error(`  ${v.id} (${v.impact}): ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) console.error(`    ${n.target.join(' ')}`);
    }
  }
  expect(blockers).toEqual([]);
});

test('a11y: prefers-reduced-motion zeroes animation durations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  // --dur-fast / --dur-med / --dur-slow should evaluate to "0ms" under the
  // reduced-motion media query (defined in style.css).
  const durations = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      fast: cs.getPropertyValue('--dur-fast').trim(),
      med:  cs.getPropertyValue('--dur-med').trim(),
      slow: cs.getPropertyValue('--dur-slow').trim(),
    };
  });
  expect(durations.fast).toBe('0ms');
  expect(durations.med).toBe('0ms');
  expect(durations.slow).toBe('0ms');
});

test('a11y: keyboard Tab walks through topbar, footer, and skips hidden views', async ({ page }) => {
  await boot(page);
  // Tab from the empty document focus and collect what gets focused. Cap the
  // walk at 20 stops — enough to traverse the topbar + queue + footer with
  // headroom — so we don't loop forever if focus traps somewhere.
  await page.evaluate(() => document.body.focus());
  const stops = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return null;
      // Compact ID — use id, then class, then tagName.
      const cls = a.className && typeof a.className === 'string' ? `.${a.className.split(/\s+/)[0]}` : '';
      return `${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}${cls}`;
    });
    if (id) stops.push(id);
  }
  // We expect: lang, theme, settings toggles, tip button (topbar) → at least
  // one button inside #queue-view (the empty-state click-to-browse) → footer
  // links. Hidden editor-view must not contribute any focusable element.
  const ids = stops.join('|');
  expect(ids).toMatch(/lang-toggle/);
  expect(ids).toMatch(/theme-toggle/);
  expect(ids).toMatch(/settings-toggle/);
  expect(ids).toMatch(/privacy-toggle/);
  // Editor view is hidden with the `hidden` attribute — nothing inside should
  // be in the tab order.
  expect(ids).not.toMatch(/base-canvas/);
  expect(ids).not.toMatch(/back-to-queue/);
});
