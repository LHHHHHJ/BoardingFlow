export const DEFAULT_PHASE2_SETTINGS = {
  eta: {
    walkingSpeedMps: 1.2,
    assistedWalkingSpeedMps: 0.8,
    estimatedSecuritySeconds: 180,
    minimumRemainingSecuritySeconds: 30,
    stopProbability: 0.25,
    stopDelayMinSeconds: 30,
    stopDelayMaxSeconds: 180,
    overdueRecheckSeconds: 15
  },
  scenarios: {
    securityDelayProbability: 0.3,
    securityDelayMinSeconds: 600,
    securityDelayMaxSeconds: 1200,
    latePartyProbability: 0.2,
    lateStopMinSeconds: 900,
    lateStopMaxSeconds: 1800
  },
  adaptive: {
    reviewIntervalSeconds: 5,
    lookaheadSeconds: 20,
    maxAnticipationWaitSeconds: 8,
    waitCostPerSecond: 1,
    minimumScoreImprovement: 5,
    expectedStowSecondsPerBag: 15,
    seatDepthWeight: 12,
    rowWeight: 0.4,
    zoneWeight: 1.5,
    congestionWeight: 0.4,
    interferenceWeight: 8
  }
};

export function phase2Settings(patch = {}) {
  const result = structuredClone(DEFAULT_PHASE2_SETTINGS);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Phase 2 settings must be an object');
  for (const [section, overrides] of Object.entries(patch)) {
    if (!Object.hasOwn(result, section) || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error(`Unknown/invalid Phase 2 section: ${section}`);
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(result[section], key)) throw new Error(`Unknown Phase 2 setting: ${section}.${key}`);
      result[section][key] = value;
    }
  }
  for (const section of Object.values(result)) {
    for (const [key, value] of Object.entries(section)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid Phase 2 setting: ${key}`);
      if (key.endsWith('Probability') && value > 1) throw new Error(`${key} must be in [0, 1]`);
    }
  }
  for (const key of ['walkingSpeedMps', 'assistedWalkingSpeedMps', 'estimatedSecuritySeconds', 'minimumRemainingSecuritySeconds', 'overdueRecheckSeconds']) {
    if (result.eta[key] <= 0) throw new Error(`${key} must be positive`);
  }
  if (result.adaptive.reviewIntervalSeconds <= 0) throw new Error('reviewIntervalSeconds must be positive');
  for (const [section, min, max] of [
    ['eta', 'stopDelayMinSeconds', 'stopDelayMaxSeconds'],
    ['scenarios', 'securityDelayMinSeconds', 'securityDelayMaxSeconds'],
    ['scenarios', 'lateStopMinSeconds', 'lateStopMaxSeconds']
  ]) if (result[section][min] > result[section][max]) throw new Error(`Reversed bounds: ${min}, ${max}`);
  return result;
}
