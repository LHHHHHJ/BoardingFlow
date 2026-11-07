import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { compareBaselines } from './compare.js';
import { generateFlight } from './generate.js';
import { manifestHash } from './model.js';
import { STRATEGIES } from './strategies.js';
import { csv, writeArtifacts, writeJSON } from './io.js';

// Fixed before measuring outcomes. These are synthetic Phase 1 arrival stress
// cases, not the separate Phase 2 terminal/security scenarios.
export const BASELINE_SEEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 42];
export const BASELINE_CASES = {
  normal: {},
  'all-at-gate': { lateArrivalProbability: 0, earlyArrivalMinSeconds: -60, earlyArrivalMaxSeconds: -60 },
  'late-arrivals': { lateArrivalProbability: 0.25, lateArrivalMinSeconds: 120, lateArrivalMaxSeconds: 1200 }
};
export const REPORT_METRICS = ['totalBoardingSeconds', 'meanGateWaitSeconds', 'aisleBlockingPersonMinutes', 'constraintViolationCount'];

export function sampleSummary(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error('Statistics require finite, nonempty samples');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { count: values.length, mean,
    sampleSD: values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null,
    min: Math.min(...values), max: Math.max(...values) };
}

export function scenarioFingerprints(manifest) {
  const passengers = [...manifest.passengers].sort((a, b) => a.id.localeCompare(b.id));
  return {
    inputHash: manifestHash(manifest),
    passengerProfileHash: manifestHash(passengers.map(({ gateArrivalSeconds, checkInAtSeconds, securityClearedAtSeconds, ...profile }) => profile)),
    actualArrivalHash: manifestHash(passengers.map(p => ({ id: p.id, gateArrivalSeconds: p.gateArrivalSeconds,
      checkInStatus: p.checkInStatus, checkInAtSeconds: p.checkInAtSeconds,
      securityStatus: p.securityStatus, securityClearedAtSeconds: p.securityClearedAtSeconds }))),
    simulatorAssumptionsHash: manifestHash({ aircraft: manifest.config.aircraft, simulation: manifest.config.simulation })
  };
}

function validateSelection(seeds, cases) {
  if (!Array.isArray(seeds) || !seeds.length || seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFFFFFF)
      || new Set(seeds).size !== seeds.length) throw new Error('seeds must be a nonempty list of distinct uint32 integers');
  if (!Array.isArray(cases) || !cases.length || cases.some(name => !Object.hasOwn(BASELINE_CASES, name))
      || new Set(cases).size !== cases.length) throw new Error(`cases must be distinct names from ${Object.keys(BASELINE_CASES).join(', ')}`);
}

export function summarizeExperiments(experiments) {
  const cases = [...new Set(experiments.map(run => run.scenario))];
  return cases.map(scenario => {
    const runs = experiments.filter(run => run.scenario === scenario);
    const strategies = STRATEGIES.map(strategy => ({ strategy,
      metrics: Object.fromEntries(REPORT_METRICS.map(metric => [metric,
        sampleSummary(runs.map(run => run.results.find(result => result.strategy === strategy).metrics[metric]))])) }));
    const paired = STRATEGIES.slice(1).map(strategy => {
      const deltas = runs.map(run => ({ seed: run.seed,
        deltaSeconds: run.results.find(result => result.strategy === strategy).metrics.totalBoardingSeconds
          - run.results.find(result => result.strategy === 'random').metrics.totalBoardingSeconds }));
      return { strategy, reference: 'random', deltaDefinition: 'strategy minus random; positive is slower',
        wins: deltas.filter(row => row.deltaSeconds < 0).length, ties: deltas.filter(row => row.deltaSeconds === 0).length,
        losses: deltas.filter(row => row.deltaSeconds > 0).length,
        completionDeltaSeconds: sampleSummary(deltas.map(row => row.deltaSeconds)), deltas };
    });
    return { scenario, strategies, paired };
  });
}

export function runBaselineBenchmark({ seeds = BASELINE_SEEDS, cases = Object.keys(BASELINE_CASES), config = {} } = {}) {
  validateSelection(seeds, cases);
  const experiments = [];
  const artifacts = [];
  const profiles = new Map();
  let assumptions;
  for (const scenario of cases) {
    for (const seed of seeds) {
      const manifest = generateFlight(seed, { ...config, generation: { ...config.generation, ...BASELINE_CASES[scenario] } });
      const fingerprints = scenarioFingerprints(manifest);
      const comparison = compareBaselines(manifest);
      if ((profiles.has(seed) && profiles.get(seed) !== fingerprints.passengerProfileHash)
          || (assumptions && assumptions !== fingerprints.simulatorAssumptionsHash)) throw new Error('Cross-scenario passenger profiles or simulator assumptions changed');
      profiles.set(seed, fingerprints.passengerProfileHash);
      assumptions = fingerprints.simulatorAssumptionsHash;
      for (const result of comparison.results) {
        if (result.inputHash !== fingerprints.inputHash || !result.validation.passed || result.constraintViolations.total !== 0
            || result.metrics.constraintViolationCount !== 0) throw new Error(`Invalid baseline run: ${scenario}/${seed}/${result.strategy}`);
      }
      experiments.push({ scenario, seed, passengerCount: manifest.passengers.length, ...fingerprints,
        results: comparison.results.map(({ strategy, inputHash, metrics, validation, constraintViolations }) => ({ strategy, inputHash, metrics, validation, constraintViolations })) });
      artifacts.push({ scenario, seed, manifest, results: comparison.results });
    }
  }
  const report = { schemaVersion: 1, dataKind: 'SYNTHETIC', comparisonType: 'STAGE3_BASELINES',
    seeds: [...seeds], cases: [...cases], strategies: [...STRATEGIES],
    caseGenerationOverrides: Object.fromEntries(cases.map(name => [name, BASELINE_CASES[name]])),
    scenarioConfigs: Object.fromEntries(cases.map(name => [name, artifacts.find(run => run.scenario === name).manifest.config])),
    notes: [
      'Generate once per case/seed; freeze and reuse the same full manifest for all three strategies. No adaptive runs.',
      'Across cases for a given seed, passenger profiles stay fixed; only arrival/clearance timelines and their generation settings change.',
      'Across seeds, both passenger composition and the boarding lottery change. SD is sample SD across these synthetic flights, not an operational confidence interval.',
      'Gate wait includes time before opening. Aisle blocking is summed passenger-minutes; these are not additive elapsed-time components.',
      'Baggage-aware Phase 1 ranks sampled stow work as known synthetic input, an idealized information assumption.',
      'No failed runs are dropped. No airport distances, measured performance or optimality claims.'
    ], experiments, summaries: summarizeExperiments(experiments) };
  return { report, artifacts };
}

const fixed = value => value === null ? 'n/a' : value.toFixed(2);
export function baselineReportMarkdown(report) {
  const lines = ['# Stage 3 synthetic baseline comparison', '',
    `Seeds: ${report.seeds.join(', ')}. ${report.experiments.length} identical-input comparisons; ${report.experiments.length * 3} simulation runs.`, '',
    ...report.notes.map(note => `- ${note}`), '',
    'Times below are seconds; blocking is passenger-minutes. Entries show mean ± sample SD [min, max].', '',
    '| Case | Strategy | Completion | Mean gate wait | Aisle blocking | Violations (sum) |',
    '| --- | --- | --- | --- | --- | --- |'];
  const cell = stat => `${fixed(stat.mean)} ± ${fixed(stat.sampleSD)} [${fixed(stat.min)}, ${fixed(stat.max)}]`;
  for (const summary of report.summaries) {
    for (const row of summary.strategies) {
      const m = row.metrics;
      lines.push(`| ${summary.scenario} | ${row.strategy} | ${cell(m.totalBoardingSeconds)} | ${cell(m.meanGateWaitSeconds)} | ${cell(m.aisleBlockingPersonMinutes)} | ${m.constraintViolationCount.mean * m.constraintViolationCount.count} |`);
    }
  }
  lines.push('', 'Paired completion comparisons against random (positive delta is slower):', '',
    '| Case | Strategy | Wins/ties/losses | Mean delta (s) | Slower seeds (delta s) |', '| --- | --- | --- | --- | --- |');
  for (const summary of report.summaries) for (const row of summary.paired) {
    lines.push(`| ${summary.scenario} | ${row.strategy} | ${row.wins}/${row.ties}/${row.losses} | ${fixed(row.completionDeltaSeconds.mean)} | ${row.deltas.filter(d => d.deltaSeconds > 0).map(d => `${d.seed} (+${d.deltaSeconds})`).join(', ') || 'none'} |`);
  }
  lines.push('', 'Every individual run (unrounded metrics and fingerprints are in benchmark.json / runs.csv):', '',
    '| Case | Seed | Strategy | Completion (s) | Mean gate wait (s) | Blocking (person-min) | Violations |',
    '| --- | --- | --- | --- | --- | --- | --- |');
  for (const run of report.experiments) for (const result of run.results) {
    const m = result.metrics;
    lines.push(`| ${run.scenario} | ${run.seed} | ${result.strategy} | ${m.totalBoardingSeconds} | ${fixed(m.meanGateWaitSeconds)} | ${fixed(m.aisleBlockingPersonMinutes)} | ${m.constraintViolationCount} |`);
  }
  return `${lines.join('\n')}\n`;
}

export async function writeBaselineBenchmark(directory, { report, artifacts }) {
  // Known filenames only; do not remove existing user outputs.
  for (const run of artifacts) await writeArtifacts(resolve(directory, run.scenario, `seed-${run.seed}`), run.manifest, run.results);
  await writeJSON(resolve(directory, 'benchmark.json'), report);
  await writeFile(resolve(directory, 'runs.csv'), csv(report.experiments.flatMap(run => run.results.map(result => ({
    scenario: run.scenario, seed: run.seed, passengerCount: run.passengerCount,
    inputHash: run.inputHash, passengerProfileHash: run.passengerProfileHash,
    actualArrivalHash: run.actualArrivalHash, simulatorAssumptionsHash: run.simulatorAssumptionsHash,
    strategy: result.strategy, ...result.metrics
  })))), 'utf8');
  await writeFile(resolve(directory, 'report.md'), baselineReportMarkdown(report), 'utf8');
}
