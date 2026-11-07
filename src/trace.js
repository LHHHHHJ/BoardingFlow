import { blockingSeats, canonicalJSON, manifestHash, parseSeat, STAGE_NAMES, validateManifest } from './model.js';
import { boardingUnits } from './strategies.js';
import { constraintReport } from './constraints.js';

export const TRACE_SCHEMA_VERSION = 1;
export const TRACE_EVENT_TYPES = Object.freeze([
  'stage_opened', 'unit_called', 'boarded', 'moved', 'row_service_started',
  'assistance_started', 'assistance_completed', 'stow_started', 'stow_completed',
  'seat_interference_started', 'seat_interference_completed', 'seating_started', 'seated',
  'aisle_block_started', 'aisle_block_ended', 'gate_entry_block_started', 'gate_entry_block_ended',
  'escort_released', 'boarding_completed'
]);
const round = value => Math.round(value * 1e6) / 1e6;

export function createTraceMetadata(manifest) {
  const dt = manifest.config.simulation.tickSeconds;
  const units = boardingUnits(manifest);
  const byId = new Map(units.flatMap(unit => unit.members.map(passenger => [passenger.id, unit])));
  return {
    schemaVersion: TRACE_SCHEMA_VERSION, engine: 'boardingflow-single-aisle-cells',
    timeUnit: 'seconds', tickSeconds: dt, timeOrigin: manifest.flight.boardingOpenTime,
    geometry: { rows: manifest.config.aircraft.rows, seatLetters: manifest.config.aircraft.seatLetters, entranceCell: 0, cellCapacity: 1 },
    ordering: 'eventIndex is chronological; sequence is the unique emission identifier. Cell intervals are half-open.',
    eventTypes: TRACE_EVENT_TYPES,
    passengers: manifest.passengers.map(passenger => ({
      passengerId: passenger.id, seatNumber: passenger.seatNumber, row: parseSeat(passenger.seatNumber).row,
      unitId: byId.get(passenger.id).id, stage: STAGE_NAMES[byId.get(passenger.id).stage],
      walkStepSeconds: round(Math.ceil(passenger.behavior.walkSecondsPerRow / dt - 1e-10) * dt)
    }))
  };
}

export function createTraceEnvelope(manifest, result) {
  if (!result.events || !result.traceMetadata) throw new Error('No structured trace; simulate with --trace');
  return { traceSchemaVersion: TRACE_SCHEMA_VERSION, dataKind: 'SYNTHETIC', strategy: result.strategy,
    inputHash: result.inputHash, metadata: result.traceMetadata, metrics: result.metrics,
    validation: result.traceValidation, events: result.events };
}

// Independent post-run replay. This module never chooses boarding order and
// never supplies future truth to a policy. It checks each tick, even empty ones.
export function validateSimulationTrace(manifest, source, { requireFullFlight = true } = {}) {
  validateManifest(manifest, { requireFullFlight });
  const fail = message => { throw new Error(`Trace invariant failed: ${message}`); };
  const metadata = source.metadata ?? source.traceMetadata;
  if (!metadata || metadata.schemaVersion !== TRACE_SCHEMA_VERSION
      || (source.traceSchemaVersion !== undefined && source.traceSchemaVersion !== TRACE_SCHEMA_VERSION)) {
    fail('unsupported trace schema; regenerate with --trace');
  }
  if (source.dataKind !== 'SYNTHETIC' || source.inputHash !== manifestHash(manifest)) fail('input identity mismatch');
  if (canonicalJSON(metadata) !== canonicalJSON(createTraceMetadata(manifest))) fail('geometry/passenger metadata mismatch');
  const events = source.events;
  if (!Array.isArray(events) || !events.length) fail('events are required');
  if (events[0].type !== 'stage_opened' || events[0].stage !== 'PREBOARD' || events[0].timeSeconds !== 0) fail('initial stage event is required');
  const config = manifest.config.simulation;
  const dt = config.tickSeconds;
  const quantize = value => round(Math.ceil(value / dt - 1e-10) * dt);
  const close = (actual, expected, label) => {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-5) fail(`${label}: expected ${expected}, got ${actual}`);
  };
  const atTick = value => {
    if (!Number.isFinite(value) || value < 0 || value > config.maxSimulationSeconds + 1e-5) fail('invalid event time');
    const tick = Math.round(value / dt);
    close(value, tick * dt, 'event time is off the simulation grid');
    return tick;
  };
  const frames = new Map();
  const identifiers = new Set();
  let previousTime = -Infinity;
  for (const [index, event] of events.entries()) {
    if (!TRACE_EVENT_TYPES.includes(event.type)) fail('unknown event type');
    if (event.eventIndex !== index || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || identifiers.has(event.sequence)) fail('invalid event index/identifier');
    identifiers.add(event.sequence);
    if (event.timeSeconds < previousTime) fail('events are not chronological');
    previousTime = event.timeSeconds;
    const tick = atTick(event.timeSeconds);
    if (!frames.has(tick)) frames.set(tick, []);
    frames.get(tick).push(event);
  }
  const endTick = atTick(events.at(-1).timeSeconds);
  const passengers = new Map(manifest.passengers.map(p => [p.id, p]));
  const descriptions = new Map(metadata.passengers.map(p => [p.passengerId, p]));
  const units = new Map(boardingUnits(manifest).map(unit => [unit.id, unit]));
  const states = new Map();
  const cells = new Map();
  const seatedSeats = new Set();
  const called = new Set();
  const escortsReleased = new Set();
  let gateBlock = null;
  let gateAdmissionDue = null;
  let gateBlockedSeconds = 0;
  let lastAdmission = -Infinity;
  let openedStage = -1;
  let completionCount = 0;
  let peak = 0;
  const phaseTypes = new Set(['assistance_started', 'assistance_completed', 'stow_started', 'stow_completed',
    'seat_interference_started', 'seat_interference_completed', 'seating_started']);
  for (let tick = 0; tick <= endTick; tick++) {
    const now = round(tick * dt);
    let physicalPhase = 0; // Release cells, move, then admit at the same instant.
    for (const event of frames.get(tick) ?? []) {
      const passenger = passengers.get(event.passengerId);
      const description = descriptions.get(event.passengerId);
      const state = states.get(event.passengerId);
      if (event.passengerId !== undefined && !passenger) fail('unknown passenger');
      if (!['stage_opened', 'unit_called', 'escort_released', 'boarding_completed'].includes(event.type) && !passenger) fail('passengerId is required');
      if (event.type === 'stage_opened') {
        const stage = STAGE_NAMES.indexOf(event.stage);
        if (stage !== openedStage + 1 || (stage === 0 && now !== 0)) fail('invalid stage transition');
        for (const item of metadata.passengers) {
          if (stage === 1 && item.stage === 'PREBOARD' && states.get(item.passengerId)?.seatedAtSeconds === undefined) fail('priority stage opened before preboarding seated');
          if (stage === 2 && item.stage === 'PRIORITY' && !states.has(item.passengerId)) fail('general stage opened before priority entry');
        }
        openedStage = stage;
      } else if (event.type === 'unit_called') {
        const unit = units.get(event.unitId);
        if (!unit || called.has(unit.id) || unit.stage !== openedStage || event.stage !== STAGE_NAMES[unit.stage]
            || event.assisted !== unit.assisted || canonicalJSON(event.memberIds) !== canonicalJSON(unit.members.map(p => p.id))) fail('invalid boarding unit call');
        if (unit.members.some(p => p.gateArrivalSeconds > now)) fail('party called before all members arrived');
        if (unit.assisted && cells.size) fail('assistance requires an empty aisle');
        called.add(unit.id);
      } else if (event.type === 'boarded') {
        if (state || cells.has(0) || event.cell !== 0 || !called.has(description.unitId)) fail('duplicate entry or occupied entrance');
        if (event.seatNumber !== passenger.seatNumber || event.unitId !== description.unitId || event.stage !== description.stage
            || event.stage !== STAGE_NAMES[openedStage]) fail('entry metadata or stage mismatch');
        if (now < Math.max(0, passenger.gateArrivalSeconds, passenger.securityClearedAtSeconds, passenger.checkInAtSeconds)) fail('entry before arrival/clearance');
        if (now - lastAdmission < quantize(config.gateHeadwaySeconds) - 1e-5) fail('gate headway violated');
        if (gateAdmissionDue && (gateAdmissionDue.passengerId !== passenger.id || gateAdmissionDue.time !== now)) fail('gate block did not end with its waiting admission');
        gateAdmissionDue = null;
        lastAdmission = now;
        physicalPhase = 2;
        states.set(passenger.id, { passengerId: passenger.id, seatNumber: passenger.seatNumber, unitId: event.unitId, stage: event.stage,
          cell: 0, lastMove: now, boardedAtSeconds: now, gateWaitSeconds: now - passenger.gateArrivalSeconds,
          blockStart: null, blockEndAwaitingMove: null, aisleBlockingSeconds: 0, markers: new Set() });
        cells.set(0, passenger.id);
      } else if (event.type === 'moved') {
        if (physicalPhase > 1) fail('walking after gate admission in the same tick');
        physicalPhase = 1;
        if (!state || state.cell !== event.fromCell || cells.get(event.fromCell) !== passenger.id
            || event.cell !== event.fromCell + 1 || event.cell > description.row || cells.has(event.cell)) fail('impossible movement or aisle collision');
        if (state.blockStart !== null || state.rowArrivalSeconds !== undefined) fail('movement while blocked or servicing');
        if (now - state.lastMove < description.walkStepSeconds - 1e-5) fail('walking faster than sampled speed');
        cells.delete(state.cell);
        cells.set(event.cell, passenger.id);
        state.cell = event.cell;
        state.lastMove = now;
        state.blockEndAwaitingMove = null;
      } else if (event.type === 'row_service_started') {
        if (!state || state.cell !== description.row || event.cell !== state.cell || state.lastMove !== now
            || state.rowArrivalSeconds !== undefined) fail('row service at wrong location/time');
        const blockers = blockingSeats(passenger.seatNumber).filter(seat => seatedSeats.has(seat));
        if (canonicalJSON(event.blockingSeats) !== canonicalJSON(blockers)) fail('seat interference blockers mismatch');
        const assistance = passenger.assistance.type === 'MOBILITY' ? config.mobilityAssistanceSeconds
          : passenger.assistance.type === 'EXTRA_TIME' ? config.extraTimeAssistanceSeconds : 0;
        Object.assign(state, { rowArrivalSeconds: now, assistanceSeconds: quantize(assistance),
          stowSeconds: quantize(passenger.actualBaggage.overheadPieces * passenger.behavior.stowSecondsPerBag),
          seatInterferenceSeconds: quantize(blockers.length * config.seatInterferenceSecondsPerBlocker),
          seatInterferenceCount: blockers.length, seatingSeconds: quantize(passenger.behavior.seatSeconds) });
        state.rowServiceSeconds = round(state.assistanceSeconds + state.stowSeconds + state.seatInterferenceSeconds + state.seatingSeconds);
        state.expectedEnd = round(now + state.rowServiceSeconds);
        for (const key of ['assistanceSeconds', 'stowSeconds', 'seatInterferenceSeconds', 'seatingSeconds']) close(event[key], state[key], key);
        close(event.serviceEndSeconds, state.expectedEnd, 'row service end');
        state.expectedMarkers = new Map();
        if (state.assistanceSeconds) {
          state.expectedMarkers.set('assistance_started', now);
          state.expectedMarkers.set('assistance_completed', round(now + state.assistanceSeconds));
        }
        const stowStart = round(now + state.assistanceSeconds);
        if (state.stowSeconds) {
          state.expectedMarkers.set('stow_started', stowStart);
          state.expectedMarkers.set('stow_completed', round(stowStart + state.stowSeconds));
        }
        const interferenceStart = round(stowStart + state.stowSeconds);
        if (state.seatInterferenceSeconds) {
          state.expectedMarkers.set('seat_interference_started', interferenceStart);
          state.expectedMarkers.set('seat_interference_completed', round(interferenceStart + state.seatInterferenceSeconds));
        }
        state.expectedMarkers.set('seating_started', round(interferenceStart + state.seatInterferenceSeconds));
      } else if (phaseTypes.has(event.type)) {
        if (!state?.expectedMarkers?.has(event.type) || state.markers.has(event.type)) fail('unexpected/duplicate service phase');
        close(now, state.expectedMarkers.get(event.type), 'service phase time');
        state.markers.add(event.type);
      } else if (event.type === 'seated') {
        if (physicalPhase > 0) fail('cell release after walking/admission in the same tick');
        if (!state || state.cell !== description.row || event.cell !== state.cell || cells.get(state.cell) !== passenger.id
            || state.expectedEnd === undefined || state.markers.size !== state.expectedMarkers.size || seatedSeats.has(passenger.seatNumber)) fail('invalid seating');
        close(now, state.expectedEnd, 'seating time');
        state.seatedAtSeconds = now;
        cells.delete(state.cell);
        state.cell = null;
        seatedSeats.add(passenger.seatNumber);
      } else if (event.type === 'aisle_block_started') {
        if (!state || state.cell !== event.cell || state.cell >= description.row || state.blockStart !== null
            || event.blockedCell !== state.cell + 1 || cells.get(event.blockedCell) !== event.blockedByPassengerId
            || !cells.has(event.blockedCell) || now < state.lastMove + description.walkStepSeconds - 1e-5) fail('invalid aisle blocking reason');
        state.blockStart = now;
      } else if (event.type === 'aisle_block_ended') {
        if (!state || state.blockStart === null || state.cell !== event.cell || now <= state.blockStart) fail('invalid aisle block end');
        close(event.durationSeconds, now - state.blockStart, 'aisle block duration');
        state.aisleBlockingSeconds = round(state.aisleBlockingSeconds + event.durationSeconds);
        state.blockStart = null;
        state.blockEndAwaitingMove = now;
      } else if (event.type === 'gate_entry_block_started') {
        if (gateBlock || state || !cells.has(0) || cells.get(0) !== event.blockedByPassengerId
            || !called.has(description.unitId) || description.stage !== STAGE_NAMES[openedStage]
            || units.get(description.unitId).members.some(p => p.gateArrivalSeconds > now)
            || now - lastAdmission < quantize(config.gateHeadwaySeconds) - 1e-5) fail('invalid gate blocking reason');
        gateBlock = { start: now, passengerId: passenger.id };
      } else if (event.type === 'gate_entry_block_ended') {
        if (!gateBlock || gateBlock.passengerId !== passenger.id || cells.has(0) || now <= gateBlock.start) fail('invalid gate block end');
        close(event.durationSeconds, now - gateBlock.start, 'gate block duration');
        gateBlockedSeconds = round(gateBlockedSeconds + event.durationSeconds);
        gateAdmissionDue = { passengerId: passenger.id, time: now };
        gateBlock = null;
      } else if (event.type === 'escort_released') {
        const unit = units.get(event.unitId);
        if (!unit?.assisted || escortsReleased.has(unit.id) || unit.members.some(p => states.get(p.id)?.seatedAtSeconds === undefined)) fail('invalid escort release');
        close(now, Math.max(...unit.members.map(p => states.get(p.id).seatedAtSeconds)), 'escort release time');
        escortsReleased.add(unit.id);
      } else if (event.type === 'boarding_completed') {
        completionCount++;
        if (cells.size || seatedSeats.size !== passengers.size || event.passengerCount !== passengers.size || event !== events.at(-1)) fail('invalid boarding completion');
      }
    }
    peak = Math.max(peak, cells.size);
    if (cells.size > manifest.config.aircraft.rows + 1) fail('queue exceeds physical aisle capacity');
    for (const [cell, id] of cells) {
      const state = states.get(id);
      const description = descriptions.get(id);
      if (state.blockEndAwaitingMove !== null) fail('block ended without movement');
      if (cell === description.row) {
        if (state.rowArrivalSeconds === undefined || state.expectedEnd <= now + 1e-5) fail('missing or overdue row service');
      } else if (state.lastMove + description.walkStepSeconds <= now + 1e-5 && state.lastMove < now) {
        if (!cells.has(cell + 1)) fail('unexplained queue: ready passenger paused in a clear aisle');
        if (state.blockStart === null) fail('missing aisle blocking interval');
      }
    }
    if (gateBlock && !cells.has(0)) fail('gate blockage continued after entrance cleared');
    if (gateAdmissionDue) fail('gate block ended without admission');
  }
  if (completionCount !== 1 || seatedSeats.size !== passengers.size || gateBlock) fail('incomplete trace');
  for (const unit of units.values()) if (unit.assisted && !escortsReleased.has(unit.id)) fail('missing escort release');
  const timings = [...states.values()];
  for (const state of timings) {
    const description = descriptions.get(state.passengerId);
    close(state.rowArrivalSeconds - state.boardedAtSeconds, description.row * description.walkStepSeconds + state.aisleBlockingSeconds, 'walking/blocking reconciliation');
    if (state.blockStart !== null) fail('unclosed aisle blocking interval');
  }
  const constraints = constraintReport(manifest, { passengerTimings: timings });
  if (constraints.total) fail('boarding rights/party/assistance constraints violated');
  const sum = key => round(timings.reduce((total, row) => total + row[key], 0));
  const count = timings.length;
  const mean = key => count ? round(sum(key) / count) : 0;
  const total = round(endTick * dt);
  const metrics = {
    passengerCount: count, totalBoardingSeconds: total, activeBoardingSeconds: count ? round(total - timings[0].boardedAtSeconds) : 0,
    totalGateWaitSeconds: sum('gateWaitSeconds'), meanGateWaitSeconds: mean('gateWaitSeconds'),
    maxGateWaitSeconds: count ? Math.max(...timings.map(row => row.gateWaitSeconds)) : 0,
    aisleBlockingPersonSeconds: sum('aisleBlockingSeconds'), aisleBlockingPersonMinutes: round(sum('aisleBlockingSeconds') / 60),
    meanAisleBlockingSeconds: mean('aisleBlockingSeconds'), gateEntranceBlockedSeconds: gateBlockedSeconds,
    rowServicePersonSeconds: sum('rowServiceSeconds'), stowPersonSeconds: sum('stowSeconds'),
    seatInterferencePersonSeconds: sum('seatInterferenceSeconds'), seatInterferenceCount: sum('seatInterferenceCount'),
    maxConcurrentInAisle: peak, constraintViolationCount: constraints.total
  };
  if (source.metrics) for (const [key, value] of Object.entries(metrics)) close(source.metrics[key], value, `metric ${key}`);
  return { passed: true, traceSchemaVersion: TRACE_SCHEMA_VERSION, eventCount: events.length, seatedExactlyOnce: count,
    collisionFree: true, movementTimingRespected: true, noUnexplainedAisleQueues: true, servicePhasesVerified: true,
    blockingIntervalsReconciled: true, constraints, metrics };
}
