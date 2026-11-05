import { createOperationId } from './operationId';

export const PRINT_COMPARISON_KEY = 'clc-print-comparison-handoff';
export const PRINT_COMPARISON_EVENT = 'clc-print-comparison-ready';

function valid(value) {
  return value && typeof value.id === 'string' && value.id.length <= 100
    && (value.userId === null || (typeof value.userId === 'string' && value.userId.length <= 100))
    && typeof value.listName === 'string' && value.listName.length <= 120
    && typeof value.cardText === 'string' && value.cardText.trim().length > 0 && value.cardText.length <= 100000
    && typeof value.comparison?.beforeText === 'string' && value.comparison.beforeText.length <= 100000
    && ['changes', 'full'].includes(value.comparison.mode);
}

/** Keep the displayed comparison intact through sign-in without replacing a saved print draft. */
export function savePrintComparison(storage, { beforeText = '', afterText, listName = 'Compared lists', mode = 'changes' }, userId = null) {
  const value = { id: createOperationId(), userId: userId == null ? null : String(userId),
    listName: String(listName).slice(0, 120), cardText: afterText, comparison: { beforeText, mode } };
  if (!valid(value)) throw new Error('Print lists need a nonempty After list, with at most 100,000 characters per list.');
  storage.setItem(PRINT_COMPARISON_KEY, JSON.stringify(value));
  return value;
}

export function loadPrintComparison(storage, userId) {
  try {
    const value = JSON.parse(storage.getItem(PRINT_COMPARISON_KEY));
    if (!valid(value) || userId == null || (value.userId !== null && value.userId !== String(userId))) return null;
    return value;
  } catch { return null; }
}

/** An older screen must never discard a newer comparison's handoff. */
export function consumePrintComparison(storage, id) {
  try {
    const value = JSON.parse(storage.getItem(PRINT_COMPARISON_KEY));
    if (value?.id === id) storage.removeItem(PRINT_COMPARISON_KEY);
  } catch { /* A failed storage read cannot authorize deleting another handoff. */ }
}
