// js/pointer.js — normalize mouse/touch/pen interactions through PointerEvents.
//
// One thin wrapper. No policy. Tools layer (Phase 4+) interprets the events.
//
// Responsibilities:
//   - Translate PointerEvent → a normalized {id, x, y, kind, pressure, ...} shape.
//   - Track which pointers are "down" so move events route to either `move`
//     (if currently captured) or `hover` (otherwise).
//   - Set `el.setPointerCapture()` so drags survive the cursor leaving the
//     element — Capture continues to deliver move events even when the
//     pointer is over a child or outside the bounds of the element.
//   - Apply `touch-action: none` on attach (restored on detach) so the
//     browser doesn't steal touch gestures (pan/zoom) from the canvas.
//   - Return a detach function that removes every listener and restores
//     the previous style.

export function attachPointer(el, handlers = {}) {
  if (!el) throw new Error('attachPointer: element is required');

  // Preserve any user-set inline touch-action so we can restore it.
  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = 'none';

  // Pointer ids currently in a "down" state on this element. We track this
  // because a pointermove between down and up should fire `move`, otherwise
  // it should fire `hover` (if provided).
  const captured = new Set();

  function normalize(e) {
    const rect = el.getBoundingClientRect();
    return {
      id: e.pointerId,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      clientX: e.clientX,
      clientY: e.clientY,
      pressure: e.pressure,
      kind: e.pointerType || 'mouse',
      buttons: e.buttons,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      isPrimary: e.isPrimary,
      raw: e,
    };
  }

  function onDown(e) {
    // Attempt to capture; some browsers reject if the element is not
    // attached / disabled — swallow that case rather than throw.
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    captured.add(e.pointerId);
    if (handlers.down) handlers.down(normalize(e));
  }

  function onMove(e) {
    if (captured.has(e.pointerId)) {
      if (handlers.move) handlers.move(normalize(e));
    } else if (handlers.hover) {
      handlers.hover(normalize(e));
    }
  }

  function onUp(e) {
    const wasCaptured = captured.has(e.pointerId);
    captured.delete(e.pointerId);
    try { el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    // Only fire `up` if this pointer was actually in a down state for us.
    // Stray pointerup (e.g. mouse releasing after capture was lost) is
    // ignored so consumers don't see phantom releases.
    if (wasCaptured && handlers.up) handlers.up(normalize(e));
  }

  function onCancel(e) {
    const wasCaptured = captured.has(e.pointerId);
    captured.delete(e.pointerId);
    try { el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (wasCaptured && handlers.cancel) handlers.cancel(normalize(e));
  }

  el.addEventListener('pointerdown',   onDown);
  el.addEventListener('pointermove',   onMove);
  el.addEventListener('pointerup',     onUp);
  el.addEventListener('pointercancel', onCancel);

  // Detach function: remove listeners, restore previous touch-action.
  return function detach() {
    el.removeEventListener('pointerdown',   onDown);
    el.removeEventListener('pointermove',   onMove);
    el.removeEventListener('pointerup',     onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.style.touchAction = prevTouchAction;
    captured.clear();
  };
}
