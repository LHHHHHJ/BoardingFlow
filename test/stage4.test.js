import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateScenario, validateScenario } from '../src/scenarios.js';
import { DEFAULT_TERMINAL, accessibleRoute, auditTerminal, validateTerminal } from '../src/terminal.js';
import { createReadinessObserver, estimateGateETA, evaluateGateETA } from '../src/readiness.js';
import { phase2Settings } from '../src/phase2-config.js';
import { manifestHash } from '../src/model.js';
import { simulate } from '../src/simulate.js';

function journey(rows = 1) {
  const manifest = generateScenario(42, 'normal', { aircraft: { rows }, generation: {
    assistanceProbability: 0, additionalPreboardingProbability: 0, partyProbability: 0
  } });
  for (const p of manifest.passengers) Object.assign(p, { checkInAtSeconds: -300,
    securityScanAtSeconds: -60, securityClearedAtSeconds: 120, gateArrivalSeconds: 500 });
  const times = { CHECK_IN_CLEARED: -300, SECURITY_ENTERED: -60, SECURITY_CLEARED: 120, CHECKPOINT: 270, GATE_ARRIVED: 500 };
  for (const e of manifest.phase2.observations) e.timeSeconds = times[e.type];
  for (const truth of manifest.phase2.truth) Object.assign(truth, {
    actualSecurityProcessingSeconds: 180, actualWalkingSpeedMps: 1.2, actualStopDelaySeconds: 30
  });
  validateScenario(manifest);
  return manifest;
}
function drop(manifest, ...types) {
  manifest.phase2.observations = manifest.phase2.observations.filter(e => !types.includes(e.type));
  validateScenario(manifest);
  return manifest;
}
const at = (manifest, seconds) => createReadinessObserver(manifest).snapshot(seconds).passengers[0];
const routes = new Map(DEFAULT_TERMINAL.nodes.map(node => [node, accessibleRoute(DEFAULT_TERMINAL, node, 'GATE_B')]));

test('Stage 4 check-in, security entrance and clearance have independent exact-time transitions', () => {
  const observer = createReadinessObserver(journey());
  assert.equal(observer.snapshot(-301).passengers[0].checkIn.status, 'NOT_OBSERVED');
  let p = observer.snapshot(-300).passengers[0];
  assert.equal(p.checkIn.status, 'CLEARED'); assert.equal(p.security.status, 'NOT_OBSERVED');
  p = observer.snapshot(-60).passengers[0];
  assert.equal(p.security.status, 'SCREENING'); assert.equal(p.security.clearedAtSeconds, null);
  assert.ok(p.readinessBlockers.includes('SECURITY_STILL_SCREENING'));
  assert.equal(observer.snapshot(119.999).passengers[0].security.status, 'SCREENING');
  p = observer.snapshot(120).passengers[0];
  assert.equal(p.security.status, 'CLEARED'); assert.equal(p.security.clearedAtSeconds, 120);
  assert.equal(p.readyAtGate, false);
  assert.equal(observer.snapshot(500).passengers[0].readyAtGate, true);
});

test('Stage 4 tape input order and equal-time check-in/entry cannot change causality', () => {
  const first = journey();
  for (const p of first.passengers) p.checkInAtSeconds = -60;
  for (const e of first.phase2.observations.filter(e => e.type === 'CHECK_IN_CLEARED')) e.timeSeconds = -60;
  const shuffled = structuredClone(first);
  shuffled.phase2.observations.reverse();
  validateScenario(shuffled);
  assert.deepEqual(createReadinessObserver(first).snapshot(0), createReadinessObserver(shuffled).snapshot(0));
});

test('Stage 4 duplicate, regressing, mistyped checkpoint and pre-clearance travel events fail', () => {
  const duplicate = journey();
  duplicate.phase2.observations.push({ ...duplicate.phase2.observations[0] });
  assert.throws(() => validateScenario(duplicate), /duplicate/);
  assert.throws(() => createReadinessObserver(duplicate).snapshot(0), /duplicate/);
  const wrongNode = journey();
  wrongNode.phase2.observations.find(e => e.type === 'SECURITY_CLEARED').checkpointId = 'SECURITY_ENTRY';
  assert.throws(() => validateScenario(wrongNode), /checkpoint mismatch/);
  const regressing = journey();
  regressing.phase2.observations.find(e => e.type === 'SECURITY_ENTERED').timeSeconds = 200;
  assert.throws(() => validateScenario(regressing), /regressing/);
  assert.throws(() => createReadinessObserver(regressing).snapshot(200), /regressing/);
  const tooEarly = journey();
  tooEarly.phase2.observations.find(e => e.type === 'CHECKPOINT').timeSeconds = 100;
  assert.throws(() => validateScenario(tooEarly), /regressing|cleared journey/);
  const genericStatus = journey();
  genericStatus.phase2.observations.find(e => e.type === 'CHECKPOINT').checkpointId = 'SECURITY_EXIT';
  assert.throws(() => validateScenario(genericStatus), /explicit event type/);
});

test('Stage 4 terminal audit preserves all six synthetic nodes and accessible route lengths', () => {
  const before = manifestHash(DEFAULT_TERMINAL);
  const report = auditTerminal(DEFAULT_TERMINAL, 'GATE_B');
  assert.equal(report.nodeCount, 6); assert.equal(report.edgeCount, 7);
  assert.equal(report.accessibleEdgeCount, 6); assert.equal(report.excludedInaccessibleEdgeCount, 1);
  assert.deepEqual(report.routes.map(r => [r.checkpointId, r.distanceMeters]), [
    ['CHECK_IN', 540], ['SECURITY_ENTRY', 420], ['SECURITY_EXIT', 420], ['JUNCTION', 240], ['LOUNGE', 220], ['GATE_B', 0]
  ]);
  assert.equal(manifestHash(DEFAULT_TERMINAL), before);
  assert.ok(report.notes.some(note => note.includes('not Toronto Pearson measurements')));
});

test('Stage 4 accessible route supports a different assigned gate, lounge route, and disconnection', () => {
  const terminal = structuredClone(DEFAULT_TERMINAL);
  terminal.nodes.push('GATE_C');
  terminal.edges.push({ from: 'LOUNGE', to: 'GATE_C', distanceMeters: 70, accessible: true });
  assert.deepEqual(accessibleRoute(terminal, 'SECURITY_EXIT', 'GATE_C'), {
    reachable: true, distanceMeters: 350, nodes: ['SECURITY_EXIT', 'JUNCTION', 'LOUNGE', 'GATE_C']
  });
  const manifest = journey();
  manifest.phase2.terminal = terminal; manifest.phase2.assignedGateId = 'GATE_C';
  for (const e of manifest.phase2.observations.filter(e => e.type === 'GATE_ARRIVED')) e.checkpointId = 'GATE_C';
  validateScenario(manifest);
  const p = at(manifest, 120);
  assert.equal(p.prediction.remainingDistanceMeters, 350);
  terminal.edges.at(-1).accessible = false;
  assert.equal(auditTerminal(terminal, 'GATE_C').routes.find(r => r.checkpointId === 'SECURITY_EXIT').reachable, false);
  assert.equal(at(manifest, 120).prediction.basis, 'NO_ACCESSIBLE_ROUTE');
  assert.throws(() => validateScenario(manifest), /accessible route/);
});

test('Stage 4 malformed edge lengths, nodes, accessibility and assigned gates fail', () => {
  for (const edge of [null, { from: 'CHECK_IN', to: 'SECURITY_ENTRY', accessible: true, distanceMeters: -1 },
    { from: 'CHECK_IN', to: 'UNKNOWN', accessible: true, distanceMeters: 1 },
    { from: 'CHECK_IN', to: 'SECURITY_ENTRY', accessible: 'yes', distanceMeters: 1 }]) {
    const terminal = structuredClone(DEFAULT_TERMINAL); terminal.edges.push(edge);
    assert.throws(() => validateTerminal(terminal), /terminal edge/);
  }
  assert.throws(() => auditTerminal(DEFAULT_TERMINAL, 'UNKNOWN'), /assigned gate/);
});

test('Stage 4 hand-calculated ETA separates security, walking and expected stops', () => {
  const manifest = journey();
  const p = at(manifest, 0);
  assert.equal(p.prediction.remainingDistanceMeters, 420);
  assert.equal(p.prediction.securityRemainingSeconds, 120);
  assert.equal(p.prediction.expectedStopDelaySeconds, 26.25);
  assert.equal(p.prediction.estimatedGateArrivalSeconds, 496.25);
  assert.equal(p.prediction.observationAgeSeconds, 60);
  assert.equal(p.prediction.securityOverdue, false);
  assert.equal(manifest.passengers[0].gateArrivalSeconds, 500);
});

test('Stage 4 configurable walking speeds and stops change forecasts without resampling truth', () => {
  const manifest = journey();
  const actual = manifest.passengers.map(p => p.gateArrivalSeconds);
  const initial = at(manifest, 120).prediction.estimatedGateArrivalSeconds;
  manifest.phase2.settings.eta.walkingSpeedMps = 0.6;
  assert.equal(at(manifest, 120).prediction.estimatedGateArrivalSeconds, initial + 350);
  manifest.phase2.settings.eta.stopProbability = 0;
  assert.equal(at(manifest, 120).prediction.expectedStopDelaySeconds, 0);
  assert.deepEqual(manifest.passengers.map(p => p.gateArrivalSeconds), actual);
  const view = structuredClone(at(journey(), 120));
  view.assistance.type = 'MOBILITY';
  assert.equal(estimateGateETA(view, 120, routes, phase2Settings().eta).estimatedGateArrivalSeconds, 671.25);
});

test('Stage 4 overdue security remains screening and stale walking ETAs roll forward', () => {
  const manifest = journey();
  for (const p of manifest.passengers) { p.securityClearedAtSeconds += 600; p.gateArrivalSeconds += 600; }
  for (const e of manifest.phase2.observations) if (['SECURITY_CLEARED', 'CHECKPOINT', 'GATE_ARRIVED'].includes(e.type)) e.timeSeconds += 600;
  for (const truth of manifest.phase2.truth) truth.actualSecurityProcessingSeconds += 600;
  validateScenario(manifest);
  const p = at(manifest, 300);
  assert.equal(p.security.status, 'SCREENING'); assert.equal(p.security.clearedAtSeconds, null);
  assert.equal(p.prediction.securityRemainingSeconds, 30);
  assert.equal(p.prediction.securityOverdue, true);
  assert.equal(p.readyAtGate, false);
  const late = drop(journey(), 'GATE_ARRIVED');
  const overdue = at(late, 700);
  assert.equal(overdue.prediction.overdue, true);
  assert.equal(overdue.prediction.estimatedGateArrivalSeconds, 715);
});

test('Stage 4 missing security entrance uses earlier observation until explicit clearance', () => {
  const manifest = drop(journey(), 'SECURITY_ENTERED');
  const p = at(manifest, 0);
  assert.equal(p.security.status, 'NOT_OBSERVED'); assert.equal(p.security.scanAtSeconds, null);
  assert.equal(p.lastCheckpoint.id, 'CHECK_IN');
  assert.equal(p.prediction.estimatedGateArrivalSeconds, 356.25);
  assert.equal(p.readyAtGate, false);
  const cleared = at(manifest, 120);
  assert.equal(cleared.security.status, 'CLEARED'); assert.equal(cleared.security.scanAtSeconds, null);
  assert.equal(at(manifest, 500).readyAtGate, true);
});

test('Stage 4 missing optional junction scans leave readiness safe and gate observation restores location', () => {
  const manifest = drop(journey(), 'CHECKPOINT');
  assert.equal(at(manifest, 300).lastCheckpoint.id, 'SECURITY_EXIT');
  assert.equal(at(manifest, 499).readyAtGate, false);
  assert.equal(at(manifest, 500).readyAtGate, true);
  assert.equal(simulate(manifest, 'random').metrics.constraintViolationCount, 0);
});

test('Stage 4 missing clearance/check-in/gate never falls back to private completion or arrival', () => {
  for (const type of ['CHECK_IN_CLEARED', 'SECURITY_CLEARED', 'GATE_ARRIVED']) {
    const manifest = drop(journey(), type);
    assert.equal(at(manifest, 1000).readyAtGate, false, type);
    assert.ok(at(manifest, 1000).readinessBlockers.length > 0);
    manifest.config.simulation.maxSimulationSeconds = 550;
    assert.throws(() => simulate(manifest, 'random'), /exceeded 550s/);
  }
  const noScans = drop(journey(), 'CHECK_IN_CLEARED', 'SECURITY_ENTERED', 'SECURITY_CLEARED', 'CHECKPOINT', 'GATE_ARRIVED');
  const p = at(noScans, 1000);
  assert.equal(p.prediction.estimatedGateArrivalSeconds, null);
  assert.equal(p.prediction.basis, 'NO_OBSERVATION');
  const evaluation = evaluateGateETA(noScans, [0]);
  assert.equal(evaluation.summaries[0].unavailablePredictions, 6);
});

test('Stage 4 observed gate location cannot clear security or inflate forecast accuracy', () => {
  const manifest = drop(journey(), 'SECURITY_CLEARED');
  const p = at(manifest, 500);
  assert.equal(p.prediction.basis, 'OBSERVED_AT_GATE');
  assert.equal(p.security.status, 'SCREENING'); assert.equal(p.readyAtGate, false);
  const summary = evaluateGateETA(manifest, [500]).summaries[0];
  assert.equal(summary.observedAtGate, 6); assert.equal(summary.predictedCount, 0);
  assert.equal(summary.meanAbsoluteErrorSeconds, null);
});

test('Stage 4 future arrivals, clearances, walking/stop truth and unseen payloads cannot change a prefix', () => {
  const first = journey();
  const changed = structuredClone(first);
  for (const p of changed.passengers) { p.securityClearedAtSeconds += 900; p.gateArrivalSeconds += 900; }
  for (const e of changed.phase2.observations) if (e.timeSeconds > 0) e.timeSeconds += 900;
  for (const truth of changed.phase2.truth) { truth.actualSecurityProcessingSeconds += 900; truth.actualStopDelaySeconds += 99; truth.actualWalkingSpeedMps = 0.1; }
  validateScenario(changed);
  assert.deepEqual(createReadinessObserver(first).snapshot(0), createReadinessObserver(changed).snapshot(0));
  // Invalid future telemetry must not affect an earlier valid prediction; its
  // envelope will be rejected if it becomes observed. Offline validation may
  // independently audit the whole imported scenario.
  changed.phase2.observations.find(e => e.type === 'GATE_ARRIVED').checkpointId = 'UNKNOWN';
  assert.deepEqual(createReadinessObserver(first).snapshot(0), createReadinessObserver(changed).snapshot(0));
  assert.throws(() => createReadinessObserver(changed).snapshot(1500), /checkpoint/);
});

test('Stage 4 observer and pure predictor never read private truth getters', () => {
  const manifest = journey();
  const forbidden = () => { throw new Error('Private truth accessed'); };
  for (const p of manifest.passengers) for (const field of ['gateArrivalSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'checkInAtSeconds', 'behavior']) {
    Object.defineProperty(p, field, { get: forbidden });
  }
  Object.defineProperty(manifest.phase2, 'truth', { get: forbidden });
  for (const e of manifest.phase2.observations.filter(e => e.timeSeconds > 0)) Object.defineProperty(e, 'hiddenOutcome', { get: forbidden });
  const snapshot = createReadinessObserver(manifest).snapshot(0);
  assert.equal(snapshot.passengers[0].prediction.estimatedGateArrivalSeconds, 496.25);
  const view = structuredClone(snapshot.passengers[0]);
  Object.defineProperty(view, 'gateArrivalSeconds', { get: forbidden });
  assert.doesNotThrow(() => estimateGateETA(view, 0, routes, phase2Settings().eta));
});

test('Stage 4 pure ETA rejects every kind of future observation and inconsistent observed status', () => {
  for (const field of ['checkIn', 'scan', 'clearance', 'checkpoint', 'gate']) {
    const view = structuredClone(at(journey(), 0));
    if (field === 'checkIn') view.checkIn.clearedAtSeconds = 1;
    if (field === 'scan') view.security.scanAtSeconds = 1;
    if (field === 'clearance') view.security.clearedAtSeconds = 1;
    if (field === 'checkpoint') view.lastCheckpoint.observedAtSeconds = 1;
    if (field === 'gate') view.gateObservedAtSeconds = 1;
    assert.throws(() => estimateGateETA(view, 0, routes, phase2Settings().eta), /future/);
  }
  const view = structuredClone(at(journey(), 0)); view.security.status = 'CLEARED';
  assert.throws(() => estimateGateETA(view, 0, routes, phase2Settings().eta), /own observed event/);
  assert.throws(() => estimateGateETA(view, NaN, routes, phase2Settings().eta), /finite/);
});

test('Stage 4 accuracy metrics match hand-calculated errors and empty cohorts report null', () => {
  const report = evaluateGateETA(journey(), [500, 0]);
  const [first, last] = report.summaries;
  assert.equal(first.asOfSeconds, 0); assert.equal(first.predictedCount, 6);
  assert.equal(first.meanAbsoluteErrorSeconds, 3.75); assert.equal(first.meanSignedErrorSeconds, -3.75);
  assert.equal(first.rootMeanSquaredErrorSeconds, 3.75); assert.equal(first.maxAbsoluteErrorSeconds, 3.75);
  assert.equal(first.p90AbsoluteErrorSeconds, 3.75);
  assert.equal(last.predictedCount, 0); assert.equal(last.observedAtGate, 6);
  for (const field of ['meanAbsoluteErrorSeconds', 'meanSignedErrorSeconds', 'rootMeanSquaredErrorSeconds', 'p90AbsoluteErrorSeconds', 'maxAbsoluteErrorSeconds']) assert.equal(last[field], null);
  const varied = journey(2);
  varied.passengers.forEach((p, index) => {
    p.gateArrivalSeconds += index * 10;
    varied.phase2.observations.find(e => e.passengerId === p.id && e.type === 'GATE_ARRIVED').timeSeconds = p.gateArrivalSeconds;
    varied.phase2.truth.find(t => t.passengerId === p.id).actualStopDelaySeconds += index * 10;
  });
  validateScenario(varied);
  const tail = evaluateGateETA(varied, [0]).summaries[0];
  assert.equal(tail.meanAbsoluteErrorSeconds, 58.75);
  assert.equal(tail.meanSignedErrorSeconds, -58.75);
  assert.equal(tail.p90AbsoluteErrorSeconds, 103.75); // rank 11 of 12, distinct from max
  assert.equal(tail.maxAbsoluteErrorSeconds, 113.75);
  for (const times of [[], [0, 0], [NaN], [Infinity], ['0']]) assert.throws(() => evaluateGateETA(journey(), times), /finite seconds/);
});

test('Stage 4 normal, delayed-security and late-arrival forecasts repeat across seeds with explicit cohorts', () => {
  for (const seed of [7, 42, 123]) for (const name of ['normal', 'security-delays', 'late-arrivals']) {
    const manifest = generateScenario(seed, name);
    const before = manifestHash(manifest);
    const first = evaluateGateETA(manifest);
    assert.deepEqual(first, evaluateGateETA(manifest));
    assert.equal(manifestHash(manifest), before);
    for (const row of first.summaries) assert.equal(row.predictedCount + row.observedAtGate + row.unavailablePredictions, 180);
    assert.ok(first.rows.every(row => Number.isFinite(row.errorSeconds)));
  }
});

test('Stage 4 CLI exports reproducible route and ETA audits and rejects invalid input/times', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-stage4-'));
  const cli = (...args) => execFileSync(process.execPath, [resolve('src/cli.js'), ...args], { encoding: 'utf8', stdio: 'pipe' });
  try {
    const input = join(directory, 'scenario.json');
    writeFileSync(input, JSON.stringify(journey()));
    const routesPath = join(directory, 'routes.json');
    assert.match(cli('terminal-audit', '--input', input, '--output', routesPath), /not Toronto Pearson measurements/);
    assert.equal(JSON.parse(readFileSync(routesPath)).routes[0].distanceMeters, 540);
    for (const output of ['first', 'second']) assert.match(cli('eta-evaluate', '--input', input, '--times', '0,500', '--output', join(directory, output)), /MAE=3.75s/);
    for (const file of ['eta-evaluation.json', 'eta-evaluation.csv', 'eta-summary.csv']) assert.equal(readFileSync(join(directory, 'first', file), 'utf8'), readFileSync(join(directory, 'second', file), 'utf8'));
    for (const times of ['NaN', '0,,300', '0,0', 'Infinity']) assert.throws(() => cli('eta-evaluate', '--input', input, '--times', times));
    assert.throws(() => cli('terminal-audit'));
    const smallConfig = join(directory, 'small.json');
    const configuredPath = join(directory, 'configured.json');
    writeFileSync(smallConfig, JSON.stringify({ aircraft: { rows: 1 } }));
    cli('generate', '--scenario', 'security-delays', '--config', smallConfig,
      '--phase2-config', 'config/stage4.example.json', '--output', configuredPath);
    const configured = JSON.parse(readFileSync(configuredPath));
    assert.equal(configured.phase2.settings.eta.walkingSpeedMps, 0.9);
    assert.equal(configured.phase2.settings.eta.estimatedSecuritySeconds, 300);
    const invalid = journey(); invalid.phase2.observations.find(e => e.type === 'SECURITY_CLEARED').checkpointId = 'CHECK_IN';
    writeFileSync(input, JSON.stringify(invalid));
    assert.throws(() => cli('eta-evaluate', '--input', input));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
