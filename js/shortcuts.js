// js/shortcuts.js — global keyboard shortcuts for the editor.
//
// v1 shortcuts:
//   Ctrl/Cmd + Z              → undo
//   Ctrl/Cmd + Shift + Z      → redo
//   Ctrl + Y (Windows/Linux)  → redo
//
// Modifier detection uses (e.metaKey || e.ctrlKey) so Mac users get Cmd-Z
// while Windows / Linux users get Ctrl-Z. We don't differentiate on
// platform — both modifiers map to the same chord — matching browser
// convention.
//
// Focus check: when the active element is an <input>, <textarea>, <select>,
// or a contenteditable element, we IGNORE the shortcut so the browser's
// built-in undo (e.g., inside the text-overlay textarea) keeps working
// without us yanking it away to revert the previous global edit.
//
// initShortcuts() is idempotent so main.js can call it freely.

import { undo, redo } from './history.js';
import { cancelActiveToolInProgress } from './toolCancel.js';
import { activatePanTemporarily, deactivatePanTemporarily } from './tools/panTool.js';
import { getState } from './state.js';
import { cancelFindMode, hasUndoableRemove, undoLastRemove } from './dedupe.js';

let installed = false;
let detach = null;

/**
 * Install the global keydown handler. Returns a detach function that removes
 * it; the second call to initShortcuts is a no-op (returns the previous
 * detach). Tests call _resetForTest() to fully reset across runs.
 */
export function initShortcuts() {
  if (installed) return detach;
  installed = true;

  // Space-held pan accelerator. While Space is held, any tool's drag-on-canvas
  // becomes a pan instead of the tool's normal behavior. Matches Photoshop /
  // Figma muscle memory. Releasing Space restores the previous tool.
  let spaceHeld = false;

  const onKey = (e) => {
    // Space accelerator: process BEFORE the editing-target check, but skip if
    // the user is typing — they need Space for, well, spaces.
    if (e.code === 'Space' && !isEditingTarget(e.target)) {
      if (!spaceHeld) {
        spaceHeld = true;
        activatePanTemporarily();
      }
      e.preventDefault();
      return;
    }

    // Don't hijack typing in form controls or contenteditable.
    if (isEditingTarget(e.target)) return;

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // Normalise letter case — `key` is lowercase for plain `z`, uppercase
    // for shift-z. We just look at the lowercase form + shift flag.
    const k = (e.key || '').toLowerCase();

    if (k === 'z') {
      if (e.shiftKey) {
        if (redo()) {
          e.preventDefault();
          e.stopPropagation();
        }
      } else {
        // v1.1.1: undo first tries to cancel any in-progress action in the
        // active tool (e.g., an uncommitted eyedropper pick). Only if no
        // tool has in-flight state do we fall through to history.undo().
        // See js/toolCancel.js + design doc §9.
        //
        // v1.2 Feature 7: ALSO check dedupe find-mode. If the user has
        // entered find-duplicates mode without yet clicking Remove,
        // Ctrl+Z exits that mode (restores queue order + clears marks)
        // BEFORE falling through to in-tool cancel or global undo.
        // First priority: if dedupe has an undoable removal stashed,
        // restore it. Pop the snapshot, restore images at their queue
        // positions, re-enter find-mode. A second Ctrl+Z then falls to
        // the cancelFindMode branch below and exits find-mode entirely.
        if (hasUndoableRemove()) {
          undoLastRemove();
          e.preventDefault();
          e.stopPropagation();
        } else if (getState().dedupe.active) {
          cancelFindMode();
          e.preventDefault();
          e.stopPropagation();
        } else if (cancelActiveToolInProgress()) {
          e.preventDefault();
          e.stopPropagation();
        } else if (undo()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      return;
    }

    // Windows / Linux convention: Ctrl+Y also redoes.
    if (k === 'y' && !e.shiftKey) {
      if (redo()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };

  const onKeyUp = (e) => {
    if (e.code === 'Space' && spaceHeld) {
      spaceHeld = false;
      deactivatePanTemporarily();
    }
  };

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  detach = () => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKeyUp, true);
    if (spaceHeld) {
      spaceHeld = false;
      deactivatePanTemporarily();
    }
    installed = false;
    detach = null;
  };
  return detach;
}

// Element classification for the focus-ignore check.
function isEditingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    // Sliders, checkboxes, color-pickers etc. don't intercept undo — only
    // text-bearing input types do. Be permissive: anything text-like counts.
    const type = (el.type || '').toLowerCase();
    const textTypes = new Set([
      '', 'text', 'search', 'email', 'url', 'password', 'tel', 'number',
    ]);
    if (textTypes.has(type)) return true;
    return false;
  }
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

// Test-only reset hook so browser specs can re-initialise.
export function _resetForTest() {
  if (detach) {
    try { detach(); } catch { /* ignore */ }
  }
  installed = false;
  detach = null;
}
