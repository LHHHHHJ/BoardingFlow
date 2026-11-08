import { blockingSeats, manifestHash, parseSeat, STAGE_NAMES, validateManifest } from './model.js';
import { boardingUnits, orderUnits, readyUnit } from './strategies.js';
import { validateScenario } from './scenarios.js';
import { createReadinessObserver } from './readiness.js';
import { createAdaptiveController } from './adaptive.js';
import { createPassengerAwareController, ADAPTIVE_VERSION } from './adaptive-v2.js';
import { createPolicyObserver, reviewBoardingRecommendation } from './policy.js';
import { constraintReport } from './constraints.js';
import { createTraceMetadata, validateSimulationTrace } from './trace.js';

const clean = value => Math.round(value * 1_000_000) / 1_000_000;
const sum = (items, key) => clean(items.reduce((total, item) => total + item[key], 0));

export function simulate(manifest, strategy, { trace = false, requireFullFlight = true, adaptiveVersion = null, adaptiveSettings = {} } = {}) {
  validateManifest(manifest, { requireFullFlight });
  if (manifest.phase2) validateScenario(manifest, { requireFullFlight });
  if (manifest.boardingPolicy?.status === 'UNVERIFIED') throw new Error('Policy unverified: staff review required before simulated boarding');
  if (strategy === 'adaptive' && !manifest.phase2) throw new Error('Adaptive boarding requires a Phase 2 scenario; generate with --scenario normal');
  const pending = orderUnits(manifest, strategy);
  const observer = manifest.phase2 ? createReadinessObserver(manifest) : null;
  const policyObserver = manifest.boardingPolicy ? createPolicyObserver(manifest.boardingPolicy, manifest.passengers) : null;
  const policyAdvisories = [];
  const selectedVersion = adaptiveVersion ?? (manifest.boardingPolicy ? ADAPTIVE_VERSION : 'legacy-v1');
  if (strategy === 'adaptive' && ![ADAPTIVE_VERSION, 'legacy-v1'].includes(selectedVersion)) throw new Error('Unknown adaptive controller version');
  const passengerAware = strategy === 'adaptive' && selectedVersion === ADAPTIVE_VERSION;
  if (passengerAware && !manifest.boardingPolicy) throw new Error('Passenger-aware Adaptive requires an explicit confirmed policy');
  const adaptive = strategy === 'adaptive' ? (passengerAware
    ? createPassengerAwareController(manifest.phase2.settings.adaptive, adaptiveSettings)
    : createAdaptiveController(manifest.phase2.settings.adaptive)) : null;
  const recommendations = [];
  let lastRecommendation = null;
  let lastCabinSignature = null;
  const { simulation: config, aircraft } = manifest.config;
  const dt = config.tickSeconds;
  const ticks = seconds => Math.ceil(seconds / dt - 1e-10);
  const seconds = tick => clean(tick * dt);
  const aisle = Array(aircraft.rows + 1).fill(null); // 0 = aircraft entrance, 1..N = row cells.
  const seated = new Set();
  const records = new Map();
  const events = [];
  let eventSequence = 0;
  const emit = (tick, type, details = {}) => {
    if (trace) events.push({ timeSeconds: seconds(tick), type, ...details, sequence: eventSequence++ });
  };
  let stage = 0;
  let activeUnit = null;
  let memberIndex = 0;
  let escortUnit = null;
  let nextAdmissionTick = 0;
  let gateEntranceBlockedTicks = 0;
  let gateBlockedSinceTick = null;
  let maxConcurrentInAisle = 0;
  let completionTick = 0;
  const occupied = () => aisle.some(Boolean);
  emit(0, 'stage_opened', { stage: STAGE_NAMES[stage] });

  function startService(state, tick) {
    const passenger = state.passenger;
    const blockers = blockingSeats(passenger.seatNumber).filter(seat => seated.has(seat));
    const assistanceSeconds = passenger.assistance.type === 'MOBILITY' ? config.mobilityAssistanceSeconds
      : passenger.assistance.type === 'EXTRA_TIME' ? config.extraTimeAssistanceSeconds : 0;
    const assistanceTicks = ticks(assistanceSeconds);
    const stowTicks = ticks(passenger.actualBaggage.overheadPieces * passenger.behavior.stowSecondsPerBag);
    const interferenceTicks = ticks(blockers.length * config.seatInterferenceSecondsPerBlocker);
    const seatTicks = ticks(passenger.behavior.seatSeconds);
    const record = records.get(passenger.id);
    Object.assign(record, {
      rowArrivalSeconds: seconds(tick),
      assistanceSeconds: seconds(assistanceTicks),
      stowSeconds: seconds(stowTicks),
      seatInterferenceSeconds: seconds(interferenceTicks),
      seatInterferenceCount: blockers.length,
      seatingSeconds: seconds(seatTicks),
      rowServiceSeconds: seconds(assistanceTicks + stowTicks + interferenceTicks + seatTicks)
    });
    state.serviceEndTick = tick + assistanceTicks + stowTicks + interferenceTicks + seatTicks;
    emit(tick, 'row_service_started', { passengerId: passenger.id, cell: state.cell, blockingSeats: blockers,
      assistanceSeconds: record.assistanceSeconds, stowSeconds: record.stowSeconds,
      seatInterferenceSeconds: record.seatInterferenceSeconds, seatingSeconds: record.seatingSeconds,
      serviceEndSeconds: seconds(state.serviceEndTick) });
    if (assistanceTicks) emit(tick, 'assistance_started', { passengerId: passenger.id, durationSeconds: seconds(assistanceTicks) });
    const stowStart = tick + assistanceTicks;
    if (assistanceTicks) emit(stowStart, 'assistance_completed', { passengerId: passenger.id });
    if (stowTicks) {
      emit(stowStart, 'stow_started', { passengerId: passenger.id, pieces: passenger.actualBaggage.overheadPieces });
      emit(stowStart + stowTicks, 'stow_completed', { passengerId: passenger.id });
    }
    const interferenceStart = stowStart + stowTicks;
    if (interferenceTicks) emit(interferenceStart, 'seat_interference_started', { passengerId: passenger.id, blockingSeats: blockers });
    if (interferenceTicks) emit(interferenceStart + interferenceTicks, 'seat_interference_completed', { passengerId: passenger.id });
    emit(interferenceStart + interferenceTicks, 'seating_started', { passengerId: passenger.id });
  }

  const maxTicks = Math.floor(config.maxSimulationSeconds / dt + 1e-10);
  for (let tick = 0; tick <= maxTicks; tick++) {
    completionTick = tick;
    const observedChange = observer?.advance(seconds(tick)) ?? false;
    const policyObservedChange = policyObserver?.advance(seconds(tick)) ?? false;
    // Row cells are held until service finishes. Events at a boundary use
    // half-open occupancy intervals: release, movement, then admission.
    for (let cell = 1; cell <= aircraft.rows; cell++) {
      const state = aisle[cell];
      if (state && state.serviceEndTick !== null && state.serviceEndTick <= tick) {
        seated.add(state.passenger.seatNumber);
        const record = records.get(state.passenger.id);
        record.seatedAtSeconds = seconds(tick);
        record.inAisleSeconds = clean(record.seatedAtSeconds - record.boardedAtSeconds);
        aisle[cell] = null;
        emit(tick, 'seated', { passengerId: state.passenger.id, cell });
      }
    }
    if (escortUnit && escortUnit.members.every(p => records.get(p.id)?.seatedAtSeconds !== undefined)) {
      emit(tick, 'escort_released', { unitId: escortUnit.id });
      escortUnit = null;
    }
    if (seated.size === manifest.passengers.length) {
      emit(tick, 'boarding_completed', { passengerCount: seated.size });
      break;
    }

    // Rear-to-front update permits a line to advance together by one cell,
    // while nobody can pass or move more than one cell in a tick.
    for (let cell = aircraft.rows - 1; cell >= 0; cell--) {
      const state = aisle[cell];
      if (!state || state.serviceEndTick !== null || state.nextMoveTick > tick) continue;
      if (aisle[cell + 1]) {
        if (state.blockedSinceTick === null) {
          state.blockedSinceTick = tick;
          emit(tick, 'aisle_block_started', { passengerId: state.passenger.id, cell,
            blockedCell: cell + 1, blockedByPassengerId: aisle[cell + 1].passenger.id });
        }
        records.get(state.passenger.id).aisleBlockingSeconds += dt;
      } else {
        if (state.blockedSinceTick !== null) {
          emit(tick, 'aisle_block_ended', { passengerId: state.passenger.id, cell,
            durationSeconds: seconds(tick - state.blockedSinceTick) });
          state.blockedSinceTick = null;
        }
        aisle[cell] = null;
        aisle[cell + 1] = state;
        state.cell = cell + 1;
        state.nextMoveTick = tick + state.walkTicks;
        emit(tick, 'moved', { passengerId: state.passenger.id, fromCell: cell, cell: cell + 1 });
        if (state.cell === state.row) startService(state, tick);
      }
    }

    // Preboarding must finish seating before priority admission begins.
    // Priority admission must finish before general admission begins.
    while (stage < 2 && !activeUnit && !escortUnit && !pending.some(unit => unit.stage === stage)) {
      if (stage === 0 && occupied()) break;
      stage++;
      emit(tick, 'stage_opened', { stage: STAGE_NAMES[stage] });
    }

    if (tick >= nextAdmissionTick && !escortUnit) {
      if (!activeUnit) {
        let candidate;
        if (adaptive) {
          const visibleCabin = { seatedSeats: [...seated],
            aisle: aisle.filter(Boolean).map(state => ({ passengerId: state.passenger.id, cell: state.cell, targetRow: state.row,
              ...(passengerAware ? { rowObservedAtSeconds: records.get(state.passenger.id)?.rowArrivalSeconds ?? null } : {}) })) };
          const cabinSignature = passengerAware ? JSON.stringify(visibleCabin) : null;
          const cabinChanged = passengerAware && pending.length > 0 && cabinSignature !== lastCabinSignature;
          if (!lastRecommendation || lastRecommendation.action !== 'WAIT' || lastRecommendation.stage !== STAGE_NAMES[stage]
              || observedChange || seconds(tick) >= lastRecommendation.nextReviewSeconds
              || (lastRecommendation.reason === 'ASSISTANCE_REQUIRES_EMPTY_AISLE' && !occupied())
              || (passengerAware && (policyObservedChange || cabinChanged))) {
            // The allowlist below is the boundary between execution truth and
            // optimization. No raw unit, passenger, future event or service-end
            // timestamp crosses it.
            lastRecommendation = adaptive.recommend(observer.snapshot(seconds(tick)), {
              nowSeconds: seconds(tick), stage,
              pendingUnits: pending.map(unit => ({ id: unit.id, memberIds: unit.members.map(p => p.id),
                stage: unit.stage, zone: unit.zone, assisted: unit.assisted })),
              cabin: visibleCabin,
              ...(passengerAware ? { strategy, cabinOccupied: occupied(),
                policySnapshot: policyObserver.snapshot(seconds(tick)),
                boardedPassengerIds: [...records.keys()],
                seatedPassengerIds: [...records.values()].filter(r => r.seatedAtSeconds !== undefined).map(r => r.passengerId),
                assumptions: { tickSeconds: dt, gateHeadwaySeconds: config.gateHeadwaySeconds,
                  seatInterferenceSecondsPerBlocker: config.seatInterferenceSecondsPerBlocker,
                  mobilityAssistanceSeconds: config.mobilityAssistanceSeconds, extraTimeAssistanceSeconds: config.extraTimeAssistanceSeconds }
              } : {})
            });
            if (passengerAware) lastRecommendation = { ...lastRecommendation, trigger: observedChange ? 'PASSENGER_OBSERVATION'
              : policyObservedChange ? 'STAFF_OBSERVATION' : cabinChanged ? 'CABIN_PROGRESS' : 'STAGE_OR_REVIEW_TIMER' };
            lastCabinSignature = cabinSignature;
            recommendations.push(policyObserver ? { ...lastRecommendation, advisory: true, simulationOnly: true,
              requiresStaffApproval: true, requiresGateVerification: true, executionAuthorization: 'NONE_ADVISORY_ONLY' } : lastRecommendation);
          }
          if (lastRecommendation.action === 'RELEASE') candidate = pending.find(unit => unit.id === lastRecommendation.unitId);
        } else if (observer) {
          const units = pending.filter(unit => unit.stage === stage);
          const zone = strategy === 'zone' && stage === 2 ? Math.min(...units.map(unit => unit.zone)) : null;
          candidate = units.find(unit => (zone === null || unit.zone === zone)
            && unit.members.every(p => observer.isReadyAtGate(p.id) && (!policyObserver || policyObserver.confirmed(p.id))));
        } else {
          candidate = readyUnit(pending, stage, seconds(tick), strategy);
        }
        if (policyObserver && candidate) {
          const snapshot = observer.snapshot(seconds(tick));
          const policySnapshot = policyObserver.snapshot(seconds(tick));
          const context = { nowSeconds: seconds(tick), stage, strategy, cabinOccupied: occupied(),
            boardedPassengerIds: [...records.keys()],
            seatedPassengerIds: [...records.values()].filter(r => r.seatedAtSeconds !== undefined).map(r => r.passengerId),
            pendingUnits: pending.map(u => ({ id: u.id, memberIds: u.members.map(p => p.id), stage: u.stage, zone: u.zone, assisted: u.assisted })) };
          let review = reviewBoardingRecommendation(snapshot, context, policySnapshot, { unitId: candidate.id, memberIds: candidate.members.map(p => p.id) });
          if (!review.simulationAdmissionAllowed && review.reason === 'STAFF_APPROVAL_OR_GATE_VERIFICATION_PENDING') {
            const fallback = reviewBoardingRecommendation(snapshot, context, policySnapshot);
            if (fallback.simulationAdmissionAllowed) review = fallback;
          }
          policyAdvisories.push(review);
          candidate = review.simulationAdmissionAllowed ? pending.find(u => u.id === review.unitId) : null;
        }
        // An assisted party reserves the otherwise empty aisle and escort.
        if (candidate && (!candidate.assisted || !occupied())) {
          activeUnit = candidate;
          pending.splice(pending.indexOf(candidate), 1);
          memberIndex = 0;
          emit(tick, 'unit_called', { unitId: candidate.id, stage: STAGE_NAMES[stage], assisted: candidate.assisted,
            memberIds: candidate.members.map(passenger => passenger.id) });
        }
      }
      if (activeUnit) {
        if (aisle[0]) {
          if (gateBlockedSinceTick === null) {
            gateBlockedSinceTick = tick;
            emit(tick, 'gate_entry_block_started', { passengerId: activeUnit.members[memberIndex].id,
              blockedByPassengerId: aisle[0].passenger.id });
          }
          gateEntranceBlockedTicks++;
        } else {
          if (gateBlockedSinceTick !== null) {
            emit(tick, 'gate_entry_block_ended', { passengerId: activeUnit.members[memberIndex].id,
              durationSeconds: seconds(tick - gateBlockedSinceTick) });
            gateBlockedSinceTick = null;
          }
          const passenger = activeUnit.members[memberIndex++];
          if (seconds(tick) < passenger.gateArrivalSeconds || (observer && !observer.isReadyAtGate(passenger.id))
              || (policyObserver && !policyObserver.confirmed(passenger.id))) {
            throw new Error('Execution guard: passenger is not actually cleared and present at gate');
          }
          const { row } = parseSeat(passenger.seatNumber);
          const walkTicks = ticks(passenger.behavior.walkSecondsPerRow);
          aisle[0] = { passenger, row, cell: 0, walkTicks, nextMoveTick: tick + walkTicks, serviceEndTick: null, blockedSinceTick: null };
          records.set(passenger.id, {
            passengerId: passenger.id,
            seatNumber: passenger.seatNumber,
            unitId: activeUnit.id,
            stage: STAGE_NAMES[activeUnit.stage],
            gateArrivalSeconds: passenger.gateArrivalSeconds,
            boardedAtSeconds: seconds(tick),
            gateWaitSeconds: clean(seconds(tick) - passenger.gateArrivalSeconds),
            freeWalkingSeconds: seconds(row * walkTicks),
            aisleBlockingSeconds: 0
          });
          emit(tick, 'boarded', { passengerId: passenger.id, cell: 0, seatNumber: passenger.seatNumber,
            stage: STAGE_NAMES[stage], unitId: activeUnit.id });
          nextAdmissionTick = tick + ticks(config.gateHeadwaySeconds);
          if (memberIndex === activeUnit.members.length) {
            if (activeUnit.assisted) escortUnit = activeUnit;
            activeUnit = null;
          }
        }
      }
    }
    maxConcurrentInAisle = Math.max(maxConcurrentInAisle, aisle.filter(Boolean).length);
  }
  if (seated.size !== manifest.passengers.length) {
    throw new Error(`Simulation exceeded ${config.maxSimulationSeconds}s: ${seated.size}/${manifest.passengers.length} seated; check late arrivals or raise maxSimulationSeconds`);
  }
  const timings = [...records.values()];
  for (const record of timings) record.aisleBlockingSeconds = clean(record.aisleBlockingSeconds);
  const count = timings.length;
  const mean = key => count ? clean(sum(timings, key) / count) : 0;
  const result = {
    strategy,
    dataKind: 'SYNTHETIC',
    seed: manifest.seed,
    inputHash: manifestHash(manifest),
    metrics: {
      passengerCount: count,
      totalBoardingSeconds: count ? seconds(completionTick) : 0,
      activeBoardingSeconds: count ? clean(seconds(completionTick) - timings[0].boardedAtSeconds) : 0,
      totalGateWaitSeconds: sum(timings, 'gateWaitSeconds'),
      meanGateWaitSeconds: mean('gateWaitSeconds'),
      maxGateWaitSeconds: count ? Math.max(...timings.map(r => r.gateWaitSeconds)) : 0,
      aisleBlockingPersonSeconds: sum(timings, 'aisleBlockingSeconds'),
      aisleBlockingPersonMinutes: clean(sum(timings, 'aisleBlockingSeconds') / 60),
      meanAisleBlockingSeconds: mean('aisleBlockingSeconds'),
      gateEntranceBlockedSeconds: seconds(gateEntranceBlockedTicks),
      rowServicePersonSeconds: sum(timings, 'rowServiceSeconds'),
      stowPersonSeconds: sum(timings, 'stowSeconds'),
      seatInterferencePersonSeconds: sum(timings, 'seatInterferenceSeconds'),
      seatInterferenceCount: sum(timings, 'seatInterferenceCount'),
      maxConcurrentInAisle
    },
    passengerTimings: timings
  };
  if (trace) {
    result.traceMetadata = createTraceMetadata(manifest);
    result.events = events.sort((a, b) => a.timeSeconds - b.timeSeconds || a.sequence - b.sequence)
      .map((event, eventIndex) => ({ ...event, eventIndex }));
  }
  if (adaptive) result.recommendations = recommendations;
  if (passengerAware) result.adaptiveVersion = ADAPTIVE_VERSION;
  if (policyObserver) {
    result.policyProfileId = manifest.boardingPolicy.profileId;
    result.policyAdvisories = policyAdvisories;
  }
  result.constraintViolations = constraintReport(manifest, result);
  result.metrics.constraintViolationCount = result.constraintViolations.total;
  if (result.constraintViolations.total) throw new Error('Boarding constraint violations detected');
  result.validation = auditResult(manifest, result, { requireFullFlight });
  if (trace) result.traceValidation = validateSimulationTrace(manifest, result, { requireFullFlight });
  return result;
}

export function auditResult(manifest, result, { requireFullFlight = true } = {}) {
  validateManifest(manifest, { requireFullFlight });
  const fail = message => { throw new Error(`Simulation invariant failed: ${message}`); };
  const timings = result.passengerTimings;
  if (!Array.isArray(timings) || !result.metrics) fail('timings and metrics are required');
  if (result.inputHash !== manifestHash(manifest)) fail('input fingerprint changed');
  if (timings.length !== manifest.passengers.length) fail('not all passengers seated');
  const byId = new Map(manifest.passengers.map(p => [p.id, p]));
  const unitByPassenger = new Map(boardingUnits(manifest).flatMap(unit => unit.members.map(p => [p.id, unit])));
  const ids = new Set();
  const seats = new Set();
  let previousStage = -1;
  let previousBoardedAt = -Infinity;
  const dt = manifest.config.simulation.tickSeconds;
  const quantize = value => clean(Math.ceil(value / dt - 1e-10) * dt);
  const close = (actual, expected, label) => {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-5) fail(`${label} inconsistent`);
  };
  for (const record of timings) {
    const passenger = byId.get(record.passengerId);
    if (!passenger || ids.has(record.passengerId) || seats.has(record.seatNumber)) fail('unknown or duplicate seating');
    ids.add(record.passengerId);
    seats.add(record.seatNumber);
    if (record.seatNumber !== passenger.seatNumber) fail('seat assignment changed');
    const unit = unitByPassenger.get(passenger.id);
    if (record.stage !== STAGE_NAMES[unit.stage] || unit.stage < previousStage) fail('priority stages violated');
    previousStage = unit.stage;
    for (const key of ['boardedAtSeconds', 'rowArrivalSeconds', 'seatedAtSeconds', 'gateWaitSeconds', 'freeWalkingSeconds',
      'aisleBlockingSeconds', 'rowServiceSeconds', 'assistanceSeconds', 'stowSeconds', 'seatInterferenceSeconds',
      'seatInterferenceCount', 'seatingSeconds', 'inAisleSeconds']) {
      if (!Number.isFinite(record[key]) || record[key] < 0) fail(`invalid ${key}`);
    }
    if (!Number.isFinite(record.boardedAtSeconds) || !Number.isFinite(record.seatedAtSeconds)
        || record.boardedAtSeconds < Math.max(0, passenger.gateArrivalSeconds)
        || record.seatedAtSeconds <= record.boardedAtSeconds) fail('invalid boarding/seating time');
    if (record.boardedAtSeconds - previousBoardedAt < quantize(manifest.config.simulation.gateHeadwaySeconds) - 1e-5) fail('admission headway inconsistent');
    previousBoardedAt = record.boardedAtSeconds;
    for (const key of ['boardedAtSeconds', 'rowArrivalSeconds', 'seatedAtSeconds']) close(record[key], Math.round(record[key] / dt) * dt, 'timestamp grid');
    close(record.gateWaitSeconds, record.boardedAtSeconds - passenger.gateArrivalSeconds, 'gate wait');
    close(record.freeWalkingSeconds, parseSeat(passenger.seatNumber).row * quantize(passenger.behavior.walkSecondsPerRow), 'free walking');
    close(record.rowArrivalSeconds - record.boardedAtSeconds, record.freeWalkingSeconds + record.aisleBlockingSeconds, 'row arrival');
    close(record.rowServiceSeconds, record.assistanceSeconds + record.stowSeconds + record.seatInterferenceSeconds + record.seatingSeconds, 'row service');
    close(record.seatedAtSeconds - record.rowArrivalSeconds, record.rowServiceSeconds, 'seating completion');
    close(record.inAisleSeconds, record.seatedAtSeconds - record.boardedAtSeconds, 'in-aisle duration');
    close(record.stowSeconds, quantize(passenger.actualBaggage.overheadPieces * passenger.behavior.stowSecondsPerBag), 'stowing duration');
    close(record.seatingSeconds, quantize(passenger.behavior.seatSeconds), 'seating duration');
    const assistance = passenger.assistance.type === 'MOBILITY' ? manifest.config.simulation.mobilityAssistanceSeconds
      : passenger.assistance.type === 'EXTRA_TIME' ? manifest.config.simulation.extraTimeAssistanceSeconds : 0;
    close(record.assistanceSeconds, quantize(assistance), 'assistance duration');
    const expected = record.freeWalkingSeconds + record.aisleBlockingSeconds + record.rowServiceSeconds;
    if (Math.abs(record.inAisleSeconds - expected) > 1e-5 || record.aisleBlockingSeconds < 0) fail('aisle time does not reconcile');
  }
  const bySeat = new Map(timings.map(record => [record.seatNumber, record]));
  for (const record of timings) {
    const blockers = blockingSeats(record.seatNumber).filter(seat => bySeat.has(seat) && bySeat.get(seat).seatedAtSeconds <= record.rowArrivalSeconds);
    close(record.seatInterferenceCount, blockers.length, 'seat interference count');
    close(record.seatInterferenceSeconds, quantize(blockers.length * manifest.config.simulation.seatInterferenceSecondsPerBlocker), 'seat interference duration');
  }
  const preboardEnd = Math.max(0, ...timings.filter(r => r.stage === 'PREBOARD').map(r => r.seatedAtSeconds));
  if (timings.some(r => r.stage !== 'PREBOARD' && r.boardedAtSeconds < preboardEnd)) fail('preboarding seating barrier violated');
  for (const unit of new Set(unitByPassenger.values())) {
    const indexes = timings.map((record, index) => record.unitId === unit.id ? index : -1).filter(index => index >= 0);
    if (indexes.length !== unit.members.length || indexes.at(-1) - indexes[0] + 1 !== indexes.length) fail('party split');
    if (unit.assisted) {
      const members = timings.filter(r => r.unitId === unit.id);
      const start = Math.min(...members.map(r => r.boardedAtSeconds));
      const end = Math.max(...members.map(r => r.seatedAtSeconds));
      if (timings.some(r => r.unitId !== unit.id && r.boardedAtSeconds < end && r.seatedAtSeconds > start)) fail('assistance escort reservation violated');
    }
  }
  const expectedEnd = Math.max(0, ...timings.map(r => r.seatedAtSeconds));
  for (const [key, value] of Object.entries(result.metrics)) if (!Number.isFinite(value) || value < 0) fail(`invalid metric ${key}`);
  close(result.metrics.totalBoardingSeconds, expectedEnd, 'completion metric');
  close(result.metrics.passengerCount, timings.length, 'passenger count metric');
  close(result.metrics.activeBoardingSeconds, timings.length ? expectedEnd - timings[0].boardedAtSeconds : 0, 'active boarding metric');
  close(result.metrics.totalGateWaitSeconds, sum(timings, 'gateWaitSeconds'), 'total gate wait metric');
  close(result.metrics.meanGateWaitSeconds, timings.length ? sum(timings, 'gateWaitSeconds') / timings.length : 0, 'mean gate wait metric');
  close(result.metrics.maxGateWaitSeconds, Math.max(0, ...timings.map(r => r.gateWaitSeconds)), 'maximum gate wait metric');
  close(result.metrics.aisleBlockingPersonSeconds, sum(timings, 'aisleBlockingSeconds'), 'aisle blocking metric');
  if (result.metrics.aisleBlockingPersonMinutes !== undefined) close(result.metrics.aisleBlockingPersonMinutes, sum(timings, 'aisleBlockingSeconds') / 60, 'blocking minutes metric');
  close(result.metrics.meanAisleBlockingSeconds, timings.length ? sum(timings, 'aisleBlockingSeconds') / timings.length : 0, 'mean aisle blocking metric');
  for (const [metric, key] of [['rowServicePersonSeconds', 'rowServiceSeconds'], ['stowPersonSeconds', 'stowSeconds'],
    ['seatInterferencePersonSeconds', 'seatInterferenceSeconds'], ['seatInterferenceCount', 'seatInterferenceCount']]) close(result.metrics[metric], sum(timings, key), metric);
  let concurrent = 0;
  let peak = 0;
  const boundaries = timings.flatMap(record => [[record.boardedAtSeconds, 1], [record.seatedAtSeconds, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, delta] of boundaries) { concurrent += delta; peak = Math.max(peak, concurrent); }
  close(result.metrics.maxConcurrentInAisle, peak, 'peak occupancy metric');
  if (peak > manifest.config.aircraft.rows + 1) fail('aisle queue exceeds cell capacity');
  return {
    passed: true,
    seatedExactlyOnce: ids.size,
    uniqueSeats: seats.size,
    gateArrivalRespected: true,
    priorityStagesRespected: true,
    partiesAndAssistanceRespected: true
  };
}
