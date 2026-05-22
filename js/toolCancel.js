// js/toolCancel.js — dispatcher for "cancel in-progress action on the active tool."
//
// v1.1.1: Ctrl+Z and the Undo button should first try to cancel any
// in-progress action in the currently-active tool (e.g., an uncommitted
// eyedropper pick, a half-drawn crop rectangle) before falling through to
// history.undo(). This module is the indirection: shortcuts.js and
// editor.js call cancelActiveToolInProgress(); the tools register their
// cancel handlers here.
//
// Tools that have no in-progress state (Select, Pan, BgRemove mid-async)
// simply don't register, and the dispatcher returns false for them. That
// lets undo fall through cleanly.
//
// See v1.1.1 design §9.
import { getState } from './state.js';
import { cancelEyedropperTool } from './tools/eyedropperTool.js';

// Per-tool cancel functions. Each returns true if it had an in-progress
// action to cancel (caller should NOT proceed to history.undo()), false if
// the tool was idle.
const TOOL_CANCEL = Object.freeze({
  select:     () => false,
  pan:        () => false,
  crop:       () => false,   // TODO v1.1.2: cancel in-progress crop drag
  transform:  () => false,   // no in-flight gesture (rotate slider uses focus/blur)
  text:       () => false,   // TODO v1.1.2: discard uncommitted text edit
  brush:      () => false,   // TODO v1.1.2: discard unfinished stroke
  shape:      () => false,   // TODO v1.1.2: discard in-progress shape
  redact:     () => false,   // TODO v1.1.2: discard in-progress rect
  eyedropper: cancelEyedropperTool,
  'bg-remove': () => false,  // async in-flight op; don't try to cancel mid-stream
});

/**
 * If the active tool has an in-progress action, cancel it and return true.
 * Otherwise return false so the caller can fall through to history.undo().
 *
 * @returns {boolean} true = cancelled, false = nothing in flight
 */
export function cancelActiveToolInProgress() {
  const id = getState().ui?.activeTool;
  if (!id) return false;
  const fn = TOOL_CANCEL[id];
  if (typeof fn !== 'function') return false;
  try {
    return !!fn();
  } catch (err) {
    // A tool's cancel handler shouldn't throw, but if one does we don't
    // want to brick the undo flow. Log and let undo proceed.
    console.error('toolCancel: cancel handler threw for tool', id, err);
    return false;
  }
}
