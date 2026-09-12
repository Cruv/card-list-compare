export const PRINT_JOB_STATES = {
  active: 'Preparing on the Mac',
  claimed: 'Preparing on the Mac', submitting: 'Submitting to Epson',
  submitted: 'In the Epson queue', awaiting_refeed: 'Waiting for flip and reload',
  uncertain: 'Needs review at the Mac', completed: 'Spooler completed',
  preparing: 'Generating PDFs in CLC', queued: 'Waiting in CLC', failed: 'Failed', canceled: 'Canceled', expired: 'PDFs expired',
};

export function printerHealthPresentation(health, current) {
  // A stale report or an undecoded driver response cannot confirm a fault.
  if (!current) return {
    kind: 'unavailable', label: 'Status details', tone: 'neutral',
    message: 'Waiting for a current printer report from the Mac.', advisories: [],
  };
  const advisories = Array.isArray(health?.advisories)
    ? [...new Set(health.advisories.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))] : [];
  if (health?.known !== true || typeof health.ok !== 'boolean') return {
    kind: 'unavailable', label: 'Status details', tone: 'neutral',
    message: health?.message || 'The Mac could not confirm the printer status.', advisories,
  };
  if (!health.ok) return {
    kind: 'fault', label: 'Reported problem', tone: 'warning',
    message: health.message || 'Check the printer and its queue on the Mac for the reported problem.', advisories,
  };
  return {
    kind: 'ready', label: 'No printer fault reported', tone: 'good',
    message: health.message || 'The printer has not reported a problem.', advisories,
  };
}

export function printStationSummary(station, { fresh, online, loading }) {
  if (!fresh) return loading ? 'Checking in with your Mac' : 'Waiting for a fresh status';
  if (!online) return 'The Mac is offline';
  if (station.paused) return 'Printing is paused';
  const activeJob = station.activeJob;
  if (activeJob?.state === 'awaiting_refeed') return 'Your paper needs flipping';
  if (activeJob?.state === 'uncertain') return 'Review this batch on the Mac';
  const health = printerHealthPresentation(station.health, true);
  if (health.kind === 'fault') return 'The printer needs attention';
  if (activeJob) return PRINT_JOB_STATES[activeJob.state] || 'A batch is in progress';
  if (health.kind === 'unavailable') return 'Printer status unavailable';
  if (station.testPrintingEnabled) return 'Ready for a test batch';
  if (!station.recipeVerified) return 'Verify your print recipe on the Mac';
  return 'Ready for your next batch';
}
