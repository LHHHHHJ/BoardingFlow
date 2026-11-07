import { generateFlight } from './generate.js';
import { canonicalJSON, validateManifest } from './model.js';
import { DEFAULT_TERMINAL, accessibleRoute, validateTerminal } from './terminal.js';
import { phase2Settings } from './phase2-config.js';
import { integer, randomStream } from './random.js';
import { OBSERVATION_TYPES, observationOrder, validateObservation, observationProgress, advanceObservationProgress } from './observations.js';

export const SCENARIOS = ['normal', 'security-delays', 'late-arrivals'];
export { OBSERVATION_TYPES } from './observations.js';

export function generateScenario(seed = 42, scenarioName = 'normal', config = {}, settingsPatch = {}) {
  if (!SCENARIOS.includes(scenarioName)) throw new Error(`Unknown scenario '${scenarioName}'; choose ${SCENARIOS.join(', ')}`);
  const manifest = generateFlight(seed, config);
  const settings = phase2Settings(settingsPatch);
  const terminal = structuredClone(DEFAULT_TERMINAL);
  const assignedGateId = 'GATE_B';
  const observations = [];
  const truth = [];
  const groups = new Map();
  for (const passenger of manifest.passengers) {
    const key = passenger.travelPartyId ?? passenger.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(passenger);
  }
  for (const [id, members] of groups) {
    const random = randomStream(seed, `terminal-party-v1:${id}`);
    const preboard = members.some(p => p.mandatoryPreboarding || p.assistance.type !== 'NONE');
    const scanAt = preboard ? integer(random, -1500, -1200) : integer(random, -1100, -250);
    const securityDelay = random() < settings.scenarios.securityDelayProbability
      ? integer(random, settings.scenarios.securityDelayMinSeconds, settings.scenarios.securityDelayMaxSeconds) : 0;
    const lateDelay = random() < settings.scenarios.latePartyProbability
      ? integer(random, settings.scenarios.lateStopMinSeconds, settings.scenarios.lateStopMaxSeconds) : 0;
    for (const passenger of members) {
      const personRandom = randomStream(seed, `terminal-person-v1:${passenger.id}`);
      const assisted = passenger.assistance.type !== 'NONE';
      // Independent truth draws are never given to the ETA or adaptive modules.
      const walkingSpeed = (assisted ? settings.eta.assistedWalkingSpeedMps : settings.eta.walkingSpeedMps)
        * (0.75 + personRandom() * 0.5);
      const baseSecurity = integer(personRandom, 120, 240);
      const processing = baseSecurity + (scenarioName === 'security-delays' ? securityDelay : 0);
      const stop = personRandom() < settings.eta.stopProbability
        ? integer(personRandom, settings.eta.stopDelayMinSeconds, settings.eta.stopDelayMaxSeconds) : 0;
      const extraStop = scenarioName === 'late-arrivals' ? lateDelay : 0;
      const checkInAt = scanAt - Math.ceil(120 / walkingSpeed) - integer(personRandom, 120, 600);
      const clearedAt = scanAt + processing;
      const junctionAt = clearedAt + Math.ceil(accessibleRoute(terminal, 'SECURITY_EXIT', 'JUNCTION').distanceMeters / walkingSpeed);
      const arrivalAt = junctionAt + Math.ceil(accessibleRoute(terminal, 'JUNCTION', assignedGateId).distanceMeters / walkingSpeed) + stop + extraStop;
      Object.assign(passenger, {
        checkInAtSeconds: checkInAt,
        securityScanAtSeconds: scanAt,
        securityClearedAtSeconds: clearedAt,
        // Legacy field is execution truth in both phases, never an ETA.
        gateArrivalSeconds: arrivalAt
      });
      for (const [type, timeSeconds, checkpointId] of [
        ['CHECK_IN_CLEARED', checkInAt, 'CHECK_IN'],
        ['SECURITY_ENTERED', scanAt, 'SECURITY_ENTRY'],
        ['SECURITY_CLEARED', clearedAt, 'SECURITY_EXIT'],
        ['CHECKPOINT', junctionAt, 'JUNCTION'],
        ['GATE_ARRIVED', arrivalAt, assignedGateId]
      ]) observations.push({ passengerId: passenger.id, type, timeSeconds, checkpointId });
      truth.push({ passengerId: passenger.id, actualSecurityProcessingSeconds: processing,
        actualWalkingSpeedMps: walkingSpeed, actualStopDelaySeconds: stop + extraStop });
    }
  }
  observations.sort((a, b) => a.timeSeconds - b.timeSeconds || a.passengerId.localeCompare(b.passengerId)
    || OBSERVATION_TYPES.indexOf(a.type) - OBSERVATION_TYPES.indexOf(b.type));
  manifest.phase2 = { schemaVersion: 1, scenarioName, assignedGateId, terminal, settings, observations, truth };
  manifest.provenance += ' Phase 2 terminal routes, observation events and arrival truth are also synthetic.';
  validateScenario(manifest);
  return manifest;
}

export function validateScenario(manifest, options = {}) {
  const base = validateManifest(manifest, options);
  const data = manifest.phase2;
  const fail = message => { throw new Error(`Invalid Phase 2 scenario: ${message}`); };
  if (!data || data.schemaVersion !== 1 || !SCENARIOS.includes(data.scenarioName)) fail('missing/unknown scenario');
  if (canonicalJSON(phase2Settings(data.settings)) !== canonicalJSON(data.settings)) fail('settings must be complete');
  validateTerminal(data.terminal);
  if (!data.terminal.nodes.includes(data.assignedGateId)) fail('unknown assigned gate');
  if (!Array.isArray(data.observations) || !Array.isArray(data.truth)) fail('observations and truth required');
  const byId = new Map(manifest.passengers.map(p => [p.id, p]));
  const passengerIds = new Set(byId.keys());
  const terminalNodes = new Set(data.terminal.nodes);
  const eventsByPassenger = new Map(manifest.passengers.map(p => [p.id, []]));
  for (const event of data.observations) {
    validateObservation(event, passengerIds, terminalNodes, data.assignedGateId);
    eventsByPassenger.get(event.passengerId).push(event);
  }
  for (const passenger of manifest.passengers) {
    if (!Number.isFinite(passenger.securityScanAtSeconds) || passenger.checkInAtSeconds > passenger.securityScanAtSeconds
        || passenger.securityScanAtSeconds >= passenger.securityClearedAtSeconds) fail('security entry must precede clearance');
    const events = eventsByPassenger.get(passenger.id).sort(observationOrder);
    const progress = observationProgress();
    for (const event of events) advanceObservationProgress(progress, event);
    for (const [type, field, checkpoint] of [
      ['CHECK_IN_CLEARED', 'checkInAtSeconds', 'CHECK_IN'],
      ['SECURITY_ENTERED', 'securityScanAtSeconds', 'SECURITY_ENTRY'],
      ['SECURITY_CLEARED', 'securityClearedAtSeconds', 'SECURITY_EXIT'],
      ['GATE_ARRIVED', 'gateArrivalSeconds', data.assignedGateId]
    ]) {
      const matching = events.filter(event => event.type === type);
      // A scan can be missing. If supplied, it must agree with execution truth.
      // No missing observation is reconstructed from those private timestamps.
      if (matching.length > 1 || (matching.length === 1
          && (matching[0].timeSeconds !== passenger[field] || matching[0].checkpointId !== checkpoint))) fail(`duplicate/inconsistent ${type}`);
    }
    for (const event of events.filter(event => event.type === 'CHECKPOINT')) {
      if (event.timeSeconds < passenger.securityClearedAtSeconds || event.timeSeconds > passenger.gateArrivalSeconds) fail('checkpoint outside cleared journey');
    }
    if (!accessibleRoute(data.terminal, 'CHECK_IN', data.assignedGateId).reachable) fail('gate has no accessible route');
  }
  const truthIds = new Set();
  for (const item of data.truth) {
    const passenger = byId.get(item.passengerId);
    if (!passenger || truthIds.has(item.passengerId) || !Number.isFinite(item.actualWalkingSpeedMps) || item.actualWalkingSpeedMps <= 0
        || !Number.isFinite(item.actualStopDelaySeconds) || item.actualStopDelaySeconds < 0
        || item.actualSecurityProcessingSeconds !== passenger.securityClearedAtSeconds - passenger.securityScanAtSeconds) fail('invalid ground truth');
    truthIds.add(item.passengerId);
  }
  if (truthIds.size !== byId.size) fail('missing ground truth');
  return base;
}
