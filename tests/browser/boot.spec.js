import { test, expect } from '@playwright/test';

test('boot completes and sets data-boot-ready within 1s', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-boot-ready', '1', { timeout: 1000 });
});
