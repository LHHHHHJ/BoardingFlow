import { blockingSeats, parseSeat, seatDepth, STAGE_NAMES } from './model.js';
import { recommendNextUnit as legacyRecommendation } from './adaptive.js';
import { reviewBoardingRecommendation } from './policy.js';

export const ADAPTIVE_VERSION = 'passenger-aware-v2';
export const DEFAULT_ADAPTIVE_V2 = {
  expectedSeatSeconds: 4, expectedWalkSecondsPerRow: 1, expectedAssistedWalkSecondsPerRow: 2,
  completionWeight: 0.15, inducedBlockingWeight: 1, pathDelayWeight: 1,
  seatAccessWeight: 2, baggageOverlapWeight: 1, rowWeight: 0.2,
  waitingSecondsPerMinute: 0.1, waitingCreditCapSeconds: 5,
  staleObservationSeconds: 120, uncertaintyBaseSeconds: 30,
  uncertaintyAgeWeight: 0.25, overdueUncertaintySeconds: 60
};
const round = value => Math.round(value * 1000) / 1000;
export function adaptiveV2Settings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Stage 6 adaptive settings must be an object');
  const result = { ...DEFAULT_ADAPTIVE_V2 };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(result, key) || !Number.isFinite(value) || value < 0) throw new Error(`Unknown/invalid Stage 6 adaptive setting: ${key}`);
    result[key] = value;
  }
  for (const key of ['expectedSeatSeconds', 'expectedWalkSecondsPerRow', 'expectedAssistedWalkSecondsPerRow', 'staleObservationSeconds']) {
    if (result[key] <= 0) throw new Error(`${key} must be positive`);
  }
  return Object.freeze(result);
}

function readyEvidence(p, now, staff) {
  const times = [p.checkIn?.clearedAtSeconds, p.security?.clearedAtSeconds, p.gateObservedAtSeconds];
  const bags = p.declaredCabinBaggage, allowance = p.carryOnAllowance;
  return p.readyAtGate === true && p.checkIn?.status === 'CLEARED' && p.security?.status === 'CLEARED'
    && bags && allowance && Number.isSafeInteger(bags.overheadPieces) && bags.overheadPieces >= 0
    && Number.isSafeInteger(bags.personalItems) && bags.personalItems >= 0 && Number.isFinite(bags.overheadWeightKg)
    && bags.overheadWeightKg >= 0 && bags.overheadPieces <= allowance.overheadPieces
    && bags.personalItems <= allowance.personalItems && bags.overheadWeightKg <= allowance.maxOverheadWeightKg
    && times.every(t => Number.isFinite(t) && t <= now) && times[0] <= times[1] && times[1] <= times[2]
    && staff?.approval?.confirmed === true && staff?.gateVerification?.confirmed === true
    && [staff.approval.atSeconds, staff.gateVerification.atSeconds].every(t => Number.isFinite(t) && t <= now)
    && staff.gateVerification.atSeconds >= p.gateObservedAtSeconds;
}

// Analytical expected-delay surrogate; not a second execution simulator.
// Only current cells, observed row-arrival times, booking data and configured
// expectations enter this calculation. No actual service-end times are read.
export function expectedGroupCost(unit, byId, context, legacy, config) {
  const { nowSeconds: now, cabin, assumptions } = context;
  const members = unit.memberIds.map(id => byId.get(id));
  const seated = new Set(cabin.seatedSeats);
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const walk = p => p.assistance.type === 'NONE' ? config.expectedWalkSecondsPerRow : config.expectedAssistedWalkSecondsPerRow;
  const interference = p => blockingSeats(p.seatNumber).filter(s => seated.has(s)).length * assumptions.seatInterferenceSecondsPerBlocker;
  const service = p => p.declaredCabinBaggage.overheadPieces * legacy.expectedStowSecondsPerBag
    + config.expectedSeatSeconds + interference(p)
    + (p.assistance.type === 'MOBILITY' ? assumptions.mobilityAssistanceSeconds
      : p.assistance.type === 'EXTRA_TIME' ? assumptions.extraTimeAssistanceSeconds : 0);
  const pendingMembers = context.pendingUnits.flatMap(u => u.memberIds.map(id => byId.get(id)));
  const pathDelays = members.map(p => {
    const row = parseSeat(p.seatNumber).row;
    return Math.max(0, ...cabin.aisle.filter(o => o.targetRow <= row).map(o => {
      const occupant = byId.get(o.passengerId);
      if (!occupant) throw new Error('Unknown visible occupant');
      if (o.rowObservedAtSeconds !== null && (!Number.isFinite(o.rowObservedAtSeconds) || o.rowObservedAtSeconds > now)) throw new Error('Future row observation');
      const remaining = o.rowObservedAtSeconds === null
        ? Math.max(0, o.targetRow - o.cell) * walk(occupant) + service(occupant)
        : Math.max(assumptions.tickSeconds, service(occupant) - (now - o.rowObservedAtSeconds));
      return remaining - o.targetRow * walk(p);
    }));
  });
  const projectedCompletion = Math.max(...members.map((p, i) => i * assumptions.gateHeadwaySeconds
    + parseSeat(p.seatNumber).row * walk(p) + pathDelays[i] + service(p)));
  const own = new Set(unit.memberIds);
  const induced = mean(members.map(p => service(p) * pendingMembers.filter(q => !own.has(q.id)
    && parseSeat(q.seatNumber).row >= parseSeat(p.seatNumber).row).length / Math.max(1, pendingMembers.length - members.length)));
  const components = {
    expectedCompletion: config.completionWeight * projectedCompletion,
    inducedBlocking: config.inducedBlockingWeight * induced,
    pathCongestion: config.pathDelayWeight * mean(pathDelays),
    knownSeatInterference: mean(members.map(interference)),
    seatAccess: mean(members.map(p => seatDepth(parseSeat(p.seatNumber).letter))) * assumptions.seatInterferenceSecondsPerBlocker * config.seatAccessWeight,
    baggageOverlap: -mean(members.map(p => p.declaredCabinBaggage.overheadPieces * legacy.expectedStowSecondsPerBag)) * config.baggageOverlapWeight,
    rearCoverage: -Math.max(...members.map(p => parseSeat(p.seatNumber).row)) * config.rowWeight,
    waiting: -Math.min(config.waitingCreditCapSeconds, mean(members.map(p => p.gateObservedAtSeconds === null ? 0
      : Math.max(0, now - p.gateObservedAtSeconds) / 60)) * config.waitingSecondsPerMinute),
    readinessUncertainty: 0 // verified observed presence; forecasts score plans only
  };
  return { score: round(Object.values(components).reduce((a, b) => a + b, 0)),
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round(v)])),
    projectedCompletionDelaySeconds: round(projectedCompletion) };
}

function recommendObserved(snapshot, context, legacy, config) {
  const now = context.nowSeconds;
  const base = { timeSeconds: now, informationTimeSeconds: snapshot?.asOfSeconds,
    latestObservedAtSeconds: snapshot?.latestObservedAtSeconds, algorithmVersion: ADAPTIVE_VERSION,
    advisory: true, simulationOnly: true, requiresStaffApproval: true, requiresGateVerification: true,
    stage: STAGE_NAMES[context.stage], action: 'WAIT', unitId: null, memberIds: [],
    plannedUnitId: null, predictedReadyAtSeconds: null, releaseAtSeconds: null,
    nextReviewSeconds: round(now + legacy.reviewIntervalSeconds), readyUnitCount: 0 };
  const hold = (reason, reasonText) => ({ ...base, reason, reasonText });
  if (!Number.isFinite(now) || snapshot?.asOfSeconds !== now || (snapshot.latestObservedAtSeconds !== null && snapshot.latestObservedAtSeconds > now)
      || context.policySnapshot?.asOfSeconds !== now
      || (context.policySnapshot.latestObservedAtSeconds !== null && (!Number.isFinite(context.policySnapshot.latestObservedAtSeconds)
        || context.policySnapshot.latestObservedAtSeconds > now))) return hold('INFORMATION_UNRELIABLE', 'Hold for current observations and policy confirmation; no forecast authorizes entry.');
  if (context.policySnapshot.rules?.status !== 'CONFIRMED') return hold('POLICY_REVIEW_REQUIRED', 'Hold for staff confirmation of the selected policy.');
  const byId = new Map(snapshot.passengers.map(p => [p.id, p]));
  const staff = new Map(context.policySnapshot.passengers.map(p => [p.passengerId, p]));
  const stageUnits = context.pendingUnits.filter(u => u.stage === context.stage);
  if (!stageUnits.length) return hold('ALL_STAGE_UNITS_CALLED', 'No further group is pending in this stage; existing cabin occupants may still be seating.');
  const eligible = stageUnits.filter(u => u.memberIds.length && u.memberIds.every(id => byId.has(id) && readyEvidence(byId.get(id), now, staff.get(id))));
  const planned = stageUnits.filter(u => !eligible.includes(u)).map(u => {
    const members = u.memberIds.map(id => byId.get(id));
    const predictions = members.map(p => p?.prediction);
    if (predictions.some(p => !p || !Number.isFinite(p.estimatedGateArrivalSeconds))) return null;
    const stale = predictions.some(p => p.overdue || p.securityOverdue || (p.observationAgeSeconds ?? 0) > config.staleObservationSeconds);
    const uncertainty = Math.max(...predictions.map(p => config.uncertaintyBaseSeconds
      + Math.min(config.staleObservationSeconds, p.observationAgeSeconds ?? 0) * config.uncertaintyAgeWeight
      + (p.overdue || p.securityOverdue ? config.overdueUncertaintySeconds : 0)));
    return { id: u.id, at: Math.max(...predictions.map(p => p.estimatedGateArrivalSeconds)), stale, uncertainty };
  }).filter(Boolean).sort((a, b) => a.at + a.uncertainty - b.at - b.uncertainty || a.id.localeCompare(b.id));
  if (!eligible.length) {
    const next = planned[0];
    return { ...hold('NO_CONFIRMED_READY_UNIT', 'Hold: every member needs observed clearance, gate presence, staff approval, gate verification and declared baggage within allowance.'),
      plannedUnitId: next?.id ?? null, predictedReadyAtSeconds: null, plannedGateETASeconds: next?.at ?? null,
      readinessUncertaintySeconds: next?.uncertainty ?? null, staleETA: next?.stale ?? null,
      nextReviewSeconds: round(Math.min(base.nextReviewSeconds, next && next.at > now ? next.at : base.nextReviewSeconds)) };
  }
  // Keep the existing common protected-stage lottery; general optimization is
  // work conserving and never delays a verified ready group for a forecast.
  if (context.stage < 2) {
    const allowed = new Set(eligible.flatMap(u => u.memberIds));
    const filtered = { ...snapshot, passengers: snapshot.passengers.map(p => ({ ...p, readyAtGate: allowed.has(p.id) })) };
    const decision = legacyRecommendation(filtered, context, legacy);
    if (decision.action === 'RELEASE') {
      const check = reviewBoardingRecommendation(snapshot, context, context.policySnapshot, decision);
      if (!check.simulationAdmissionAllowed) return { ...hold('POLICY_SAFE_HOLD', `Independent protected-stage review: ${check.reason}.`), policyReason: check.reason };
    }
    return { ...base, ...decision, algorithmVersion: ADAPTIVE_VERSION,
      reasonText: decision.action === 'RELEASE' ? 'Preserve the common protected-stage lottery for a fully confirmed group.'
        : 'Preserve the confirmed assistance/escort arrangement until the aisle is empty.', readyUnitCount: eligible.length,
      releaseInterval: decision.action === 'RELEASE' ? { notBeforeSeconds: now, minimumDurationSeconds: (decision.memberIds.length - 1) * context.assumptions.gateHeadwaySeconds, forecastOnly: true } : null };
  }
  if (context.cabin.aisle.some(o => o.cell === 0)) return {
    ...hold('ENTRANCE_OCCUPIED', 'A verified group is ready; recheck next tick because the entrance cell is occupied.'),
    plannedUnitId: eligible[0].id, readyUnitCount: eligible.length, nextReviewSeconds: round(now + context.assumptions.tickSeconds)
  };
  const scored = eligible.map((unit, rank) => ({ unit, rank, ...expectedGroupCost(unit, byId, context, legacy, config) }))
    .sort((a, b) => a.score - b.score || a.rank - b.rank);
  const best = scored[0];
  const check = reviewBoardingRecommendation(snapshot, context, context.policySnapshot, { unitId: best.unit.id, memberIds: best.unit.memberIds });
  if (!check.simulationAdmissionAllowed) return { ...hold('POLICY_SAFE_HOLD', `Independent policy review held this proposal: ${check.reason}.`), policyReason: check.reason };
  return { ...base, action: 'RELEASE', unitId: best.unit.id, memberIds: [...best.unit.memberIds],
    predictedReadyAtSeconds: now, releaseAtSeconds: now, readyUnitCount: eligible.length,
    reason: 'MIN_EXPECTED_OBSERVABLE_DELAY', reasonText: 'Release a fully verified whole group now; minimize expected path/seat delay and induced blocking while overlapping baggage work.',
    score: best.score, scoreComponents: best.components, projectedCompletionDelaySeconds: best.projectedCompletionDelaySeconds,
    readinessUncertaintySeconds: 0,
    releaseInterval: { notBeforeSeconds: now, minimumDurationSeconds: (best.unit.memberIds.length - 1) * context.assumptions.gateHeadwaySeconds,
      forecastOnly: true, actualEntryRequiresFreeAisleCell: true } };
}

export function recommendPassengerAware(snapshot, context, legacy, config = adaptiveV2Settings()) {
  try { return recommendObserved(snapshot, context, legacy, config); }
  catch {
    return { timeSeconds: context?.nowSeconds ?? null, informationTimeSeconds: snapshot?.asOfSeconds ?? null,
      algorithmVersion: ADAPTIVE_VERSION, advisory: true, simulationOnly: true, requiresStaffApproval: true, requiresGateVerification: true,
      action: 'WAIT', unitId: null, memberIds: [], plannedUnitId: null, predictedReadyAtSeconds: null, releaseAtSeconds: null,
      reason: 'INFORMATION_UNRELIABLE', reasonText: 'Hold for staff review of incomplete or inconsistent observations.',
      nextReviewSeconds: Number.isFinite(context?.nowSeconds) ? context.nowSeconds + legacy.reviewIntervalSeconds : null };
  }
}

export function createPassengerAwareController(legacy, patch = {}) {
  const config = adaptiveV2Settings(patch);
  return { recommend(snapshot, context) { return recommendPassengerAware(snapshot, context, legacy, config); } };
}
