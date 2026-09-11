// Match ManaSync's JSON Schema maxLength, which counts Unicode code points.
export const MAX_PROPOSAL_TEXT_LENGTH = 500_000;

export function validProposalText(value) {
  if (typeof value !== 'string') return false;
  if (value.length <= MAX_PROPOSAL_TEXT_LENGTH) return true;
  let count = 0;
  const characters = value[Symbol.iterator]();
  while (!characters.next().done) {
    if (++count > MAX_PROPOSAL_TEXT_LENGTH) return false;
  }
  return true;
}

// Two maximum-length fields can each contain JSON-escaped surrogate pairs:
// 500,000 × 12 bytes × 2 fields, plus the small proposal identity envelope.
export const MAX_PROPOSAL_BODY_SIZE = 12 * 1024 * 1024;
