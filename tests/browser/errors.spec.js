import { test, expect } from '@playwright/test';

// Clear any existing toast-root before each test so toasts don't accumulate across tests
async function cleanRoot(page) {
  await page.evaluate(() => {
    const root = document.getElementById('toast-root');
    if (root) root.remove();
  });
}

test('showToast adds a .toast element with the message and role="status"', async ({ page }) => {
  await page.goto('/');
  await cleanRoot(page);
  await page.evaluate(async () => {
    const m = await import('/js/errors.js');
    m.showToast('hello', { duration: 0 });
  });
  const toast = page.locator('#toast-root .toast').first();
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toContainText('hello');
});

test('variant: warn produces role="alert" and class toast-warn', async ({ page }) => {
  await page.goto('/');
  await cleanRoot(page);
  await page.evaluate(async () => {
    const m = await import('/js/errors.js');
    m.showToast('warning', { variant: 'warn', duration: 0 });
  });
  const toast = page.locator('#toast-root .toast').first();
  await expect(toast).toHaveAttribute('role', 'alert');
  await expect(toast).toHaveClass(/toast-warn/);
});

test('variant: error produces role="alert" and class toast-error', async ({ page }) => {
  await page.goto('/');
  await cleanRoot(page);
  await page.evaluate(async () => {
    const m = await import('/js/errors.js');
    m.showToast('boom', { variant: 'error', duration: 0 });
  });
  const toast = page.locator('#toast-root .toast').first();
  await expect(toast).toHaveAttribute('role', 'alert');
  await expect(toast).toHaveClass(/toast-error/);
});

test('toast auto-dismisses after the specified duration', async ({ page }) => {
  await page.goto('/');
  await cleanRoot(page);
  await page.evaluate(async () => {
    const m = await import('/js/errors.js');
    m.showToast('temporary', { duration: 200 });
  });
  // Verify the toast was added first
  const toast = page.locator('#toast-root .toast');
  await expect(toast).toHaveCount(1);
  // Now wait for it to auto-dismiss
  await expect(toast).toHaveCount(0, { timeout: 1000 });
});

test('clicking .toast-close dismisses the toast immediately', async ({ page }) => {
  await page.goto('/');
  await cleanRoot(page);
  await page.evaluate(async () => {
    const m = await import('/js/errors.js');
    m.showToast('click me', { duration: 0 });
  });
  const toast = page.locator('#toast-root .toast');
  await expect(toast).toHaveCount(1);
  await page.locator('#toast-root .toast .toast-close').first().click();
  await expect(toast).toHaveCount(0);
});

test('XSS: HTML-like content is rendered as escaped text, not as raw HTML', async ({ page }) => {
  await page.goto('/');
  await cleanRoot(page);
  // Capture any unexpected dialogs (which would indicate XSS triggered)
  let dialogTriggered = false;
  page.on('dialog', async (dialog) => {
    dialogTriggered = true;
    await dialog.dismiss();
  });

  await page.evaluate(async () => {
    const m = await import('/js/errors.js');
    m.showToast('<script>alert(1)</script>', { duration: 0 });
  });

  const toast = page.locator('#toast-root .toast').first();
  await expect(toast).toBeVisible();

  // Verify no <script> element appeared inside the toast
  const scriptCount = await page.locator('#toast-root .toast script').count();
  expect(scriptCount).toBe(0);

  // Verify the literal text is present
  await expect(toast).toContainText('<script>alert(1)</script>');

  // And no alert dialog fired
  expect(dialogTriggered).toBe(false);
});

test('returned dismiss function removes the toast', async ({ page }) => {
  await page.goto('/');
  await cleanRoot(page);
  await page.evaluate(async () => {
    const m = await import('/js/errors.js');
    const dismiss = m.showToast('manual', { duration: 0 });
    // Stash dismiss on window so we can call it from the next evaluate
    window.__dismiss = dismiss;
  });
  const toast = page.locator('#toast-root .toast');
  await expect(toast).toHaveCount(1);

  await page.evaluate(() => window.__dismiss());
  await expect(toast).toHaveCount(0);
});
