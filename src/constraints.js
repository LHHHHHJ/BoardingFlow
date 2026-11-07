import { STAGE_NAMES } from './model.js';
import { boardingUnits } from './strategies.js';

// Post-run evaluation. Actual timestamps belong here, never in policy inputs.
export function constraintReport(manifest, result) {
  const counts = {
    earlyGateEntry: 0, earlyCheckInEntry: 0, earlySecurityEntry: 0,
    duplicatePassenger: 0, duplicateSeat: 0, wrongSeat: 0, missingPassenger: 0,
    priorityStageOrder: 0, preboardingBarrier: 0, splitTravelParty: 0, assistanceConflict: 0
  };
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
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
}
