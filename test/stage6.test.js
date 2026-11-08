import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateScenario, validateScenario } from '../src/scenarios.js';
import { withBoardingPolicy } from '../src/policy-scenario.js';
import { POLICY_DEFAULTS, createPolicyObserver } from '../src/policy.js';
import { createReadinessObserver } from '../src/readiness.js';
import { orderUnits, STAGE6_STRATEGIES } from '../src/strategies.js';
import { parseSeat, seatDepth, manifestHash } from '../src/model.js';
import { simulate } from '../src/simulate.js';
import { compareAllStrategies } from '../src/compare.js';
import { phase2Settings } from '../src/phase2-config.js';
import { adaptiveV2Settings, expectedGroupCost, recommendPassengerAware } from '../src/adaptive-v2.js';
import { runStage6Benchmark, stage6Scenario, summarizeStage6, stage6ReportMarkdown } from '../src/stage6-benchmark.js';
import { constraintReport } from '../src/constraints.js';

function rawFixture() {
  const m = generateScenario(42, 'normal', { aircraft: { rows: 3 }, generation: {
    assistanceProbability: 0, additionalPreboardingProbability: 0, partyProbability: 0, priorityProbability: 0
  } });
  const times = { CHECK_IN_CLEARED: -700, SECURITY_ENTERED: -530, SECURITY_CLEARED: -350, CHECKPOINT: -200, GATE_ARRIVED: 0 };
  for (const p of m.passengers) Object.assign(p, { travelClass: 'ECONOMY', checkInAtSeconds: -700,
    securityScanAtSeconds: -530, securityClearedAtSeconds: -350, gateArrivalSeconds: 0,
    behavior: { walkSecondsPerRow: 1, stowSecondsPerBag: 10, seatSeconds: 1 },
    actualBaggage: { overheadPieces: 0, personalItems: 0, overheadWeightKg: 0 } });
  for (const e of m.phase2.observations) e.timeSeconds = times[e.type];
  for (const t of m.phase2.truth) Object.assign(t, { actualSecurityProcessingSeconds: 180, actualWalkingSpeedMps: 1.2, actualStopDelaySeconds: 0 });
  return m;
}
const activate = (m, rules = {}) => withBoardingPolicy(m, { status: 'CONFIRMED',
  confirmedAssistancePassengerIds: m.passengers.filter(p => p.assistance.type !== 'NONE').map(p => p.id),
  syntheticStaffConfirmation: { approvalDelaySeconds: 0, gateVerificationDelaySeconds: 0 }, ...rules });
const family = ids => ({ id: 'CONFIRMED-FAMILY', memberIds: ids,
  youngChildUnderFivePassengerIds: [ids[0]], guardianPassengerIds: [ids[1]] });
function view(m, at = 0) {
  const { simulation: s } = m.config;
  const units = orderUnits(m, 'adaptive');
  return { snapshot: structuredClone(createReadinessObserver(m).snapshot(at)), context: {
    nowSeconds: at, stage: Math.min(...units.map(u => u.stage)), strategy: 'adaptive',
    pendingUnits: units.map(u => ({ id: u.id, memberIds: u.members.map(p => p.id), stage: u.stage, zone: u.zone, assisted: u.assisted })),
    cabin: { seatedSeats: [], aisle: [] }, cabinOccupied: false, boardedPassengerIds: [], seatedPassengerIds: [],
    policySnapshot: createPolicyObserver(m.boardingPolicy, m.passengers).snapshot(at),
    assumptions: { tickSeconds: s.tickSeconds, gateHeadwaySeconds: s.gateHeadwaySeconds,
      seatInterferenceSecondsPerBlocker: s.seatInterferenceSecondsPerBlocker,
      mobilityAssistanceSeconds: s.mobilityAssistanceSeconds, extraTimeAssistanceSeconds: s.extraTimeAssistanceSeconds }
  } };
}
const advise = v => recommendPassengerAware(v.snapshot, v.context, phase2Settings().adaptive);
const unitIds = units => units.map(u => u.id);
const smallPolicy = { ...structuredClone(POLICY_DEFAULTS), status: 'CONFIRMED',
  syntheticStaffConfirmation: { approvalDelaySeconds: 0, gateVerificationDelaySeconds: 0 } };

test('Stage 6 WilMA orders solo windows, middles and aisles, with the shared seeded tie lottery', () => {
  const m = activate(rawFixture()); const units = orderUnits(m, 'wilma');
  const depths = units.map(u => seatDepth(parseSeat(u.members[0].seatNumber).letter));
  assert.deepEqual(depths, [...depths].sort());
  assert.deepEqual(new Set(depths), new Set([0, 1, 2]));
  for (const depth of [0, 1, 2]) assert.deepEqual(unitIds(units.filter(u => u.depth === depth)),
    unitIds(orderUnits(m, 'random').filter(u => u.depth === depth)));
  assert.deepEqual(unitIds(units), unitIds(orderUnits(m, 'wilma')));
});

test('Stage 6 mixed WilMA parties use mean depth, remain intact, and ignore luggage/row tie scores', () => {
  const m = rawFixture(); m.passengers[0].travelPartyId = m.passengers[2].travelPartyId = 'WINDOW-AISLE';
  const p = activate(m); const mixed = orderUnits(p, 'wilma').find(u => u.members.length === 2);
  assert.equal(mixed.depth, 1);
  assert.deepEqual(mixed.members.map(p => p.seatNumber), ['1A', '1C']);
  const changed = structuredClone(p); Object.assign(changed.passengers[0].actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  assert.deepEqual(unitIds(orderUnits(p, 'wilma')), unitIds(orderUnits(changed, 'wilma')));
  const r = simulate(p, 'wilma', { trace: true });
  const positions = r.passengerTimings.map((t, i) => t.unitId === mixed.id ? i : -1).filter(i => i >= 0);
  assert.equal(positions[1], positions[0] + 1); assert.equal(r.traceValidation.passed, true);
});

test('Stage 6 preboarding precedes VIP/First/Business/elite; all five retain protected lottery and timings', () => {
  const m = rawFixture(); const ids = m.passengers.map(p => p.id);
  m.passengers[0].mandatoryPreboarding = true;
  m.passengers[1].priorityEligible = true; // confirmed VIP entitlement, no inference from a label
  m.passengers[2].travelClass = 'BUSINESS';
  const p = activate(m, { confirmedFirstClassPassengerIds: [ids[3]], elitePriorityPassengerIds: [ids[4]], families: [family(ids.slice(5, 7))] });
  const prefix = [];
  for (const strategy of STAGE6_STRATEGIES) {
    const r = simulate(p, strategy);
    prefix.push(r.passengerTimings.filter(t => t.stage !== 'GENERAL'));
    assert.equal(r.metrics.constraintViolationCount, 0);
  }
  for (const actual of prefix) assert.deepEqual(actual, prefix[0]);
  assert.ok(prefix[0].slice(0, 3).every(p => p.stage === 'PREBOARD'));
});

test('Stage 6 confirmed assistance, escort and cross-booking family constraints hold in all five', () => {
  const m = rawFixture(); const [a, companion] = m.passengers;
  a.assistance = { type: 'MOBILITY', companionId: companion.id };
  const p = activate(m, { families: [{ ...family([a.id, companion.id]), youngChildUnderFivePassengerIds: [] }] });
  for (const strategy of STAGE6_STRATEGIES) {
    const r = simulate(p, strategy, { trace: true });
    assert.equal(r.traceValidation.passed, true); assert.equal(r.constraintViolations.counts.assistanceConflict, 0);
    assert.equal(r.passengerTimings[0].unitId, r.passengerTimings[1].unitId);
    assert.equal(r.passengerTimings.find(t => t.passengerId === a.id).assistanceSeconds, 40);
  }
});

test('Stage 6 age, claimed VIP and pet/service-animal labels alone add no rights or processing time', () => {
  const base = activate(rawFixture()), changed = structuredClone(base);
  Object.assign(changed.passengers[0], { age: 90, hasPet: true, claimedVip: true });
  changed.boardingPolicy.confirmedAnimalArrangements = [
    { passengerId: changed.passengers[0].id, kind: 'PET', confirmed: true, boardingRequirement: 'NONE' },
    { passengerId: changed.passengers[1].id, kind: 'SERVICE_ANIMAL', confirmed: true, boardingRequirement: 'NONE' }
  ];
  for (const strategy of STAGE6_STRATEGIES) assert.deepEqual(simulate(changed, strategy).metrics, simulate(base, strategy).metrics);
});

test('Stage 6 animal-related extra time requires a separate confirmed operational arrangement', () => {
  const m = rawFixture(); const p = m.passengers[0];
  const arrangement = { passengerId: p.id, kind: 'SERVICE_ANIMAL', confirmed: true, boardingRequirement: 'EXTRA_TIME' };
  assert.throws(() => activate(m, { confirmedAnimalArrangements: [arrangement] }), /separately confirmed assistance/);
  p.assistance.type = 'EXTRA_TIME';
  const good = activate(m, { confirmedAnimalArrangements: [arrangement] });
  assert.equal(simulate(good, 'adaptive').passengerTimings.find(t => t.passengerId === p.id).assistanceSeconds, 20);
  assert.throws(() => activate(m, { confirmedAnimalArrangements: [{ ...arrangement, confirmed: false }] }), /unconfirmed animal/);
  assert.throws(() => activate(m, { confirmedAnimalArrangements: [{ ...arrangement, diagnosis: 'not collected' }] }), /animal arrangement fields/);
});

test('Stage 6 revised scoring exposes expected delay/seat/baggage/congestion costs and never waits for a forecast over a feasible group', () => {
  const p = activate(rawFixture()); const v = view(p);
  const d = advise(v);
  assert.equal(d.action, 'RELEASE'); assert.equal(d.releaseAtSeconds, 0);
  for (const key of ['expectedCompletion', 'inducedBlocking', 'pathCongestion', 'knownSeatInterference', 'seatAccess', 'baggageOverlap', 'readinessUncertainty']) assert.ok(Number.isFinite(d.scoreComponents[key]));
  const delayed = v.snapshot.passengers[0]; delayed.readyAtGate = false; delayed.gateObservedAtSeconds = null;
  delayed.prediction = { estimatedGateArrivalSeconds: 1, observationAgeSeconds: 0 };
  assert.equal(advise(v).action, 'RELEASE');
  assert.equal(d.releaseInterval.notBeforeSeconds, 0); assert.equal(d.releaseInterval.forecastOnly, true);
});

test('Stage 6 occupied entrance receives a one-tick hold and no false immediate release interval', () => {
  const v = view(activate(rawFixture()));
  v.context.cabin.aisle = [{ passengerId: v.snapshot.passengers[0].id, cell: 0, targetRow: 1, rowObservedAtSeconds: null }];
  v.context.cabinOccupied = true;
  const d = advise(v);
  assert.equal(d.action, 'WAIT'); assert.equal(d.reason, 'ENTRANCE_OCCUPIED');
  assert.equal(d.nextReviewSeconds, 1); assert.equal(d.releaseAtSeconds, null);
});

test('Stage 6 expected congestion uses observed elapsed row service, not a future sampled end time', () => {
  const v = view(activate(rawFixture())); const p = v.snapshot.passengers[0];
  p.declaredCabinBaggage.overheadPieces = 1;
  const occupantUnit = v.context.pendingUnits.find(u => u.memberIds.includes(p.id));
  v.context.pendingUnits = v.context.pendingUnits.filter(u => u.id !== occupantUnit.id);
  v.context.boardedPassengerIds = [p.id]; v.context.cabinOccupied = true;
  v.context.cabin.aisle = [{ passengerId: p.id, cell: 1, targetRow: 1, rowObservedAtSeconds: 0 }];
  const unit = v.context.pendingUnits.find(u => u.memberIds.some(id => v.snapshot.passengers.find(p => p.id === id).seatNumber === '3A'));
  const ids = new Map(v.snapshot.passengers.map(p => [p.id, p]));
  const at0 = expectedGroupCost(unit, ids, v.context, phase2Settings().adaptive, adaptiveV2Settings());
  v.context.nowSeconds = 10;
  const at10 = expectedGroupCost(unit, ids, v.context, phase2Settings().adaptive, adaptiveV2Settings());
  assert.equal(at0.components.pathCongestion, 18); assert.equal(at10.components.pathCongestion, 8);
  Object.defineProperty(v.context.cabin.aisle[0], 'serviceEndSeconds', { get() { throw new Error('Hidden end read'); } });
  assert.deepEqual(at10, expectedGroupCost(unit, ids, v.context, phase2Settings().adaptive, adaptiveV2Settings()));
});

test('Stage 6 already seated same-side blockers affect expected seat interference', () => {
  const v = view(activate(rawFixture())); v.context.cabin.seatedSeats = ['1B', '1C'];
  const ids = new Map(v.snapshot.passengers.map(p => [p.id, p]));
  const unit = seat => v.context.pendingUnits.find(u => u.memberIds.some(id => ids.get(id).seatNumber === seat));
  const a = expectedGroupCost(unit('1A'), ids, v.context, phase2Settings().adaptive, adaptiveV2Settings());
  const b = expectedGroupCost(unit('2A'), ids, v.context, phase2Settings().adaptive, adaptiveV2Settings());
  assert.equal(a.components.knownSeatInterference, 16); assert.equal(b.components.knownSeatInterference, 0);
});

test('Stage 6 current recommendation never reads actual arrivals, behavior samples, demographic data or unit truth', () => {
  const v = view(activate(rawFixture())); const expected = advise(v);
  const forbidden = () => { throw new Error('Hidden truth read'); };
  for (const p of v.snapshot.passengers) for (const field of ['gateArrivalSeconds', 'securityClearedAtSeconds', 'behavior', 'actualWalkingSpeedMps', 'age', 'hasPet', 'diagnosis']) Object.defineProperty(p, field, { get: forbidden });
  for (const u of v.context.pendingUnits) Object.defineProperty(u, 'readySeconds', { get: forbidden });
  assert.deepEqual(advise(v), expected); assert.equal(expected.action, 'RELEASE');
});

test('Stage 6 future journey/staff changes leave the entire earlier decision and movement prefix identical', () => {
  const m = rawFixture(); const target = m.passengers[0];
  for (const f of ['checkInAtSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'gateArrivalSeconds']) target[f] += 1000;
  for (const e of m.phase2.observations.filter(e => e.passengerId === target.id)) e.timeSeconds += 1000;
  const first = activate(m), changed = structuredClone(first);
  const cutoff = target.checkInAtSeconds;
  for (const f of ['checkInAtSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'gateArrivalSeconds']) changed.passengers[0][f] += 900;
  changed.passengers[0].behavior.stowSecondsPerBag = 100;
  for (const e of changed.phase2.observations.filter(e => e.passengerId === target.id)) e.timeSeconds += 900;
  for (const e of changed.boardingPolicy.staffEvents.filter(e => e.passengerId === target.id)) e.timeSeconds += 900;
  validateScenario(changed);
  assert.deepEqual(advise(view(first)), advise(view(changed)));
  const a = simulate(first, 'adaptive', { trace: true }), b = simulate(changed, 'adaptive', { trace: true });
  assert.deepEqual(a.recommendations.filter(r => r.timeSeconds < cutoff), b.recommendations.filter(r => r.timeSeconds < cutoff));
  assert.deepEqual(a.events.filter(r => r.timeSeconds < cutoff), b.events.filter(r => r.timeSeconds < cutoff));
});

test('Stage 6 seen security entrance does not expose future clearance or hidden processing duration', () => {
  const m = rawFixture(); const p = m.passengers[0];
  Object.assign(p, { checkInAtSeconds: -300, securityScanAtSeconds: -60, securityClearedAtSeconds: 120, gateArrivalSeconds: 500 });
  const times = { CHECK_IN_CLEARED: -300, SECURITY_ENTERED: -60, SECURITY_CLEARED: 120, CHECKPOINT: 270, GATE_ARRIVED: 500 };
  for (const e of m.phase2.observations.filter(e => e.passengerId === p.id)) e.timeSeconds = times[e.type];
  const a = activate(m), b = structuredClone(a);
  b.passengers[0].securityClearedAtSeconds += 600; b.passengers[0].gateArrivalSeconds += 600;
  b.phase2.truth.find(t => t.passengerId === p.id).actualSecurityProcessingSeconds += 600;
  for (const e of b.phase2.observations.filter(e => e.passengerId === p.id && ['SECURITY_CLEARED', 'CHECKPOINT', 'GATE_ARRIVED'].includes(e.type))) e.timeSeconds += 600;
  for (const e of b.boardingPolicy.staffEvents.filter(e => e.passengerId === p.id)) e.timeSeconds += 600;
  validateScenario(b);
  assert.deepEqual(advise(view(a)), advise(view(b)));
});

test('Stage 6 future staff confirmation outcomes cannot affect the current recommendation', () => {
  const p = activate(rawFixture(), { syntheticStaffConfirmation: { approvalDelaySeconds: 100, gateVerificationDelaySeconds: 100 } });
  const changed = structuredClone(p);
  for (const e of changed.boardingPolicy.staffEvents) { e.timeSeconds += 900; e.confirmed = false; }
  assert.deepEqual(advise(view(p)), advise(view(changed)));
  assert.equal(advise(view(p)).action, 'WAIT');
});

test('Stage 6 staff confirmations trigger immediate reoptimization between review timers', () => {
  const m = rawFixture(); m.passengers[0].priorityEligible = true;
  const p = activate(m, { syntheticStaffConfirmation: { approvalDelaySeconds: 5, gateVerificationDelaySeconds: 7 } });
  const r = simulate(p, 'adaptive');
  assert.equal(r.passengerTimings[0].boardedAtSeconds, 7);
  assert.ok(r.recommendations.some(d => d.timeSeconds === 7 && d.action === 'RELEASE' && d.trigger === 'STAFF_OBSERVATION'));
});

test('Stage 6 observed gate arrival/clearance changes recalculate without waiting for a timer', () => {
  const m = rawFixture(); const p = m.passengers[0]; p.priorityEligible = true;
  for (const f of ['checkInAtSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'gateArrivalSeconds']) p[f] += 350;
  for (const e of m.phase2.observations.filter(e => e.passengerId === p.id)) e.timeSeconds += 350;
  const r = simulate(activate(m), 'adaptive');
  assert.equal(r.passengerTimings[0].boardedAtSeconds, 350);
  assert.ok(r.recommendations.some(d => d.timeSeconds === 350 && d.trigger === 'PASSENGER_OBSERVATION' && d.action === 'RELEASE'));
});

test('Stage 6 stale or missing gate evidence produces a conditional ETA plan, never admission', () => {
  const m = rawFixture(); m.passengers[0].priorityEligible = true;
  m.phase2.observations = m.phase2.observations.filter(e => !(e.passengerId === m.passengers[0].id && e.type === 'GATE_ARRIVED'));
  const p = activate(m), v = view(p, 100);
  const d = advise(v);
  assert.equal(d.action, 'WAIT'); assert.equal(d.staleETA, true);
  assert.ok(d.readinessUncertaintySeconds > 30); assert.equal(d.predictedReadyAtSeconds, null); assert.equal(d.releaseAtSeconds, null);
  p.config.simulation.maxSimulationSeconds = 100;
  assert.throws(() => simulate(p, 'adaptive'), /exceeded/);
});

test('Stage 6 changed overdue ETA plans recalculate at review times without new scans', () => {
  const m = rawFixture(); m.passengers[0].priorityEligible = true;
  m.phase2.observations = m.phase2.observations.filter(e => !(e.passengerId === m.passengers[0].id && e.type === 'GATE_ARRIVED'));
  const p = activate(m), a = advise(view(p, 50)), b = advise(view(p, 55));
  assert.equal(a.action, 'WAIT'); assert.equal(b.action, 'WAIT');
  assert.equal(a.plannedGateETASeconds, 65); assert.equal(b.plannedGateETASeconds, 70);
  assert.equal(a.nextReviewSeconds, 55); assert.equal(b.nextReviewSeconds, 60);
});

test('Stage 6 missing entrance scans allow explicit clearance; missing clearance cannot be inferred', () => {
  for (const type of ['SECURITY_ENTERED', 'SECURITY_CLEARED']) {
    const m = rawFixture(); m.phase2.observations = m.phase2.observations.filter(e => e.type !== type);
    const p = activate(m);
    if (type === 'SECURITY_ENTERED') for (const strategy of STAGE6_STRATEGIES) assert.equal(simulate(p, strategy).metrics.constraintViolationCount, 0);
    else { assert.equal(advise(view(p)).action, 'WAIT'); p.config.simulation.maxSimulationSeconds = 10;
      for (const strategy of STAGE6_STRATEGIES) assert.throws(() => simulate(p, strategy), /exceeded/); }
  }
});

test('Stage 6 independent policy checks stop demotion, split parties and unverified policy', () => {
  const m = rawFixture(); m.passengers[0].travelClass = 'BUSINESS';
  const v = view(activate(m)); v.context.stage = 2;
  assert.equal(advise(v).action, 'WAIT');
  const p = activate(rawFixture(), { families: [family(rawFixture().passengers.slice(0, 2).map(p => p.id))] });
  const split = view(p); split.context.pendingUnits[0].memberIds.pop();
  assert.equal(advise(split).action, 'WAIT');
  const unverified = view(activate(rawFixture(), { status: 'UNVERIFIED' }));
  assert.equal(advise(unverified).reason, 'POLICY_REVIEW_REQUIRED');
});

test('Stage 6 unknown, malformed or future observation/context data safely hold instead of releasing', () => {
  const mutations = [v => { v.context.policySnapshot.latestObservedAtSeconds = 1; },
    v => { v.snapshot.latestObservedAtSeconds = 1; }, v => { v.context.policySnapshot = null; },
    v => { v.context.cabin = null; }, v => { v.context.pendingUnits[0].memberIds = ['UNKNOWN']; }];
  for (const mutate of mutations) { const v = view(activate(rawFixture())); mutate(v); assert.equal(advise(v).action, 'WAIT'); }
});

test('Stage 6 declared carry-on allowance is a feasibility condition, not future stow truth', () => {
  const v = view(activate(rawFixture()));
  for (const p of v.snapshot.passengers) p.declaredCabinBaggage.overheadPieces = p.carryOnAllowance.overheadPieces + 1;
  assert.equal(advise(v).action, 'WAIT');
});

test('Stage 6 retained legacy mode reproduces pre-change seed-42 Adaptive without changing input', async () => {
  const m = await stage6Scenario(42, 'normal'); const hash = manifestHash(m);
  const r = simulate(m, 'adaptive', { adaptiveVersion: 'legacy-v1' });
  assert.equal(r.metrics.totalBoardingSeconds, 1788); assert.equal(manifestHash(m), hash);
  assert.throws(() => simulate(m, 'adaptive', { adaptiveVersion: 'invalid' }), /controller version/);
});

test('Stage 6 all five share one frozen manifest, actual arrivals, service samples and protected rights', async () => {
  const m = await stage6Scenario(42, 'normal'); const hash = manifestHash(m);
  const comparison = compareAllStrategies(m, { trace: true });
  assert.deepEqual(comparison.results.map(r => r.strategy), STAGE6_STRATEGIES);
  const physical = r => r.passengerTimings.map(p => ({ id: p.passengerId, seat: p.seatNumber, arrival: p.gateArrivalSeconds,
    walk: p.freeWalkingSeconds, stow: p.stowSeconds, assistance: p.assistanceSeconds, seating: p.seatingSeconds })).sort((a, b) => a.id.localeCompare(b.id));
  for (const r of comparison.results) {
    assert.equal(r.inputHash, hash); assert.equal(r.traceValidation.passed, true); assert.equal(r.validation.seatedExactlyOnce, 180);
    assert.deepEqual(physical(r), physical(comparison.results[0])); assert.equal(r.constraintViolations.total, 0);
    for (const p of r.passengerTimings) assert.ok(p.boardedAtSeconds >= m.passengers.find(x => x.id === p.passengerId).gateArrivalSeconds);
  }
  assert.ok(comparison.results.find(r => r.strategy === 'adaptive').recommendations.some(d => d.trigger === 'CABIN_PROGRESS'));
  assert.ok(Object.isFrozen(m.passengers[0].behavior)); assert.equal(manifestHash(m), hash);
});

test('Stage 6 controller and WilMA are reproducible across simulation order; constraint counters remain independent', () => {
  const p = activate(rawFixture());
  const first = simulate(p, 'adaptive', { trace: true }); simulate(p, 'wilma');
  assert.deepEqual(first, simulate(p, 'adaptive', { trace: true }));
  const damaged = structuredClone(first); damaged.passengerTimings[0].boardedAtSeconds = -1;
  assert.ok(constraintReport(p, damaged).counts.earlyGateEntry > 0);
});

test('Stage 6 benchmark covers normal/security/late cohorts and deterministic sample statistics without requiring improvements', async () => {
  const options = { seeds: [1, 42], generation: { aircraft: { rows: 2 }, generation: { assistanceProbability: 0 } }, policyConfiguration: smallPolicy };
  const a = await runStage6Benchmark(options), b = await runStage6Benchmark(options);
  assert.deepEqual(a, b); assert.equal(a.experiments.length, 6);
  for (const e of a.experiments) { assert.equal(e.results.length, 5); assert.equal(new Set(e.results.map(r => r.inputHash)).size, 1); }
  for (const s of a.summaries) { assert.equal(s.strategies.length, 5); assert.equal(s.paired.length, 8);
    assert.ok(s.paired.every(p => p.wins + p.ties + p.losses === 2)); }
  assert.match(stage6ReportMarkdown(a), /Every individual strategy result/);
});

test('Stage 6 pair reporting retains explicit Adaptive/WilMA losing cases', () => {
  const metrics = n => ({ totalBoardingSeconds: n, meanGateWaitSeconds: n, aisleBlockingPersonMinutes: n,
    seatInterferencePersonSeconds: 0, seatInterferenceCount: 0, constraintViolationCount: 0 });
  const runs = [0, 1].map(seed => ({ scenario: 'fixture', seed, beforeAdaptive: { metrics: metrics(100) },
    results: STAGE6_STRATEGIES.map(strategy => ({ strategy, metrics: metrics(strategy === 'random' ? 100 : strategy === 'adaptive' ? 90 + seed * 20 : 105) })) }));
  const summary = summarizeStage6(runs)[0];
  const a = summary.paired.find(p => p.strategy === 'adaptive' && p.reference === 'random');
  assert.equal(a.wins, 1); assert.equal(a.losses, 1); assert.equal(a.deltas[1].completionSeconds, 10);
  assert.equal(summary.paired.find(p => p.strategy === 'wilma' && p.reference === 'random').losses, 2);
});

test('Stage 6 rejects invalid configuration and experiment selections; timeouts are not discarded', async () => {
  assert.throws(() => adaptiveV2Settings({ unknown: 1 })); assert.throws(() => adaptiveV2Settings({ expectedSeatSeconds: 0 }));
  for (const seeds of [[], [42, 42], [-1], [1.5], [2 ** 32]]) await assert.rejects(runStage6Benchmark({ seeds }), /seeds/);
  await assert.rejects(runStage6Benchmark({ cases: ['unknown'] }), /scenario/);
  await assert.rejects(runStage6Benchmark({ beforeDirectory: 'not-read', generation: { aircraft: { rows: 2 } } }), /cannot be combined/);
  await assert.rejects(runStage6Benchmark({ beforeDirectory: 'not-read', output: 'not-read' }), /immutable before snapshot/);
  await assert.rejects(runStage6Benchmark({ seeds: [42], cases: ['normal'], generation: { simulation: { maxSimulationSeconds: 1 } } }), /exceeded/);
});

test('Stage 6 CLI exports reproducible five-strategy and paired before/after reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boardingflow-stage6-'));
  const cli = (...args) => execFileSync(process.execPath, [resolve('src/cli.js'), ...args], { encoding: 'utf8', stdio: 'pipe' });
  try {
    const cfg = join(dir, 'small.json'), policy = join(dir, 'policy.json');
    writeFileSync(cfg, JSON.stringify({ aircraft: { rows: 2 }, generation: { assistanceProbability: 0 } }));
    writeFileSync(policy, JSON.stringify(smallPolicy));
    for (const name of ['a', 'b']) assert.match(cli('stage6', '--seeds', '42', '--cases', 'normal', '--config', cfg,
      '--policy-config', policy, '--output', join(dir, name)), /PASS: 5 strategy runs \+ 1 legacy/);
    for (const file of ['comparison.json', 'runs.csv', 'report.md', 'normal/seed-42/manifest.json']) assert.equal(readFileSync(join(dir, 'a', file), 'utf8'), readFileSync(join(dir, 'b', file), 'utf8'));
    const input = join(dir, 'a/normal/seed-42/manifest.json'), output = join(dir, 'single');
    cli('compare-all', '--input', input, '--output', output, '--trace');
    const result = JSON.parse(readFileSync(join(output, 'comparison.json')));
    assert.deepEqual(result.results.map(r => r.strategy), STAGE6_STRATEGIES); assert.equal(result.adaptiveVersion, 'passenger-aware-v2');
    assert.ok(JSON.parse(readFileSync(join(output, 'events-wilma.json'))).events.length > 0);
    for (const args of [['stage6', '--seeds', '42,42'], ['stage6', '--cases', 'typo'], ['compare-all'],
      ['simulate', '--input', input, '--strategy', 'adaptive', '--adaptive-version', 'typo']]) assert.throws(() => cli(...args));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
