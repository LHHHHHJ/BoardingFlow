import { blockingSeats, parseSeat, seatDepth, STAGE_NAMES } from './model.js';

const round = value => Math.round(value * 1000) / 1000;

// This module accepts observations and public passenger details only. It does
// not import a manifest, simulator truth, scenario generator, or random stream.
export function recommendNextUnit(snapshot, context, settings) {
  const { nowSeconds, stage, pendingUnits, cabin, heldSinceSeconds = null } = context;
  if (snapshot.asOfSeconds !== nowSeconds || (snapshot.latestObservedAtSeconds !== null
      && snapshot.latestObservedAtSeconds > nowSeconds)) throw new Error('Policy received observations from the future');
  const byId = new Map(snapshot.passengers.map(passenger => [passenger.id, passenger]));
  const stageUnits = pendingUnits.filter(unit => unit.stage === stage);
  const seated = new Set(cabin.seatedSeats);
  const scored = stageUnits.map((unit, rank) => {
    const members = unit.memberIds.map(id => byId.get(id));
    if (members.some(member => !member)) throw new Error('Unknown policy passenger');
    const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
    const row = Math.max(...members.map(p => parseSeat(p.seatNumber).row));
    const expectedBaggage = mean(members.map(p => p.declaredCabinBaggage.overheadPieces * settings.expectedStowSecondsPerBag));
    const congestion = cabin.aisle.filter(person => person.cell <= row && person.targetRow <= row)
      .reduce((total, person) => total + (byId.get(person.passengerId)?.declaredCabinBaggage.overheadPieces ?? 0)
        * settings.expectedStowSecondsPerBag + 4, 0);
    const components = {
      seatDepth: mean(members.map(p => seatDepth(parseSeat(p.seatNumber).letter))) * settings.seatDepthWeight,
      knownSeatInterference: mean(members.map(p => blockingSeats(p.seatNumber).filter(seat => seated.has(seat)).length)) * settings.interferenceWeight,
      baggage: -expectedBaggage * 0.25,
      row: -row * settings.rowWeight,
      zone: (unit.zone - 1) * settings.zoneWeight,
      congestion: congestion * settings.congestionWeight,
      waiting: -Math.min(20, mean(members.map(p => p.gateObservedAtSeconds === null ? 0 : (nowSeconds - p.gateObservedAtSeconds) / 60)))
    };
    const estimates = members.map(p => p.prediction.estimatedGateArrivalSeconds);
    return { unit, rank, score: round(Object.values(components).reduce((a, b) => a + b, 0)),
      components, ready: members.every(p => p.readyAtGate),
      predictedArrival: estimates.some(value => value === null) ? null : Math.max(...estimates) };
  });
  const bestFirst = (a, b) => a.score - b.score || a.rank - b.rank;
  const ready = scored.filter(item => item.ready);
  // Protected stages retain the common lottery. General boarding is adaptive.
  if (stage === 2) ready.sort(bestFirst);
  const base = {
    timeSeconds: nowSeconds, informationTimeSeconds: snapshot.asOfSeconds,
    latestObservedAtSeconds: snapshot.latestObservedAtSeconds,
    stage: STAGE_NAMES[stage], action: 'WAIT', unitId: null, memberIds: [],
    plannedUnitId: null, predictedReadyAtSeconds: null, releaseAtSeconds: null,
    nextReviewSeconds: round(nowSeconds + settings.reviewIntervalSeconds),
    readyUnitCount: ready.length, reason: 'NO_READY_ELIGIBLE_UNIT'
  };
  const future = scored.filter(item => !item.ready && item.predictedArrival !== null)
    .sort((a, b) => a.predictedArrival - b.predictedArrival || bestFirst(a, b));
  if (!ready.length) {
    const next = future[0];
    return { ...base, reason: stageUnits.length ? base.reason : 'ALL_STAGE_UNITS_CALLED',
      plannedUnitId: next?.unit.id ?? null, predictedReadyAtSeconds: next?.predictedArrival ?? null };
  }
  const best = ready[0];
  if (best.unit.assisted && cabin.aisle.length) return { ...base, reason: 'ASSISTANCE_REQUIRES_EMPTY_AISLE', plannedUnitId: best.unit.id };
  if (stage === 2) {
    const spent = heldSinceSeconds === null ? 0 : nowSeconds - heldSinceSeconds;
    const budget = Math.max(0, settings.maxAnticipationWaitSeconds - spent);
    const alternative = future.filter(item => item.predictedArrival > nowSeconds
      && item.predictedArrival - nowSeconds <= Math.min(settings.lookaheadSeconds, budget))
      .sort(bestFirst).find(item => item.score + (item.predictedArrival - nowSeconds) * settings.waitCostPerSecond
        + settings.minimumScoreImprovement < best.score);
    if (alternative) return { ...base, reason: 'BETTER_FIT_EXPECTED_SOON',
      plannedUnitId: alternative.unit.id, predictedReadyAtSeconds: alternative.predictedArrival,
      nextReviewSeconds: round(Math.min(base.nextReviewSeconds, alternative.predictedArrival)),
      currentReadyScore: best.score, anticipatedScore: alternative.score,
      remainingAnticipationBudgetSeconds: round(budget) };
  }
  return { ...base, action: 'RELEASE', unitId: best.unit.id, memberIds: best.unit.memberIds,
    predictedReadyAtSeconds: best.predictedArrival, releaseAtSeconds: nowSeconds,
    reason: stage === 2 ? 'BEST_OBSERVED_READY_FIT' : 'PROTECTED_STAGE_READY',
    score: best.score, scoreComponents: Object.fromEntries(Object.entries(best.components).map(([key, value]) => [key, round(value)])) };
}

export function createAdaptiveController(settings) {
  let heldSinceSeconds = null;
  return {
    recommend(snapshot, context) {
      const recommendation = recommendNextUnit(snapshot, { ...context, heldSinceSeconds }, settings);
      if (recommendation.reason === 'BETTER_FIT_EXPECTED_SOON' && heldSinceSeconds === null) heldSinceSeconds = context.nowSeconds;
      if (recommendation.action === 'RELEASE') heldSinceSeconds = null;
      return recommendation;
    }
  };
}
