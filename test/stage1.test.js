import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFlight } from '../src/generate.js';
import { makeConfig, TRAVEL_CLASSES } from '../src/config.js';
import { validateManifest, manifestHash, individualStage } from '../src/model.js';
import { auditCarryOn } from '../src/baggage.js';
import { auditPassengerDataset } from '../src/dataset-audit.js';
import { passengerRows } from '../src/io.js';
import { compareStrategies } from '../src/compare.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => execFileSync(process.execPath, ['src/cli.js', ...args], { cwd: project, encoding: 'utf8' });
function asLegacy(manifest) {
  const legacy = structuredClone(manifest);
  legacy.schemaVersion = 1;
  for (const passenger of legacy.passengers) delete passenger.travelClass;
  for (const key of ['partySizeMin', 'partySizeMax', 'travelClassProbabilities']) delete legacy.config.generation[key];
  return legacy;
}

test('Stage 1 defaults provide every requested passenger field and the exact 180-seat grid', () => {
  const manifest = generateFlight(42);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.dataKind, 'SYNTHETIC');
  const expectedSeats = Array.from({ length: 30 }, (_, index) => [...'ABCDEF'].map(letter => `${index + 1}${letter}`)).flat().sort();
  assert.deepEqual(manifest.passengers.map(p => p.seatNumber).sort(), expectedSeats);
  for (const passenger of manifest.passengers) {
    for (const key of ['id', 'flightId', 'seatNumber', 'boardingZone', 'priorityEligible', 'mandatoryPreboarding', 'travelClass',
      'carryOnAllowance', 'actualBaggage', 'travelPartyId', 'assistance', 'gateArrivalSeconds',
      'checkInStatus', 'checkInAtSeconds', 'securityStatus', 'securityClearedAtSeconds', 'behavior']) assert.ok(Object.hasOwn(passenger, key), key);
    assert.ok(TRAVEL_CLASSES.includes(passenger.travelClass));
  }
  const audit = auditPassengerDataset(manifest);
  assert.equal(audit.stage1Complete, true);
  assert.equal(audit.validation.uniqueSeats, 180);
  assert.equal(audit.carryOn.compliantPassengers, 180);
  assert.equal(audit.carryOn.noncompliantPassengers, 0);
});

test('schema 2 rejects missing required fields and unknown class rather than inferring them', () => {
  for (const key of ['id', 'flightId', 'seatNumber', 'boardingZone', 'priorityEligible', 'mandatoryPreboarding', 'travelClass',
    'carryOnAllowance', 'actualBaggage', 'travelPartyId', 'assistance', 'gateArrivalSeconds',
    'checkInStatus', 'checkInAtSeconds', 'securityStatus', 'securityClearedAtSeconds', 'behavior']) {
    const manifest = generateFlight(42);
    delete manifest.passengers[0][key];
    assert.throws(() => validateManifest(manifest), undefined, key);
  }
  for (const travelClass of [null, '', 'FIRST', 1]) {
    const manifest = generateFlight(42);
    manifest.passengers[0].travelClass = travelClass;
    assert.throws(() => validateManifest(manifest), /travelClass/);
  }
});

test('changing the class mix changes only class labels, leaving rights, baggage, status and arrivals identical', () => {
  const classMix = name => Object.fromEntries(TRAVEL_CLASSES.map(key => [key, key === name ? 1 : 0]));
  const economy = generateFlight(42, { generation: { travelClassProbabilities: classMix('ECONOMY') } });
  const business = generateFlight(42, { generation: { travelClassProbabilities: classMix('BUSINESS') } });
  assert.ok(economy.passengers.every(p => p.travelClass === 'ECONOMY'));
  assert.ok(business.passengers.every(p => p.travelClass === 'BUSINESS'));
  const stripClass = passengers => passengers.map(({ travelClass, ...rest }) => rest);
  assert.deepEqual(stripClass(economy.passengers), stripClass(business.passengers));
  assert.deepEqual(economy.passengers.map(individualStage), business.passengers.map(individualStage));
  assert.ok(business.passengers.some(p => !p.priorityEligible && p.assistance.type === 'NONE'));
});

test('configurable party sizes cover pairs, triples, larger parties and the final capacity remainder', () => {
  for (const size of [2, 3, 4, 6, 7]) {
    const manifest = generateFlight(8, { generation: { partyProbability: 1, partySizeMin: size, partySizeMax: size } });
    const groups = new Map();
    for (const passenger of manifest.passengers) groups.set(passenger.travelPartyId, (groups.get(passenger.travelPartyId) ?? 0) + 1);
    assert.equal(validateManifest(manifest).passengerCount, 180);
    const sizes = [...groups.values()];
    assert.equal(sizes.filter(actual => actual === size).length, Math.floor(180 / size));
    if (180 % size) assert.equal(sizes.at(-1), 180 % size);
    assert.ok(sizes.every(actual => actual <= size));
  }
  const solo = generateFlight(8, { generation: { partyProbability: 0, partySizeMin: 2, partySizeMax: 6 } });
  assert.ok(solo.passengers.every(p => p.travelPartyId === null && p.assistance.companionId === null));
});

test('configured class, priority, assistance, carry-on and party mix is reproducible without fixed quotas', () => {
  const overrides = { generation: { partySizeMin: 2, partySizeMax: 6, partyProbability: 0.75,
    overheadBagProbability: 0.8, priorityProbability: 0.3, assistanceProbability: 0.1,
    travelClassProbabilities: { ECONOMY: 0.6, PREMIUM_ECONOMY: 0.25, BUSINESS: 0.15 } } };
  assert.deepEqual(generateFlight(123, overrides), generateFlight(123, overrides));
  assert.notEqual(manifestHash(generateFlight(123, overrides)), manifestHash(generateFlight(124, overrides)));
  for (const rate of [0, 1]) {
    const manifest = generateFlight(7, { generation: { overheadBagProbability: rate, personalItemProbability: rate,
      priorityProbability: rate, assistanceProbability: rate } });
    assert.ok(manifest.passengers.every(p => p.actualBaggage.overheadPieces === rate && p.actualBaggage.personalItems === rate));
    assert.ok(manifest.passengers.every(p => p.priorityEligible === Boolean(rate)));
    assert.ok(manifest.passengers.every(p => (p.assistance.type !== 'NONE') === Boolean(rate)));
  }
});

test('invalid class distributions and group-size bounds fail configuration validation', () => {
  for (const generation of [
    { travelClassProbabilities: { ECONOMY: 0, PREMIUM_ECONOMY: 0, BUSINESS: 0 } },
    { travelClassProbabilities: { ECONOMY: 0.9, PREMIUM_ECONOMY: 0.1, BUSINESS: 0.1 } },
    { travelClassProbabilities: { ECONOMY: -0.1, PREMIUM_ECONOMY: 0.1, BUSINESS: 1 } },
    { travelClassProbabilities: { ECONOMY: '0.85' } },
    { travelClassProbabilities: { FIRST: 0.1 } },
    { partySizeMin: 1 }, { partySizeMin: 4, partySizeMax: 3 },
    { partySizeMax: 181 }, { partySizeMax: 2.5 }
  ]) assert.throws(() => makeConfig({ generation }));
});

test('baggage audit reports excess pieces, personal items and weight with exact allowance/actual values', () => {
  const passenger = generateFlight(42).passengers[0];
  const audit = actualBaggage => auditCarryOn({ ...passenger, actualBaggage });
  assert.equal(audit({ overheadPieces: 0, personalItems: 0, overheadWeightKg: 0 }).compliant, true);
  assert.equal(audit({ overheadPieces: 1, personalItems: 1, overheadWeightKg: 10 }).compliant, true);
  const excess = audit({ overheadPieces: 2, personalItems: 2, overheadWeightKg: 25 });
  assert.deepEqual(excess.allowance, passenger.carryOnAllowance);
  assert.equal(excess.excessOverheadPieces, 1);
  assert.equal(excess.excessPersonalItems, 1);
  assert.equal(excess.overweightKg, 5);
  assert.deepEqual(excess.violations, ['EXCESS_OVERHEAD_PIECES', 'EXCESS_PERSONAL_ITEMS', 'OVERWEIGHT_OVERHEAD_BAGGAGE']);
  assert.equal(audit({ overheadPieces: 0, personalItems: 0, overheadWeightKg: 1 }).compliant, false);
  assert.equal(audit({ overheadPieces: 1, personalItems: 0, overheadWeightKg: 10.00000001 }).compliant, false);
  assert.throws(() => audit({ overheadPieces: -1, personalItems: 0, overheadWeightKg: 0 }));
});

test('dataset inspection reports noncompliance while normal validation keeps rejecting it', () => {
  const manifest = generateFlight(42);
  manifest.passengers[0].actualBaggage = { overheadPieces: 2, personalItems: 2, overheadWeightKg: 25 };
  const report = auditPassengerDataset(manifest);
  assert.equal(report.stage1Complete, false);
  assert.equal(report.carryOn.noncompliantPassengers, 1);
  assert.equal(report.carryOn.excessOverheadPieces, 1);
  assert.equal(report.carryOn.excessPersonalItems, 1);
  assert.equal(report.carryOn.overweightKg, 5);
  assert.throws(() => validateManifest(manifest), /excess cabin baggage/);
});

test('original schema 1 payload remains valid and byte-identical, with missing class explicitly reported', () => {
  const legacy = asLegacy(generateFlight(42));
  const before = JSON.stringify(legacy);
  assert.equal(manifestHash(legacy), '1970236f8c08e6aa1c59b5d03f67d3b7c6e9f69043f5539fb526c65fca425d5a');
  assert.equal(validateManifest(legacy).passengerCount, 180);
  assert.deepEqual(compareStrategies(legacy).results.map(result => result.metrics.totalBoardingSeconds), [1624, 1796, 1426]);
  const audit = auditPassengerDataset(legacy);
  assert.equal(audit.passengerMix.unknownClassCount, 180);
  assert.equal(audit.stage1Complete, false);
  assert.equal(JSON.stringify(legacy), before);
  const incomplete = structuredClone(legacy);
  delete incomplete.config.generation.overheadBagProbability;
  assert.throws(() => validateManifest(incomplete), /config must be complete/);
});

test('class remains a separate field in CSV', () => {
  const manifest = generateFlight(42);
  const row = passengerRows(manifest)[0];
  for (const item of [row]) {
    assert.equal(item.travelClass, manifest.passengers[0].travelClass);
    assert.equal(item.boardingZone, manifest.passengers[0].boardingZone);
    assert.equal(item.priorityEligible, manifest.passengers[0].priorityEligible);
    assert.ok(!Object.hasOwn(item, 'classPriority'));
  }
});

test('custom larger-party datasets remain consumable by the existing Phase 1 pipeline', () => {
  const config = { aircraft: { rows: 2 }, generation: { partyProbability: 1, partySizeMin: 4, partySizeMax: 4, assistanceProbability: 0.4 } };
  for (const manifest of [generateFlight(7, config)]) {
    const report = auditPassengerDataset(manifest);
    assert.deepEqual(report.travelParties.partySizeCounts, { 4: 3 });
    // Small geometry is valid for compatibility tests, but is not the Stage 1 180-seat target.
    assert.equal(report.stage1Complete, false);
    for (const result of compareStrategies(manifest).results) {
      assert.equal(result.validation.seatedExactlyOnce, 12);
      assert.equal(result.validation.passed, true);
    }
  }
});

test('Stage 1 CLI generates configurable data and exports both passing and noncompliant audits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-stage1-'));
  try {
    const input = join(directory, 'passengers.json');
    const output = join(directory, 'audit.json');
    cli('generate', '--seed', '42', '--config', 'config/stage1.example.json', '--output', input);
    assert.match(cli('validate', '--input', input), /180 unique seats/);
    assert.match(cli('audit-dataset', '--input', input, '--output', output), /PASS: Stage 1/);
    const manifest = JSON.parse(readFileSync(input, 'utf8'));
    assert.equal(manifest.config.generation.partySizeMax, 6);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).stage1Complete, true);
    manifest.passengers[0].actualBaggage.overheadPieces = 2;
    writeFileSync(input, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, ['src/cli.js', 'audit-dataset', '--input', input, '--output', output], { cwd: project, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /INCOMPLETE/);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).carryOn.noncompliantPassengers, 1);
    writeFileSync(input, JSON.stringify(asLegacy(generateFlight(42))));
    const legacyResult = spawnSync(process.execPath, ['src/cli.js', 'audit-dataset', '--input', input, '--output', output], { cwd: project, encoding: 'utf8' });
    assert.equal(legacyResult.status, 1);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).passengerMix.unknownClassCount, 180);
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('boardingflow-stage1-'));
    rmSync(target, { recursive: true, force: true });
  }
});
