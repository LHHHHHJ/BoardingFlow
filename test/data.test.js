import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFlight } from '../src/generate.js';
import { makeConfig } from '../src/config.js';
import { manifestHash, validateManifest } from '../src/model.js';

test('default flight has exactly 180 passengers, IDs and unique seats', () => {
  const manifest = generateFlight(42);
  assert.equal(manifest.passengers.length, 180);
  assert.equal(new Set(manifest.passengers.map(p => p.id)).size, 180);
  assert.equal(validateManifest(manifest).uniqueSeats, 180);
  assert.equal(manifest.dataKind, 'SYNTHETIC');
  assert.ok(manifest.passengers.some(p => p.actualBaggage.overheadPieces === 0));
  assert.ok(manifest.passengers.some(p => p.actualBaggage.overheadPieces === 1));
});

test('generation is reproducible and changes with seed', () => {
  assert.deepEqual(generateFlight(42), generateFlight(42));
  assert.notEqual(manifestHash(generateFlight(42)), manifestHash(generateFlight(43)));
});

test('synthetic status timestamps and companions are coherent', () => {
  const manifest = generateFlight(42);
  const byId = new Map(manifest.passengers.map(p => [p.id, p]));
  for (const passenger of manifest.passengers) {
    assert.ok(passenger.checkInAtSeconds <= passenger.securityClearedAtSeconds);
    assert.ok(passenger.securityClearedAtSeconds <= passenger.gateArrivalSeconds);
    if (passenger.assistance.companionId) {
      assert.equal(byId.get(passenger.assistance.companionId).travelPartyId, passenger.travelPartyId);
    }
  }
});

test('manifest validation rejects duplicate seats, IDs, missing passengers, and uncleared status', () => {
  for (const mutate of [
    m => { m.passengers[1].seatNumber = m.passengers[0].seatNumber; },
    m => { m.passengers[1].id = m.passengers[0].id; },
    m => { m.passengers.pop(); },
    m => { m.passengers[0].securityStatus = 'PENDING'; },
    m => { m.passengers[0].checkInStatus = 'BLOCKED'; },
    m => { m.passengers[0].gateArrivalSeconds = NaN; },
    m => { m.passengers[0].actualBaggage.overheadPieces = 2; },
    m => { m.passengers[0].assistance = { type: 'MOBILITY', companionId: 'missing' }; }
  ]) {
    const manifest = generateFlight(42);
    mutate(manifest);
    assert.throws(() => validateManifest(manifest));
  }
});

test('configuration rejects typos, invalid probabilities, timings, rows and seeds', () => {
  for (const config of [
    { simulation: { typo: 1 } },
    { generation: { priorityProbability: 2 } },
    { simulation: { tickSeconds: 0 } },
    { simulation: { gateHeadwaySeconds: 0 } },
    { generation: { walkSecondsPerRow: 0 } },
    { generation: { seatSecondsMin: -1 } },
    { generation: { earlyArrivalMinSeconds: 20 } },
    { aircraft: { rows: 0 } }
  ]) assert.throws(() => makeConfig(config));
  assert.throws(() => generateFlight(-1));
});

test('configurable one-row geometry and no baggage generate valid data', () => {
  const manifest = generateFlight(7, { aircraft: { rows: 1 }, generation: { overheadBagProbability: 0 } });
  assert.equal(manifest.passengers.length, 6);
  assert.ok(manifest.passengers.every(p => p.actualBaggage.overheadPieces === 0));
  assert.equal(validateManifest(manifest).capacity, 6);
});
