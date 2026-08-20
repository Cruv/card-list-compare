// Decide what to do with an edited collection-quantity field. Kept pure so the
// edge cases that caused a data-loss bug (audit H2) are unit-tested: an empty or
// invalid field, or a zero, must NOT be sent as a destructive update — removal is
// an explicit action. Returns the integer quantity to commit, or null to ignore
// the edit (revert the field to the current value).
export function parseQtyEdit(raw, current) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return null; // empty / non-numeric / zero → ignore
  // Compare BEFORE clamping: a collection legitimately holding more than the
  // clamp (e.g. 1200 basic lands, imported in bulk) must read as unchanged on a
  // no-op blur, not be silently truncated to 999.
  if (n === current) return null; // unchanged → no-op
  return Math.min(999, n);
}
