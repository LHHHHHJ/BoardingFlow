// Observation-only contract. No manifest, actual journey or future truth imports.
export const OBSERVATION_TYPES = ['CHECK_IN_CLEARED', 'SECURITY_ENTERED', 'SECURITY_CLEARED', 'CHECKPOINT', 'GATE_ARRIVED'];

export const observationOrder = (a, b) => a.timeSeconds - b.timeSeconds
  || a.passengerId.localeCompare(b.passengerId)
  || OBSERVATION_TYPES.indexOf(a.type) - OBSERVATION_TYPES.indexOf(b.type);

export function validateObservation(event, passengerIds, terminalNodes, assignedGateId) {
  const fail = message => { throw new Error(`Invalid observation: ${message}`); };
  if (!event || !passengerIds.has(event.passengerId) || !OBSERVATION_TYPES.includes(event.type)
      || !Number.isFinite(event.timeSeconds) || !terminalNodes.has(event.checkpointId)) fail('unknown identity/type/checkpoint or invalid time');
  const checkpoints = { CHECK_IN_CLEARED: 'CHECK_IN', SECURITY_ENTERED: 'SECURITY_ENTRY',
    SECURITY_CLEARED: 'SECURITY_EXIT', GATE_ARRIVED: assignedGateId };
  if (checkpoints[event.type] && event.checkpointId !== checkpoints[event.type]) fail('event/checkpoint mismatch');
  if (event.type === 'CHECKPOINT' && Object.values(checkpoints).includes(event.checkpointId)) fail('status checkpoints require their explicit event type');
}

export function observationProgress() { return { rank: -1, seen: new Set() }; }

// Apply only after the adapter has established event.timeSeconds <= now.
// Missing intermediate observations never grant the omitted status.
export function advanceObservationProgress(progress, event) {
  const rank = OBSERVATION_TYPES.indexOf(event.type);
  if (rank < progress.rank || (event.type !== 'CHECKPOINT' && progress.seen.has(event.type))) {
    throw new Error('Invalid observation: duplicate or regressing event in a single journey');
  }
  progress.rank = rank;
  progress.seen.add(event.type);
}
