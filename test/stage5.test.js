import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateScenario, validateScenario } from '../src/scenarios.js';
import { generateFlight } from '../src/generate.js';
import { simulate } from '../src/simulate.js';
import { manifestHash, individualStage, validateManifest } from '../src/model.js';
import * as strategyCatalog from '../src/strategies.js';
const { boardingUnits, orderUnits } = strategyCatalog;
// Run the committed baselines and exercise optional local adaptive integration
// when that implementation is present, without requiring it in this commit.
const SUPPORTED_STRATEGIES = strategyCatalog.SUPPORTED_STRATEGIES ?? strategyCatalog.STRATEGIES;
const protectedTestStrategy = SUPPORTED_STRATEGIES.includes('adaptive') ? 'adaptive' : 'random';
import { createReadinessObserver } from '../src/readiness.js';
import { withBoardingPolicy } from '../src/policy-scenario.js';
import { POLICY_ID, createPolicyObserver, reviewBoardingRecommendation } from '../src/policy.js';
import { constraintReport } from '../src/constraints.js';

function fixture() {
  const m = generateScenario(42, 'normal', { aircraft: { rows: 2 }, generation: {
    assistanceProbability: 0, additionalPreboardingProbability: 0, partyProbability: 0, priorityProbability: 0
  } });
  const times = { CHECK_IN_CLEARED: -700, SECURITY_ENTERED: -530, SECURITY_CLEARED: -350, CHECKPOINT: -200, GATE_ARRIVED: 0 };
  for (const p of m.passengers) Object.assign(p, { travelClass: 'ECONOMY', checkInAtSeconds: -700,
    securityScanAtSeconds: -530, securityClearedAtSeconds: -350, gateArrivalSeconds: 0,
    behavior: { walkSecondsPerRow: 1, stowSecondsPerBag: 10, seatSeconds: 1 },
    actualBaggage: { overheadPieces: 0, personalItems: 0, overheadWeightKg: 0 } });
  for (const e of m.phase2.observations) e.timeSeconds = times[e.type];
  for (const t of m.phase2.truth) Object.assign(t, { actualSecurityProcessingSeconds: 180, actualWalkingSpeedMps: 1.2, actualStopDelaySeconds: 0 });
  validateScenario(m);
  return m;
}
const activate = (m, rules = {}, staff = true) => withBoardingPolicy(m, {
  status: 'CONFIRMED', // explicit fixture assumption, never inferred by the app
  confirmedAssistancePassengerIds: m.passengers.filter(p => p.assistance.type !== 'NONE').map(p => p.id),
  ...(staff ? { syntheticStaffConfirmation: { approvalDelaySeconds: 0, gateVerificationDelaySeconds: 0 } } : {}), ...rules
});
const family = (members, child = members[0], guardian = members[1]) => ({ id: 'CONFIRMED-FAMILY', memberIds: members,
  youngChildUnderFivePassengerIds: child ? [child] : [], guardianPassengerIds: guardian ? [guardian] : [] });
function views(m, seconds = 0, strategy = 'random') {
  const units = orderUnits(m, strategy);
  return { snapshot: structuredClone(createReadinessObserver(m).snapshot(seconds)),
    policy: createPolicyObserver(m.boardingPolicy, m.passengers).snapshot(seconds),
    context: { nowSeconds: seconds, stage: Math.min(...units.map(u => u.stage)), strategy, cabinOccupied: false,
      boardedPassengerIds: [], seatedPassengerIds: [],
      pendingUnits: units.map(u => ({ id: u.id, memberIds: u.members.map(p => p.id), stage: u.stage, zone: u.zone, assisted: u.assisted })) } };
}
const review = (v, proposal = null) => reviewBoardingRecommendation(v.snapshot, v.context, v.policy, proposal);

test('Stage 5 profile is explicit; existing synthetic fare labels and seed-42 legacy results remain unchanged', () => {
  const m = generateFlight(42); const hash = manifestHash(m);
  const business = m.passengers.find(p => p.travelClass === 'BUSINESS' && !p.priorityEligible && !p.mandatoryPreboarding);
  assert.equal(individualStage(business), 2);
  assert.deepEqual(m.passengers.map(individualStage), m.passengers.map(p => individualStage(p)));
  assert.deepEqual(['random', 'zone', 'baggage-aware'].map(s => simulate(m, s).metrics.totalBoardingSeconds), [1624, 1796, 1426]);
  assert.equal(manifestHash(m), hash);
  assert.throws(() => activate(m), /observed terminal/);
});

test('Stage 5 confirmed First, Business, elite and explicit priority grants cannot be demoted', () => {
  const m = fixture(); const [first, business, elite, explicit] = m.passengers;
  business.travelClass = 'BUSINESS'; explicit.priorityEligible = true;
  const p = activate(m, { confirmedFirstClassPassengerIds: [first.id], elitePriorityPassengerIds: [elite.id] });
  for (const person of p.passengers.slice(0, 4)) assert.equal(individualStage(person, p.boardingPolicy), 1);
  assert.equal(individualStage(p.passengers[4], p.boardingPolicy), 2);
  for (const strategy of SUPPORTED_STRATEGIES) {
    const r = simulate(p, strategy);
    assert.ok(r.passengerTimings.slice(0, 4).every(t => t.stage === 'PRIORITY'));
    assert.equal(r.metrics.constraintViolationCount, 0);
  }
});

test('Stage 5 protected conflict, false stage metadata and missing protected units are rejected', () => {
  const m = fixture(); m.passengers[0].travelClass = 'BUSINESS'; const p = activate(m);
  let v = views(p); v.context.stage = 2;
  assert.equal(review(v).reason, 'PROTECTED_STAGE_CONFLICT_STAFF_REVIEW');
  v = views(p); v.context.pendingUnits.find(u => u.stage === 1).stage = 2;
  assert.equal(review(v).reason, 'RIGHTS_OR_PARTY_CONFLICT_STAFF_REVIEW');
  v = views(p); v.context.pendingUnits = v.context.pendingUnits.filter(u => u.stage !== 1);
  assert.equal(review(v).simulationAdmissionAllowed, false);
  v = views(p); const general = v.context.pendingUnits.find(u => u.stage === 2);
  assert.equal(review(v, { unitId: general.id, memberIds: general.memberIds }).reason, 'PROPOSAL_POLICY_CONFLICT_STAFF_REVIEW');
});

test('Stage 5 a late Business passenger holds the protected stage across all strategies', () => {
  const m = fixture(); const target = m.passengers[0]; target.travelClass = 'BUSINESS';
  for (const field of ['checkInAtSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'gateArrivalSeconds']) target[field] += 200;
  for (const e of m.phase2.observations.filter(e => e.passengerId === target.id)) e.timeSeconds += 200;
  const p = activate(m);
  for (const strategy of SUPPORTED_STRATEGIES) {
    const r = simulate(p, strategy);
    assert.equal(r.passengerTimings[0].passengerId, target.id);
    assert.ok(r.passengerTimings.every(t => t.boardedAtSeconds >= 200));
  }
});

test('Stage 5 verified young-child family preboards intact, including cross-party guardians', () => {
  const m = fixture(); const [child, guardian, companion] = m.passengers;
  guardian.travelPartyId = companion.travelPartyId = 'REQUIRED-PAIR';
  const p = activate(m, { families: [family([child.id, guardian.id])] });
  const group = boardingUnits(p).find(u => u.members.some(x => x.id === child.id));
  assert.equal(group.stage, 0); assert.equal(group.members.length, 3);
  for (const strategy of SUPPORTED_STRATEGIES) {
    const r = simulate(p, strategy, { trace: true });
    assert.ok(r.passengerTimings.slice(0, 3).every(t => t.unitId === group.id && t.stage === 'PREBOARD'));
    assert.ok(r.passengerTimings.slice(3).every(t => t.boardedAtSeconds >= Math.max(...r.passengerTimings.slice(0, 3).map(t => t.seatedAtSeconds))));
    assert.equal(r.traceValidation.passed, true);
  }
});

test('Stage 5 overlapping confirmed families form one required group without losing original parties', () => {
  const m = fixture(); const ids = m.passengers.slice(0, 4).map(p => p.id);
  m.passengers[2].travelPartyId = m.passengers[3].travelPartyId = 'PAIR';
  const a = family(ids.slice(0, 2)); const b = { ...family(ids.slice(1, 3), null, null), id: 'SECOND' };
  const p = activate(m, { families: [a, b] });
  assert.deepEqual(new Set(boardingUnits(p).find(u => u.members.some(x => x.id === ids[0])).members.map(x => x.id)), new Set(ids));
});

test('Stage 5 required older-family arrangements stay together without an automatic child privilege', () => {
  const m = fixture(); const ids = m.passengers.slice(0, 2).map(p => p.id);
  const p = activate(m, { families: [family(ids, null, null)] });
  const group = boardingUnits(p).find(u => u.members.length === 2);
  assert.equal(group.stage, 2);
  const r = simulate(p, 'zone');
  const positions = r.passengerTimings.map((t, i) => ids.includes(t.passengerId) ? i : -1).filter(i => i >= 0);
  assert.equal(positions[1] - positions[0], 1);
});

test('Stage 5 unavailable family member prevents splitting even when another member is ready', () => {
  const m = fixture(); const [child, guardian] = m.passengers;
  for (const field of ['checkInAtSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'gateArrivalSeconds']) guardian[field] += 100;
  for (const e of m.phase2.observations.filter(e => e.passengerId === guardian.id)) e.timeSeconds += 100;
  const p = activate(m, { families: [family([child.id, guardian.id])] });
  assert.equal(review(views(p)).simulationAdmissionAllowed, false);
  const r = simulate(p, protectedTestStrategy);
  assert.ok(r.passengerTimings.slice(0, 2).every(t => t.boardedAtSeconds >= 100));
  const v = views(p, 100); const unit = v.context.pendingUnits[0];
  assert.equal(review(v, { unitId: unit.id, memberIds: unit.memberIds.slice(0, 1) }).simulationAdmissionAllowed, false);
});

test('Stage 5 confirmed assistance and companion retain escort reservation and additional service', () => {
  const m = fixture(); const [assisted, companion] = m.passengers;
  assisted.assistance = { type: 'MOBILITY', companionId: companion.id };
  assisted.travelPartyId = companion.travelPartyId = 'ASSISTED';
  assert.throws(() => activate(m, { confirmedAssistancePassengerIds: [] }), /explicit confirmation/);
  const p = activate(m);
  for (const strategy of SUPPORTED_STRATEGIES) {
    const r = simulate(p, strategy, { trace: true });
    assert.equal(r.passengerTimings.find(t => t.passengerId === assisted.id).assistanceSeconds, 40);
    assert.equal(r.constraintViolations.counts.assistanceConflict, 0);
    assert.equal(r.traceValidation.passed, true);
  }
  const v = views(p); v.context.cabinOccupied = true;
  assert.equal(review(v).reason, 'ASSISTANCE_REQUIRES_EMPTY_AISLE');
  v.context.pendingUnits.find(u => u.assisted).assisted = false;
  assert.equal(review(v).reason, 'RIGHTS_OR_PARTY_CONFLICT_STAFF_REVIEW');
});

test('Stage 5 an explicitly confirmed family may include an assistance companion on a separate reservation', () => {
  const m = fixture(); const [assisted, companion] = m.passengers;
  assisted.assistance = { type: 'EXTRA_TIME', companionId: companion.id };
  const rules = { families: [family([assisted.id, companion.id], null, null)] };
  const p = activate(m, rules);
  assert.equal(p.passengers[0].travelPartyId, null);
  const r = simulate(p, 'zone', { trace: true });
  assert.equal(r.passengerTimings[0].assistanceSeconds, 20);
  assert.equal(r.passengerTimings[0].unitId, r.passengerTimings[1].unitId);
  assert.equal(r.traceValidation.passed, true);
  assert.throws(() => activate(m), /same required party/);
});

test('Stage 5 senior and pet labels confer no rights or automatic changes to walking/service', () => {
  const m = fixture(); const p = activate(m); const changed = structuredClone(p);
  Object.assign(changed.passengers[0], { age: 90, isSenior: true, hasPet: true });
  assert.equal(individualStage(changed.passengers[0], changed.boardingPolicy), 2);
  assert.deepEqual(orderUnits(p, 'random').map(u => u.id), orderUnits(changed, 'random').map(u => u.id));
  assert.deepEqual(simulate(p, 'random').metrics, simulate(changed, 'random').metrics);
  assert.deepEqual(p.passengers[0].behavior, changed.passengers[0].behavior);
});

test('Stage 5 diagnosis, age and pet getters are not accessed by advisory rights checks', () => {
  const v = views(activate(fixture()));
  const forbidden = () => { throw new Error('Unnecessary sensitive/demographic data read'); };
  for (const p of v.snapshot.passengers) for (const key of ['diagnosis', 'medicalCondition', 'age', 'hasPet', 'gateArrivalSeconds', 'behavior']) Object.defineProperty(p, key, { get: forbidden });
  assert.equal(review(v).simulationAdmissionAllowed, true);
});

test('Stage 5 unknown profiles, invalid rights IDs, family guardians and diagnosis fields fail safely', () => {
  const m = fixture(); const ids = m.passengers.slice(0, 2).map(p => p.id);
  for (const rules of [{ profileId: 'UNKNOWN' }, { elitePriorityPassengerIds: ['missing'] },
    { elitePriorityPassengerIds: [ids[0], ids[0]] }, { diagnosis: 'not collected' },
    { families: [{ ...family(ids), guardianPassengerIds: [] }] },
    { families: [{ ...family(ids), guardianPassengerIds: [ids[0]] }] }]) assert.throws(() => activate(m, rules), /boarding policy/);
  const v = views(activate(m)); v.policy.rules.profileId = 'UNKNOWN';
  assert.equal(review(v).simulationAdmissionAllowed, false);
});

test('Stage 5 unverified policy produces staff-review hold and no simulated boarding', () => {
  const p = activate(fixture(), { status: 'UNVERIFIED' });
  assert.equal(review(views(p)).reason, 'POLICY_UNVERIFIED_STAFF_REVIEW');
  assert.throws(() => simulate(p, 'random'), /staff review required/);
});

test('Stage 5 omitted policy confirmation defaults to unverified even with synthetic staff events', () => {
  const p = withBoardingPolicy(fixture(), { syntheticStaffConfirmation: { approvalDelaySeconds: 0, gateVerificationDelaySeconds: 0 } });
  assert.equal(p.boardingPolicy.status, 'UNVERIFIED');
  assert.equal(review(views(p)).reason, 'POLICY_UNVERIFIED_STAFF_REVIEW');
  assert.throws(() => simulate(p, 'random'), /staff review required/);
});

test('Stage 5 recommendation remains advisory and cannot replace staff approval or gate verification', () => {
  const p = activate(fixture(), {}, false); const v = views(p);
  const decision = review(v);
  assert.equal(decision.advisory, true); assert.equal(decision.simulationOnly, true);
  assert.equal(decision.requiresStaffApproval, true); assert.equal(decision.requiresGateVerification, true);
  assert.equal(decision.reason, 'STAFF_APPROVAL_OR_GATE_VERIFICATION_PENDING');
  p.config.simulation.maxSimulationSeconds = 10;
  assert.throws(() => simulate(p, 'zone'), /exceeded/);
});

test('Stage 5 staff approval and gate verification activate only at their observed timestamps', () => {
  const p = activate(fixture(), { syntheticStaffConfirmation: { approvalDelaySeconds: 20, gateVerificationDelaySeconds: 25 } });
  const observer = createPolicyObserver(p.boardingPolicy, p.passengers);
  assert.equal(observer.confirmed(p.passengers[0].id), false);
  assert.equal(observer.snapshot(20).passengers[0].approval.confirmed, true);
  assert.equal(observer.confirmed(p.passengers[0].id), false);
  observer.advance(25); assert.equal(observer.confirmed(p.passengers[0].id), true);
  assert.throws(() => observer.advance(24), /monotonic/);
  for (const strategy of SUPPORTED_STRATEGIES) assert.ok(simulate(p, strategy).passengerTimings.every(t => t.boardedAtSeconds >= 25));
});

test('Stage 5 withheld confirmation and missing required clearance cannot be bypassed', () => {
  const p = activate(fixture());
  const priority = p.passengers[0]; priority.travelClass = 'BUSINESS';
  p.boardingPolicy.staffEvents.find(e => e.passengerId === priority.id && e.kind === 'STAFF_APPROVAL').confirmed = false;
  assert.equal(review(views(p)).simulationAdmissionAllowed, false);
  p.config.simulation.maxSimulationSeconds = 50;
  assert.throws(() => simulate(p, protectedTestStrategy), /exceeded/);
  const missing = activate(fixture());
  missing.phase2.observations = missing.phase2.observations.filter(e => e.type !== 'SECURITY_CLEARED');
  assert.equal(review(views(missing)).simulationAdmissionAllowed, false);
  missing.config.simulation.maxSimulationSeconds = 10;
  assert.throws(() => simulate(missing, 'random'), /exceeded/);
});

test('Stage 5 forged ready flags, future information and early gate verification do not authorize entry', () => {
  let v = views(activate(fixture()));
  for (const p of v.snapshot.passengers) p.security.clearedAtSeconds = null;
  assert.equal(review(v).simulationAdmissionAllowed, false);
  v = views(activate(fixture())); v.policy.latestObservedAtSeconds = 1;
  assert.equal(review(v).reason, 'INFORMATION_UNRELIABLE_STAFF_REVIEW');
  v = views(activate(fixture()));
  for (const p of v.policy.passengers) p.gateVerification.atSeconds = -1;
  assert.equal(review(v).simulationAdmissionAllowed, false);
});

test('Stage 5 inconsistent observed identity or cabin-state information falls back to staff review', () => {
  for (const mutate of [v => { v.policy.passengers[1].passengerId = v.policy.passengers[0].passengerId; },
    v => { v.context.boardedPassengerIds = ['UNKNOWN']; },
    v => { v.context.seatedPassengerIds = [v.snapshot.passengers[0].id]; },
    v => { v.snapshot.latestObservedAtSeconds = NaN; }]) {
    const v = views(activate(fixture())); mutate(v);
    assert.equal(review(v).reason, 'INFORMATION_UNRELIABLE_STAFF_REVIEW');
  }
});

test('Stage 5 a null policy is invalid rather than silently reverting to legacy rules', () => {
  const m = fixture(); m.boardingPolicy = null;
  assert.throws(() => validateManifest(m), /valid profile/);
  assert.throws(() => simulate(m, 'random'), /valid profile/);
});

test('Stage 5 safe fallback needs no ETA and stays inside the protected stage/zone', () => {
  const p = activate(fixture()); const v = views(p, 0, 'zone');
  for (const passenger of v.snapshot.passengers) Object.defineProperty(passenger, 'prediction', { get() { throw new Error('ETA consumed by safety fallback'); } });
  const d = review(v); assert.equal(d.reason, 'SAFE_READY_UNIT_FALLBACK');
  assert.equal(v.context.pendingUnits.find(u => u.id === d.unitId).zone, Math.min(...v.context.pendingUnits.map(u => u.zone)));
});

test('Stage 5 preboarding must be seated before a priority advisory is permitted', () => {
  const m = fixture(); m.passengers[0].mandatoryPreboarding = true; m.passengers[1].travelClass = 'BUSINESS';
  const v = views(activate(m)); const pre = v.context.pendingUnits.find(u => u.stage === 0);
  v.context.boardedPassengerIds = [...pre.memberIds]; v.context.pendingUnits = v.context.pendingUnits.filter(u => u.id !== pre.id); v.context.stage = 1;
  assert.equal(review(v).reason, 'PREBOARDING_MUST_BE_SEATED');
  v.context.seatedPassengerIds = [...pre.memberIds];
  assert.equal(review(v).simulationAdmissionAllowed, true);
});

test('Stage 5 future staff outcomes, actual arrival and unseen journey changes cannot change earlier advisories', () => {
  const m = fixture();
  const target = m.passengers[0];
  for (const field of ['checkInAtSeconds', 'securityScanAtSeconds', 'securityClearedAtSeconds', 'gateArrivalSeconds']) target[field] += 1000;
  for (const e of m.phase2.observations.filter(e => e.passengerId === target.id)) e.timeSeconds += 1000;
  const first = activate(m, { syntheticStaffConfirmation: { approvalDelaySeconds: 100, gateVerificationDelaySeconds: 100 } });
  const changed = structuredClone(first);
  changed.passengers[0].securityClearedAtSeconds += 900;
  changed.passengers[0].gateArrivalSeconds += 900;
  for (const e of changed.phase2.observations.filter(e => e.passengerId === target.id
      && ['SECURITY_CLEARED', 'CHECKPOINT', 'GATE_ARRIVED'].includes(e.type))) e.timeSeconds += 900;
  changed.phase2.truth.find(t => t.passengerId === target.id).actualSecurityProcessingSeconds += 900;
  validateScenario(changed);
  for (const e of changed.boardingPolicy.staffEvents) { e.timeSeconds += 500; e.confirmed = false; }
  const a = views(first), b = views(changed);
  assert.deepEqual(a.snapshot, b.snapshot);
  assert.deepEqual(a.policy, b.policy); assert.deepEqual(review(a), review(b));
  assert.ok(!JSON.stringify(a.policy).includes('staffEvents'));
  const forbidden = () => { throw new Error('Private truth read'); };
  for (const p of a.snapshot.passengers) Object.defineProperty(p, 'securityClearedAtSeconds', { get: forbidden });
  assert.deepEqual(review(a), review(b));
});

test('Stage 5 post-run evaluator detects missing observed readiness, staff approvals, gate verification and family separation', () => {
  const m = fixture(); const ids = m.passengers.slice(0, 2).map(p => p.id);
  const p = activate(m, { families: [family(ids)] }); const r = simulate(p, 'random');
  const changed = structuredClone(p); changed.boardingPolicy.staffEvents = [];
  changed.phase2.observations = changed.phase2.observations.filter(e => e.type !== 'SECURITY_CLEARED');
  const broken = structuredClone(r); broken.passengerTimings.find(t => t.passengerId === ids[1]).unitId = 'SEPARATED';
  const report = constraintReport(changed, broken);
  assert.ok(report.counts.observedReadinessViolation > 0); assert.ok(report.counts.staffApprovalViolation > 0);
  assert.ok(report.counts.gateVerificationViolation > 0); assert.ok(report.counts.familySeparation > 0);
});

test('Stage 5 profile preparation is reproducible, preserves passenger truth and rejects invalid synthetic confirmations', () => {
  const m = fixture(); const hash = manifestHash(m); const p = activate(m);
  assert.deepEqual(p, activate(m)); assert.deepEqual(p.passengers, m.passengers);
  assert.deepEqual(p.phase2, m.phase2); assert.equal(manifestHash(m), hash);
  assert.throws(() => activate(m, { syntheticStaffConfirmation: { approvalDelaySeconds: -1, gateVerificationDelaySeconds: 0 } }));
  const bad = structuredClone(p); bad.boardingPolicy.staffEvents.push({ ...bad.boardingPolicy.staffEvents[0] });
  assert.throws(() => validateManifest(bad), /duplicate staff event/);
});

test('Stage 5 full seed-42 profile uses one immutable input across all available strategies and traced results repeat', () => {
  const settings = JSON.parse(readFileSync('config/stage5.example.json', 'utf8'));
  const m = withBoardingPolicy(generateScenario(42), settings); const hash = manifestHash(m);
  for (const strategy of SUPPORTED_STRATEGIES) {
    const r = simulate(m, strategy, { trace: true });
    assert.equal(r.inputHash, hash); assert.equal(r.metrics.constraintViolationCount, 0);
    assert.equal(r.validation.seatedExactlyOnce, 180); assert.equal(r.traceValidation.passed, true);
    assert.ok(r.policyAdvisories.every(d => d.advisory && d.requiresStaffApproval && d.requiresGateVerification));
    if (strategy === 'adaptive') assert.ok(r.recommendations.every(d => d.advisory && d.executionAuthorization === 'NONE_ADVISORY_ONLY'));
    assert.deepEqual(r, simulate(m, strategy, { trace: true }));
  }
  assert.equal(manifestHash(m), hash);
});

test('Stage 5 CLI applies the explicit profile and exports a reproducible advisory without changing input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-stage5-'));
  const cli = (...args) => execFileSync(process.execPath, [resolve('src/cli.js'), ...args], { encoding: 'utf8', stdio: 'pipe' });
  try {
    const input = join(directory, 'normal.json'), output = join(directory, 'policy.json'), advisory = join(directory, 'advisory.json');
    writeFileSync(input, JSON.stringify(generateScenario(42))); const before = readFileSync(input, 'utf8');
    assert.match(cli('apply-policy', '--input', input, '--policy-config', 'config/stage5.example.json', '--output', output), /SYNTHETIC/);
    assert.match(cli('policy-preview', '--input', output, '--at', '0', '--output', advisory), /ADVISORY ONLY/);
    const first = readFileSync(advisory, 'utf8');
    cli('policy-preview', '--input', output, '--at', '0', '--output', advisory);
    assert.equal(readFileSync(advisory, 'utf8'), first); assert.equal(readFileSync(input, 'utf8'), before);
    assert.equal(JSON.parse(readFileSync(output)).boardingPolicy.profileId, POLICY_ID);
    const simulated = join(directory, 'simulated');
    cli('simulate', '--input', output, '--strategy', 'random', '--output', simulated);
    assert.equal(JSON.parse(readFileSync(join(simulated, 'comparison.json'))).policyProfileId, POLICY_ID);
    const timings = JSON.parse(readFileSync(join(simulated, 'timings-random.json')));
    assert.equal(timings.metrics.constraintViolationCount, 0);
    assert.ok(timings.policyAdvisories.every(d => d.advisory && d.requiresStaffApproval));
    assert.throws(() => cli('apply-policy', '--input', input));
    assert.throws(() => cli('policy-preview', '--input', input));
    assert.throws(() => cli('policy-preview', '--input', output, '--at', 'NaN'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
