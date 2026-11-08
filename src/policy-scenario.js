import { POLICY_DEFAULTS } from './policy.js';
import { validateManifest } from './model.js';

// Offline synthetic fixture preparation, never called by advisory decisions.
export function withBoardingPolicy(manifest, configuration) {
  if (!manifest.phase2) throw new Error('Stage 5 policy requires an observed terminal scenario');
  const copy = structuredClone(manifest);
  const { syntheticStaffConfirmation, ...rules } = configuration;
  copy.boardingPolicy = { ...structuredClone(POLICY_DEFAULTS), ...structuredClone(rules) };
  if (syntheticStaffConfirmation !== undefined) {
    const settings = syntheticStaffConfirmation;
    if (!settings || Object.keys(settings).some(key => !['approvalDelaySeconds', 'gateVerificationDelaySeconds'].includes(key))
        || ![settings.approvalDelaySeconds, settings.gateVerificationDelaySeconds].every(t => Number.isFinite(t) && t >= 0)
        || copy.boardingPolicy.staffEvents.length) throw new Error('Invalid explicit synthetic staff-confirmation settings');
    copy.boardingPolicy.staffEvents = copy.passengers.flatMap(p => [
      { passengerId: p.id, kind: 'STAFF_APPROVAL', timeSeconds: p.gateArrivalSeconds + settings.approvalDelaySeconds, confirmed: true },
      { passengerId: p.id, kind: 'GATE_VERIFICATION', timeSeconds: p.gateArrivalSeconds + settings.gateVerificationDelaySeconds, confirmed: true }
    ]);
  }
  validateManifest(copy);
  return copy;
}
