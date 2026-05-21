// tests/browser/perf-budget.spec.js — initial page-weight budget +
// lazy-module discipline check (Phase 14).
//
// Two assertions per test run:
//   1. Total bytes transferred for the initial visit are under the budget.
//   2. None of the vendored "lazy" modules (bgremove, jspdf, heic, jszip)
//      were fetched as part of that initial visit.
//
// The dev server is a tiny static file server (scripts/serve.js) that does
// NOT gzip — so we measure encodedBodySize from the Resource Timing API,
// which corresponds to over-the-wire bytes. The number we're checking is
// the raw bytes the server actually sent. GitHub Pages serves these files
// gzipped, so production traffic will be smaller than these numbers, not
// larger. The budget is therefore a conservative upper bound.
import { test, expect } from '@playwright/test';

// Raw-bytes budget for the initial visit (no gzip on dev server). We grew
// past the original 600 KB target with v1.1 (compression UI, EXIF strip,
// trim, PDF export loader, HEIC loader); 1.2 MB raw is a comfortable
// ceiling that production gzip will compress down well below 800 KB wire.
const BUDGET_BYTES = 1_200_000;

// Path fragments that, if seen in the initial page-load network, indicate
// a lazy module leaked into the initial bundle.
const LAZY_PATHS = [
  '/js/vendor/bgremove/',
  '/js/vendor/jspdf/',
  '/js/vendor/heic/',
  '/js/vendor/jszip.min.js',
  '/js/vendor/onnxruntime-web/',
];

async function gatherInitialNetwork(page) {
  const requests = [];
  page.on('request', req => {
    requests.push({ url: req.url(), method: req.method() });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  // Give the engine a beat to finish any post-boot fetches before we read
  // the Resource Timing API — without this the tail of late-loading
  // requests (font subsets, idle prefetches) could land after our snapshot.
  await page.waitForTimeout(300);
  return requests;
}

async function gatherEncodedSizes(page) {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType('resource');
    return entries.map(e => ({
      name: e.name,
      encodedBodySize: e.encodedBodySize || 0,
      transferSize:    e.transferSize    || 0,
      type:            e.initiatorType,
    }));
  });
}

test('perf: initial page weight is under the budget (1.2 MB raw)', async ({ page }) => {
  await gatherInitialNetwork(page);
  const resources = await gatherEncodedSizes(page);

  // We sum encodedBodySize, which is the number of bytes in the HTTP message
  // payload after content encoding (gzip) but before content decoding —
  // i.e., bytes-on-the-wire. The dev server doesn't gzip, so on dev this is
  // the raw file size. transferSize includes response headers; we use
  // encodedBodySize for a cleaner comparison.
  let total = 0;
  for (const r of resources) total += r.encodedBodySize;

  // Add the document itself — the navigation request doesn't appear in the
  // resource buffer in all browsers (chromium does; webkit may not), so we
  // include it explicitly for a stable measurement.
  const docSize = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav ? (nav.encodedBodySize || nav.transferSize || 0) : 0;
  });
  total += docSize;

  console.log(`[perf] initial load wire bytes = ${total} (${(total/1024).toFixed(1)} KB)`);
  // Log top 10 contributors so future regressions are easy to diagnose.
  const sorted = [...resources].sort((a, b) => b.encodedBodySize - a.encodedBodySize).slice(0, 10);
  for (const r of sorted) {
    console.log(`  ${r.encodedBodySize.toString().padStart(8)} B  ${r.name.replace(/^https?:\/\/[^/]+/, '')}`);
  }

  expect(total).toBeLessThan(BUDGET_BYTES);
});

test('perf: lazy modules are NOT fetched on initial visit', async ({ page }) => {
  const requests = await gatherInitialNetwork(page);

  for (const lazy of LAZY_PATHS) {
    const hits = requests.filter(r => r.url.includes(lazy)).map(r => r.url);
    if (hits.length > 0) {
      console.error(`[perf] lazy path ${lazy} was fetched during initial visit:`);
      for (const h of hits) console.error(`  ${h}`);
    }
    expect(hits, `lazy module ${lazy} should not load on initial visit`).toEqual([]);
  }
});

test('perf: no third-party origin is contacted during initial visit', async ({ page }) => {
  // Privacy invariant: every request on first paint must hit our own origin.
  // GitHub Pages will serve from noadsphotos.com; locally that's localhost.
  // We allow data: and blob: schemes (Playwright + canvas internals use them).
  const requests = await gatherInitialNetwork(page);
  const offenders = requests.filter(r => {
    if (r.url.startsWith('data:')) return false;
    if (r.url.startsWith('blob:')) return false;
    const u = new URL(r.url);
    return u.host !== 'localhost:4173' && u.host !== 'noadsphotos.com';
  });
  if (offenders.length) {
    console.error('[perf] third-party requests on initial visit:');
    for (const o of offenders) console.error(`  ${o.method} ${o.url}`);
  }
  expect(offenders).toEqual([]);
});
