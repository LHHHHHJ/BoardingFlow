import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STRATEGIES } from './strategies.js';

export async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read JSON '${path}': ${error.message}`);
  }
}

export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function csv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const escape = value => {
    const string = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  };
  return [columns.map(escape).join(','), ...rows.map(row => columns.map(key => escape(row[key])).join(','))].join('\n') + '\n';
}

export function passengerRows(manifest) {
  const absolute = seconds => new Date(Date.parse(manifest.flight.boardingOpenTime) + seconds * 1000).toISOString();
  return manifest.passengers.map(passenger => ({
    dataKind: manifest.dataKind,
    passengerId: passenger.id,
    flightId: passenger.flightId,
    seatNumber: passenger.seatNumber,
    travelClass: passenger.travelClass ?? null,
    boardingZone: passenger.boardingZone,
    priorityEligible: passenger.priorityEligible,
    mandatoryPreboarding: passenger.mandatoryPreboarding,
    allowanceOverheadPieces: passenger.carryOnAllowance.overheadPieces,
    allowancePersonalItems: passenger.carryOnAllowance.personalItems,
    allowanceMaxOverheadWeightKg: passenger.carryOnAllowance.maxOverheadWeightKg,
    actualOverheadPieces: passenger.actualBaggage.overheadPieces,
    actualPersonalItems: passenger.actualBaggage.personalItems,
    actualOverheadWeightKg: passenger.actualBaggage.overheadWeightKg,
    checkInStatus: passenger.checkInStatus,
    checkInAtSeconds: passenger.checkInAtSeconds,
    checkInAtUTC: absolute(passenger.checkInAtSeconds),
    securityStatus: passenger.securityStatus,
    securityClearedAtSeconds: passenger.securityClearedAtSeconds,
    securityClearedAtUTC: absolute(passenger.securityClearedAtSeconds),
    gateArrivalSeconds: passenger.gateArrivalSeconds,
    estimatedGateArrivalUTC: absolute(passenger.gateArrivalSeconds),
    travelPartyId: passenger.travelPartyId,
    assistanceType: passenger.assistance.type,
    companionId: passenger.assistance.companionId,
    walkSecondsPerRow: passenger.behavior.walkSecondsPerRow,
    stowSecondsPerBag: passenger.behavior.stowSecondsPerBag,
    seatSeconds: passenger.behavior.seatSeconds
  }));
}

export const duration = seconds => {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
};

export function resultTable(results) {
  const columns = ['Strategy', 'Boarding m:ss', 'Mean gate wait min', 'Aisle block person-min', 'Seat interference s'];
  const rows = results.map(result => [
    result.strategy,
    duration(result.metrics.totalBoardingSeconds),
    (result.metrics.meanGateWaitSeconds / 60).toFixed(2),
    (result.metrics.aisleBlockingPersonSeconds / 60).toFixed(2),
    result.metrics.seatInterferencePersonSeconds.toFixed(1)
  ]);
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map(row => row[index].length)));
  const format = row => row.map((value, index) => value.padEnd(widths[index])).join('  ');
  return [format(columns), ...rows.map(format)].join('\n');
}

export async function writeArtifacts(directory, manifest, results) {
  await mkdir(directory, { recursive: true });
  // Clear only known generated artifacts that would otherwise describe an old run.
  for (const strategy of STRATEGIES) {
    const result = results.find(item => item.strategy === strategy);
    if (!result) {
      await rm(join(directory, `timings-${strategy}.json`), { force: true });
      await rm(join(directory, `timings-${strategy}.csv`), { force: true });
    }
    if (!result?.events) await rm(join(directory, `events-${strategy}.json`), { force: true });
  }
  await writeJSON(join(directory, 'manifest.json'), manifest);
  await writeFile(join(directory, 'passengers.csv'), csv(passengerRows(manifest)), 'utf8');
  const comparison = {
    schemaVersion: 1,
    dataKind: 'SYNTHETIC',
    seed: manifest.seed,
    flightId: manifest.flight.flightId,
    inputHash: results[0]?.inputHash,
    metricNotes: {
      totalBoardingSeconds: 'Elapsed from boarding opening (t=0) until last seating; includes idle periods.',
      meanGateWaitSeconds: 'Mean entry time minus estimated gate arrival, including time before boarding opens.',
      aisleBlockingPersonSeconds: 'Sum of time ready-to-walk passengers wait for an occupied next cell; excludes their own row service.',
      gateEntranceBlockedSeconds: 'Elapsed time a ready gate admission waits because entrance cell 0 is occupied.'
    },
    results: results.map(({ strategy, inputHash, metrics, validation }) => ({ strategy, inputHash, metrics, validation }))
  };
  await writeJSON(join(directory, 'comparison.json'), comparison);
  await writeFile(join(directory, 'comparison.csv'), csv(results.map(result => ({ strategy: result.strategy, inputHash: result.inputHash, ...result.metrics }))), 'utf8');
  for (const result of results) {
    const { events, ...timingResult } = result;
    await writeJSON(join(directory, `timings-${result.strategy}.json`), timingResult);
    await writeFile(join(directory, `timings-${result.strategy}.csv`), csv(result.passengerTimings), 'utf8');
    if (events) await writeJSON(join(directory, `events-${result.strategy}.json`), {
      dataKind: 'SYNTHETIC', strategy: result.strategy, inputHash: result.inputHash, events
    });
  }
  await writeFile(join(directory, 'report.txt'), [
    `BoardingFlow | SYNTHETIC | seed ${manifest.seed} | ${manifest.passengers.length} passengers`,
    `Input SHA-256: ${comparison.inputHash}`,
    '',
    resultTable(results),
    '',
    'All result invariant audits passed. See comparison.json for metric definitions.',
    'These are uncalibrated synthetic simulation results, not operational forecasts.',
    ''
  ].join('\n'), 'utf8');
}
