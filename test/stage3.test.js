import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateFlight } from '../src/generate.js';
import { manifestHash } from '../src/model.js';
import { boardingUnits, orderUnits, readyUnit, STRATEGIES } from '../src/strategies.js';
import { compareBaselines, compareStrategies } from '../src/compare.js';
import { simulate } from '../src/simulate.js';
import { BASELINE_SEEDS, BASELINE_CASES, runBaselineBenchmark, sampleSummary, summarizeExperiments,
  scenarioFingerprints, baselineReportMarkdown } from '../src/baseline-benchmark.js';

function fixture(seats) {
  const manifest = generateFlight(42);
  manifest.passengers = seats.map((seatNumber, index) => ({ ...manifest.passengers[index],
    id: `P${index}`, seatNumber, boardingZone: 1, priorityEligible: false, mandatoryPreboarding: false,
    travelPartyId: null, assistance: { type: 'NONE', companionId: null },
    checkInAtSeconds: -200, securityClearedAtSeconds: -100, gateArrivalSeconds: 0,
    actualBaggage: { overheadPieces: 0, personalItems: 0, overheadWeightKg: 0 },
    behavior: { walkSecondsPerRow: 1, stowSecondsPerBag: 10, seatSeconds: 1 }
  }));
  return manifest;
}
const ids = units => units.map(unit => unit.members.map(p => p.id).join('+'));
const small = (manifest, strategy) => simulate(manifest, strategy, { requireFullFlight: false, trace: true });

test('Stage 3 random lottery is reproducible and changes with seed on fixed passenger records', () => {
  const manifest = fixture(['1A', '2A', '3A', '4A', '5A', '6A', '7A', '8A']);
  const profile = scenarioFingerprints(manifest).passengerProfileHash;
  const orders = [];
  for (const seed of BASELINE_SEEDS) {
    manifest.seed = seed;
    const first = ids(orderUnits(manifest, 'random'));
    assert.deepEqual(first, ids(orderUnits(manifest, 'random')));
    assert.deepEqual([...first].sort(), manifest.passengers.map(p => p.id).sort());
    assert.equal(scenarioFingerprints(manifest).passengerProfileHash, profile);
    orders.push(first.join(','));
  }
  assert.ok(new Set(orders).size >= 8);
});

test('Stage 3 lottery applies within protected stages identically across all baselines', () => {
  const manifest = generateFlight(42);
  const prefixes = STRATEGIES.map(strategy => ids(orderUnits(manifest, strategy).filter(unit => unit.stage < 2)));
  assert.ok(prefixes[0].length > 1);
  assert.deepEqual(prefixes[0], prefixes[1]);
  assert.deepEqual(prefixes[0], prefixes[2]);
  for (const strategy of STRATEGIES) {
    const stages = orderUnits(manifest, strategy).map(unit => unit.stage);
    assert.deepEqual(stages, [...stages].sort((a, b) => a - b));
  }
});

test('Stage 3 ready selection skips unavailable units only within the eligible stage/zone', () => {
  const pending = [
    { id: 'late-priority', stage: 1, zone: 3, readySeconds: 100 },
    { id: 'ready-priority', stage: 1, zone: 3, readySeconds: 0 },
    { id: 'late-zone1', stage: 2, zone: 1, readySeconds: 100 },
    { id: 'ready-zone2', stage: 2, zone: 2, readySeconds: 0 }
  ];
  for (const strategy of STRATEGIES) {
    assert.equal(readyUnit(pending, 1, 0, strategy).id, 'ready-priority');
    assert.equal(readyUnit(pending, 0, 0, strategy), undefined);
  }
  assert.equal(readyUnit(pending, 2, 0, 'zone'), undefined);
  assert.equal(readyUnit(pending, 2, 0, 'random').id, 'ready-zone2');
  assert.equal(readyUnit(pending, 2, 100, 'zone').id, 'late-zone1');
});

test('Stage 3 zone mapping and general ordering are rear 1, middle 2, front 3', () => {
  const manifest = generateFlight(42);
  for (const p of manifest.passengers) {
    const row = Number(p.seatNumber.slice(0, -1));
    assert.equal(p.boardingZone, row >= 21 ? 1 : row >= 11 ? 2 : 3);
  }
  const general = orderUnits(manifest, 'zone').filter(unit => unit.stage === 2);
  assert.deepEqual(general.map(unit => unit.zone), general.map(unit => unit.zone).sort());
  for (const zone of [1, 2, 3]) {
    assert.deepEqual(ids(general.filter(unit => unit.zone === zone)),
      ids(orderUnits(manifest, 'random').filter(unit => unit.stage === 2 && unit.zone === zone)));
  }
});

test('Stage 3 cross-zone parties receive earliest zone and strongest entitlement intact', () => {
  const manifest = fixture(['1C', '30A', '2A']);
  const [a, b] = manifest.passengers;
  a.travelPartyId = b.travelPartyId = 'MIXED';
  a.boardingZone = 3; b.boardingZone = 1; a.priorityEligible = true;
  const unit = boardingUnits(manifest).find(u => u.members.length === 2);
  assert.equal(unit.zone, 1);
  assert.equal(unit.stage, 1);
  assert.deepEqual(ids([unit]), ['P1+P0']);
  for (const strategy of STRATEGIES) {
    const result = small(manifest, strategy);
    assert.deepEqual(result.passengerTimings.slice(0, 2).map(p => p.passengerId), ['P1', 'P0']);
    assert.equal(result.metrics.constraintViolationCount, 0);
  }
});

test('Stage 3 late priority and assisted companions block later stages without boarding early', () => {
  const manifest = fixture(['3A', '3B', '2A', '1A']);
  const [assisted, companion, priority] = manifest.passengers;
  assisted.assistance = { type: 'MOBILITY', companionId: companion.id };
  assisted.travelPartyId = companion.travelPartyId = 'ASSIST';
  companion.gateArrivalSeconds = 25;
  priority.priorityEligible = true; priority.gateArrivalSeconds = 150;
  for (const strategy of STRATEGIES) {
    const result = small(manifest, strategy);
    const t = result.passengerTimings;
    assert.deepEqual(t.map(p => p.passengerId), ['P0', 'P1', 'P2', 'P3']);
    assert.ok(t[0].boardedAtSeconds >= 25);
    assert.ok(t[2].boardedAtSeconds >= Math.max(150, t[0].seatedAtSeconds, t[1].seatedAtSeconds));
    assert.ok(t[3].boardedAtSeconds > t[2].boardedAtSeconds);
    assert.equal(result.traceValidation.passed, true);
    assert.equal(result.constraintViolations.total, 0);
  }
});

test('Stage 3 baggage ranks window depth before baggage, then longer stow work before shorter', () => {
  const manifest = fixture(['1A', '2F', '3A', '4B', '5C']);
  const [, longer, shorter, middle, aisle] = manifest.passengers;
  for (const p of [longer, shorter, middle, aisle]) Object.assign(p.actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  longer.behavior.stowSecondsPerBag = 20;
  shorter.behavior.stowSecondsPerBag = 10;
  middle.behavior.stowSecondsPerBag = aisle.behavior.stowSecondsPerBag = 100;
  assert.deepEqual(ids(orderUnits(manifest, 'baggage-aware')), ['P1', 'P2', 'P0', 'P3', 'P4']);
  // It uses work, not just the bag count.
  longer.behavior.stowSecondsPerBag = 5;
  assert.deepEqual(ids(orderUnits(manifest, 'baggage-aware')).slice(0, 2), ['P2', 'P1']);
});

test('Stage 3 baggage row parity/rear ordering breaks equal scores only', () => {
  const manifest = fixture(['1A', '2A', '3A', '4A']);
  assert.deepEqual(ids(orderUnits(manifest, 'baggage-aware')), ['P3', 'P1', 'P2', 'P0']);
  Object.assign(manifest.passengers[0].actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  assert.equal(ids(orderUnits(manifest, 'baggage-aware'))[0], 'P0');
});

test('Stage 3 baggage party scores are means; every member stays in its party', () => {
  const manifest = fixture(['1A', '1C', '2B']);
  const [a, b, solo] = manifest.passengers;
  a.travelPartyId = b.travelPartyId = 'PARTY';
  Object.assign(a.actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  a.behavior.stowSecondsPerBag = 20;
  Object.assign(solo.actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  solo.behavior.stowSecondsPerBag = 11;
  const unit = boardingUnits(manifest).find(u => u.members.length === 2);
  assert.equal(unit.depth, 1); assert.equal(unit.baggageSeconds, 10);
  assert.deepEqual(ids(orderUnits(manifest, 'baggage-aware')), ['P2', 'P0+P1']);
});

test('Stage 3 baseline rankings do not optimize against future actual arrivals', () => {
  const first = generateFlight(42);
  const changed = structuredClone(first);
  changed.passengers.forEach((p, index) => {
    p.gateArrivalSeconds = 1000 + index;
    p.securityClearedAtSeconds = 900;
    p.checkInAtSeconds = 800;
  });
  for (const strategy of STRATEGIES) assert.deepEqual(ids(orderUnits(first, strategy)), ids(orderUnits(changed, strategy)));
  // Actual arrival is still used by execution to determine presence, not as a
  // score for ranking passengers who have yet to reach the gate.
  assert.equal(readyUnit(orderUnits(changed, 'random'), 0, 0, 'random'), undefined);
});

test('Stage 3 full-flight comparisons reuse arrivals, sampled service, geometry and protected prefix exactly', () => {
  const manifest = generateFlight(42);
  const before = manifestHash(manifest);
  const comparison = compareBaselines(manifest, { trace: true });
  const inputs = new Map(manifest.passengers.map(p => [p.id, p]));
  const physical = result => result.passengerTimings.map(t => ({ id: t.passengerId,
    seat: t.seatNumber, arrival: t.gateArrivalSeconds, walk: t.freeWalkingSeconds,
    stow: t.stowSeconds, assistance: t.assistanceSeconds, seating: t.seatingSeconds })).sort((a, b) => a.id.localeCompare(b.id));
  const reference = physical(comparison.results[0]);
  for (const result of comparison.results) {
    assert.equal(result.inputHash, before);
    assert.deepEqual(physical(result), reference);
    assert.equal(result.traceValidation.passed, true);
    for (const t of result.passengerTimings) assert.ok(t.boardedAtSeconds >= inputs.get(t.passengerId).gateArrivalSeconds);
    assert.deepEqual(result, simulate(manifest, result.strategy, { trace: true }));
  }
  assert.ok(Object.isFrozen(manifest.passengers[0].behavior));
  assert.equal(manifestHash(manifest), before);
});

test('Stage 3 multi-seed cases preserve profiles and assumptions while varying actual arrivals', () => {
  assert.ok(BASELINE_SEEDS.includes(42));
  const { report } = runBaselineBenchmark({ seeds: [0, 1, 42] });
  assert.equal(report.experiments.length, 9);
  assert.deepEqual(report.cases, Object.keys(BASELINE_CASES));
  assert.equal(new Set(report.experiments.map(e => e.simulatorAssumptionsHash)).size, 1);
  for (const seed of [0, 1, 42]) {
    const runs = report.experiments.filter(e => e.seed === seed);
    assert.equal(new Set(runs.map(e => e.passengerProfileHash)).size, 1);
    assert.equal(new Set(runs.map(e => e.actualArrivalHash)).size, 3);
    for (const run of runs) {
      assert.equal(run.passengerCount, 180);
      assert.equal(new Set(run.results.map(r => r.inputHash)).size, 1);
      assert.equal(run.results[0].inputHash, run.inputHash);
      assert.ok(run.results.every(r => r.metrics.constraintViolationCount === 0 && r.validation.seatedExactlyOnce === 180));
    }
  }
});

test('Stage 3 benchmark repeats exactly; custom config applies equally to every strategy', () => {
  const options = { seeds: [42, 1], cases: ['normal', 'late-arrivals'],
    config: { aircraft: { rows: 2 }, generation: { overheadBagProbability: 0 }, simulation: { gateHeadwaySeconds: 3 } } };
  const first = runBaselineBenchmark(options);
  assert.deepEqual(first, runBaselineBenchmark(options));
  for (const run of first.artifacts) {
    assert.equal(run.manifest.config.simulation.gateHeadwaySeconds, 3);
    assert.ok(run.results.every(r => r.metrics.stowPersonSeconds === 0));
  }
});

test('Stage 3 sample statistics use n-1 and singleton SD is undefined', () => {
  assert.deepEqual(sampleSummary([1, 2, 3]), { count: 3, mean: 2, sampleSD: 1, min: 1, max: 3 });
  assert.equal(sampleSummary([7]).sampleSD, null);
  assert.throws(() => sampleSummary([]));
  assert.throws(() => sampleSummary([NaN]));
});

test('Stage 3 paired report counts wins, ties and losses without hiding underperformance', () => {
  const runs = [0, 1, 2].map(seed => ({ scenario: 'fixture', seed,
    results: STRATEGIES.map(strategy => ({ strategy, metrics: {
      totalBoardingSeconds: strategy === 'random' ? 100 : strategy === 'zone' ? 90 + seed * 10 : 110 - seed * 10,
      meanGateWaitSeconds: 2, aisleBlockingPersonMinutes: 3, constraintViolationCount: 0
    } })) }));
  const summary = summarizeExperiments(runs)[0];
  for (const row of summary.paired) {
    assert.equal(row.wins, 1); assert.equal(row.ties, 1); assert.equal(row.losses, 1);
    assert.equal(row.completionDeltaSeconds.mean, 0);
  }
  const report = baselineReportMarkdown({ seeds: [0, 1, 2], notes: [], experiments: runs, summaries: [summary] });
  assert.match(report, /baggage-aware \| 1\/1\/1 \| 0.00 \| 0 \(\+10\)/);
});

test('Stage 3 selection rejects duplicate/invalid seeds and unknown cases; timeout is not dropped', () => {
  for (const seeds of [[], [42, 42], [-1], [1.5], [2 ** 32], ['42']]) assert.throws(() => runBaselineBenchmark({ seeds }), /seeds/);
  for (const cases of [[], ['typo'], ['normal', 'normal']]) assert.throws(() => runBaselineBenchmark({ cases }), /cases/);
  assert.throws(() => runBaselineBenchmark({ seeds: [42], cases: ['normal'], config: { simulation: { maxSimulationSeconds: 1 } } }), /exceeded/);
});

test('Stage 3 CLI exports reproducible reports and manifests, respects config, rejects malformed options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boardingflow-stage3-'));
  const cli = resolve('src/cli.js');
  try {
    const config = join(directory, 'config.json');
    await writeFile(config, JSON.stringify({ aircraft: { rows: 2 }, generation: { overheadBagProbability: 0 } }));
    for (const folder of ['first', 'second']) {
      const output = execFileSync(process.execPath, [cli, 'baselines', '--seeds', '1,42', '--config', config,
        '--output', join(directory, folder)], { encoding: 'utf8' });
      assert.match(output, /PASS: 18 runs; zero constraint violations/);
    }
    for (const file of ['benchmark.json', 'runs.csv', 'report.md', 'normal/seed-42/manifest.json', 'normal/seed-42/comparison.json']) {
      assert.equal(await readFile(join(directory, 'first', file), 'utf8'), await readFile(join(directory, 'second', file), 'utf8'));
    }
    const report = JSON.parse(await readFile(join(directory, 'first/benchmark.json'), 'utf8'));
    assert.ok(report.experiments.every(e => e.results.every(r => r.metrics.stowPersonSeconds === 0)));
    for (const flags of [['--seeds', ''], ['--seeds', '42,'], ['--seeds', '42,42'], ['--cases', 'typo'], ['--trace']]) {
      assert.throws(() => execFileSync(process.execPath, [cli, 'baselines', ...flags], { stdio: 'pipe' }));
    }
  } finally {
    // Only the fresh directory created above, never a computed workspace path.
    await rm(directory, { recursive: true, force: true });
  }
});
