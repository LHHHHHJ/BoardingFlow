import { deepFreeze } from './model.js';
import { accessibleRoute } from './terminal.js';
import { phase2Settings } from './phase2-config.js';
import { observationOrder, validateObservation, observationProgress, advanceObservationProgress } from './observations.js';

// Explicit allowlist: never spread a simulation passenger into a policy input.
export function publicPassengerCatalog(manifest) {
  return deepFreeze(manifest.passengers.map(passenger => ({
    id: passenger.id,
    seatNumber: passenger.seatNumber,
    travelClass: passenger.travelClass ?? null,
    boardingZone: passenger.boardingZone,
    priorityEligible: passenger.priorityEligible,
    mandatoryPreboarding: passenger.mandatoryPreboarding,
    travelPartyId: passenger.travelPartyId,
    assistance: structuredClone(passenger.assistance),
    carryOnAllowance: structuredClone(passenger.carryOnAllowance),
    declaredCabinBaggage: structuredClone(passenger.actualBaggage)
  })));
}

export function estimateGateETA(view, nowSeconds, routes, settings) {
  if (!Number.isFinite(nowSeconds)) throw new Error('ETA decision time must be finite');
  const timestamps = [view.checkIn?.clearedAtSeconds, view.security?.scanAtSeconds,
    view.security?.clearedAtSeconds, view.lastCheckpoint?.observedAtSeconds, view.gateObservedAtSeconds];
  if (timestamps.some(time => time !== null && time !== undefined && (!Number.isFinite(time) || time > nowSeconds))) {
    throw new Error('ETA view contains invalid or future observation timestamps');
  }
  if ((view.security?.status === 'CLEARED' && view.security.clearedAtSeconds == null)
      || (view.security?.status === 'SCREENING' && view.security.scanAtSeconds == null)
      || (view.checkIn?.status === 'CLEARED' && view.checkIn.clearedAtSeconds == null)) {
    throw new Error('ETA status requires its own observed event timestamp');
  }
  if (view.gateObservedAtSeconds !== null) return {
    estimatedGateArrivalSeconds: view.gateObservedAtSeconds, reachable: true,
    remainingDistanceMeters: 0, route: [], securityRemainingSeconds: 0, expectedStopDelaySeconds: 0,
    basis: 'OBSERVED_AT_GATE'
  };
  if (!view.lastCheckpoint) return { estimatedGateArrivalSeconds: null, reachable: null, basis: 'NO_OBSERVATION' };
  const route = routes.get(view.lastCheckpoint.id);
  if (!route) throw new Error('ETA view has an unknown checkpoint');
  if (!route.reachable) return { estimatedGateArrivalSeconds: null, reachable: false, basis: 'NO_ACCESSIBLE_ROUTE' };
  const speed = view.assistance.type === 'NONE' ? settings.walkingSpeedMps : settings.assistedWalkingSpeedMps;
  const expectedStopDelay = settings.stopProbability * (settings.stopDelayMinSeconds + settings.stopDelayMaxSeconds) / 2;
  let estimate;
  let overdue = false;
  let securityRemaining = 0;
  if (view.security.status === 'SCREENING') {
    const elapsed = nowSeconds - view.security.scanAtSeconds;
    securityRemaining = Math.max(settings.minimumRemainingSecuritySeconds, settings.estimatedSecuritySeconds - elapsed);
    estimate = nowSeconds + securityRemaining + route.distanceMeters / speed + expectedStopDelay;
  } else {
    securityRemaining = view.security.status === 'CLEARED' ? 0 : settings.estimatedSecuritySeconds;
    estimate = view.lastCheckpoint.observedAtSeconds + route.distanceMeters / speed + securityRemaining + expectedStopDelay;
    if (estimate <= nowSeconds) { overdue = true; estimate = nowSeconds + settings.overdueRecheckSeconds; }
  }
  return {
    estimatedGateArrivalSeconds: Math.round(estimate * 1000) / 1000,
    reachable: true, remainingDistanceMeters: route.distanceMeters, route: route.nodes,
    securityRemainingSeconds: securityRemaining, expectedStopDelaySeconds: expectedStopDelay,
    observationAgeSeconds: nowSeconds - view.lastCheckpoint.observedAtSeconds,
    overdue, securityOverdue: view.security.status === 'SCREENING'
      && nowSeconds - view.security.scanAtSeconds >= settings.estimatedSecuritySeconds,
    basis: view.security.status === 'SCREENING' ? 'SECURITY_ENTRY_WITHOUT_CLEARANCE' : 'LAST_OBSERVED_CHECKPOINT'
  };
}

export function createReadinessObserver(manifest) {
  if (!manifest.phase2) throw new Error('Readiness requires a Phase 2 scenario');
  const { terminal, assignedGateId, settings } = manifest.phase2;
  const etaSettings = phase2Settings({ eta: settings.eta }).eta;
  const catalog = publicPassengerCatalog(manifest);
  // Only the observation adapter holds future events; snapshots never do.
  const events = [...manifest.phase2.observations].sort(observationOrder);
  const passengerIds = new Set(catalog.map(p => p.id));
  const terminalNodes = new Set(terminal.nodes);
  const progress = new Map(catalog.map(p => [p.id, observationProgress()]));
  const routes = new Map(terminal.nodes.map(node => [node, accessibleRoute(terminal, node, assignedGateId)]));
  const states = new Map(catalog.map(passenger => [passenger.id, {
    checkIn: { status: 'NOT_OBSERVED', clearedAtSeconds: null },
    security: { status: 'NOT_OBSERVED', scanAtSeconds: null, clearedAtSeconds: null },
    lastCheckpoint: null, gateObservedAtSeconds: null
  }]));
  let cursor = 0;
  let clock = -Infinity;
  let latestObservedAtSeconds = null;
  function advance(nowSeconds) {
    if (!Number.isFinite(nowSeconds) || nowSeconds < clock) throw new Error('Observation clock must be finite and monotonic');
    clock = nowSeconds;
    let changed = false;
    while (cursor < events.length && events[cursor].timeSeconds <= nowSeconds) {
      const event = events[cursor++];
      validateObservation(event, passengerIds, terminalNodes, assignedGateId);
      advanceObservationProgress(progress.get(event.passengerId), event);
      const state = states.get(event.passengerId);
      if (!state) throw new Error('Observation refers to an unknown passenger');
      if (event.type === 'CHECK_IN_CLEARED') state.checkIn = { status: 'CLEARED', clearedAtSeconds: event.timeSeconds };
      if (event.type === 'SECURITY_ENTERED') state.security = { status: 'SCREENING', scanAtSeconds: event.timeSeconds, clearedAtSeconds: null };
      if (event.type === 'SECURITY_CLEARED') state.security = { ...state.security, status: 'CLEARED', clearedAtSeconds: event.timeSeconds };
      if (event.type === 'GATE_ARRIVED') state.gateObservedAtSeconds = event.timeSeconds;
      state.lastCheckpoint = { id: event.checkpointId, observedAtSeconds: event.timeSeconds };
      latestObservedAtSeconds = event.timeSeconds;
      changed = true;
    }
    return changed;
  }
  const isReadyAtGate = id => {
    const state = states.get(id);
    return !!state && state.checkIn.status === 'CLEARED' && state.security.status === 'CLEARED' && state.gateObservedAtSeconds !== null;
  };
  function snapshot(nowSeconds) {
    advance(nowSeconds);
    return deepFreeze({
      dataKind: 'SYNTHETIC',
      asOfSeconds: nowSeconds, latestObservedAtSeconds, assignedGateId,
      passengers: catalog.map(passenger => {
        const view = { ...passenger, ...structuredClone(states.get(passenger.id)) };
        const prediction = estimateGateETA(view, nowSeconds, routes, etaSettings);
        const readinessBlockers = [];
        if (view.checkIn.status !== 'CLEARED') readinessBlockers.push('CHECK_IN_NOT_OBSERVED');
        if (view.security.status !== 'CLEARED') readinessBlockers.push(view.security.status === 'SCREENING' ? 'SECURITY_STILL_SCREENING' : 'SECURITY_CLEARANCE_NOT_OBSERVED');
        if (view.gateObservedAtSeconds === null) readinessBlockers.push('GATE_NOT_OBSERVED');
        return { ...view, readyAtGate: isReadyAtGate(passenger.id), prediction,
          readinessBlockers,
          likelyReadyWithinSeconds: prediction.estimatedGateArrivalSeconds === null ? null
            : Math.max(0, prediction.estimatedGateArrivalSeconds - nowSeconds) };
      })
    });
  }
  return { advance, snapshot, isReadyAtGate };
}

// Evaluation joins predictions to truth only after predictions have been made.
// Its output is never fed back to the policy or readiness observer.
export function evaluateGateETA(manifest, times = [0, 300, 600]) {
  if (!Array.isArray(times) || !times.length || times.some(time => !Number.isFinite(time)) || new Set(times).size !== times.length) {
    throw new Error('ETA evaluation times must be nonempty, distinct finite seconds');
  }
  const observer = createReadinessObserver(manifest);
  const actual = new Map(manifest.passengers.map(p => [p.id, p.gateArrivalSeconds]));
  const rows = [];
  const summaries = [];
  for (const asOfSeconds of [...times].sort((a, b) => a - b)) {
    const snapshot = observer.snapshot(asOfSeconds);
    let observedAtGate = 0;
    let unavailablePredictions = 0;
    const errors = [];
    for (const passenger of snapshot.passengers) {
      // Location is already observed even if a clearance scan was lost. Do not
      // count an observed arrival's zero error as a successful prediction.
      if (passenger.gateObservedAtSeconds !== null) { observedAtGate++; continue; }
      const predicted = passenger.prediction.estimatedGateArrivalSeconds;
      if (predicted === null) { unavailablePredictions++; continue; }
      const error = predicted - actual.get(passenger.id);
      errors.push(error);
      rows.push({ passengerId: passenger.id, asOfSeconds, securityStatus: passenger.security.status,
        lastCheckpoint: passenger.lastCheckpoint?.id, predictedGateArrivalSeconds: predicted,
        actualGateArrivalSeconds: actual.get(passenger.id), errorSeconds: error,
        absoluteErrorSeconds: Math.abs(error), predictionBasis: passenger.prediction.basis,
        observationAgeSeconds: passenger.prediction.observationAgeSeconds,
        overdue: passenger.prediction.overdue, securityOverdue: passenger.prediction.securityOverdue });
    }
    const mean = items => items.length ? items.reduce((a, b) => a + b, 0) / items.length : null;
    const round = value => value === null ? null : Math.round(value * 1000) / 1000;
    const absoluteErrors = errors.map(Math.abs).sort((a, b) => a - b);
    summaries.push({ asOfSeconds, predictedCount: errors.length, observedAtGate, unavailablePredictions,
      meanAbsoluteErrorSeconds: round(mean(errors.map(Math.abs))),
      meanSignedErrorSeconds: round(mean(errors)),
      maxAbsoluteErrorSeconds: round(absoluteErrors.length ? absoluteErrors.at(-1) : null),
      p90AbsoluteErrorSeconds: round(absoluteErrors.length ? absoluteErrors[Math.ceil(absoluteErrors.length * 0.9) - 1] : null),
      rootMeanSquaredErrorSeconds: round(errors.length ? Math.sqrt(mean(errors.map(error => error ** 2))) : null) });
  }
  return { dataKind: 'SYNTHETIC', scenarioName: manifest.phase2.scenarioName,
    errorConvention: 'prediction minus actual; negative means early prediction. Already observed gate arrivals excluded.',
    uncertaintyNote: 'Empirical synthetic forecast errors, not calibrated confidence intervals. Cohorts change as passengers reach the gate; empty error cohorts report null.',
    summaries, rows };
}
