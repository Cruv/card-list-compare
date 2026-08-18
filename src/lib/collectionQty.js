// Decide what to do with an edited collection-quantity field. Kept pure so the
// edge cases that caused a data-loss bug (audit H2) are unit-tested: an empty or
// invalid field, or a zero, must NOT be sent as a destructive update — removal is
// an explicit action. Returns the integer quantity to commit, or null to ignore
// the edit (revert the field to the current value).
export function parseQtyEdit(raw, current) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return null; // empty / non-numeric / zero → ignore
  const clamped = Math.min(999, n);
  if (clamped === current) return null; // unchanged → no-op
  return clamped;
}
