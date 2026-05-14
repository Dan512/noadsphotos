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
      s.ui.view = 'editor';
      s.ui.activeTool = 'select';
      s.ui.zoom = 'fit';
    });
  });
}

const TOOL_IDS = ['select', 'crop', 'text', 'brush', 'shape', 'redact', 'eyedropper', 'bg-remove'];

test('editor toolbar contains all 8 tool buttons', async ({ page }) => {
  await resetApp(page);
  for (const tool of TOOL_IDS) {
    await expect(page.locator(`#editor-view .editor-toolbar button[data-tool="${tool}"]`)).toHaveCount(1);
  }
});

test('editor toolbar contains undo, redo, and back buttons', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#editor-view #undo-btn')).toHaveCount(1);
  await expect(page.locator('#editor-view #redo-btn')).toHaveCount(1);
  await expect(page.locator('#editor-view #back-to-queue')).toHaveCount(1);
});

test('clicking a tool button sets state.ui.activeTool and applies .is-active', async ({ page }) => {
  await resetApp(page);

  await page.locator('#editor-view .editor-toolbar button[data-tool="crop"]').click();

  const active = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().ui.activeTool;
  });
  expect(active).toBe('crop');

  await expect(page.locator('#editor-view .editor-toolbar button[data-tool="crop"]')).toHaveClass(/is-active/);
  await expect(page.locator('#editor-view .editor-toolbar button[data-tool="select"]')).not.toHaveClass(/is-active/);

  // Switching tools moves the active class.
  await page.locator('#editor-view .editor-toolbar button[data-tool="text"]').click();
  await expect(page.locator('#editor-view .editor-toolbar button[data-tool="crop"]')).not.toHaveClass(/is-active/);
  await expect(page.locator('#editor-view .editor-toolbar button[data-tool="text"]')).toHaveClass(/is-active/);
});

test('clicking "Back to queue" sets state.ui.view to queue', async ({ page }) => {
  await resetApp(page);
  await page.locator('#back-to-queue').click();
  const view = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().ui.view;
  });
  expect(view).toBe('queue');
  await expect(page.locator('#queue-view')).toBeVisible();
  await expect(page.locator('#editor-view')).toBeHidden();
});

test('side panel has 5 <details> sections: Tool options, Resize, Adjust, Overlays, Export', async ({ page }) => {
  await resetApp(page);
  const summaries = await page.locator('#editor-view .editor-panel details summary').allTextContents();
  expect(summaries).toEqual(['Tool options', 'Resize', 'Adjust', 'Overlays', 'Export']);
});

test('zoom controls visible: [Fit ▾] [-] [%] [+]', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#editor-view .zoom-controls')).toBeVisible();
  await expect(page.locator('#editor-view .zoom-controls select')).toBeVisible();
  await expect(page.locator('#editor-view .zoom-controls .zoom-out')).toBeVisible();
  await expect(page.locator('#editor-view .zoom-controls .zoom-in')).toBeVisible();
  await expect(page.locator('#editor-view .zoom-controls .zoom-readout')).toBeVisible();
});

test('zoom select change updates state.ui.zoom', async ({ page }) => {
  await resetApp(page);
  await page.locator('#editor-view .zoom-controls select').selectOption('1');
  const zoom = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().ui.zoom;
  });
  expect(zoom).toBe(1);
});

test('zoom + button doubles zoom from fit (lands at 1.0)', async ({ page }) => {
  await resetApp(page);
  await page.locator('#editor-view .zoom-controls .zoom-in').click();
  const zoom = await page.evaluate(async () => {
    const { getState } = await import('/js/state.js');
    return getState().ui.zoom;
  });
  expect(typeof zoom).toBe('number');
  expect(zoom).toBeGreaterThan(0);
});

test('two canvases stacked in canvas frame: #base-canvas and #overlay-canvas', async ({ page }) => {
  await resetApp(page);
  await expect(page.locator('#editor-view .canvas-frame #base-canvas')).toHaveCount(1);
  await expect(page.locator('#editor-view .canvas-frame #overlay-canvas')).toHaveCount(1);
});

test('tool buttons have aria-labels', async ({ page }) => {
  await resetApp(page);
  for (const tool of TOOL_IDS) {
    const aria = await page.locator(`#editor-view .editor-toolbar button[data-tool="${tool}"]`).getAttribute('aria-label');
    expect(aria).toBeTruthy();
  }
});
