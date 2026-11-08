import { deepFreeze, manifestHash, validateManifest } from './model.js';
import { simulate } from './simulate.js';
import { STRATEGIES, STAGE6_STRATEGIES } from './strategies.js';

export function compareStrategies(manifest, options = {}) {
  return compareWith(manifest, STRATEGIES, options);
}

// Explicitly retain the three original baselines for future adaptive comparisons.
export function compareBaselines(manifest, options = {}) {
  return compareWith(manifest, STRATEGIES, options);
}

export function compareAllStrategies(manifest, options = {}) {
  if (!manifest.boardingPolicy || !manifest.phase2) throw new Error('Five-strategy comparison requires observed readiness and the explicit policy');
  return compareWith(manifest, STAGE6_STRATEGIES, options);
}

function compareWith(manifest, strategies, options) {
  validateManifest(manifest);
  deepFreeze(manifest);
  const inputHash = manifestHash(manifest);
  const results = strategies.map(strategy => simulate(manifest, strategy, options));
  if (manifestHash(manifest) !== inputHash || results.some(result => result.inputHash !== inputHash)) {
    throw new Error('Fair comparison failed: passenger inputs changed');
  }
  return {
    schemaVersion: 1,
    dataKind: 'SYNTHETIC',
    flightId: manifest.flight.flightId,
    seed: manifest.seed,
    inputHash,
    results
  };
}
