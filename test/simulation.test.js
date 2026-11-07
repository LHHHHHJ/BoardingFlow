import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFlight } from '../src/generate.js';
import { deepFreeze, manifestHash } from '../src/model.js';
import { simulate } from '../src/simulate.js';
import { STRATEGIES } from '../src/strategies.js';

function smallFlight(seats, { rows = 3, config = {} } = {}) {
  const manifest = generateFlight(1, { aircraft: { rows }, ...config });
  manifest.passengers = seats.map((seatNumber, index) => ({
    ...manifest.passengers[index],
    id: `TEST-${index}`,
    seatNumber,
    boardingZone: 1,
    mandatoryPreboarding: false,
    priorityEligible: false,
    travelPartyId: null,
    assistance: { type: 'NONE', companionId: null },
    gateArrivalSeconds: 0,
    securityClearedAtSeconds: -10,
    checkInAtSeconds: -20,
    actualBaggage: { overheadPieces: 0, personalItems: 0, overheadWeightKg: 0 },
    behavior: { walkSecondsPerRow: 1, seatSeconds: 1, stowSecondsPerBag: 10 }
  }));
  return manifest;
}
const runSmall = (manifest, strategy = 'random', options = {}) => simulate(manifest, strategy, { requireFullFlight: false, ...options });

test('all three strategies seat the same immutable 180 passengers exactly once', () => {
  const manifest = deepFreeze(generateFlight(42));
  const before = manifestHash(manifest);
  for (const strategy of STRATEGIES) {
    const result = simulate(manifest, strategy);
    assert.equal(result.validation.passed, true);
    assert.equal(result.validation.seatedExactlyOnce, 180);
    assert.equal(result.validation.uniqueSeats, 180);
    assert.equal(result.inputHash, before);
    assert.equal(manifestHash(manifest), before);
    assert.equal(new Set(result.passengerTimings.map(p => p.passengerId)).size, 180);
  }
});

test('results and event traces are exactly reproducible and independent of run order', () => {
  const manifest = deepFreeze(generateFlight(42));
  const first = simulate(manifest, 'random', { trace: true });
  simulate(manifest, 'baggage-aware');
  assert.deepEqual(first, simulate(manifest, 'random', { trace: true }));
});

test('single passenger has analytically known walking + stowing + seating time', () => {
  const manifest = smallFlight(['3A']);
  Object.assign(manifest.passengers[0].actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  const result = runSmall(manifest);
  assert.equal(result.metrics.totalBoardingSeconds, 14); // 3 walk + 10 stow + 1 sit
  assert.equal(result.metrics.aisleBlockingPersonSeconds, 0);
  assert.equal(result.metrics.stowPersonSeconds, 10);
});

test('late passenger cannot board early and completion includes gate idle time', () => {
  const manifest = smallFlight(['1A']);
  manifest.passengers[0].gateArrivalSeconds = 100.25;
  const result = runSmall(manifest);
  assert.equal(result.passengerTimings[0].boardedAtSeconds, 101);
  assert.equal(result.metrics.totalBoardingSeconds, 103);
  assert.equal(result.metrics.activeBoardingSeconds, 2);
});

test('empty partial flight completes with zero metrics', () => {
  const result = runSmall(smallFlight([]));
  for (const metric of Object.values(result.metrics)) assert.equal(metric, 0);
});

test('blocking is spatial: a stowing passenger stops a follower in an earlier cell', () => {
  const manifest = smallFlight(['1A', '3F']);
  manifest.passengers[0].priorityEligible = true; // enforce known order
  Object.assign(manifest.passengers[0].actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  const result = runSmall(manifest);
  const follower = result.passengerTimings.find(p => p.passengerId === 'TEST-1');
  assert.ok(follower.aisleBlockingSeconds > 0);
  assert.ok(result.metrics.gateEntranceBlockedSeconds >= 0);
  assert.equal(follower.aisleBlockingSeconds, 9);
});

test('different rows can stow concurrently, completion is not a sum of service times', () => {
  const manifest = smallFlight(['3A', '1F']);
  manifest.passengers[0].priorityEligible = true;
  for (const passenger of manifest.passengers) Object.assign(passenger.actualBaggage, { overheadPieces: 1, overheadWeightKg: 5 });
  const result = runSmall(manifest);
  assert.equal(result.metrics.stowPersonSeconds, 20);
  assert.equal(result.metrics.totalBoardingSeconds, 14);
  assert.ok(result.metrics.maxConcurrentInAisle >= 2);
});

test('seat interference counts only already seated passengers nearer the same-side aisle', () => {
  const manifest = smallFlight(['1C', '1B', '1A', '1F']);
  // Force known arrival order using isolated late times, with ample service gaps.
  manifest.passengers.forEach((passenger, index) => { passenger.gateArrivalSeconds = index * 100; });
  const result = runSmall(manifest);
  assert.deepEqual(result.passengerTimings.map(p => p.seatInterferenceCount), [0, 1, 2, 0]);
  assert.equal(result.metrics.seatInterferencePersonSeconds, 24);
});

test('late priority is waited for, preboarding seats first, and companions stay together', () => {
  const manifest = smallFlight(['2A', '2B', '3A', '1A']);
  const [assisted, companion, priority] = manifest.passengers;
  assisted.assistance = { type: 'MOBILITY', companionId: companion.id };
  assisted.travelPartyId = companion.travelPartyId = 'ASSISTED';
  companion.gateArrivalSeconds = 20;
  priority.priorityEligible = true;
  priority.gateArrivalSeconds = 200;
  for (const strategy of STRATEGIES) {
    const result = runSmall(manifest, strategy);
    assert.deepEqual(result.passengerTimings.map(p => p.passengerId), ['TEST-0', 'TEST-1', 'TEST-2', 'TEST-3']);
    assert.ok(result.passengerTimings[0].boardedAtSeconds >= 20);
    assert.ok(result.passengerTimings[2].boardedAtSeconds >= 200);
    assert.ok(result.passengerTimings[2].boardedAtSeconds >= Math.max(...result.passengerTimings.slice(0, 2).map(p => p.seatedAtSeconds)));
  }
});

test('zone strategy uses strict rear/mid/front general calls even with late arrivals', () => {
  const manifest = smallFlight(['1A', '2A', '3A']);
  manifest.passengers.forEach((p, index) => { p.boardingZone = 3 - index; });
  manifest.passengers[2].gateArrivalSeconds = 100;
  const result = runSmall(manifest, 'zone');
  assert.deepEqual(result.passengerTimings.map(p => p.passengerId), ['TEST-2', 'TEST-1', 'TEST-0']);
  assert.equal(result.passengerTimings[0].boardedAtSeconds, 100);
});

test('event replay proves aisle cell exclusion and one-cell movement', () => {
  const manifest = generateFlight(42);
  for (const strategy of STRATEGIES) {
    const result = simulate(manifest, strategy, { trace: true });
    const cells = new Map();
    const passengerCells = new Map();
    const seated = new Set();
    for (const event of result.events) {
      if (event.type === 'boarded' || event.type === 'moved') {
        assert.ok(!cells.has(event.cell), `occupied cell ${event.cell} at ${event.timeSeconds}`);
        if (event.type === 'moved') {
          assert.equal(passengerCells.get(event.passengerId), event.fromCell);
          assert.equal(event.cell, event.fromCell + 1);
          cells.delete(event.fromCell);
        }
        cells.set(event.cell, event.passengerId);
        passengerCells.set(event.passengerId, event.cell);
      } else if (event.type === 'seated') {
        assert.equal(cells.get(event.cell), event.passengerId);
        assert.ok(!seated.has(event.passengerId));
        seated.add(event.passengerId);
        cells.delete(event.cell);
        passengerCells.delete(event.passengerId);
      }
    }
    assert.equal(cells.size, 0);
    assert.equal(seated.size, 180);
  }
});

test('preboard and priority admission orders are identical in strategy comparisons', () => {
  const manifest = generateFlight(42);
  const prefixes = STRATEGIES.map(strategy => simulate(manifest, strategy).passengerTimings.filter(p => p.stage !== 'GENERAL'));
  assert.deepEqual(prefixes[0], prefixes[1]);
  assert.deepEqual(prefixes[0], prefixes[2]);
});

test('no-bag and all-bag flights, slow walking and fractional ticks remain valid', () => {
  for (const overheadBagProbability of [0, 1]) {
    const manifest = generateFlight(9, {
      aircraft: { rows: 5 },
      generation: { overheadBagProbability, walkSecondsPerRow: 1.5 },
      simulation: { tickSeconds: 0.5 }
    });
    for (const strategy of STRATEGIES) assert.ok(simulate(manifest, strategy).validation.passed);
  }
});

test('all-priority and all-assisted flights preserve shared constraints', () => {
  for (const settings of [{ priorityProbability: 1 }, { assistanceProbability: 1 }]) {
    const manifest = generateFlight(15, { aircraft: { rows: 2 }, generation: settings });
    for (const strategy of STRATEGIES) assert.ok(simulate(manifest, strategy).validation.passed);
  }
});

test('unknown strategies and simulation timeout fail explicitly', () => {
  const manifest = smallFlight(['1A']);
  assert.throws(() => runSmall(manifest, 'typo'), /Unknown strategy/);
  manifest.config.simulation.maxSimulationSeconds = 10;
  manifest.passengers[0].gateArrivalSeconds = 100;
  assert.throws(() => runSmall(manifest), /exceeded 10s/);
});
