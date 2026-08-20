import { describe, it, expect, beforeEach } from 'vitest';
import { pushLayer, popLayer, isTopLayer, layerCount, _resetLayers } from './modalLayerStack.js';

beforeEach(() => _resetLayers());

describe('modal layer stack (audit: stacked overlays close together)', () => {
  it('reports the first push and the last pop so scroll locks/unlocks once', () => {
    const a = {};
    const b = {};
    expect(pushLayer(a)).toBe(true);   // first layer → lock scroll
    expect(pushLayer(b)).toBe(false);  // nested → already locked
    expect(popLayer(b)).toBe(false);   // parent still open → stay locked
    expect(popLayer(a)).toBe(true);    // last one out → unlock
  });

  it('only the topmost layer is active, so one Escape closes one overlay', () => {
    const parent = {};
    const child = {};
    pushLayer(parent);
    expect(isTopLayer(parent)).toBe(true);

    pushLayer(child); // e.g. MpcOverlay opened from inside TimelineOverlay
    expect(isTopLayer(child)).toBe(true);
    expect(isTopLayer(parent)).toBe(false); // parent must ignore the keypress

    popLayer(child); // child handled Escape and closed
    expect(isTopLayer(parent)).toBe(true); // now the parent takes over
  });

  it('handles out-of-order removal without corrupting the stack', () => {
    const a = {}, b = {}, c = {};
    pushLayer(a); pushLayer(b); pushLayer(c);
    popLayer(b); // middle layer closed programmatically
    expect(layerCount()).toBe(2);
    expect(isTopLayer(c)).toBe(true);
    popLayer(c);
    expect(isTopLayer(a)).toBe(true);
  });

  it('ignores popping an unknown token and never goes negative', () => {
    const a = {};
    pushLayer(a);
    expect(popLayer({})).toBe(false); // unknown token, `a` still open
    expect(layerCount()).toBe(1);
    expect(popLayer(a)).toBe(true);
    expect(layerCount()).toBe(0);
  });

  it('has no top layer when empty', () => {
    expect(isTopLayer({})).toBe(false);
  });
});
