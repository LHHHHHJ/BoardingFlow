import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScenario, validateScenario, SCENARIOS } from '../src/scenarios.js';
import { DEFAULT_TERMINAL, accessibleRoute } from '../src/terminal.js';
import { phase2Settings } from '../src/phase2-config.js';
import { createReadinessObserver, publicPassengerCatalog, evaluateGateETA } from '../src/readiness.js';
import { manifestHash } from '../src/model.js';

export function screeningFixture() {
  const manifest = generateScenario(3, 'normal', { aircraft: { rows: 1 }, generation: {
    assistanceProbability: 0, additionalPreboardingProbability: 0, partyProbability: 0
  } });
  const passenger = manifest.passengers[0];
  Object.assign(passenger, { checkInAtSeconds: -300, securityScanAtSeconds: -60, securityClearedAtSeconds: 120, gateArrivalSeconds: 500 });
  const times = { CHECK_IN_CLEARED: -300, SECURITY_ENTERED: -60, SECURITY_CLEARED: 120, CHECKPOINT: 270, GATE_ARRIVED: 500 };
  for (const event of manifest.phase2.observations.filter(e => e.passengerId === passenger.id)) event.timeSeconds = times[event.type];
  manifest.phase2.truth.find(item => item.passengerId === passenger.id).actualSecurityProcessingSeconds = 180;
  validateScenario(manifest);
  return manifest;
}

test('synthetic graph uses the accessible 420m route and excludes the 60m stairs shortcut', () => {
  assert.deepEqual(accessibleRoute(DEFAULT_TERMINAL, 'SECURITY_EXIT', 'GATE_B'), {
    reachable: true, distanceMeters: 420, nodes: ['SECURITY_EXIT', 'JUNCTION', 'GATE_B']
  });
  assert.equal(accessibleRoute(DEFAULT_TERMINAL, 'GATE_B', 'GATE_B').distanceMeters, 0);
  const disconnected = structuredClone(DEFAULT_TERMINAL);
  disconnected.edges = [];
  assert.equal(accessibleRoute(disconnected, 'CHECK_IN', 'GATE_B').reachable, false);
  assert.throws(() => accessibleRoute(DEFAULT_TERMINAL, 'UNKNOWN', 'GATE_B'), /Unknown/);
});

test('security entry is screening, not clearance; future clearance remains hidden', () => {
  const manifest = screeningFixture();
  const observer = createReadinessObserver(manifest);
  const passenger = observer.snapshot(0).passengers[0];
  assert.equal(passenger.checkIn.status, 'CLEARED');
  assert.equal(passenger.checkIn.clearedAtSeconds, -300);
  assert.equal(passenger.security.status, 'SCREENING');
  assert.equal(passenger.security.scanAtSeconds, -60);
  assert.equal(passenger.security.clearedAtSeconds, null);
  assert.equal(passenger.readyAtGate, false);
  assert.equal(passenger.prediction.securityRemainingSeconds, 120);
  assert.equal(passenger.prediction.estimatedGateArrivalSeconds, 496.25); // 120 security + 350 walk + 26.25 expected stops
  assert.equal(observer.snapshot(120).passengers[0].security.status, 'CLEARED');
  assert.equal(observer.snapshot(499).passengers[0].readyAtGate, false);
  assert.equal(observer.snapshot(500).passengers[0].readyAtGate, true);
});

test('check-in and last checkpoint are exposed only after their timestamps', () => {
  const observer = createReadinessObserver(screeningFixture());
  const before = observer.snapshot(-301).passengers[0];
  assert.equal(before.checkIn.status, 'NOT_OBSERVED');
  assert.equal(before.lastCheckpoint, null);
  assert.equal(before.prediction.estimatedGateArrivalSeconds, null);
  assert.equal(observer.snapshot(-300).passengers[0].lastCheckpoint.id, 'CHECK_IN');
  assert.equal(observer.snapshot(120).passengers[0].lastCheckpoint.id, 'SECURITY_EXIT');
  assert.equal(observer.snapshot(270).passengers[0].lastCheckpoint.id, 'JUNCTION');
});

test('ETA updates from observed checkpoints, overdue screening and configurable speed', () => {
  const fixture = screeningFixture();
  const observer = createReadinessObserver(fixture);
  const screening = observer.snapshot(100).passengers[0];
  assert.equal(screening.prediction.securityRemainingSeconds, 30);
  const cleared = observer.snapshot(120).passengers[0];
  assert.equal(cleared.prediction.securityRemainingSeconds, 0);
  const junction = observer.snapshot(270).passengers[0];
  assert.equal(junction.prediction.remainingDistanceMeters, 240);
  const slower = structuredClone(fixture);
  slower.phase2.settings.eta.walkingSpeedMps = 0.6;
  assert.ok(createReadinessObserver(slower).snapshot(270).passengers[0].prediction.estimatedGateArrivalSeconds
    > junction.prediction.estimatedGateArrivalSeconds);
});

test('future actual arrival and stops cannot affect the current snapshot', () => {
  const first = screeningFixture();
  const changed = structuredClone(first);
  const id = first.passengers[0].id;
  changed.passengers[0].gateArrivalSeconds += 900;
  changed.phase2.observations.find(e => e.passengerId === id && e.type === 'GATE_ARRIVED').timeSeconds += 900;
  changed.phase2.truth[0].actualStopDelaySeconds += 900;
  changed.phase2.truth[0].actualWalkingSpeedMps = 0.1;
  validateScenario(changed);
  assert.deepEqual(createReadinessObserver(first).snapshot(0), createReadinessObserver(changed).snapshot(0));
  const catalog = JSON.stringify(publicPassengerCatalog(first));
  for (const forbidden of ['gateArrivalSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'behavior', 'actualStop', 'truth']) {
    assert.ok(!catalog.includes(forbidden), forbidden);
  }
});

test('future security clearance and processing duration cannot leak into an entry-scan ETA', () => {
  const first = screeningFixture();
  const delayed = structuredClone(first);
  const passenger = delayed.passengers[0];
  passenger.securityClearedAtSeconds += 600;
  passenger.gateArrivalSeconds += 600;
  for (const event of delayed.phase2.observations.filter(e => e.passengerId === passenger.id
      && ['SECURITY_CLEARED', 'CHECKPOINT', 'GATE_ARRIVED'].includes(e.type))) event.timeSeconds += 600;
  delayed.phase2.truth.find(item => item.passengerId === passenger.id).actualSecurityProcessingSeconds += 600;
  validateScenario(delayed);
  assert.deepEqual(createReadinessObserver(first).snapshot(0), createReadinessObserver(delayed).snapshot(0));
  assert.equal(createReadinessObserver(delayed).snapshot(120).passengers[0].security.status, 'SCREENING');
});

test('normal, security-delay and late-arrival scenarios are reproducible full flights', () => {
  for (const scenario of SCENARIOS) {
    const manifest = generateScenario(42, scenario);
    assert.equal(validateScenario(manifest).uniqueSeats, 180);
    assert.equal(manifestHash(manifest), manifestHash(generateScenario(42, scenario)));
    assert.ok(manifest.phase2.truth.some(item => item.actualStopDelaySeconds > 0));
  }
  const normal = generateScenario(42, 'normal');
  const security = generateScenario(42, 'security-delays');
  const late = generateScenario(42, 'late-arrivals');
  assert.ok(security.passengers.some((p, index) => p.securityClearedAtSeconds > normal.passengers[index].securityClearedAtSeconds));
  assert.ok(late.passengers.some((p, index) => p.gateArrivalSeconds > normal.passengers[index].gateArrivalSeconds));
  assert.deepEqual(normal.passengers.map(p => p.actualBaggage), security.passengers.map(p => p.actualBaggage));
});

test('ETA evaluation joins truth separately and excludes already observed gate arrivals', () => {
  const manifest = screeningFixture();
  const evaluation = evaluateGateETA(manifest, [0, 500]);
  const row = evaluation.rows.find(p => p.passengerId === manifest.passengers[0].id && p.asOfSeconds === 0);
  assert.equal(row.actualGateArrivalSeconds, 500);
  assert.equal(row.predictedGateArrivalSeconds, 496.25);
  assert.equal(row.errorSeconds, -3.75);
  assert.ok(!evaluation.rows.some(p => p.passengerId === row.passengerId && p.asOfSeconds === 500));
  assert.ok(evaluation.summaries[0].meanAbsoluteErrorSeconds >= 0);
});

test('settings, observation chronology, route reachability and clock validation fail explicitly', () => {
  assert.throws(() => phase2Settings({ eta: { walkingSpeedMps: 0 } }));
  assert.throws(() => phase2Settings({ eta: { stopProbability: 2 } }));
  assert.throws(() => phase2Settings({ adaptive: { typo: 1 } }));
  const manifest = screeningFixture();
  manifest.passengers[0].securityScanAtSeconds = 120;
  assert.throws(() => validateScenario(manifest), /entry must precede/);
  const disconnected = screeningFixture();
  disconnected.phase2.terminal.edges = [];
  assert.throws(() => validateScenario(disconnected), /accessible route/);
  const observer = createReadinessObserver(screeningFixture());
  observer.snapshot(10);
  assert.throws(() => observer.snapshot(9), /monotonic/);
});
