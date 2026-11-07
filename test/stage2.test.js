import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFlight } from '../src/generate.js';
import { simulate, auditResult } from '../src/simulate.js';
import { createTraceEnvelope, validateSimulationTrace, TRACE_EVENT_TYPES } from '../src/trace.js';
import { STRATEGIES } from '../src/strategies.js';

function fixture(seats, tickSeconds = 1) {
  const manifest = generateFlight(8, { aircraft: { rows: 3 }, simulation: { tickSeconds } });
  manifest.passengers = seats.map((seatNumber, index) => ({
    ...manifest.passengers[index], id: `STAGE2-${index}`, seatNumber, boardingZone: 1,
    priorityEligible: index === 0, mandatoryPreboarding: false, travelPartyId: null,
    assistance: { type: 'NONE', companionId: null },
    gateArrivalSeconds: 0, securityClearedAtSeconds: -10, checkInAtSeconds: -20,
    actualBaggage: { overheadPieces: 0, personalItems: 0, overheadWeightKg: 0 },
    behavior: { walkSecondsPerRow: 1, seatSeconds: 1, stowSecondsPerBag: 10 }
  }));
  return manifest;
}
const run = (manifest, options = {}) => simulate(manifest, 'random', { requireFullFlight: false, trace: true, ...options });
const audit = (manifest, source) => validateSimulationTrace(manifest, source, { requireFullFlight: false });
function changedTrace(manifest, result, mutate) {
  const source = structuredClone(createTraceEnvelope(manifest, result));
  mutate(source);
  source.events.forEach((event, eventIndex) => { event.eventIndex = eventIndex; });
  return source;
}

test('Stage 2 uses one engine and trace mode preserves original strategy metrics and timings', () => {
  const manifest = generateFlight(42);
  for (const [index, strategy] of STRATEGIES.entries()) {
    const plain = simulate(manifest, strategy);
    const traced = simulate(manifest, strategy, { trace: true });
    assert.deepEqual(traced.metrics, plain.metrics);
    assert.deepEqual(traced.passengerTimings, plain.passengerTimings);
    assert.equal(traced.metrics.totalBoardingSeconds, [1624, 1796, 1426][index]);
    assert.equal(traced.traceValidation.seatedExactlyOnce, 180);
    assert.ok(traced.traceValidation.noUnexplainedAisleQueues);
    assert.equal(traced.metrics.aisleBlockingPersonMinutes, Math.round(traced.metrics.aisleBlockingPersonSeconds / 60 * 1e6) / 1e6);
  }
});

test('single passenger trace accounts for walking, assistance, luggage and seating at exact times', () => {
  const manifest = fixture(['3A']);
  const passenger = manifest.passengers[0];
  passenger.assistance.type = 'MOBILITY';
  passenger.behavior.walkSecondsPerRow = 2;
  passenger.actualBaggage = { overheadPieces: 1, personalItems: 1, overheadWeightKg: 5 };
  const result = run(manifest);
  assert.equal(result.metrics.totalBoardingSeconds, 57); // 6 walk + 40 assistance + 10 stow + 1 sit.
  const at = type => result.events.find(event => event.type === type).timeSeconds;
  assert.equal(at('assistance_started'), 6);
  assert.equal(at('assistance_completed'), 46);
  assert.equal(at('stow_started'), 46);
  assert.equal(at('stow_completed'), 56);
  assert.equal(at('seating_started'), 56);
  assert.equal(at('seated'), 57);
});

test('blocking intervals explain the known 9-second follower delay and reconcile metrics', () => {
  const manifest = fixture(['1A', '3F']);
  manifest.passengers[0].actualBaggage = { overheadPieces: 1, personalItems: 0, overheadWeightKg: 5 };
  const result = run(manifest);
  const intervals = result.events.filter(event => event.type === 'aisle_block_ended');
  assert.equal(intervals.reduce((sum, event) => sum + event.durationSeconds, 0), 9);
  assert.equal(result.metrics.aisleBlockingPersonSeconds, 9);
  assert.equal(result.metrics.aisleBlockingPersonMinutes, 0.15);
  assert.equal(result.events.find(event => event.type === 'aisle_block_started').blockedByPassengerId, 'STAGE2-0');
  assert.equal(audit(manifest, createTraceEnvelope(manifest, result)).metrics.aisleBlockingPersonSeconds, 9);
});

test('traces show genuine parallel stowing rather than a sum of passenger service times', () => {
  const manifest = fixture(['3A', '1F']);
  for (const passenger of manifest.passengers) passenger.actualBaggage = { overheadPieces: 1, personalItems: 0, overheadWeightKg: 5 };
  const result = run(manifest);
  assert.equal(result.metrics.totalBoardingSeconds, 14);
  assert.equal(result.metrics.stowPersonSeconds, 20);
  assert.deepEqual(result.events.filter(event => event.type === 'stow_started').map(event => event.timeSeconds), [3, 3]);
});

test('a fast follower cannot overtake a slow leader and entrance blocking is explicit', () => {
  const manifest = fixture(['3A', '3F']);
  manifest.passengers[0].behavior.walkSecondsPerRow = 3;
  const result = run(manifest);
  assert.equal(result.passengerTimings[1].boardedAtSeconds, 3);
  assert.equal(result.metrics.gateEntranceBlockedSeconds, 1);
  assert.equal(result.events.filter(event => event.type === 'gate_entry_block_ended').reduce((sum, event) => sum + event.durationSeconds, 0), 1);
  const positions = new Map();
  for (const event of result.events) {
    if (event.type === 'boarded' || event.type === 'moved') positions.set(event.passengerId, event.cell);
    if (event.type === 'seated') positions.delete(event.passengerId);
    if (positions.has('STAGE2-0') && positions.has('STAGE2-1')) assert.ok(positions.get('STAGE2-0') > positions.get('STAGE2-1'));
  }
});

test('both seat sides report one- and two-blocker interference with matched phase boundaries', () => {
  const manifest = fixture(['1C', '1B', '1A', '1D', '1E', '1F']);
  manifest.passengers.forEach((passenger, index) => { passenger.gateArrivalSeconds = index * 100; });
  const result = run(manifest);
  assert.deepEqual(result.passengerTimings.map(row => row.seatInterferenceCount), [0, 1, 2, 0, 1, 2]);
  assert.equal(result.metrics.seatInterferencePersonSeconds, 48);
  assert.equal(result.events.filter(event => event.type === 'seat_interference_started').length, 4);
  assert.equal(result.events.filter(event => event.type === 'seat_interference_completed').length, 4);
});

test('late companions, mandatory assistance and protected stages remain valid in trace replay', () => {
  const manifest = fixture(['2A', '2B', '3A', '1F']);
  const [assisted, companion, priority] = manifest.passengers;
  assisted.assistance = { type: 'MOBILITY', companionId: companion.id };
  assisted.travelPartyId = companion.travelPartyId = 'STAGE2-PARTY';
  companion.gateArrivalSeconds = 20;
  priority.priorityEligible = true;
  priority.gateArrivalSeconds = 100;
  const result = run(manifest);
  assert.equal(result.passengerTimings[0].boardedAtSeconds, 20);
  assert.deepEqual(result.passengerTimings.map(row => row.stage), ['PREBOARD', 'PREBOARD', 'PRIORITY', 'GENERAL']);
  assert.equal(result.traceValidation.constraints.total, 0);
});

test('fractional ticks and rounded walking/service times remain replayable', () => {
  for (const dt of [0.1, 0.5, 1]) {
    const manifest = fixture(['3A', '1F'], dt);
    manifest.passengers[0].behavior = { walkSecondsPerRow: 1.3, stowSecondsPerBag: 2.3, seatSeconds: 1.2 };
    manifest.passengers[0].actualBaggage = { overheadPieces: 1, personalItems: 0, overheadWeightKg: 5 };
    const result = run(manifest);
    assert.equal(result.traceValidation.passed, true);
    assert.equal(audit(manifest, createTraceEnvelope(manifest, result)).passed, true);
  }
});

test('dense all-bag flight stays within the aisle capacity and has no unexplained movement waits', () => {
  const manifest = generateFlight(42, { generation: { partyProbability: 0, assistanceProbability: 0,
    additionalPreboardingProbability: 0, priorityProbability: 0, overheadBagProbability: 1, lateArrivalProbability: 0,
    stowSecondsPerBagMin: 20, stowSecondsPerBagMax: 20 }, simulation: { gateHeadwaySeconds: 1 } });
  for (const passenger of manifest.passengers) passenger.gateArrivalSeconds = 0;
  const result = simulate(manifest, 'random', { trace: true });
  assert.ok(result.metrics.maxConcurrentInAisle > 1 && result.metrics.maxConcurrentInAisle <= 31);
  assert.ok(result.metrics.gateEntranceBlockedSeconds > 0);
  assert.ok(result.traceValidation.noUnexplainedAisleQueues);
});

test('trace envelope includes replay geometry, units, chronological indices and deterministic identities', () => {
  const manifest = fixture(['3A']);
  const result = run(manifest);
  const envelope = createTraceEnvelope(manifest, result);
  assert.equal(envelope.traceSchemaVersion, 1);
  assert.equal(envelope.metadata.geometry.cellCapacity, 1);
  assert.equal(envelope.metadata.passengers[0].seatNumber, '3A');
  assert.deepEqual(envelope.metadata.eventTypes, TRACE_EVENT_TYPES);
  assert.deepEqual(envelope.events.map(event => event.eventIndex), envelope.events.map((event, index) => index));
  assert.deepEqual(envelope, createTraceEnvelope(manifest, run(manifest)));
  assert.equal(audit(manifest, envelope).passed, true);
});

test('empty trace has one completion, zero occupants and zero passenger-time metrics', () => {
  const manifest = fixture([]);
  const result = run(manifest);
  assert.equal(result.events.filter(event => event.type === 'boarding_completed').length, 1);
  assert.equal(result.traceValidation.seatedExactlyOnce, 0);
  for (const value of Object.values(result.metrics)) assert.equal(value, 0);
});

test('trace audit rejects teleports, excessive speed, wrong-row service and skipped clear-aisle movement', () => {
  const manifest = fixture(['3A']);
  manifest.passengers[0].behavior.walkSecondsPerRow = 2;
  const result = run(manifest);
  const mutate = action => changedTrace(manifest, result, action);
  assert.throws(() => audit(manifest, mutate(source => { source.events.find(e => e.type === 'moved').cell = 2; })), /impossible movement/);
  assert.throws(() => audit(manifest, mutate(source => { source.events.find(e => e.type === 'moved').timeSeconds = 1; })), /faster/);
  assert.throws(() => audit(manifest, mutate(source => { source.events.find(e => e.type === 'row_service_started').cell = 2; })), /row service/);
  assert.throws(() => audit(manifest, mutate(source => { source.events.splice(source.events.findIndex(e => e.type === 'moved'), 1); })), /unexplained queue/);
});

test('trace audit rejects a collision even when event times and indices are re-sorted', () => {
  const manifest = fixture(['1A', '3F']);
  manifest.passengers[0].actualBaggage = { overheadPieces: 1, personalItems: 0, overheadWeightKg: 5 };
  const result = run(manifest);
  const source = changedTrace(manifest, result, trace => {
    trace.events.find(e => e.type === 'moved' && e.passengerId === 'STAGE2-1').timeSeconds = 3;
    trace.events.sort((a, b) => a.timeSeconds - b.timeSeconds || a.sequence - b.sequence);
  });
  assert.throws(() => audit(manifest, source), /collision/);
});

test('trace audit rejects bad blocking/service durations, missing phases and altered aggregate metrics', () => {
  const manifest = fixture(['1A', '3F']);
  manifest.passengers[0].actualBaggage = { overheadPieces: 1, personalItems: 0, overheadWeightKg: 5 };
  const result = run(manifest);
  for (const mutate of [
    source => { source.events.find(e => e.type === 'aisle_block_ended').durationSeconds++; },
    source => { source.events.find(e => e.type === 'row_service_started').stowSeconds++; },
    source => { source.events.splice(source.events.findIndex(e => e.type === 'stow_completed'), 1); },
    source => { source.metrics.meanGateWaitSeconds++; },
    source => { source.metrics.aisleBlockingPersonMinutes++; },
    source => { source.events.splice(source.events.findIndex(e => e.type === 'seated'), 1); }
  ]) assert.throws(() => audit(manifest, changedTrace(manifest, result, mutate)), /Trace invariant/);
});

test('trace audit rejects malformed identities, timestamps, ordering and unsupported trace versions', () => {
  const manifest = fixture(['3A']);
  const result = run(manifest);
  for (const mutate of [
    source => { source.inputHash = 'wrong'; },
    source => { source.metadata.geometry.rows++; },
    source => { source.traceSchemaVersion = 99; },
    source => { source.events[0].timeSeconds = -1; },
    source => { source.events[0].timeSeconds = NaN; },
    source => { source.events[1].timeSeconds = 0.25; },
    source => { source.events[1].sequence = source.events[0].sequence; },
    source => { source.events.find(e => e.type === 'moved').passengerId = 'UNKNOWN'; },
    source => { source.events[0].type = 'TELEPORT'; }
  ]) assert.throws(() => audit(manifest, changedTrace(manifest, result, mutate)), /Trace invariant/);
});

test('timing audit rejects NaN, inconsistent durations, false gate wait and corrupted metrics without a trace', () => {
  const manifest = fixture(['3A', '1F']);
  const result = run(manifest, { trace: false });
  for (const mutate of [
    copy => { copy.passengerTimings[0].inAisleSeconds = NaN; },
    copy => { copy.passengerTimings[0].gateWaitSeconds++; },
    copy => { copy.passengerTimings[0].rowServiceSeconds++; },
    copy => { copy.passengerTimings[1].boardedAtSeconds = 0; },
    copy => { copy.metrics.meanGateWaitSeconds++; },
    copy => { copy.metrics.aisleBlockingPersonMinutes++; },
    copy => { copy.metrics.maxConcurrentInAisle = 100; }
  ]) {
    const copy = structuredClone(result);
    mutate(copy);
    assert.throws(() => auditResult(manifest, copy, { requireFullFlight: false }), /Simulation invariant/);
  }
});

test('CLI exports and independently validates a structured trace; corrupted files fail', () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-stage2-'));
  const cli = args => execFileSync(process.execPath, ['src/cli.js', ...args], { cwd: project, encoding: 'utf8' });
  try {
    const config = join(directory, 'small-config.json');
    const input = join(directory, 'manifest.json');
    writeFileSync(config, JSON.stringify({ aircraft: { rows: 2 } }));
    cli(['generate', '--seed', '42', '--config', config, '--output', input]);
    const output = join(directory, 'run');
    cli(['simulate', '--input', input, '--output', output, '--trace']);
    const traceFile = join(output, 'events-random.json');
    const reportFile = join(directory, 'validation.json');
    assert.match(cli(['validate-trace', '--input', input, '--trace-file', traceFile, '--output', reportFile]), /VALID TRACE/);
    assert.equal(JSON.parse(readFileSync(reportFile, 'utf8')).seatedExactlyOnce, 12);
    const source = JSON.parse(readFileSync(traceFile, 'utf8'));
    source.events.find(event => event.type === 'moved').cell += 2;
    writeFileSync(traceFile, JSON.stringify(source));
    const failed = spawnSync(process.execPath, ['src/cli.js', 'validate-trace', '--input', input, '--trace-file', traceFile], { cwd: project, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Trace invariant/);
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('boardingflow-stage2-'));
    rmSync(target, { recursive: true, force: true });
  }
});
