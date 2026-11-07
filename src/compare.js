import { deepFreeze, manifestHash, validateManifest } from './model.js';
import { simulate } from './simulate.js';
import { STRATEGIES } from './strategies.js';

export function compareStrategies(manifest, options = {}) {
  validateManifest(manifest);
  deepFreeze(manifest);
  const inputHash = manifestHash(manifest);
  const results = STRATEGIES.map(strategy => simulate(manifest, strategy, options));
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
