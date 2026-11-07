export const TRAVEL_CLASSES = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS'];

export const DEFAULT_CONFIG = {
  aircraft: { rows: 30, seatLetters: 'ABCDEF' },
  generation: {
    partyProbability: 0.55,
    partySizeMin: 2,
    partySizeMax: 3,
    travelClassProbabilities: { ECONOMY: 0.85, PREMIUM_ECONOMY: 0.1, BUSINESS: 0.05 },
    priorityProbability: 0.12,
    assistanceProbability: 0.025,
    additionalPreboardingProbability: 0.01,
    overheadBagProbability: 0.65,
    personalItemProbability: 0.85,
    lateArrivalProbability: 0.08,
    earlyArrivalMinSeconds: -900,
    earlyArrivalMaxSeconds: -60,
    lateArrivalMinSeconds: 30,
    lateArrivalMaxSeconds: 480,
    maxOverheadWeightKg: 10,
    stowSecondsPerBagMin: 10,
    stowSecondsPerBagMax: 20,
    seatSecondsMin: 3,
    seatSecondsMax: 5,
    walkSecondsPerRow: 1,
    assistedWalkSecondsPerRow: 2
  },
  simulation: {
    tickSeconds: 1,
    gateHeadwaySeconds: 2,
    seatInterferenceSecondsPerBlocker: 8,
    mobilityAssistanceSeconds: 40,
    extraTimeAssistanceSeconds: 20,
    maxSimulationSeconds: 7200
  }
};

function mergeKnown(base, patch, path = 'config') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`${path} must be an object`);
  }
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(base, key)) throw new Error(`Unknown configuration key: ${path}.${key}`);
    result[key] = typeof base[key] === 'object'
      ? mergeKnown(base[key], value, `${path}.${key}`) : value;
  }
  return result;
}

export function makeConfig(overrides = {}) {
  const config = mergeKnown(DEFAULT_CONFIG, overrides);
  const { aircraft, generation: gen, simulation: sim } = config;
  if (!Number.isInteger(aircraft.rows) || aircraft.rows < 1 || aircraft.rows > 100) {
    throw new Error('aircraft.rows must be an integer in [1, 100]');
  }
  if (aircraft.seatLetters !== 'ABCDEF') throw new Error('This model requires six seats ABCDEF');
  for (const [key, value] of [...Object.entries(gen).filter(([key]) => key !== 'travelClassProbabilities'), ...Object.entries(sim)]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be finite`);
    if (key.endsWith('Probability') && (value < 0 || value > 1)) throw new Error(`${key} must be in [0, 1]`);
    if (!key.includes('Arrival') && value < 0) throw new Error(`${key} cannot be negative`);
  }
  if (!Number.isSafeInteger(gen.partySizeMin) || !Number.isSafeInteger(gen.partySizeMax)
      || gen.partySizeMin < 2 || gen.partySizeMin > gen.partySizeMax || gen.partySizeMax > aircraft.rows * 6) {
    throw new Error('partySizeMin/partySizeMax must be integers with 2 <= min <= max <= aircraft capacity');
  }
  let classProbabilityTotal = 0;
  for (const [name, probability] of Object.entries(gen.travelClassProbabilities)) {
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`travelClassProbabilities.${name} must be in [0, 1]`);
    }
    classProbabilityTotal += probability;
  }
  if (Math.abs(classProbabilityTotal - 1) > 1e-9) throw new Error('travelClassProbabilities must sum to 1');
  for (const key of ['earlyArrivalMinSeconds', 'earlyArrivalMaxSeconds', 'lateArrivalMinSeconds', 'lateArrivalMaxSeconds']) {
    if (!Number.isInteger(gen[key])) throw new Error(`${key} must be integer seconds`);
  }
  if (gen.earlyArrivalMinSeconds > gen.earlyArrivalMaxSeconds || gen.earlyArrivalMaxSeconds > 0
      || gen.lateArrivalMinSeconds < 0 || gen.lateArrivalMinSeconds > gen.lateArrivalMaxSeconds) {
    throw new Error('Arrival bounds must be ordered; early <= 0 and late >= 0');
  }
  for (const prefix of ['stowSecondsPerBag', 'seatSeconds']) {
    if (gen[`${prefix}Min`] > gen[`${prefix}Max`]) throw new Error(`${prefix} bounds are reversed`);
  }
  for (const [key, value] of Object.entries({
    maxOverheadWeightKg: gen.maxOverheadWeightKg,
    seatSecondsMin: gen.seatSecondsMin,
    walkSecondsPerRow: gen.walkSecondsPerRow,
    assistedWalkSecondsPerRow: gen.assistedWalkSecondsPerRow,
    gateHeadwaySeconds: sim.gateHeadwaySeconds,
    maxSimulationSeconds: sim.maxSimulationSeconds
  })) {
    if (value <= 0) throw new Error(`${key} must be positive`);
  }
  if (sim.tickSeconds < 0.1 || sim.tickSeconds > 1) throw new Error('tickSeconds must be in [0.1, 1]');
  if (sim.maxSimulationSeconds / sim.tickSeconds > 1_000_000) throw new Error('Simulation tick limit is too large');
  return config;
}
