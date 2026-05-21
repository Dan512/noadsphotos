// js/tools/bgRemoveTool.js — Remove background tool side panel.
//
// Unlike the other tools, bg-remove is a one-shot action rather than a
// persistent paint/select mode. When state.ui.activeTool === 'bg-remove' we
// own the Tool options panel with:
//   - A heading + brief explanation of what the action does
//   - Status text reflecting whether the active image has already been
//     processed (img.bgRemoved)
//   - An "Apply" / "Run again" button that calls applyBgRemove()
//   - A processing indicator while the model runs
//
// The lazy model load and the first-use consent modal both live inside
// js/ops/bgremove.js — this module is the thin UI shell.
//
// Why not a one-click action straight from the toolbar (i.e. activating the
// tool runs immediately)? Two reasons:
//   1) Pressing the model takes 1-10s on a desktop and longer on phones;
//      surfacing a Run button + status row gives a clear handle for cancel /
//      retry and matches the pattern other tools use.
//   2) The consent modal would fire from the toolbar button on first use,
//      which feels jarring — keeping the Apply button as the trigger lets
//      the user read the helper text first.
import { getState, subscribe } from '../state.js';
import { setToolPanel, clearToolPanel, getToolPanelBody } from '../editor.js';
import { applyBgRemove, hasStoredConsent } from '../ops/bgremove.js';
import { t } from '../i18n.js';

let active = false;
let processing = false;
let els = null; // { applyBtn, status, progressLabel }

export function initBgRemoveTool() {
  subscribe(handleStateChange);
  handleStateChange();
}

function handleStateChange() {
  const s = getState();
  const want = s.ui.view === 'editor' && s.ui.activeTool === 'bg-remove';
  if (want && !active) activate();
  else if (!want && active) deactivate();
  if (active) syncFromState();
}

function activate() {
  const body = getToolPanelBody();
  if (!body) return;
  active = true;
  renderPanel();
}

function deactivate() {
  active = false;
  els = null;
  processing = false;
  clearToolPanel({ owner: 'bg-remove' });
}

function renderPanel() {
  const root = document.createElement('div');
  root.className = 'bg-remove-panel';

  const heading = document.createElement('h2');
  heading.textContent = t('bgRemoveTitle');
  heading.className = 'panel-heading';
  root.appendChild(heading);

  const help = document.createElement('p');
  help.className = 'bg-remove-help';
  // Two variants — pre-consent vs post-consent — kept terse to match brand
  // voice (Patient · Honest · Specific).
  help.textContent = hasStoredConsent()
    ? t('bgRemoveHelpPostConsent')
    : t('bgRemoveHelpPreConsent');
  root.appendChild(help);

  const status = document.createElement('p');
  status.className = 'bg-remove-status';
  status.setAttribute('aria-live', 'polite');
  root.appendChild(status);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'bg-remove-apply btn-primary';
  applyBtn.textContent = t('bgRemoveApply');
  applyBtn.addEventListener('click', onApply);
  root.appendChild(applyBtn);

  const progressLabel = document.createElement('p');
  progressLabel.className = 'bg-remove-progress';
  progressLabel.setAttribute('aria-live', 'polite');
  progressLabel.hidden = true;
  root.appendChild(progressLabel);

  const undoHint = document.createElement('p');
  undoHint.className = 'bg-remove-undo-hint';
  undoHint.textContent = t('bgRemoveUndoHint');
  root.appendChild(undoHint);

  setToolPanel(root, { owner: 'bg-remove' });
  els = { applyBtn, status, progressLabel };
  syncFromState();
}

function getActiveImage() {
  const s = getState();
  const id = s.ui.activeImageId;
  if (!id) return null;
  return s.images[id] || null;
}

function syncFromState() {
  if (!els) return;
  const img = getActiveImage();
  const { applyBtn, status } = els;
  if (!img) {
    status.textContent = t('bgRemoveStatusNoImage');
    applyBtn.disabled = true;
    applyBtn.textContent = t('bgRemoveApply');
    return;
  }
  if (processing) {
    status.textContent = t('bgRemoveStatusProcessing');
    applyBtn.disabled = true;
    applyBtn.textContent = t('bgRemoveRemoving');
    return;
  }
  if (img.bgRemoved && img.bgMask) {
    status.textContent = t('bgRemoveStatusDone');
    applyBtn.disabled = false;
    applyBtn.textContent = t('bgRemoveRunAgain');
  } else {
    status.textContent = t('bgRemoveStatusIdle');
    applyBtn.disabled = false;
    applyBtn.textContent = t('bgRemoveApply');
  }
}

async function onApply() {
  const img = getActiveImage();
  if (!img || processing) return;
  processing = true;
  syncFromState();
  if (els && els.progressLabel) {
    els.progressLabel.hidden = false;
    els.progressLabel.textContent = t('bgRemoveLoadingModel');
  }
  try {
    await applyBgRemove(img.id, (stage, current, total) => {
      if (!els || !els.progressLabel) return;
      if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
        els.progressLabel.textContent = String(stage || t('bgRemoveLoadingModel'));
        return;
      }
      const pct = Math.round((current / total) * 100);
      els.progressLabel.textContent = t('bgRemoveProgressStage', { stage, percent: pct });
    });
  } finally {
    processing = false;
    if (els && els.progressLabel) {
      els.progressLabel.hidden = true;
      els.progressLabel.textContent = '';
    }
    syncFromState();
  }
}

// Test-only reset hook so browser specs can re-initialise.
export function _resetForTest() {
  active = false;
  processing = false;
  els = null;
}
