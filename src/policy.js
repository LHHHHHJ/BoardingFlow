// Static booking rights, observed confirmations and advisory checks only.
// No aircraft truth, forecast generator or optimization imports.
export const POLICY_ID = 'BF-SWISS-INSPIRED-V1';
export const POLICY_REFERENCE = 'https://www.swiss.com/ca/en/fly/airport/boarding';
export const POLICY_DEFAULTS = {
  profileId: POLICY_ID, status: 'UNVERIFIED',
  confirmedFirstClassPassengerIds: [], elitePriorityPassengerIds: [],
  confirmedAssistancePassengerIds: [], families: [], staffEvents: []
};

const fail = message => { throw new Error(`Invalid boarding policy: ${message}`); };
const knownKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))) fail(`unknown/invalid ${label} fields`);
};
const idList = (list, ids, label) => {
  if (!Array.isArray(list) || new Set(list).size !== list.length || list.some(id => !ids.has(id))) fail(`invalid ${label} passenger IDs`);
};

export function validateBoardingPolicy(policy, passengers, { requireStaffEvents = true } = {}) {
  knownKeys(policy, [...Object.keys(POLICY_DEFAULTS), 'confirmedAnimalArrangements'], 'policy');
  if (policy.profileId !== POLICY_ID || !['CONFIRMED', 'UNVERIFIED'].includes(policy.status)) fail('unknown profile or confirmation status');
  const ids = new Set(passengers.map(p => p.id));
  for (const key of ['confirmedFirstClassPassengerIds', 'elitePriorityPassengerIds', 'confirmedAssistancePassengerIds']) idList(policy[key], ids, key);
  const requested = new Set(passengers.filter(p => p.assistance.type !== 'NONE').map(p => p.id));
  if (policy.confirmedAssistancePassengerIds.some(id => !requested.has(id))
      || [...requested].some(id => !policy.confirmedAssistancePassengerIds.includes(id))) fail('assistance arrangements require explicit confirmation; staff review required');
  if (policy.confirmedAnimalArrangements !== undefined) {
    if (!Array.isArray(policy.confirmedAnimalArrangements)) fail('confirmed animal arrangements must be an array');
    const seen = new Set();
    for (const arrangement of policy.confirmedAnimalArrangements) {
      knownKeys(arrangement, ['passengerId', 'kind', 'confirmed', 'boardingRequirement'], 'animal arrangement');
      const passenger = passengers.find(p => p.id === arrangement.passengerId);
      if (!passenger || seen.has(passenger.id) || !['PET', 'SERVICE_ANIMAL'].includes(arrangement.kind)
          || arrangement.confirmed !== true || !['NONE', 'EXTRA_TIME', 'MOBILITY'].includes(arrangement.boardingRequirement)) fail('invalid/unconfirmed animal arrangement; staff review required');
      if (arrangement.boardingRequirement !== 'NONE' && (passenger.assistance.type !== arrangement.boardingRequirement
          || !policy.confirmedAssistancePassengerIds.includes(passenger.id))) fail('animal-related requirement must match separately confirmed assistance');
      seen.add(passenger.id);
    }
  }
  if (!Array.isArray(policy.families)) fail('families must be an array');
  const familyIds = new Set();
  for (const family of policy.families) {
    knownKeys(family, ['id', 'memberIds', 'youngChildUnderFivePassengerIds', 'guardianPassengerIds'], 'family');
    if (typeof family.id !== 'string' || !family.id || familyIds.has(family.id)) fail('missing/duplicate family ID');
    familyIds.add(family.id);
    for (const key of ['memberIds', 'youngChildUnderFivePassengerIds', 'guardianPassengerIds']) idList(family[key], ids, key);
    if (family.memberIds.length < 2 || [...family.youngChildUnderFivePassengerIds, ...family.guardianPassengerIds].some(id => !family.memberIds.includes(id))
        || family.youngChildUnderFivePassengerIds.some(id => family.guardianPassengerIds.includes(id))
        || (family.youngChildUnderFivePassengerIds.length && !family.guardianPassengerIds.length)) fail('family needs intact members and confirmed guardian arrangements');
  }
  if (!requireStaffEvents) return;
  if (!Array.isArray(policy.staffEvents)) fail('staffEvents must be an array');
  const seen = new Set();
  for (const event of policy.staffEvents) {
    knownKeys(event, ['passengerId', 'kind', 'timeSeconds', 'confirmed'], 'staff event');
    const key = JSON.stringify([event.passengerId, event.kind]);
    if (!ids.has(event.passengerId) || !['STAFF_APPROVAL', 'GATE_VERIFICATION'].includes(event.kind)
        || !Number.isFinite(event.timeSeconds) || typeof event.confirmed !== 'boolean' || seen.has(key)) fail('invalid/duplicate staff event');
    seen.add(key);
  }
}

export function policyIndividualStage(passenger, policy) {
  if (policy.profileId !== POLICY_ID) fail('unknown profile');
  if (passenger.mandatoryPreboarding || (passenger.assistance.type !== 'NONE'
      && policy.confirmedAssistancePassengerIds.includes(passenger.id))
      || policy.families.some(family => family.youngChildUnderFivePassengerIds.includes(passenger.id))) return 0;
  return passenger.priorityEligible || passenger.travelClass === 'BUSINESS'
    || policy.confirmedFirstClassPassengerIds.includes(passenger.id) || policy.elitePriorityPassengerIds.includes(passenger.id) ? 1 : 2;
}

export function requiredPolicyGroups(passengers, policy) {
  const parent = new Map(passengers.map(p => [p.id, p.id]));
  const find = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  const union = ids => { for (const id of ids.slice(1)) parent.set(find(id), find(ids[0])); };
  const parties = new Map();
  for (const p of passengers) if (p.travelPartyId !== null) {
    if (!parties.has(p.travelPartyId)) parties.set(p.travelPartyId, []);
    parties.get(p.travelPartyId).push(p.id);
  }
  for (const ids of parties.values()) union(ids);
  for (const family of policy.families) union(family.memberIds);
  const groups = new Map();
  for (const p of passengers) {
    const root = find(p.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }
  return new Map([...groups.values()].map(members => [`policy:${JSON.stringify(members.map(p => p.id).sort())}`, members]));
}

export function createPolicyObserver(policy, passengers) {
  validateBoardingPolicy(policy, passengers);
  const { staffEvents, ...staticRules } = policy;
  const rules = structuredClone(staticRules);
  const events = staffEvents.map(e => ({ ...e })).sort((a, b) => a.timeSeconds - b.timeSeconds);
  const states = new Map(passengers.map(p => [p.id, { passengerId: p.id, approval: null, gateVerification: null }]));
  let clock = -Infinity, cursor = 0, latestObservedAtSeconds = null;
  function advance(now) {
    if (!Number.isFinite(now) || now < clock) throw new Error('Policy observation clock must be finite and monotonic');
    clock = now;
    let changed = false;
    while (cursor < events.length && events[cursor].timeSeconds <= now) {
      const e = events[cursor++];
      states.get(e.passengerId)[e.kind === 'STAFF_APPROVAL' ? 'approval' : 'gateVerification'] = { confirmed: e.confirmed, atSeconds: e.timeSeconds };
      latestObservedAtSeconds = e.timeSeconds;
      changed = true;
    }
    return changed;
  }
  function confirmed(id) {
    const state = states.get(id);
    return !!state?.approval?.confirmed && !!state?.gateVerification?.confirmed;
  }
  function snapshot(now) {
    advance(now);
    return { asOfSeconds: now, latestObservedAtSeconds, rules: structuredClone(rules), passengers: structuredClone([...states.values()]) };
  }
  return { advance, confirmed, snapshot };
}

// Reviews a proposal or offers the safe ready-unit lottery fallback. It never
// optimizes a sequence, consumes an ETA, or authorizes a real airline action.
export function reviewBoardingRecommendation(snapshot, context, policySnapshot, proposal = null) {
  const now = context.nowSeconds;
  const base = { timeSeconds: now, advisory: true, simulationOnly: true,
    requiresStaffApproval: true, requiresGateVerification: true,
    action: 'HOLD', unitId: null, memberIds: [], simulationAdmissionAllowed: false };
  const hold = reason => ({ ...base, reason });
  try {
    if (!Number.isFinite(now) || snapshot.asOfSeconds !== now || policySnapshot.asOfSeconds !== now
        || (snapshot.latestObservedAtSeconds !== null && snapshot.latestObservedAtSeconds > now)
        || (policySnapshot.latestObservedAtSeconds !== null && policySnapshot.latestObservedAtSeconds > now)) return hold('INFORMATION_UNRELIABLE_STAFF_REVIEW');
    const rules = policySnapshot.rules;
    validateBoardingPolicy(rules, snapshot.passengers, { requireStaffEvents: false });
    if (rules.status !== 'CONFIRMED') return hold('POLICY_UNVERIFIED_STAFF_REVIEW');
    const ids = new Set(snapshot.passengers.map(p => p.id));
    const observedTimes = [snapshot.latestObservedAtSeconds, policySnapshot.latestObservedAtSeconds];
    if (ids.size !== snapshot.passengers.length || observedTimes.some(t => t !== null && !Number.isFinite(t))
        || !Array.isArray(context.boardedPassengerIds) || !Array.isArray(context.seatedPassengerIds)
        || new Set(context.boardedPassengerIds).size !== context.boardedPassengerIds.length
        || new Set(context.seatedPassengerIds).size !== context.seatedPassengerIds.length
        || context.boardedPassengerIds.some(id => !ids.has(id))
        || context.seatedPassengerIds.some(id => !context.boardedPassengerIds.includes(id))
        || typeof context.cabinOccupied !== 'boolean' || ![0, 1, 2].includes(context.stage)
        || policySnapshot.passengers.length !== ids.size
        || new Set(policySnapshot.passengers.map(p => p.passengerId)).size !== ids.size
        || policySnapshot.passengers.some(p => !ids.has(p.passengerId))) return hold('INFORMATION_UNRELIABLE_STAFF_REVIEW');
    const groups = requiredPolicyGroups(snapshot.passengers, rules);
    const boarded = new Set(context.boardedPassengerIds);
    const seated = new Set(context.seatedPassengerIds);
    const expected = new Map();
    for (const [id, members] of groups) {
      const count = members.filter(p => boarded.has(p.id)).length;
      if (count && count !== members.length) return hold('PARTIAL_REQUIRED_PARTY_STAFF_REVIEW');
      if (!count) expected.set(id, { members, stage: Math.min(...members.map(p => policyIndividualStage(p, rules))), zone: Math.min(...members.map(p => p.boardingZone)) });
    }
    if (context.pendingUnits.length !== expected.size || new Set(context.pendingUnits.map(u => u.id)).size !== expected.size) return hold('PENDING_GROUPS_UNRELIABLE_STAFF_REVIEW');
    for (const unit of context.pendingUnits) {
      const group = expected.get(unit.id);
      if (!group || group.stage !== unit.stage || group.zone !== unit.zone
          || unit.assisted !== group.members.some(p => p.assistance.type !== 'NONE') || unit.memberIds.length !== group.members.length
          || new Set(unit.memberIds).size !== unit.memberIds.length || group.members.some(p => !unit.memberIds.includes(p.id))) return hold('RIGHTS_OR_PARTY_CONFLICT_STAFF_REVIEW');
    }
    const stage = Math.min(...[...expected.values()].map(g => g.stage));
    if (!expected.size) return hold('ALL_UNITS_CALLED');
    if (context.stage !== stage) return hold('PROTECTED_STAGE_CONFLICT_STAFF_REVIEW');
    if (stage > 0 && [...groups.values()].some(members => Math.min(...members.map(p => policyIndividualStage(p, rules))) === 0
        && members.some(p => !seated.has(p.id)))) return hold('PREBOARDING_MUST_BE_SEATED');
    const zone = context.strategy === 'zone' && stage === 2 ? Math.min(...[...expected.values()].filter(g => g.stage === stage).map(g => g.zone)) : null;
    const candidates = context.pendingUnits.filter(u => u.stage === stage && (zone === null || u.zone === zone));
    const confirmations = new Map(policySnapshot.passengers.map(p => [p.passengerId, p]));
    const ready = unit => expected.get(unit.id).members.every(p => {
      const times = [p.checkIn?.clearedAtSeconds, p.security?.clearedAtSeconds, p.gateObservedAtSeconds];
      const otherTimes = [p.security?.scanAtSeconds, p.lastCheckpoint?.observedAtSeconds];
      return p.readyAtGate === true && p.checkIn?.status === 'CLEARED' && p.security?.status === 'CLEARED'
        && times.every(t => Number.isFinite(t) && t <= now) && times[0] <= times[1] && times[1] <= times[2]
        && otherTimes.every(t => t == null || (Number.isFinite(t) && t <= now))
        && (p.security?.scanAtSeconds == null || p.security.scanAtSeconds <= times[1]);
    });
    const approved = unit => expected.get(unit.id).members.every(p => {
      const state = confirmations.get(p.id);
      return state?.approval?.confirmed === true && state?.gateVerification?.confirmed === true
        && [state.approval.atSeconds, state.gateVerification.atSeconds].every(t => Number.isFinite(t) && t <= now)
        && state.gateVerification.atSeconds >= p.gateObservedAtSeconds;
    });
    let unit;
    if (proposal) {
      unit = candidates.find(u => u.id === proposal.unitId);
      if (!unit || JSON.stringify(unit.memberIds) !== JSON.stringify(proposal.memberIds)) return hold('PROPOSAL_POLICY_CONFLICT_STAFF_REVIEW');
      if (!ready(unit)) return hold('REQUIRED_OBSERVED_READINESS_MISSING');
      if (!approved(unit)) return hold('STAFF_APPROVAL_OR_GATE_VERIFICATION_PENDING');
    } else unit = candidates.find(u => ready(u) && approved(u));
    if (!unit) return hold(candidates.some(ready) ? 'STAFF_APPROVAL_OR_GATE_VERIFICATION_PENDING' : 'NO_OBSERVED_READY_ELIGIBLE_UNIT');
    if (unit.assisted && context.cabinOccupied) return hold('ASSISTANCE_REQUIRES_EMPTY_AISLE');
    return { ...base, action: 'RECOMMEND_BOARDING', reason: proposal ? 'POLICY_CHECKS_PASSED' : 'SAFE_READY_UNIT_FALLBACK',
      profileId: rules.profileId, unitId: unit.id, memberIds: [...unit.memberIds], simulationAdmissionAllowed: true };
  } catch {
    return hold('POLICY_OR_OBSERVATIONS_INVALID_STAFF_REVIEW');
  }
}
