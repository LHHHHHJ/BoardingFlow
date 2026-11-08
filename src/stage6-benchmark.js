import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { generateScenario, validateScenario, SCENARIOS } from './scenarios.js';
import { withBoardingPolicy } from './policy-scenario.js';
import { simulate } from './simulate.js';
import { deepFreeze, manifestHash } from './model.js';
import { STAGE6_STRATEGIES } from './strategies.js';
import { ADAPTIVE_VERSION, adaptiveV2Settings } from './adaptive-v2.js';
import { BASELINE_SEEDS, sampleSummary } from './baseline-benchmark.js';
import { readJSON, writeJSON, writeArtifacts, csv } from './io.js';

export const STAGE6_METRICS = ['totalBoardingSeconds', 'meanGateWaitSeconds', 'aisleBlockingPersonMinutes',
  'seatInterferencePersonSeconds', 'seatInterferenceCount', 'constraintViolationCount'];

export async function stage6Scenario(seed, scenario, generation = {}, policyConfiguration = null) {
  const flight = generateScenario(seed, scenario, generation);
  const rules = policyConfiguration ?? JSON.parse(await readFile(new URL('../config/stage5.example.json', import.meta.url), 'utf8'));
  // Explicit synthetic experiment assumption: all requested operational
  // arrangements are staff-confirmed before travel. This is fixture preparation,
  // never a controller inference. Supplied policy configurations are respected.
  const settings = policyConfiguration ? rules : { ...rules,
    confirmedAssistancePassengerIds: flight.passengers.filter(p => p.assistance.type !== 'NONE').map(p => p.id) };
  return withBoardingPolicy(flight, settings);
}

export function controllerDiagnostics(result) {
  const stages = {};
  for (const p of result.passengerTimings) {
    const stage = stages[p.stage] ??= { passengerCount: 0, firstEntrySeconds: p.boardedAtSeconds,
      lastEntrySeconds: 0, lastSeatedSeconds: 0, blockingPersonSeconds: 0, interferencePersonSeconds: 0 };
    stage.passengerCount++; stage.lastEntrySeconds = Math.max(stage.lastEntrySeconds, p.boardedAtSeconds);
    stage.lastSeatedSeconds = Math.max(stage.lastSeatedSeconds, p.seatedAtSeconds);
    stage.blockingPersonSeconds += p.aisleBlockingSeconds; stage.interferencePersonSeconds += p.seatInterferenceSeconds;
  }
  const reasons = {};
  const recommendations = result.recommendations ?? [];
  recommendations.forEach((r, index) => {
    const row = reasons[r.reason] ??= { count: 0, waitReviewSpanSeconds: 0 };
    row.count++;
    if (r.action === 'WAIT') row.waitReviewSpanSeconds += (recommendations[index + 1]?.timeSeconds ?? r.timeSeconds) - r.timeSeconds;
  });
  return { stages, reasons,
    lastEntryToCompletionSeconds: result.metrics.totalBoardingSeconds - Math.max(0, ...result.passengerTimings.map(p => p.boardedAtSeconds)),
    policyHoldCounts: (result.policyAdvisories ?? []).filter(r => !r.simulationAdmissionAllowed)
      .reduce((o, r) => ({ ...o, [r.reason]: (o[r.reason] ?? 0) + 1 }), {}),
    note: 'WAIT review spans are diagnostic sampling intervals. ALL_STAGE_UNITS_CALLED is cabin drain, not a gate anticipation hold.' };
}

export function summarizeStage6(experiments) {
  return [...new Set(experiments.map(e => e.scenario))].map(scenario => {
    const runs = experiments.filter(e => e.scenario === scenario);
    const strategies = STAGE6_STRATEGIES.map(strategy => ({ strategy,
      metrics: Object.fromEntries(STAGE6_METRICS.map(key => [key, sampleSummary(runs.map(e => e.results.find(r => r.strategy === strategy).metrics[key]))])) }));
    const paired = ['adaptive', 'wilma'].flatMap(strategy => STAGE6_STRATEGIES.filter(reference => reference !== strategy).map(reference => {
      const deltas = runs.map(e => { const a = e.results.find(r => r.strategy === strategy).metrics, b = e.results.find(r => r.strategy === reference).metrics;
        return { seed: e.seed, completionSeconds: a.totalBoardingSeconds - b.totalBoardingSeconds,
          meanGateWaitSeconds: a.meanGateWaitSeconds - b.meanGateWaitSeconds,
          blockingPersonMinutes: a.aisleBlockingPersonMinutes - b.aisleBlockingPersonMinutes }; });
      return { strategy, reference, wins: deltas.filter(d => d.completionSeconds < 0).length,
        ties: deltas.filter(d => d.completionSeconds === 0).length, losses: deltas.filter(d => d.completionSeconds > 0).length,
        completionDelta: sampleSummary(deltas.map(d => d.completionSeconds)), deltas };
    }));
    const beforeAfter = runs.map(e => ({ seed: e.seed, beforeSeconds: e.beforeAdaptive.metrics.totalBoardingSeconds,
      afterSeconds: e.results.find(r => r.strategy === 'adaptive').metrics.totalBoardingSeconds }));
    return { scenario, strategies, paired, beforeAfter,
      adaptiveChangeSeconds: sampleSummary(beforeAfter.map(d => d.afterSeconds - d.beforeSeconds)) };
  });
}

export async function runStage6Benchmark({ seeds = BASELINE_SEEDS, cases = SCENARIOS, generation = {},
  policyConfiguration = null, adaptiveSettings = {}, beforeDirectory = null, trace = false, output = null } = {}) {
  if (!Array.isArray(seeds) || !seeds.length || new Set(seeds).size !== seeds.length
      || seeds.some(s => !Number.isSafeInteger(s) || s < 0 || s > 0xFFFFFFFF)) throw new Error('Stage 6 seeds must be distinct uint32 integers');
  if (!Array.isArray(cases) || !cases.length || new Set(cases).size !== cases.length || cases.some(s => !SCENARIOS.includes(s))) throw new Error('Unknown/duplicate Stage 6 scenario');
  if (beforeDirectory && (policyConfiguration || Object.keys(generation).length)) throw new Error('Frozen before-directory inputs cannot be combined with generation/policy overrides');
  if (beforeDirectory && output) {
    const between = relative(resolve(beforeDirectory), resolve(output));
    if (!between || (!between.startsWith('..') && !isAbsolute(between))) throw new Error('Output must not overwrite or enter the immutable before snapshot');
  }
  const settings = adaptiveV2Settings(adaptiveSettings);
  const frozenBefore = beforeDirectory ? await readJSON(resolve(beforeDirectory, 'comparison.json')) : null;
  const experiments = [];
  const profiles = new Map();
  let physicsHash;
  for (const scenario of cases) for (const seed of seeds) {
    const manifest = beforeDirectory ? await readJSON(resolve(beforeDirectory, scenario, `seed-${seed}`, 'manifest.json'))
      : await stage6Scenario(seed, scenario, generation, policyConfiguration);
    validateScenario(manifest);
    if (manifest.seed !== seed || manifest.phase2.scenarioName !== scenario) throw new Error('Frozen scenario identity does not match requested seed/case');
    if (!manifest.boardingPolicy) throw new Error('Stage 6 comparison requires an explicit policy');
    deepFreeze(manifest);
    const inputHash = manifestHash(manifest);
    const passengerProfileHash = manifestHash(manifest.passengers.map(({ gateArrivalSeconds, checkInAtSeconds, securityScanAtSeconds, securityClearedAtSeconds, ...p }) => p));
    const simulatorHash = manifestHash({ aircraft: manifest.config.aircraft, simulation: manifest.config.simulation });
    if (profiles.has(seed) && profiles.get(seed) !== passengerProfileHash) throw new Error('Cross-scenario passenger profile changed');
    if (physicsHash && physicsHash !== simulatorHash) throw new Error('Cross-scenario physics changed');
    profiles.set(seed, passengerProfileHash); physicsHash = simulatorHash;
    const before = simulate(manifest, 'adaptive', { adaptiveVersion: 'legacy-v1' });
    const previous = frozenBefore?.experiments.find(e => e.scenario === scenario && e.seed === seed);
    if (frozenBefore && (!previous || previous.inputHash !== inputHash
      || manifestHash(previous.results.find(r => r.strategy === 'adaptive').metrics) !== manifestHash(before.metrics))) throw new Error('Preserved before-change result does not reproduce');
    const results = STAGE6_STRATEGIES.map(strategy => simulate(manifest, strategy, { trace,
      adaptiveVersion: ADAPTIVE_VERSION, adaptiveSettings: settings }));
    for (const r of results) {
      if (r.inputHash !== inputHash || !r.validation.passed || r.metrics.constraintViolationCount || r.constraintViolations.total) throw new Error(`Invalid/unfair Stage 6 result: ${scenario}/${seed}/${r.strategy}`);
      if (previous && ['random', 'zone', 'baggage-aware'].includes(r.strategy)
          && manifestHash(r.metrics) !== manifestHash(previous.results.find(p => p.strategy === r.strategy).metrics)) throw new Error('Historical baseline changed during optimization');
    }
    if (manifestHash(manifest) !== inputHash) throw new Error('Stage 6 manifest mutated');
    const current = results.find(r => r.strategy === 'adaptive');
    experiments.push({ scenario, seed, passengerCount: manifest.passengers.length, inputHash, passengerProfileHash, simulatorHash,
      actualScenarioHash: manifestHash({ actualTimes: manifest.passengers.map(p => ({ id: p.id, gate: p.gateArrivalSeconds,
        checkIn: p.checkInAtSeconds, securityScan: p.securityScanAtSeconds, securityCleared: p.securityClearedAtSeconds })),
        observations: manifest.phase2.observations, truth: manifest.phase2.truth }),
      policyHash: manifestHash(manifest.boardingPolicy),
      beforeAdaptive: { metrics: before.metrics, diagnostics: controllerDiagnostics(before) },
      results: results.map(({ strategy, inputHash, metrics, validation, constraintViolations }) => ({ strategy, inputHash, metrics, validation, constraintViolations })),
      adaptiveDiagnostics: controllerDiagnostics(current) });
    if (output) {
      const directory = resolve(output, scenario, `seed-${seed}`);
      await writeArtifacts(directory, manifest, results);
      await writeJSON(resolve(directory, 'before-adaptive.json'), before);
    }
  }
  const report = { schemaVersion: 1, dataKind: 'SYNTHETIC', comparisonType: 'STAGE6_POLICY_ENABLED',
    seeds: [...seeds], cases: [...cases], strategies: STAGE6_STRATEGIES, adaptiveVersion: ADAPTIVE_VERSION,
    adaptiveSettings: settings, beforeVersion: 'legacy-v1', preservedBeforeSnapshotVerified: !!frozenBefore,
    runtimeSourceHashes: Object.fromEntries(await Promise.all(['simulate.js', 'adaptive.js', 'adaptive-v2.js', 'strategies.js',
      'model.js', 'constraints.js', 'policy.js', 'readiness.js', 'scenarios.js', 'phase2-config.js'].map(async name => [
      `src/${name}`, createHash('sha256').update(await readFile(new URL(`./${name}`, import.meta.url))).digest('hex')]))),
    notes: [
      'Same frozen passenger, actual journey, baggage, policy/staff tape and aircraft input across all five strategies per case/seed.',
      'Default synthetic fixtures explicitly confirm all requested assistance; First/elite/family arrangements are inherited from the Stage 5 example. These are invented confirmed facts, not demographic inferences.',
      'Paired deltas are subject minus reference; positive means worse. No failed or losing run is removed.',
      'Standard deviation is sample SD across 11 synthetic passenger scenarios/lotteries, not a calibrated operational confidence interval.',
      'Gate wait includes pre-opening wait; blocking is passenger-minutes. Seat interference is passenger-seconds.',
      'Expected-delay scores and ETA uncertainty are analytical heuristics. Hidden actual arrivals, service times and unobserved locations are excluded.',
      'Legacy-policy Stage 3 experiments and policy-enabled Stage 6 experiments have different inputs and must be reported separately.',
      'All recommendations and staff approvals are synthetic/advisory. Distances are invented, not Toronto Pearson measurements.'
    ], experiments, summaries: summarizeStage6(experiments) };
  if (output) {
    await writeJSON(resolve(output, 'comparison.json'), report);
    await writeFile(resolve(output, 'runs.csv'), csv(experiments.flatMap(e => e.results.map(r => ({ scenario: e.scenario, seed: e.seed,
      inputHash: e.inputHash, actualScenarioHash: e.actualScenarioHash, policyHash: e.policyHash, simulatorHash: e.simulatorHash,
      strategy: r.strategy, ...r.metrics })))), 'utf8');
    await writeFile(resolve(output, 'report.md'), stage6ReportMarkdown(report), 'utf8');
  }
  return report;
}

const fixed = x => x === null ? 'n/a' : x.toFixed(2);
export function stage6ReportMarkdown(report) {
  const lines = ['# Stage 6 policy-enabled five-strategy results', '',
    `Seeds: ${report.seeds.join(', ')}. ${report.experiments.length} frozen scenarios, ${report.experiments.length * 5} strategy runs and ${report.experiments.length} paired legacy Adaptive replays.`, '',
    ...report.notes.map(n => `- ${n}`), '',
    'Mean ± sample SD [min, max]; completion/gate wait/interference in seconds, blocking in passenger-minutes.', '',
    '| Scenario | Strategy | Completion | Mean gate wait | Blocking | Seat interference | Violations (sum) |',
    '| --- | --- | --- | --- | --- | --- | --- |'];
  const cell = s => `${fixed(s.mean)} ± ${fixed(s.sampleSD)} [${fixed(s.min)}, ${fixed(s.max)}]`;
  for (const s of report.summaries) for (const r of s.strategies) { const m = r.metrics;
    lines.push(`| ${s.scenario} | ${r.strategy} | ${cell(m.totalBoardingSeconds)} | ${cell(m.meanGateWaitSeconds)} | ${cell(m.aisleBlockingPersonMinutes)} | ${cell(m.seatInterferencePersonSeconds)} | ${m.constraintViolationCount.mean * m.constraintViolationCount.count} |`);
  }
  lines.push('', 'Paired completion wins/ties/losses, with every losing seed:', '',
    '| Scenario | Subject | Reference | W/T/L | Mean delta (s) | Losing seeds (delta s) |', '| --- | --- | --- | --- | --- | --- |');
  for (const s of report.summaries) for (const p of s.paired) lines.push(`| ${s.scenario} | ${p.strategy} | ${p.reference} | ${p.wins}/${p.ties}/${p.losses} | ${fixed(p.completionDelta.mean)} | ${p.deltas.filter(d => d.completionSeconds > 0).map(d => `${d.seed} (+${d.completionSeconds})`).join(', ') || 'none'} |`);
  lines.push('', 'Adaptive before/after on identical inputs:', '', '| Scenario | Seed | Before (s) | After (s) | Delta (s) |', '| --- | --- | --- | --- | --- |');
  for (const s of report.summaries) for (const r of s.beforeAfter) lines.push(`| ${s.scenario} | ${r.seed} | ${r.beforeSeconds} | ${r.afterSeconds} | ${r.afterSeconds - r.beforeSeconds} |`);
  lines.push('', 'Every individual strategy result (unrounded JSON/CSV retained):', '',
    '| Scenario | Seed | Strategy | Completion (s) | Mean wait (s) | Blocking (person-min) | Interference (s) | Violations |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of report.experiments) for (const r of e.results) { const m = r.metrics;
    lines.push(`| ${e.scenario} | ${e.seed} | ${r.strategy} | ${m.totalBoardingSeconds} | ${fixed(m.meanGateWaitSeconds)} | ${fixed(m.aisleBlockingPersonMinutes)} | ${m.seatInterferencePersonSeconds} | ${m.constraintViolationCount} |`);
  }
  return lines.join('\n') + '\n';
}
