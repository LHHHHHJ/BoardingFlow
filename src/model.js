import { createHash } from 'node:crypto';
import { makeConfig, TRAVEL_CLASSES } from './config.js';
import { auditCarryOn } from './baggage.js';

export const ASSISTANCE_TYPES = ['NONE', 'MOBILITY', 'EXTRA_TIME'];
export const STAGE_NAMES = ['PREBOARD', 'PRIORITY', 'GENERAL'];

export function parseSeat(seatNumber) {
  const match = /^(\d+)([A-F])$/.exec(seatNumber);
  if (!match || String(Number(match[1])) !== match[1]) throw new Error(`Invalid seat: ${seatNumber}`);
  return { row: Number(match[1]), letter: match[2] };
}

export function seatDepth(letter) {
  return { A: 0, F: 0, B: 1, E: 1, C: 2, D: 2 }[letter];
}

export function blockingSeats(seatNumber) {
  const { row, letter } = parseSeat(seatNumber);
  return ({ A: ['B', 'C'], B: ['C'], C: [], D: [], E: ['D'], F: ['D', 'E'] })[letter]
    .map(other => `${row}${other}`);
}

export function individualStage(passenger) {
  if (passenger.mandatoryPreboarding || passenger.assistance.type !== 'NONE') return 0;
  return passenger.priorityEligible ? 1 : 2;
}

// Stable canonical hashing also tolerates JSON object-key reordering on reload.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const manifestHash = manifest => createHash('sha256').update(canonicalJSON(manifest)).digest('hex');

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function validateManifest(manifest, { requireFullFlight = true, allowNoncompliantBaggage = false } = {}) {
  const fail = message => { throw new Error(`Invalid manifest: ${message}`); };
  if (!manifest || ![1, 2].includes(manifest.schemaVersion) || manifest.dataKind !== 'SYNTHETIC') fail('expected schemaVersion 1 or 2, SYNTHETIC data');
  if (!Number.isSafeInteger(manifest.seed) || manifest.seed < 0 || manifest.seed > 0xFFFFFFFF) fail('seed must be uint32');
  const config = makeConfig(manifest.config);
  const expectedConfig = structuredClone(config);
  if (manifest.schemaVersion === 1) {
    // Accept complete original configurations without mutating their bytes or
    // inventing a travel class for previously saved Phase 1/2 passengers.
    for (const key of ['partySizeMin', 'partySizeMax', 'travelClassProbabilities']) {
      if (!Object.hasOwn(manifest.config?.generation ?? {}, key)) delete expectedConfig.generation[key];
    }
  }
  if (canonicalJSON(expectedConfig) !== canonicalJSON(manifest.config)) fail('config must be complete; use generate or demo to create a manifest');
  const { flight, passengers } = manifest;
  if (!flight || typeof flight.flightId !== 'string' || !flight.flightId
      || !Number.isFinite(Date.parse(flight.boardingOpenTime))) fail('flight ID and boardingOpenTime required');
  if (!Array.isArray(passengers)) fail('passengers must be an array');
  const capacity = config.aircraft.rows * 6;
  if (requireFullFlight && passengers.length !== capacity) fail(`expected ${capacity} passengers, got ${passengers.length}`);
  if (passengers.length > capacity) fail('aircraft capacity exceeded');
  const ids = new Set();
  const seats = new Set();
  const finite = (value, label, min = -Infinity) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(`${label} must be finite and >= ${min}`);
  };
  const count = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`);
  };
  for (const passenger of passengers) {
    if (!passenger || typeof passenger.id !== 'string' || !passenger.id || ids.has(passenger.id)) fail('missing or duplicate passenger ID');
    ids.add(passenger.id);
    if (passenger.flightId !== flight.flightId) fail(`${passenger.id}: wrong flight`);
    if (typeof passenger.seatNumber !== 'string') fail(`${passenger.id}: seat required`);
    const { row } = parseSeat(passenger.seatNumber);
    if (row < 1 || row > config.aircraft.rows || seats.has(passenger.seatNumber)) fail('duplicate or out-of-range seat');
    seats.add(passenger.seatNumber);
    if (![1, 2, 3].includes(passenger.boardingZone)) fail('boardingZone must be 1, 2 or 3');
    if ((manifest.schemaVersion >= 2 || Object.hasOwn(passenger, 'travelClass'))
        && !TRAVEL_CLASSES.includes(passenger.travelClass)) fail('travelClass must be ECONOMY, PREMIUM_ECONOMY or BUSINESS');
    if (typeof passenger.priorityEligible !== 'boolean' || typeof passenger.mandatoryPreboarding !== 'boolean') fail('boarding rights must be boolean');
    if (passenger.checkInStatus !== 'CLEARED' || passenger.securityStatus !== 'CLEARED') fail(`${passenger.id}: check-in and security must be CLEARED`);
    for (const key of ['checkInAtSeconds', 'securityClearedAtSeconds', 'gateArrivalSeconds']) finite(passenger[key], key);
    if (passenger.checkInAtSeconds > passenger.securityClearedAtSeconds
        || passenger.securityClearedAtSeconds > passenger.gateArrivalSeconds) fail('check-in/security/gate timestamps are out of order');
    if (passenger.travelPartyId !== null && (typeof passenger.travelPartyId !== 'string' || !passenger.travelPartyId)) fail('invalid travelPartyId');
    if (!passenger.assistance || !ASSISTANCE_TYPES.includes(passenger.assistance.type)) fail('unknown assistance type');
    if (passenger.assistance.companionId !== null && typeof passenger.assistance.companionId !== 'string') fail('invalid companion ID');
    if (passenger.assistance.type === 'NONE' && passenger.assistance.companionId !== null) fail('companion requires assistance');
    const allowance = passenger.carryOnAllowance;
    const bags = passenger.actualBaggage;
    if (!allowance || !bags) fail('carry-on allowance and actual baggage required');
    for (const key of ['overheadPieces', 'personalItems']) {
      count(allowance[key], `allowance.${key}`);
      count(bags[key], `actualBaggage.${key}`);
    }
    finite(allowance.maxOverheadWeightKg, 'maxOverheadWeightKg', 0);
    finite(bags.overheadWeightKg, 'overheadWeightKg', 0);
    const baggageAudit = auditCarryOn(passenger);
    if (!allowNoncompliantBaggage) {
      if (baggageAudit.excessOverheadPieces || baggageAudit.excessPersonalItems) fail('excess cabin baggage must be resolved before simulation');
      if (!baggageAudit.compliant) fail('overweight cabin baggage');
    }
    if (!passenger.behavior) fail('sampled behavior required');
    for (const key of ['walkSecondsPerRow', 'seatSeconds', 'stowSecondsPerBag']) finite(passenger.behavior[key], key, 0);
    if (passenger.behavior.walkSecondsPerRow <= 0 || passenger.behavior.seatSeconds <= 0) fail('walking and seating durations must be positive');
  }
  const byId = new Map(passengers.map(passenger => [passenger.id, passenger]));
  for (const passenger of passengers) {
    const companionId = passenger.assistance.companionId;
    if (companionId !== null) {
      const companion = byId.get(companionId);
      if (!companion || companionId === passenger.id || !passenger.travelPartyId
          || companion.travelPartyId !== passenger.travelPartyId) fail('assistance companion must be another passenger in the same party');
    }
  }
  return { passengerCount: passengers.length, uniqueSeats: seats.size, capacity, inputHash: manifestHash(manifest) };
}
