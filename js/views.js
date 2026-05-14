// js/views.js — toggles which view section is visible based on state.ui.view.
//
// Owns the single source of truth for which top-level <section> is visible:
// '#queue-view' when state.ui.view === 'queue', '#editor-view' otherwise.
// Subscribes to state and reapplies the `hidden` attribute on each change.
import { getState, subscribe } from './state.js';

export function initViews() {
  const queueEl  = document.getElementById('queue-view');
  const editorEl = document.getElementById('editor-view');
  if (!queueEl || !editorEl) return;

  function render() {
    const view = getState().ui.view;
    queueEl.hidden  = view !== 'queue';
    editorEl.hidden = view !== 'editor';
  }

  render();
  subscribe(render);
}
