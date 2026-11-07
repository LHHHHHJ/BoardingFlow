import { blockingSeats, manifestHash, parseSeat, STAGE_NAMES, validateManifest } from './model.js';
import { boardingUnits, orderUnits, readyUnit } from './strategies.js';

const clean = value => Math.round(value * 1_000_000) / 1_000_000;
const sum = (items, key) => clean(items.reduce((total, item) => total + item[key], 0));

export function simulate(manifest, strategy, { trace = false, requireFullFlight = true } = {}) {
  validateManifest(manifest, { requireFullFlight });
  const pending = orderUnits(manifest, strategy);
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
    emit(tick, 'row_service_started', { passengerId: passenger.id, cell: state.cell, blockingSeats: blockers });
    if (assistanceTicks) emit(tick, 'assistance_started', { passengerId: passenger.id, durationSeconds: seconds(assistanceTicks) });
    const stowStart = tick + assistanceTicks;
    if (stowTicks) {
      emit(stowStart, 'stow_started', { passengerId: passenger.id, pieces: passenger.actualBaggage.overheadPieces });
      emit(stowStart + stowTicks, 'stow_completed', { passengerId: passenger.id });
    }
    const interferenceStart = stowStart + stowTicks;
    if (interferenceTicks) emit(interferenceStart, 'seat_interference_started', { passengerId: passenger.id, blockingSeats: blockers });
    emit(interferenceStart + interferenceTicks, 'seating_started', { passengerId: passenger.id });
  }

  const maxTicks = Math.floor(config.maxSimulationSeconds / dt + 1e-10);
  for (let tick = 0; tick <= maxTicks; tick++) {
    completionTick = tick;
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
        records.get(state.passenger.id).aisleBlockingSeconds += dt;
      } else {
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
        const candidate = readyUnit(pending, stage, seconds(tick), strategy);
        // An assisted party reserves the otherwise empty aisle and escort.
        if (candidate && (!candidate.assisted || !occupied())) {
          activeUnit = candidate;
          pending.splice(pending.indexOf(candidate), 1);
          memberIndex = 0;
          emit(tick, 'unit_called', { unitId: candidate.id, stage: STAGE_NAMES[stage], assisted: candidate.assisted });
        }
      }
      if (activeUnit) {
        if (aisle[0]) {
          gateEntranceBlockedTicks++;
        } else {
          const passenger = activeUnit.members[memberIndex++];
          const { row } = parseSeat(passenger.seatNumber);
          const walkTicks = ticks(passenger.behavior.walkSecondsPerRow);
          aisle[0] = { passenger, row, cell: 0, walkTicks, nextMoveTick: tick + walkTicks, serviceEndTick: null };
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
          emit(tick, 'boarded', { passengerId: passenger.id, cell: 0, stage: STAGE_NAMES[stage], unitId: activeUnit.id });
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
  if (trace) result.events = events.sort((a, b) => a.timeSeconds - b.timeSeconds || a.sequence - b.sequence);
  result.validation = auditResult(manifest, result, { requireFullFlight });
  return result;
}

export function auditResult(manifest, result, { requireFullFlight = true } = {}) {
  validateManifest(manifest, { requireFullFlight });
  const fail = message => { throw new Error(`Simulation invariant failed: ${message}`); };
  const timings = result.passengerTimings;
  if (result.inputHash !== manifestHash(manifest)) fail('input fingerprint changed');
  if (timings.length !== manifest.passengers.length) fail('not all passengers seated');
  const byId = new Map(manifest.passengers.map(p => [p.id, p]));
  const unitByPassenger = new Map(boardingUnits(manifest).flatMap(unit => unit.members.map(p => [p.id, unit])));
  const ids = new Set();
  const seats = new Set();
  let previousStage = -1;
  let previousBoardedAt = -Infinity;
  for (const record of timings) {
    const passenger = byId.get(record.passengerId);
    if (!passenger || ids.has(record.passengerId) || seats.has(record.seatNumber)) fail('unknown or duplicate seating');
    ids.add(record.passengerId);
    seats.add(record.seatNumber);
    if (record.seatNumber !== passenger.seatNumber) fail('seat assignment changed');
    const unit = unitByPassenger.get(passenger.id);
    if (record.stage !== STAGE_NAMES[unit.stage] || unit.stage < previousStage) fail('priority stages violated');
    previousStage = unit.stage;
    if (!Number.isFinite(record.boardedAtSeconds) || !Number.isFinite(record.seatedAtSeconds)
        || record.boardedAtSeconds < Math.max(0, passenger.gateArrivalSeconds)
        || record.seatedAtSeconds <= record.boardedAtSeconds) fail('invalid boarding/seating time');
    if (record.boardedAtSeconds < previousBoardedAt) fail('admission order inconsistent');
    previousBoardedAt = record.boardedAtSeconds;
    const expected = record.freeWalkingSeconds + record.aisleBlockingSeconds + record.rowServiceSeconds;
    if (Math.abs(record.inAisleSeconds - expected) > 1e-5 || record.aisleBlockingSeconds < 0) fail('aisle time does not reconcile');
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
  if (Math.abs(expectedEnd - result.metrics.totalBoardingSeconds) > 1e-5) fail('completion metric inconsistent');
  return {
    passed: true,
    seatedExactlyOnce: ids.size,
    uniqueSeats: seats.size,
    gateArrivalRespected: true,
    priorityStagesRespected: true,
    partiesAndAssistanceRespected: true
  };
}
