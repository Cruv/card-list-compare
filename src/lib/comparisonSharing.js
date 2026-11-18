export const shareExpiryOptions = [
  { value: '0', label: 'Never' },
  { value: '1', label: 'In 24 hours' },
  { value: '7', label: 'In 7 days' },
  { value: '30', label: 'In 30 days' },
];

export const comparisonShareExpiry = days => days === '0' ? null : new Date(Date.now() + Number(days) * 86_400_000).toISOString();

export function comparisonShareUrl(id) {
  return `${window.location.origin}${window.location.pathname}#share/${encodeURIComponent(id)}`;
}
