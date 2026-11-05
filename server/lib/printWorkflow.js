/** Pure scheduling metadata. Immutable PDF manifests and physical receipts stay intact. */
export const DEFERRED_BACKS_WORKFLOW = 'deferred-backs-v1';
export const ACTIVE_PRINT_STATES = ['claimed', 'submitting', 'submitted', 'awaiting_refeed', 'awaiting_paper_reset', 'uncertain'];
export const PRINT_TERMINAL_STATES = ['completed', 'canceled', 'failed', 'expired'];
export const readSteps = row => JSON.parse(row.steps_json || '[]');
export const readBackRequest = row => JSON.parse(row.back_request_json || 'null');
export function paperClearanceId(row) {
  if (row.cancel_requested && row.cancel_request_id) return `cancel:${row.cancel_request_id}`;
  if (row.state === 'awaiting_paper_reset' && readBackRequest(row)?.id) return `back:${readBackRequest(row).id}`;
  return null;
}
export const isDeferred = row => row.workflow === DEFERRED_BACKS_WORKFLOW;
export const finishedStep = step => ['completed', 'canceled'].includes(step.state);

export function nextPrintStep(row, steps = readSteps(row)) {
  if (!isDeferred(row)) return steps.find(step => !finishedStep(step));
  const selected = readBackRequest(row);
  if (selected && row.state !== 'backs_pending') return steps.find(step => step.phase === 'backs' && step.artifactId === selected.artifactId && !finishedStep(step));
  return steps.find(step => step.phase === 'fronts' && !finishedStep(step));
}

export function settledPrintState(row, steps = readSteps(row)) {
  if (steps.every(finishedStep)) return steps.some(step => step.state === 'canceled') ? 'canceled' : 'completed';
  if (isDeferred(row)) return steps.some(step => step.phase === 'fronts' && !finishedStep(step)) ? 'claimed' : 'backs_pending';
  const next = nextPrintStep(row, steps);
  return next?.requiresRefeed && !next.refeedConfirmed ? 'awaiting_refeed' : 'claimed';
}

export function printPackets(row) {
  const steps = readSteps(row), request = readBackRequest(row);
  const artifacts = JSON.parse(row.manifest_json || 'null')?.artifacts || [];
  const packets = artifacts.filter(artifact => artifact.kind === 'dfc');
  return packets.map((artifact, index) => {
    const front = steps.find(step => step.artifactId === artifact.id && step.phase === 'fronts');
    const back = steps.find(step => step.artifactId === artifact.id && step.phase === 'backs');
    let state = back?.state || 'pending';
    if (request?.artifactId === artifact.id && state === 'pending') state = row.state === 'backs_pending' ? 'requested' : row.state;
    return { artifactId: artifact.id, label: artifact.label || null,
      packetIndex: artifact.packetIndex || index + 1, packetCount: artifact.packetCount || packets.length,
      sheetCount: artifact.sheetCount, cardCount: artifact.cardCount,
      frontCompletedAt: front?.completedAt || (front?.state === 'completed' ? row.updated_at : null),
      state, ...(front?.spoolerId ? { frontSpoolerId: front.spoolerId } : {}) };
  });
}

export const hasPendingBacks = row => readSteps(row).some(step => step.phase === 'backs' && !finishedStep(step) && step.state !== 'failed');
export const canCancelRemaining = row => !PRINT_TERMINAL_STATES.includes(row.state) && !row.cancel_requested
  && (row.state === 'preparing' || readSteps(row).some(step => !finishedStep(step)));
export const canCancelUnstartedBacks = row => ['ready', 'queued'].includes(row.state) && readSteps(row).every(step => step.state === 'pending');
export function workflowSummary(row) {
  const steps = readSteps(row), fronts = steps.filter(step => step.phase === 'fronts');
  return { workflow: row.workflow || null, backRequest: readBackRequest(row), cancelRequested: row.cancel_requested || null, cancelRequestId: row.cancel_request_id || null,
    packets: printPackets(row), backsCanceled: steps.filter(step => step.phase === 'backs' && step.state === 'canceled').length,
    frontsCompleted: fronts.length > 0 && fronts.every(step => step.state === 'completed') };
}
