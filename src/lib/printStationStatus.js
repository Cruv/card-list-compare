export const PRINT_JOB_STATES = {
  active: 'Preparing on the Mac',
  claimed: 'Preparing on the Mac', submitting: 'Submitting to Epson',
  submitted: 'In the Epson queue', awaiting_refeed: 'Waiting for flip and reload',
  backs_pending: 'Fronts printed · backs saved', awaiting_paper_reset: 'Backs printed · restore blank paper',
  awaiting_clearance: 'Canceled pages · clear paper',
  uncertain: 'Needs review at the Mac', completed: 'Spooler completed',
  preparing: 'Generating PDFs in CLC', queued: 'Waiting in CLC', failed: 'Failed', canceled: 'Canceled', expired: 'PDFs expired',
};

export function paperClearanceIdentity(job) {
  if (!['awaiting_clearance', 'awaiting_paper_reset'].includes(job?.state)
    || typeof job.id !== 'string' || !job.id
    || typeof job.clearanceId !== 'string' || !job.clearanceId) return null;
  // A later back packet (or cancellation) can belong to the same job. A paper
  // check for one boundary must never authorize another boundary after polling.
  return JSON.stringify([job.id, job.state, job.clearanceId]);
}

export function printRecoveryIdentity(job) {
  const recovery = job?.recovery;
  if (!job?.id || !recovery || !/^recover-[a-f0-9]{24}$/.test(recovery.recoveryId)
    || !recovery.artifactId || !recovery.spoolerId || !['fronts', 'backs'].includes(recovery.phase)
    || !(recovery.mode === 'resume' ? [3, 4, 5] : recovery.mode === 'reprint_remaining' ? [6, 7, 8] : []).includes(recovery.cupsState)
    || !Array.isArray(recovery.physicalPages) || !recovery.physicalPages.length
    || recovery.totalSheets !== recovery.physicalPages.length
    || recovery.physicalPages.some(page => !Number.isInteger(page) || page < 1)
    || new Set(recovery.physicalPages).size !== recovery.totalSheets) return null;
  return JSON.stringify([job.id, recovery.recoveryId, recovery.artifactId, recovery.phase,
    recovery.spoolerId, recovery.mode, recovery.cupsState, recovery.physicalPages]);
}

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
  if (activeJob?.state === 'awaiting_clearance') return 'Clear paper from the canceled pass';
  if (activeJob?.state === 'awaiting_paper_reset') return 'Restore blank paper for the next job';
  if (activeJob?.state === 'awaiting_refeed') return 'Your paper needs flipping';
  if (printRecoveryIdentity(activeJob) && (activeJob.recovery.mode === 'reprint_remaining'
    || activeJob.recovery.cupsState === 4 || (station.health?.known === true && station.health.ok === false))) return 'Continue the interrupted print pass';
  if (activeJob?.state === 'uncertain') return 'Review this batch on the Mac';
  const health = printerHealthPresentation(station.health, true);
  if (health.kind === 'fault') return 'The printer needs attention';
  if (activeJob) return PRINT_JOB_STATES[activeJob.state] || 'A batch is in progress';
  if (health.kind === 'unavailable') return 'Printer status unavailable';
  if (station.testPrintingEnabled) return 'Ready for a test batch';
  if (!station.recipeVerified) return 'Verify your print recipe on the Mac';
  return 'Ready for your next batch';
}
