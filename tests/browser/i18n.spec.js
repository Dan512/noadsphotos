// tests/browser/i18n.spec.js — i18n DOM + language picker behavior.
//
// What we verify here (in a real browser):
//   - applyDomTranslations() resolves [data-i18n] keys against EN.
//   - setLanguage() to a stub language falls back to EN strings.
//   - setLanguage('ar') flips <html dir> to rtl and lang to ar.
//   - The language picker UI opens, lists 15 entries, marks the active one,
//     and reloads the page when a different language is chosen.
//   - Missing keys show the `[?]key` dev hint.

import { test, expect } from '@playwright/test';

// Boot the app with a clean language preference. We add an initScript that
// clears the language-pref key only ONCE per page navigation (it self-disarms
// by setting a flag) so that follow-up reload()s honor whatever language the
// user picked.
async function bootClean(page) {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__i18nTestArmed__')) {
        localStorage.removeItem('noadsimages_lang');
        sessionStorage.setItem('__i18nTestArmed__', '1');
      }
    } catch { /* ignore */ }
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

test('static markup translations apply on boot', async ({ page }) => {
  await bootClean(page);
  // The settings button has data-i18n="settings" + data-i18n-attr="aria-label".
  const settings = page.locator('#settings-toggle');
  await expect(settings).toHaveAttribute('aria-label', 'Settings');
  // The Tip button uses Change 6's full-on-desktop, short-on-mobile span
  // pattern. We assert against the full span so the test works on desktop
  // viewports (the default Playwright projects' viewport widths exceed
  // the 480px mobile-tip breakpoint).
  await expect(page.locator('a.btn-tip .tip-full')).toHaveText('Support this site');
  // Privacy link.
  await expect(page.locator('#privacy-toggle')).toHaveText('Privacy');
});

test('setLanguage("en") leaves DOM untouched (strings stay English)', async ({ page }) => {
  await bootClean(page);
  await page.evaluate(async () => {
    const { setLanguage } = await import('/js/i18n.js');
    setLanguage('en');
  });
  await expect(page.locator('a.btn-tip .tip-full')).toHaveText('Support this site');
});

test('setLanguage to a stub language falls back to EN strings', async ({ page }) => {
  await bootClean(page);
  await page.evaluate(async () => {
    const { setLanguage } = await import('/js/i18n.js');
    setLanguage('es');
  });
  // Spanish dict is empty in v1 — falls back to EN.
  // The Tip button now uses Change 6's full-on-desktop, short-on-mobile
  // span pattern. We assert against the full span so the test works on
  // desktop viewports (the default Playwright projects' viewport widths
  // exceed the 480px mobile-tip breakpoint).
  await expect(page.locator('a.btn-tip .tip-full')).toHaveText('Support this site');
  await expect(page.locator('#settings-toggle')).toHaveAttribute('aria-label', 'Settings');
});

test('setLanguage("ar") sets <html dir> to rtl', async ({ page }) => {
  await bootClean(page);
  await page.evaluate(async () => {
    const { setLanguage } = await import('/js/i18n.js');
    setLanguage('ar');
  });
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
});

test('setLanguage("en") sets <html dir> back to ltr', async ({ page }) => {
  await bootClean(page);
  await page.evaluate(async () => {
    const { setLanguage } = await import('/js/i18n.js');
    setLanguage('ar');
    setLanguage('en');
  });
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('t() returns "[?]key" for a missing key (dev hint)', async ({ page }) => {
  await bootClean(page);
  const result = await page.evaluate(async () => {
    const { t } = await import('/js/i18n.js');
    return t('this_key_does_not_exist');
  });
  expect(result).toBe('[?]this_key_does_not_exist');
});

test('language picker opens on click', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  await expect(page.locator('.language-popover')).toBeVisible();
});

test('language picker lists 15 entries with flag images', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  const rows = page.locator('.language-popover .language-row');
  await expect(rows).toHaveCount(15);
  // Each row carries a data-lang attribute matching a known code.
  const codes = await rows.evaluateAll(els => els.map(el => el.dataset.lang));
  expect(codes).toEqual([
    'en', 'es', 'de', 'fr', 'it', 'pt', 'nl', 'pl',
    'ja', 'zh-CN', 'ko', 'ru', 'ar', 'hi', 'tr',
  ]);
});

test('language picker marks the currently-active language', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  // Default after a clean boot is whatever navigator.language detected —
  // the playwright defaults to en-US, so 'en' should be active.
  const active = page.locator('.language-popover .language-row.is-active');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute('data-lang', 'en');
});

test('clicking outside the language popover closes it', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  await expect(page.locator('.language-popover')).toBeVisible();
  // Click on the topbar wordmark — outside the popover, not an interactive
  // element. Previously this test clicked on body at y=200, but the queue
  // intro section now occupies that vertical range and would swallow the
  // click on mobile Safari hit-testing.
  await page.locator('.topbar .wordmark').click();
  await expect(page.locator('.language-popover')).toHaveCount(0);
});

test('pressing Escape closes the language popover', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  await expect(page.locator('.language-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.language-popover')).toHaveCount(0);
});

test('clicking a language row persists the choice and reloads', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  // Wait for navigation to settle after the click triggers reload().
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.locator('.language-row[data-lang="de"]').click(),
  ]);
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  const stored = await page.evaluate(() => localStorage.getItem('noadsimages_lang'));
  expect(stored).toBe('de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});

test('setting language to ar via picker flips html dir on next load', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.locator('.language-row[data-lang="ar"]').click(),
  ]);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl', { timeout: 5000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
});

// --- Topbar flag (Change 2) ----------------------------------------------

test('lang-toggle button shows the flag of the current language', async ({ page }) => {
  await bootClean(page);
  const src = await page.locator('#lang-toggle img.lang-flag').getAttribute('src');
  // Default boot → en. The flag src should resolve to /img/flags/en.png.
  expect(src).toBe('/img/flags/en.png');
});

test('lang-toggle flag updates after switching language', async ({ page }) => {
  await bootClean(page);
  await page.locator('#lang-toggle').click();
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.locator('.language-row[data-lang="de"]').click(),
  ]);
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  const src = await page.locator('#lang-toggle img.lang-flag').getAttribute('src');
  expect(src).toBe('/img/flags/de.png');
});

test('lang-toggle flag falls back to en.png when language has no flag', async ({ page }) => {
  // Pre-seed Turkish — which is intentionally without a flag PNG in v1.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('noadsimages_lang', 'tr');
      sessionStorage.setItem('__i18nTestArmed__', '1');
    } catch { /* ignore */ }
  });
  // Capture console warnings so we can assert the fallback warning fired.
  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
  // Wait for the onerror fallback to kick in.
  await expect.poll(async () => {
    return await page.locator('#lang-toggle img.lang-flag').getAttribute('src');
  }, { timeout: 2000 }).toBe('/img/flags/en.png');
  expect(warnings.some(w => /flag for "tr" not found/.test(w))).toBe(true);
});
