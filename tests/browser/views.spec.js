import { test, expect } from '@playwright/test';

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
  });
}

test('initially queue-view is visible and editor-view is hidden', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#queue-view')).toBeVisible();
  await expect(page.locator('#editor-view')).toBeHidden();
});

test('setting state.ui.view to "editor" flips visibility (queue hidden, editor visible)', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.ui.view = 'editor'; });
  });
  await expect(page.locator('#queue-view')).toBeHidden();
  await expect(page.locator('#editor-view')).toBeVisible();
});

test('setting state.ui.view back to "queue" restores queue visibility', async ({ page }) => {
  await resetApp(page);
  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.ui.view = 'editor'; });
  });
  await expect(page.locator('#editor-view')).toBeVisible();

  await page.evaluate(async () => {
    const { update } = await import('/js/state.js');
    update(s => { s.ui.view = 'queue'; });
  });
  await expect(page.locator('#queue-view')).toBeVisible();
  await expect(page.locator('#editor-view')).toBeHidden();
});

test('hidden attribute is applied (not just CSS) so tab order skips the inactive view', async ({ page }) => {
  await resetApp(page);
  const queueHidden = await page.locator('#queue-view').evaluate(el => el.hidden);
  const editorHidden = await page.locator('#editor-view').evaluate(el => el.hidden);
  expect(queueHidden).toBe(false);
  expect(editorHidden).toBe(true);
});
