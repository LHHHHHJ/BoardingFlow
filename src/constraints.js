import { STAGE_NAMES } from './model.js';
import { boardingUnits } from './strategies.js';

// Post-run evaluation. Actual timestamps belong here, never in policy inputs.
export function constraintReport(manifest, result) {
  const counts = {
    earlyGateEntry: 0, earlyCheckInEntry: 0, earlySecurityEntry: 0,
    duplicatePassenger: 0, duplicateSeat: 0, wrongSeat: 0, missingPassenger: 0,
    priorityStageOrder: 0, preboardingBarrier: 0, splitTravelParty: 0, assistanceConflict: 0
  };
  if (manifest.boardingPolicy) Object.assign(counts, {
    observedReadinessViolation: 0, staffApprovalViolation: 0, gateVerificationViolation: 0, familySeparation: 0
  });
  const passengers = new Map(manifest.passengers.map(p => [p.id, p]));
  const units = boardingUnits(manifest);
  const unitByPassenger = new Map(units.flatMap(unit => unit.members.map(p => [p.id, unit])));
  const ids = new Set();
  const seats = new Set();
  let previousStage = -1;
  const timings = result.passengerTimings;
  for (const record of timings) {
    const passenger = passengers.get(record.passengerId);
    if (ids.has(record.passengerId)) counts.duplicatePassenger++;
    if (seats.has(record.seatNumber)) counts.duplicateSeat++;
    ids.add(record.passengerId);
    seats.add(record.seatNumber);
    if (!passenger || passenger.seatNumber !== record.seatNumber) counts.wrongSeat++;
    if (!passenger) continue;
    if (record.boardedAtSeconds < Math.max(0, passenger.gateArrivalSeconds)) counts.earlyGateEntry++;
    if (record.boardedAtSeconds < passenger.checkInAtSeconds) counts.earlyCheckInEntry++;
    if (record.boardedAtSeconds < passenger.securityClearedAtSeconds) counts.earlySecurityEntry++;
    if (manifest.boardingPolicy) {
      const observed = manifest.phase2.observations.filter(e => e.passengerId === passenger.id && e.timeSeconds <= record.boardedAtSeconds);
      if ([['CHECK_IN_CLEARED', 'CHECK_IN'], ['SECURITY_CLEARED', 'SECURITY_EXIT'], ['GATE_ARRIVED', manifest.phase2.assignedGateId]]
        .some(([type, checkpoint]) => !observed.some(e => e.type === type && e.checkpointId === checkpoint))) counts.observedReadinessViolation++;
      const confirmations = manifest.boardingPolicy.staffEvents.filter(e => e.passengerId === passenger.id && e.confirmed === true && e.timeSeconds <= record.boardedAtSeconds);
      if (!confirmations.some(e => e.kind === 'STAFF_APPROVAL')) counts.staffApprovalViolation++;
      const gateAt = observed.find(e => e.type === 'GATE_ARRIVED')?.timeSeconds;
      if (!confirmations.some(e => e.kind === 'GATE_VERIFICATION' && e.timeSeconds >= gateAt)) counts.gateVerificationViolation++;
    }
    const stage = unitByPassenger.get(passenger.id).stage;
    if (stage < previousStage || record.stage !== STAGE_NAMES[stage]) counts.priorityStageOrder++;
    previousStage = Math.max(previousStage, stage);
  }
  counts.missingPassenger = manifest.passengers.filter(p => !ids.has(p.id)).length;
  const preboardEnd = Math.max(0, ...timings.filter(r => r.stage === 'PREBOARD').map(r => r.seatedAtSeconds));
  counts.preboardingBarrier = timings.filter(r => r.stage !== 'PREBOARD' && r.boardedAtSeconds < preboardEnd).length;
  for (const unit of units) {
    const indexes = timings.map((record, index) => record.unitId === unit.id ? index : -1).filter(index => index >= 0);
    if (indexes.length !== unit.members.length || indexes.at(-1) - indexes[0] + 1 !== indexes.length) counts.splitTravelParty++;
    if (unit.assisted && indexes.length) {
      const members = indexes.map(index => timings[index]);
      const start = Math.min(...members.map(r => r.boardedAtSeconds));
      const end = Math.max(...members.map(r => r.seatedAtSeconds));
      counts.assistanceConflict += timings.filter(r => r.unitId !== unit.id && r.boardedAtSeconds < end && r.seatedAtSeconds > start).length;
    }
  }
  if (manifest.boardingPolicy) for (const family of manifest.boardingPolicy.families) {
    const members = timings.filter(r => family.memberIds.includes(r.passengerId));
    if (members.length !== family.memberIds.length || new Set(members.map(r => r.unitId)).size !== 1) counts.familySeparation++;
  }
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
}
