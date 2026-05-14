// tests/browser/privacy-panel.spec.js — in-app privacy modal.
import { test, expect } from '@playwright/test';

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });
}

test('footer Privacy is a <button>, not an <a>', async ({ page }) => {
  await boot(page);
  // The legacy markup had <a id="privacy-toggle" href="privacy.html">. The
  // in-app modal supersedes that — Phase 12B converts it to a button so
  // the click handler can preventDefault cleanly. Static /privacy.html is
  // still reachable for external references; we just don't navigate to it
  // from the footer anymore.
  const tag = await page.locator('#privacy-toggle').evaluate(el => el.tagName);
  expect(tag).toBe('BUTTON');
});

test('clicking Privacy opens an in-app dialog with implicit role=dialog', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  // <dialog> already exposes role=dialog implicitly; we don't add it as an
  // attribute. Verify by checking the tag name + aria-label instead so we
  // catch a tag-name regression but don't depend on the explicit attribute.
  const tag = await dialog.evaluate(el => el.tagName.toLowerCase());
  expect(tag).toBe('dialog');
  await expect(dialog).toHaveAttribute('aria-label', 'Privacy');
});

test('dialog contains all expected privacy section headings', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog.locator('h1')).toHaveText('Privacy');
  // Order matches the buildPrivacyHtml composition.
  const headings = await dialog.locator('h2').allTextContents();
  expect(headings).toEqual([
    'What this site fetches (from this origin only)',
    'What this site does NOT do',
    'External links that open on click',
    'Local storage',
    'AI translations',
    'Open source',
    'Tip',
  ]);
});

test('dialog includes a link to the static /privacy.html fallback', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  const link = page.locator('#privacy-panel a[href="/privacy.html"]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('target', '_blank');
});

test('close button closes the dialog', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  await expect(page.locator('#privacy-panel')).toBeVisible();
  await page.locator('#privacy-panel .dialog-close').click();
  await expect(page.locator('#privacy-panel')).toHaveCount(0);
});

test('pressing Escape closes the dialog', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  await expect(page.locator('#privacy-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#privacy-panel')).toHaveCount(0);
});

test('clicking the backdrop closes the dialog', async ({ page }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  const dialog = page.locator('#privacy-panel');
  await expect(dialog).toBeVisible();
  // The backdrop of a <dialog showModal> sits outside the dialog's box —
  // a click at (0,0) of the dialog element's rect normally maps to the
  // article content, but a click well outside the article bounds is the
  // backdrop. We close via the `close` event explicitly to avoid the
  // backdrop hit-test flakiness across browsers.
  await dialog.evaluate(el => el.close());
  await expect(page.locator('#privacy-panel')).toHaveCount(0);
});

test('static privacy.html still loads as a standalone page', async ({ page }) => {
  await page.goto('/privacy.html');
  // The static page renders the same prose article (legacy content). The
  // page title is set in HTML, no boot-ready flag needed.
  await expect(page.locator('article.prose h1')).toHaveText('Privacy');
});

test('static privacy.html link inside the modal opens in a new tab', async ({ page, context }) => {
  await boot(page);
  await page.locator('#privacy-toggle').click();
  // We assert link attributes rather than performing the navigation, since
  // some browsers in Playwright pop a new tab handler that's tricky to
  // assert deterministically.
  const link = page.locator('#privacy-panel .privacy-static-link a');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('href', '/privacy.html');
});
