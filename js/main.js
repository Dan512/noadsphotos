// js/main.js — application boot. Synchronous imports for core; dynamic import for ML bg-removal.
import { probeCapabilities } from './capabilities.js';
import { showToast } from './errors.js';
import { createLifecycle } from './lifecycle.js';
import { initImporter } from './importer.js';
import { initQueueView, setQueueViewContext } from './queueView.js';
import { initViews } from './views.js';
import { initEditor } from './editor.js';
import { initBottomSheet } from './bottomSheet.js';
import { initPreviewRenderer } from './render/previewRenderer.js';
import { initSelectTool } from './tools/selectTool.js';
import { initPanTool } from './tools/panTool.js';
import { initCropTool } from './tools/cropTool.js';
import { initTransformTool } from './tools/transformTool.js';
import { initEyedropperTool } from './tools/eyedropperTool.js';
import { initTextTool } from './tools/textTool.js';
import { initBrushTool } from './tools/brushTool.js';
import { initShapeTool } from './tools/shapeTool.js';
import { initRedactTool } from './tools/redactTool.js';
import { initBgRemoveTool } from './tools/bgRemoveTool.js';
import { initShortcuts } from './shortcuts.js';
import { setExportContext } from './exporter.js';
import { initI18n, t } from './i18n.js';
import { initLanguagePicker } from './languagePicker.js';
import { initSettings } from './settings.js';
import { initPrivacy } from './privacy.js';

async function boot() {
  // Init i18n FIRST so the static DOM (topbar, footer) and every subsequent
  // render call sees translated strings.
  initI18n();

  // Settings BEFORE the editor renders so the stored theme is on
  // <html data-theme="…"> in time for the first paint (no flash of wrong
  // theme). The popover wiring itself depends only on the static DOM,
  // which exists by this point (settings-toggle was in the topbar).
  initSettings();
  // Privacy modal also only needs the static footer button.
  initPrivacy();

  const caps = await probeCapabilities();
  if (!caps.webp) {
    showToast(t('toastWebpUnsupported'), { variant: 'warn' });
  }

  const lifecycle = createLifecycle({
    decoder: (blob, opts) => createImageBitmap(blob, opts),
    closer: bitmap => bitmap.close(),
  });

  initViews();
  initQueueView();
  initEditor();
  // Bottom sheet must wire AFTER initEditor() — it queries the .editor-panel
  // and its <details> children which only exist once the editor shell has
  // mounted. CSS keeps the trigger and tab bar hidden outside the mobile
  // media query, so on desktop this is invisible (but the active-tab class
  // is harmless there).
  initBottomSheet();
  initImporter(caps, lifecycle);
  initPreviewRenderer(lifecycle, caps);
  // Exporter needs lifecycle + caps refs so the Download button can act.
  setExportContext({ lifecycle, caps });
  // QueueView needs the same refs so it can re-render thumbnails after
  // batch operations (auto-refresh feature). Loose coupling — we don't
  // pull the exporter's context through, in case the two diverge later.
  setQueueViewContext({ lifecycle, caps });
  // Tools must initialise AFTER the editor mounts the side panel.
  initSelectTool();
  initPanTool();
  initCropTool();
  initTransformTool();
  initEyedropperTool(lifecycle);
  initTextTool();
  initBrushTool();
  initShapeTool();
  initRedactTool();
  initBgRemoveTool();
  // Global keyboard shortcuts (Ctrl/Cmd+Z, etc.).
  initShortcuts();
  // Language picker (depends on initI18n() above for the active code).
  initLanguagePicker();

  document.documentElement.dataset.bootReady = '1';
}

boot().catch(err => {
  console.error(err);
  showToast(t('toastBootFailed'), { variant: 'error' });
});
