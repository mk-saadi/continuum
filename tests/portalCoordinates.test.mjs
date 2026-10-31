import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedPortalPosition } from '../src/lib/portalCoordinates.mjs';

test('filtered dialogs convert viewport menu coordinates to the dialog padding box', () => {
  const original = globalThis.getComputedStyle;
  try {
    const point = { left: 400, top: 250, width: 220, maxHeight: 288 };
    const owner = { clientLeft: 1, clientTop: 2, scrollLeft: 0, scrollTop: 10,
      getBoundingClientRect: () => ({ left: 100, top: 80 }) };
    globalThis.getComputedStyle = () => ({ backdropFilter: 'blur(24px)', filter: 'none', transform: 'none' });
    assert.deepEqual(fixedPortalPosition(point, owner), { left: 299, top: 178, width: 220, maxHeight: 288 });
    globalThis.getComputedStyle = () => ({ backdropFilter: 'none', filter: 'none', transform: 'none' });
    assert.equal(fixedPortalPosition(point, owner), point, 'flat dialogs retain viewport coordinates');
    assert.equal(fixedPortalPosition(point, null), point, 'body portals retain viewport coordinates');
  } finally {
    if (original) globalThis.getComputedStyle = original;
    else delete globalThis.getComputedStyle;
  }
});
