import { makeConfig, TRAVEL_CLASSES } from './config.js';
import { integer, randomStream } from './random.js';
import { validateManifest } from './model.js';

export function generateFlight(seed = 42, overrides = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new Error('seed must be uint32');
  const config = makeConfig(overrides);
  const { generation: gen, aircraft } = config;
  const random = randomStream(seed, 'synthetic-passengers-v1');
  const passengers = [];
  let partyCounter = 0;
  const sample = (min, max) => Math.round((min + random() * (max - min)) * 100) / 100;
  let seatIndex = 0;
  const capacity = aircraft.rows * 6;
  while (seatIndex < capacity) {
    // Retain original row-side clipping only for the default 2-3 model.
    // Custom bounds keep requested parties intact across sides/rows;
    // only the final aircraft-capacity remainder can truncate them.
    const defaultPartyBounds = gen.partySizeMin === 2 && gen.partySizeMax === 3;
    const remaining = defaultPartyBounds ? 3 - (seatIndex % 3) : capacity - seatIndex;
    const size = random() < gen.partyProbability
      ? Math.min(integer(random, gen.partySizeMin, gen.partySizeMax), remaining) : 1;
    const travelPartyId = size > 1 ? `SYN-T${String(++partyCounter).padStart(3, '0')}` : null;
    const late = random() < gen.lateArrivalProbability;
    let arrival = late
      ? integer(random, gen.lateArrivalMinSeconds, gen.lateArrivalMaxSeconds)
      : integer(random, gen.earlyArrivalMinSeconds, gen.earlyArrivalMaxSeconds);
    const members = [];
    for (let offset = 0; offset < size; offset++) {
      const position = seatIndex + offset;
      const row = Math.floor(position / 6) + 1;
      const overheadPieces = random() < gen.overheadBagProbability ? 1 : 0;
      const assistance = random() < gen.assistanceProbability
        ? (random() < 0.5 ? 'MOBILITY' : 'EXTRA_TIME') : 'NONE';
      const mandatoryPreboarding = assistance !== 'NONE' || random() < gen.additionalPreboardingProbability;
      members.push({
        id: `SYN-P${String(passengers.length + members.length + 1).padStart(3, '0')}`,
        flightId: 'BF-SYN-001',
        seatNumber: `${row}${aircraft.seatLetters[position % 6]}`,
        boardingZone: 3 - Math.min(2, Math.floor((row - 1) * 3 / aircraft.rows)),
        priorityEligible: random() < gen.priorityProbability,
        mandatoryPreboarding,
        carryOnAllowance: { overheadPieces: 1, personalItems: 1, maxOverheadWeightKg: gen.maxOverheadWeightKg },
        actualBaggage: {
          overheadPieces,
          personalItems: random() < gen.personalItemProbability ? 1 : 0,
          overheadWeightKg: overheadPieces ? sample(Math.min(2, gen.maxOverheadWeightKg), gen.maxOverheadWeightKg) : 0
        },
        checkInStatus: 'CLEARED',
        securityStatus: 'CLEARED',
        travelPartyId,
        assistance: { type: assistance, companionId: null },
        behavior: {
          walkSecondsPerRow: assistance === 'NONE' ? gen.walkSecondsPerRow : gen.assistedWalkSecondsPerRow,
          stowSecondsPerBag: sample(gen.stowSecondsPerBagMin, gen.stowSecondsPerBagMax),
          seatSeconds: sample(gen.seatSecondsMin, gen.seatSecondsMax)
        }
      });
    }
    // Prearranged preboarding parties arrive before opening in the default scenario.
    if (members.some(passenger => passenger.mandatoryPreboarding)) {
      arrival = Math.min(arrival, gen.earlyArrivalMaxSeconds);
    }
    for (const passenger of members) {
      passenger.gateArrivalSeconds = arrival;
      passenger.securityClearedAtSeconds = arrival - integer(random, 120, 600);
      passenger.checkInAtSeconds = passenger.securityClearedAtSeconds - integer(random, 600, 3600);
      if (passenger.assistance.type !== 'NONE' && size > 1) {
        passenger.assistance.companionId = members.find(other => other.id !== passenger.id).id;
      }
    }
    passengers.push(...members);
    seatIndex += size;
  }
  // Class is a separate synthetic fare label. It grants no priority, zone or
  // assistance entitlement and does not consume the existing physical RNG.
  const classRandom = randomStream(seed, 'synthetic-travel-class-v1');
  for (const passenger of passengers) {
    const draw = classRandom();
    let cumulative = 0;
    passenger.travelClass = TRAVEL_CLASSES.find(name => {
      cumulative += gen.travelClassProbabilities[name];
      return draw < cumulative;
    }) ?? TRAVEL_CLASSES.at(-1);
  }
  const manifest = {
    schemaVersion: 2,
    dataKind: 'SYNTHETIC',
    provenance: 'Generated independently by BoardingFlow; no official passenger records used.',
    seed,
    flight: {
      flightId: 'BF-SYN-001',
      aircraftType: `SYNTHETIC-${aircraft.rows}x6-SINGLE-AISLE`,
      boardingOpenTime: '2026-11-07T17:00:00.000Z',
      timeConvention: 'All *Seconds fields are relative to boardingOpenTime; negative is before opening.'
    },
    config,
    passengers
  };
  validateManifest(manifest);
  return manifest;
}
