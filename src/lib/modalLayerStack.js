/**
 * Pure layer-stack bookkeeping shared by every overlay/modal (see useModalLayer).
 * DOM-free on purpose so the two stacking rules are unit-testable:
 *   1. only the TOPMOST layer reacts to Escape (one press closes one overlay);
 *   2. the body scroll lock engages on the first layer and releases only when
 *      the LAST one closes (a nested overlay closing must not unlock the page).
 */

const stack = [];

/** Register a layer. Returns true when it is the first (caller locks scroll). */
export function pushLayer(token) {
  stack.push(token);
  return stack.length === 1;
}

/** Unregister a layer. Returns true when none remain (caller unlocks scroll). */
export function popLayer(token) {
  const i = stack.indexOf(token);
  if (i !== -1) stack.splice(i, 1);
  return stack.length === 0;
}

/** Is this layer the one that should handle keyboard input? */
export function isTopLayer(token) {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

export function layerCount() {
  return stack.length;
}

/** Test seam — drop all layers. */
export function _resetLayers() {
  stack.length = 0;
}
