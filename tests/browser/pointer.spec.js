import { test, expect } from '@playwright/test';

// Helper: load the app shell and inject a known-size test surface into the
// page. Returns nothing — every test re-uses the same element with id
// `#pointer-target`. The element is intentionally offset (top: 50px, left:
// 80px) so coordinate-relative-to-element math is non-trivial.
async function setupPointerSurface(page) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-boot-ready', '1', { timeout: 5000 });

  await page.evaluate(() => {
    // Clear any previous test surface.
    const old = document.getElementById('pointer-target');
    if (old) old.remove();

    const div = document.createElement('div');
    div.id = 'pointer-target';
    Object.assign(div.style, {
      position: 'fixed',
      top: '50px',
      left: '80px',
      width: '300px',
      height: '200px',
      background: '#222',
      zIndex: '9999',
    });
    document.body.appendChild(div);

    // Each test installs its own attachPointer using window.__attach below;
    // we just provide the element here.
    window.__pointerEvents = [];
  });
}

// --------------------------------------------------------------------------
// Mouse: sequence of down → moves → up
// --------------------------------------------------------------------------

test('mouse: down → moves → up reports element-relative coords and fires in order', async ({ page }) => {
  await setupPointerSurface(page);
  await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    window.__events = [];
    window.__detach = attachPointer(el, {
      down:  e => window.__events.push({ name: 'down',  x: e.x, y: e.y, id: e.id, kind: e.kind, isPrimary: e.isPrimary, buttons: e.buttons }),
      move:  e => window.__events.push({ name: 'move',  x: e.x, y: e.y, id: e.id }),
      up:    e => window.__events.push({ name: 'up',    x: e.x, y: e.y, id: e.id }),
      hover: e => window.__events.push({ name: 'hover', x: e.x, y: e.y }),
    });
  });

  await page.mouse.move(100, 80);          // hover into element (20, 30)
  await page.mouse.down();                  // press at (20, 30)
  await page.mouse.move(120, 100);          // move to (40, 50)
  await page.mouse.move(150, 130);          // move to (70, 80)
  await page.mouse.up();                    // release

  const events = await page.evaluate(() => { window.__detach(); return window.__events; });

  // Filter just the "named" handler events, skipping pre-down hover noise so
  // the test isn't brittle to which mouse-move events the browser delivers.
  const sequence = events.map(e => e.name);
  expect(sequence).toContain('down');
  expect(sequence).toContain('up');
  // After 'down' we should see at least one 'move' before 'up'.
  const downIdx = sequence.indexOf('down');
  const upIdx = sequence.indexOf('up');
  expect(downIdx).toBeGreaterThanOrEqual(0);
  expect(upIdx).toBeGreaterThan(downIdx);
  const movesBetween = sequence.slice(downIdx + 1, upIdx).filter(n => n === 'move');
  expect(movesBetween.length).toBeGreaterThanOrEqual(1);

  // Verify element-relative coords on the down event.
  const downEvent = events.find(e => e.name === 'down');
  expect(downEvent.x).toBeCloseTo(20, 0);
  expect(downEvent.y).toBeCloseTo(30, 0);
  expect(downEvent.kind).toBe('mouse');
  expect(downEvent.isPrimary).toBe(true);
});

// --------------------------------------------------------------------------
// hover vs move routing
// --------------------------------------------------------------------------

test('hover fires when no pointer is down; move fires when pointer is down', async ({ page }) => {
  await setupPointerSurface(page);
  await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    window.__events = [];
    window.__detach = attachPointer(el, {
      down:  () => window.__events.push('down'),
      move:  () => window.__events.push('move'),
      up:    () => window.__events.push('up'),
      hover: () => window.__events.push('hover'),
    });
  });

  // First move into the element with no button pressed → hover.
  await page.mouse.move(100, 80);
  await page.mouse.move(120, 100);          // another hover

  let events = await page.evaluate(() => [...window.__events]);
  expect(events.filter(n => n === 'hover').length).toBeGreaterThanOrEqual(1);
  expect(events).not.toContain('move');

  // Press, then move → those should be `move`, not `hover`.
  await page.mouse.down();
  await page.mouse.move(150, 130);
  await page.mouse.move(180, 160);

  events = await page.evaluate(() => [...window.__events]);
  const downIdx = events.indexOf('down');
  expect(downIdx).toBeGreaterThanOrEqual(0);
  const afterDown = events.slice(downIdx + 1);
  // Between down and up we should see `move` events (no `hover`).
  expect(afterDown.filter(n => n === 'move').length).toBeGreaterThanOrEqual(1);
  expect(afterDown.filter(n => n === 'hover').length).toBe(0);

  await page.mouse.up();
  await page.evaluate(() => window.__detach());
});

test('hover handler not invoked when no hover callback provided (silently ignored)', async ({ page }) => {
  await setupPointerSurface(page);
  await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    window.__events = [];
    window.__detach = attachPointer(el, {
      // no hover handler
      down: () => window.__events.push('down'),
      move: () => window.__events.push('move'),
      up:   () => window.__events.push('up'),
    });
  });

  // Move without pressing → would have been hover; should produce nothing.
  await page.mouse.move(100, 80);
  await page.mouse.move(120, 100);

  const events = await page.evaluate(() => { window.__detach(); return window.__events; });
  expect(events.length).toBe(0);
});

// --------------------------------------------------------------------------
// Coordinate translation (element offset)
// --------------------------------------------------------------------------

test('x/y are relative to the element regardless of element position on page', async ({ page }) => {
  await setupPointerSurface(page);
  // Move the surface to a different offset to be sure the math uses
  // getBoundingClientRect rather than something cached at attach time.
  await page.evaluate(() => {
    const el = document.getElementById('pointer-target');
    el.style.top = '120px';
    el.style.left = '200px';
  });
  await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    window.__events = [];
    window.__detach = attachPointer(el, {
      down: e => window.__events.push({ x: e.x, y: e.y, clientX: e.clientX, clientY: e.clientY }),
    });
  });

  // Click at page coord (250, 150). Element starts at (200, 120) → (50, 30).
  await page.mouse.move(250, 150);
  await page.mouse.down();
  await page.mouse.up();

  const events = await page.evaluate(() => { window.__detach(); return window.__events; });
  expect(events.length).toBe(1);
  expect(events[0].x).toBeCloseTo(50, 0);
  expect(events[0].y).toBeCloseTo(30, 0);
  expect(events[0].clientX).toBeCloseTo(250, 0);
  expect(events[0].clientY).toBeCloseTo(150, 0);
});

// --------------------------------------------------------------------------
// Modifier key propagation
// --------------------------------------------------------------------------

test('modifier keys (shift, ctrl) flow through on down', async ({ page }) => {
  await setupPointerSurface(page);
  await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    window.__events = [];
    window.__detach = attachPointer(el, {
      down: e => window.__events.push({
        shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
      }),
    });
  });

  // Hold Shift+Control while clicking.
  await page.keyboard.down('Shift');
  await page.keyboard.down('Control');
  await page.mouse.move(100, 80);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.keyboard.up('Shift');

  const events = await page.evaluate(() => { window.__detach(); return window.__events; });
  expect(events.length).toBe(1);
  expect(events[0].shiftKey).toBe(true);
  expect(events[0].ctrlKey).toBe(true);
});

// --------------------------------------------------------------------------
// Synthetic PointerEvent: touch & pen `kind`
// --------------------------------------------------------------------------

test('kind reports "pen" when the underlying PointerEvent.pointerType is "pen"', async ({ page }) => {
  await setupPointerSurface(page);
  const result = await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    const events = [];
    const detach = attachPointer(el, {
      down: e => events.push({ kind: e.kind, pressure: e.pressure }),
    });

    // Synthesize a PointerEvent with pointerType: 'pen'.
    const rect = el.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', {
      pointerId: 5,
      pointerType: 'pen',
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 10,
      clientY: rect.top + 20,
      pressure: 0.75,
      isPrimary: true,
    });
    el.dispatchEvent(ev);
    detach();
    return events;
  });
  expect(result.length).toBe(1);
  expect(result[0].kind).toBe('pen');
  expect(result[0].pressure).toBeCloseTo(0.75, 5);
});

test('kind reports "touch" when the underlying PointerEvent.pointerType is "touch"', async ({ page }) => {
  await setupPointerSurface(page);
  const result = await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    const events = [];
    const detach = attachPointer(el, {
      down: e => events.push({ kind: e.kind, pressure: e.pressure }),
      up:   e => events.push({ kind: e.kind, name: 'up' }),
    });
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      bubbles: true, cancelable: true,
      clientX: rect.left + 5, clientY: rect.top + 5,
      pressure: 0.5, isPrimary: true,
    }));
    el.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 7,
      pointerType: 'touch',
      bubbles: true, cancelable: true,
      clientX: rect.left + 5, clientY: rect.top + 5,
      isPrimary: true,
    }));
    detach();
    return events;
  });
  expect(result.length).toBe(2);
  expect(result[0].kind).toBe('touch');
  expect(result[0].pressure).toBeCloseTo(0.5, 5);
  expect(result[1].kind).toBe('touch');
});

// --------------------------------------------------------------------------
// pointercancel routing
// --------------------------------------------------------------------------

test('pointercancel routes to handlers.cancel, not handlers.up', async ({ page }) => {
  await setupPointerSurface(page);
  const events = await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    const events = [];
    const detach = attachPointer(el, {
      down:   e => events.push('down'),
      move:   e => events.push('move'),
      up:     e => events.push('up'),
      cancel: e => events.push('cancel'),
    });
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: rect.left + 10, clientY: rect.top + 10, isPrimary: true,
    }));
    el.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: rect.left + 10, clientY: rect.top + 10, isPrimary: true,
    }));
    detach();
    return events;
  });
  expect(events).toEqual(['down', 'cancel']);
});

// --------------------------------------------------------------------------
// Detach
// --------------------------------------------------------------------------

test('detach() removes all listeners — no more events fire after detach', async ({ page }) => {
  await setupPointerSurface(page);
  await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    window.__events = [];
    const detach = attachPointer(el, {
      down:  e => window.__events.push('down'),
      move:  e => window.__events.push('move'),
      up:    e => window.__events.push('up'),
      hover: e => window.__events.push('hover'),
    });
    // Detach immediately.
    detach();
  });

  await page.mouse.move(100, 80);
  await page.mouse.down();
  await page.mouse.move(120, 100);
  await page.mouse.up();

  const events = await page.evaluate(() => window.__events);
  expect(events.length).toBe(0);
});

test('detach() restores the previous touch-action value', async ({ page }) => {
  await setupPointerSurface(page);
  const result = await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    // Set a non-default touch-action so we can verify restoration.
    el.style.touchAction = 'pan-x';
    const before = el.style.touchAction;

    const detach = attachPointer(el, { down: () => {} });
    const during = el.style.touchAction;

    detach();
    const after = el.style.touchAction;

    return { before, during, after };
  });
  expect(result.before).toBe('pan-x');
  expect(result.during).toBe('none');
  expect(result.after).toBe('pan-x');
});

test('attach sets touch-action: none on element', async ({ page }) => {
  await setupPointerSurface(page);
  const touchAction = await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    const detach = attachPointer(el, { down: () => {} });
    const ta = el.style.touchAction;
    detach();
    return ta;
  });
  expect(touchAction).toBe('none');
});

// --------------------------------------------------------------------------
// pointerleave does NOT cancel capture
// --------------------------------------------------------------------------

test('pointerleave during a drag does not fire cancel; move events continue', async ({ page }) => {
  await setupPointerSurface(page);
  const events = await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    const events = [];
    const detach = attachPointer(el, {
      down:   () => events.push('down'),
      move:   () => events.push('move'),
      up:     () => events.push('up'),
      cancel: () => events.push('cancel'),
    });
    const rect = el.getBoundingClientRect();
    // press inside
    el.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: rect.left + 10, clientY: rect.top + 10, isPrimary: true,
    }));
    // pointerleave (should NOT cancel)
    el.dispatchEvent(new PointerEvent('pointerleave', {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: rect.left - 50, clientY: rect.top - 50, isPrimary: true,
    }));
    // pointermove while captured (should still fire move)
    el.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: rect.left + 50, clientY: rect.top + 50, isPrimary: true,
    }));
    el.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: rect.left + 50, clientY: rect.top + 50, isPrimary: true,
    }));
    detach();
    return events;
  });
  expect(events).toEqual(['down', 'move', 'up']);
  expect(events).not.toContain('cancel');
});

// --------------------------------------------------------------------------
// Multi-touch: two simultaneous touches
// --------------------------------------------------------------------------

test('two simultaneous touch pointers are tracked independently', async ({ page }) => {
  await setupPointerSurface(page);
  const events = await page.evaluate(async () => {
    const { attachPointer } = await import('/js/pointer.js');
    const el = document.getElementById('pointer-target');
    const events = [];
    const detach = attachPointer(el, {
      down: e => events.push({ name: 'down', id: e.id }),
      move: e => events.push({ name: 'move', id: e.id }),
      up:   e => events.push({ name: 'up',   id: e.id }),
    });
    const rect = el.getBoundingClientRect();
    function ev(type, id, x, y) {
      return new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true,
        clientX: rect.left + x, clientY: rect.top + y, isPrimary: id === 1, pressure: 0.5,
      });
    }
    el.dispatchEvent(ev('pointerdown', 1, 10, 10));
    el.dispatchEvent(ev('pointerdown', 2, 50, 50));
    el.dispatchEvent(ev('pointermove', 1, 20, 20));
    el.dispatchEvent(ev('pointermove', 2, 60, 60));
    el.dispatchEvent(ev('pointerup',   1, 20, 20));
    el.dispatchEvent(ev('pointerup',   2, 60, 60));
    detach();
    return events;
  });
  // Verify both ids are present, in interleaved order, each gets a down & up.
  const downs = events.filter(e => e.name === 'down').map(e => e.id);
  const ups   = events.filter(e => e.name === 'up').map(e => e.id);
  expect(downs.sort()).toEqual([1, 2]);
  expect(ups.sort()).toEqual([1, 2]);
  // Each pointer got at least one move while captured.
  const movesById = {};
  for (const e of events.filter(e => e.name === 'move')) {
    movesById[e.id] = (movesById[e.id] || 0) + 1;
  }
  expect(movesById[1]).toBeGreaterThanOrEqual(1);
  expect(movesById[2]).toBeGreaterThanOrEqual(1);
});
