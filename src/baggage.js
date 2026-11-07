export function auditCarryOn(passenger) {
  const allowance = passenger.carryOnAllowance;
  const actual = passenger.actualBaggage;
  if (!allowance || !actual) throw new Error('Carry-on allowance and actual baggage are required for audit');
  for (const item of [allowance, actual]) {
    for (const key of ['overheadPieces', 'personalItems']) {
      if (!Number.isSafeInteger(item[key]) || item[key] < 0) throw new Error(`Invalid carry-on count: ${key}`);
    }
  }
  for (const weight of [allowance.maxOverheadWeightKg, actual.overheadWeightKg]) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new Error('Invalid carry-on weight');
  }
  const excessOverheadPieces = Math.max(0, actual.overheadPieces - allowance.overheadPieces);
  const excessPersonalItems = Math.max(0, actual.personalItems - allowance.personalItems);
  const overweightKg = Math.round(Math.max(0, actual.overheadWeightKg - actual.overheadPieces * allowance.maxOverheadWeightKg) * 1e6) / 1e6;
  const violations = [];
  if (excessOverheadPieces) violations.push('EXCESS_OVERHEAD_PIECES');
  if (excessPersonalItems) violations.push('EXCESS_PERSONAL_ITEMS');
  // Compare without rounding so a small excess cannot silently pass validation.
  if (actual.overheadWeightKg > actual.overheadPieces * allowance.maxOverheadWeightKg) violations.push('OVERWEIGHT_OVERHEAD_BAGGAGE');
  return { passengerId: passenger.id, allowance: { ...allowance }, actual: { ...actual },
    compliant: violations.length === 0, excessOverheadPieces, excessPersonalItems, overweightKg, violations };
}
