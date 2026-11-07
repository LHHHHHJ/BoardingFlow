import { validateManifest } from './model.js';
import { auditCarryOn } from './baggage.js';
import { TRAVEL_CLASSES } from './config.js';

export function auditPassengerDataset(manifest) {
  // Inspection can report excess baggage; simulation validation still rejects it.
  const validation = validateManifest(manifest, { allowNoncompliantBaggage: true });
  const passengers = manifest.passengers;
  const baggageRows = passengers.map(auditCarryOn);
  const parties = new Map();
  for (const passenger of passengers) {
    if (passenger.travelPartyId !== null) parties.set(passenger.travelPartyId, (parties.get(passenger.travelPartyId) ?? 0) + 1);
  }
  const partySizeCounts = {};
  for (const size of parties.values()) partySizeCounts[size] = (partySizeCounts[size] ?? 0) + 1;
  const unknownClassCount = passengers.filter(p => !TRAVEL_CLASSES.includes(p.travelClass)).length;
  const noncompliant = baggageRows.filter(row => !row.compliant);
  const sum = key => baggageRows.reduce((total, row) => total + row[key], 0);
  const standardGeometry = manifest.config.aircraft.rows === 30 && manifest.config.aircraft.seatLetters === 'ABCDEF';
  return {
    dataKind: 'SYNTHETIC', schemaVersion: manifest.schemaVersion, seed: manifest.seed, inputHash: validation.inputHash,
    stage1Complete: standardGeometry && passengers.length === 180 && unknownClassCount === 0 && noncompliant.length === 0,
    validation,
    geometry: { rows: manifest.config.aircraft.rows, seatsPerRow: 6, capacity: validation.capacity, stage1StandardGeometry: standardGeometry },
    passengerMix: {
      travelClasses: Object.fromEntries(TRAVEL_CLASSES.map(name => [name, passengers.filter(p => p.travelClass === name).length])),
      unknownClassCount,
      boardingZones: Object.fromEntries([1, 2, 3].map(zone => [zone, passengers.filter(p => p.boardingZone === zone).length])),
      priorityEligibleCount: passengers.filter(p => p.priorityEligible).length,
      mandatoryPreboardingCount: passengers.filter(p => p.mandatoryPreboarding).length,
      assistance: Object.fromEntries(['NONE', 'MOBILITY', 'EXTRA_TIME'].map(type => [type, passengers.filter(p => p.assistance.type === type).length]))
    },
    travelParties: { partyCount: parties.size, soloPassengerCount: passengers.filter(p => p.travelPartyId === null).length, partySizeCounts },
    carryOn: {
      compliantPassengers: baggageRows.length - noncompliant.length, noncompliantPassengers: noncompliant.length,
      allowedOverheadPieces: passengers.reduce((total, p) => total + p.carryOnAllowance.overheadPieces, 0),
      actualOverheadPieces: passengers.reduce((total, p) => total + p.actualBaggage.overheadPieces, 0),
      allowedPersonalItems: passengers.reduce((total, p) => total + p.carryOnAllowance.personalItems, 0),
      actualPersonalItems: passengers.reduce((total, p) => total + p.actualBaggage.personalItems, 0),
      excessOverheadPieces: sum('excessOverheadPieces'), excessPersonalItems: sum('excessPersonalItems'),
      overweightKg: Math.round(sum('overweightKg') * 1e6) / 1e6,
      passengers: baggageRows
    },
    notes: unknownClassCount ? ['Legacy schema 1: missing class is reported as unknown, never inferred from seat, zone, priority or assistance.'] : []
  };
}
