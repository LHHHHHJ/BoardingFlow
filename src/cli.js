#!/usr/bin/env node
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { compareStrategies } from './compare.js';
import { generateFlight } from './generate.js';
import { deepFreeze, validateManifest } from './model.js';
import { csv, readJSON, resultTable, writeArtifacts, writeJSON } from './io.js';
import { simulate } from './simulate.js';
import { generateScenario, validateScenario } from './scenarios.js';
import { createReadinessObserver, evaluateGateETA } from './readiness.js';
import { auditTerminal } from './terminal.js';
import { withBoardingPolicy } from './policy-scenario.js';
import { createPolicyObserver, reviewBoardingRecommendation } from './policy.js';
import { orderUnits } from './strategies.js';
import { auditPassengerDataset } from './dataset-audit.js';
import { validateSimulationTrace } from './trace.js';
import { runBaselineBenchmark, writeBaselineBenchmark } from './baseline-benchmark.js';

const HELP = `BoardingFlow - independent SYNTHETIC boarding simulation (Node.js >=22)

Run from the BoardingFlow folder. No install step or external packages required.

  node src/cli.js generate --seed 42 --output data/synthetic-flight.json
  node src/cli.js validate --input data/synthetic-flight.json
  node src/cli.js audit-dataset --input data/synthetic-flight.json --output results/stage1/dataset-audit.json
  node src/cli.js simulate --input data/synthetic-flight.json --strategy random --output results/random --trace
  node src/cli.js validate-trace --input results/random/manifest.json --trace-file results/random/events-random.json
  node src/cli.js compare --input data/synthetic-flight.json --output results --trace
  node src/cli.js demo --seed 42 --output results --trace
  node src/cli.js baselines --seeds 0,1,2,3,4,5,6,7,8,9,42 --output results/stage3

  node src/cli.js generate --scenario normal --seed 42 --output data/normal.json
  node src/cli.js readiness --input data/normal.json --at 0 --output results/readiness.json
  node src/cli.js terminal-audit --input data/normal.json --output results/stage4/terminal-audit.json
  node src/cli.js eta-evaluate --input data/normal.json --times 0,300,600 --output results/stage4/normal

  node src/cli.js apply-policy --input data/normal.json --policy-config config/stage5.example.json --output data/stage5.json
  node src/cli.js policy-preview --input data/stage5.json --at 0 --strategy zone --output results/stage5/advisory.json

generate/demo: optional --config config/example.json (partial assumption overrides).
Stage 1 mix/group example: --config config/stage1.example.json.
audit-dataset: reports class/mix/group sizes and allowance vs actual carry-on;
  exits 1 if the 180-passenger Stage 1 checklist is incomplete, while saving the report.
generate: optional --scenario normal | security-delays | late-arrivals; --phase2-config config/stage4.example.json requires --scenario.
simulate: --strategy random | zone | baggage-aware (default random).
baselines: always random/zone/baggage-aware; synthetic Phase 1 arrival stress cases.
  Optional --seeds comma-separated uint32s, --cases normal,all-at-gate,late-arrivals,
  --config partial generation/simulator overrides; case arrival overrides take precedence.
readiness: --at seconds relative to boarding opening (default 0); no future truth in output.
terminal-audit: synthetic accessible routes to the assigned gate; no official airport measurements.
eta-evaluate: post-run forecast errors; optional --times comma-separated finite seconds.
  Writes eta-evaluation.json/.csv and eta-summary.csv into --output directory.
apply-policy: explicit Stage 5 profile; example staff events are SYNTHETIC confirmations only.
policy-preview: advisory with staff/gate checks; assumes no previous aircraft admissions.
simulate/compare: reuse the complete config and passenger behavior stored in the input.
--trace writes cell movement and row service events; --help prints this message.
node --test runs the automated checks.
`;

function parseArguments(argv) {
  if (!argv.length || argv.includes('--help')) return { help: true };
  const [command, ...flags] = argv;
  const allowed = {
    generate: ['seed', 'config', 'output', 'scenario', 'phase2-config'],
    validate: ['input'],
    'audit-dataset': ['input', 'output'],
    'validate-trace': ['input', 'trace-file', 'output'],
    simulate: ['input', 'strategy', 'output', 'trace'],
    compare: ['input', 'output', 'trace'],
    readiness: ['input', 'at', 'output'],
    'terminal-audit': ['input', 'output'],
    'eta-evaluate': ['input', 'times', 'output'],
    'apply-policy': ['input', 'policy-config', 'output'],
    'policy-preview': ['input', 'at', 'strategy', 'output'],
    baselines: ['seeds', 'cases', 'config', 'output'],
    demo: ['seed', 'config', 'output', 'trace']
  }[command];
  if (!allowed) throw new Error(`Unknown command '${command}'; use --help`);
  const options = {};
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    const key = flag.slice(2);
    if (!flag.startsWith('--') || !allowed.includes(key)) throw new Error(`Unknown option '${flag}' for ${command}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option '${flag}'`);
    if (key === 'trace') options[key] = true;
    else {
      const value = flags[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for '${flag}'`);
      options[key] = value;
    }
  }
  if (['validate', 'simulate', 'compare', 'audit-dataset', 'validate-trace', 'readiness', 'terminal-audit', 'eta-evaluate', 'apply-policy', 'policy-preview'].includes(command) && !options.input) throw new Error(`${command} requires --input`);
  if (command === 'apply-policy' && !options['policy-config']) throw new Error('apply-policy requires --policy-config');
  if (command === 'validate-trace' && !options['trace-file']) throw new Error('validate-trace requires --trace-file');
  if (options.seed !== undefined && !/^\d+$/.test(options.seed)) throw new Error('seed must be uint32');
  if (options['phase2-config'] && !options.scenario) throw new Error('--phase2-config requires --scenario');
  return { command, options };
}

async function main() {
  const { help, command, options } = parseArguments(process.argv.slice(2));
  if (help) { console.log(HELP); return; }
  if (command === 'baselines') {
    if (options.seeds !== undefined && !/^\d+(,\d+)*$/.test(options.seeds)) throw new Error('seeds must be comma-separated uint32 integers');
    const benchmark = runBaselineBenchmark({
      ...(options.seeds !== undefined ? { seeds: options.seeds.split(',').map(Number) } : {}),
      ...(options.cases !== undefined ? { cases: options.cases.split(',') } : {}),
      config: options.config ? await readJSON(options.config) : {}
    });
    const directory = resolve(options.output ?? 'results/stage3');
    await writeBaselineBenchmark(directory, benchmark);
    for (const summary of benchmark.report.summaries) {
      console.log(`${summary.scenario}: mean completion seconds (sample SD)`);
      for (const row of summary.strategies) {
        const stat = row.metrics.totalBoardingSeconds;
        console.log(`  ${row.strategy}: ${stat.mean.toFixed(2)} (${stat.sampleSD === null ? 'n/a' : stat.sampleSD.toFixed(2)})`);
      }
    }
    console.log(`PASS: ${benchmark.report.experiments.length * 3} runs; zero constraint violations. Full metrics, variability and paired losses: ${directory}/report.md`);
    return;
  }
  let manifest;
  if (command === 'generate' || command === 'demo') {
    const overrides = options.config ? await readJSON(options.config) : {};
    const settings = options['phase2-config'] ? await readJSON(options['phase2-config']) : {};
    manifest = options.scenario
      ? generateScenario(Number(options.seed ?? 42), options.scenario, overrides, settings)
      : generateFlight(Number(options.seed ?? 42), overrides);
  } else {
    manifest = await readJSON(options.input);
  }
  if (command === 'apply-policy') {
    manifest = withBoardingPolicy(manifest, await readJSON(options['policy-config']));
    const output = resolve(options.output ?? 'data/stage5.json');
    await writeJSON(output, manifest);
    console.log(`SYNTHETIC Stage 5 policy ${manifest.boardingPolicy.profileId}; staff events are simulated, not real approvals. Saved: ${output}`);
    return;
  }
  if (command === 'audit-dataset') {
    const report = auditPassengerDataset(manifest);
    const output = resolve(options.output ?? 'results/stage1/dataset-audit.json');
    await writeJSON(output, report);
    console.log(`Stage 1 dataset | SYNTHETIC | seed=${manifest.seed} | passengers=${report.validation.passengerCount}/${report.validation.capacity}`);
    console.log(`Input SHA-256: ${report.inputHash}`);
    console.log(`Travel classes: ${JSON.stringify(report.passengerMix.travelClasses)}; unknown=${report.passengerMix.unknownClassCount}`);
    console.log(`Parties: ${report.travelParties.partyCount}; solo passengers: ${report.travelParties.soloPassengerCount}; sizes: ${JSON.stringify(report.travelParties.partySizeCounts)}`);
    console.log(`Carry-on: ${report.carryOn.actualOverheadPieces}/${report.carryOn.allowedOverheadPieces} overhead pieces; ${report.carryOn.noncompliantPassengers} noncompliant passengers.`);
    console.log(`${report.stage1Complete ? 'PASS' : 'INCOMPLETE'}: Stage 1 dataset checklist. Report: ${output}`);
    for (const note of report.notes) console.log(note);
    if (!report.stage1Complete) process.exitCode = 1;
    return;
  }
  const validation = manifest.phase2 ? validateScenario(manifest) : validateManifest(manifest);
  console.log(`BoardingFlow | SYNTHETIC | seed=${manifest.seed} | passengers=${validation.passengerCount}/${validation.capacity}`);
  console.log(`Input SHA-256: ${validation.inputHash}`);
  if (command === 'policy-preview') {
    if (!manifest.boardingPolicy) throw new Error('policy-preview requires an explicit Stage 5 policy');
    const at = Number(options.at ?? 0);
    const strategy = options.strategy ?? 'zone';
    const units = orderUnits(manifest, strategy);
    const snapshot = createReadinessObserver(manifest).snapshot(at);
    const policySnapshot = createPolicyObserver(manifest.boardingPolicy, manifest.passengers).snapshot(at);
    const stage = Math.min(...units.map(u => u.stage));
    const advisory = reviewBoardingRecommendation(snapshot, { nowSeconds: at, stage, strategy,
      boardedPassengerIds: [], seatedPassengerIds: [], cabinOccupied: false,
      pendingUnits: units.map(u => ({ id: u.id, memberIds: u.members.map(p => p.id), stage: u.stage, zone: u.zone, assisted: u.assisted })) }, policySnapshot);
    const output = resolve(options.output ?? 'results/stage5/advisory.json');
    await writeJSON(output, advisory);
    console.log(`${advisory.action}: ${advisory.reason}. ADVISORY ONLY; requires staff approval and actual gate verification. Saved: ${output}`);
    return;
  }
  if (command === 'terminal-audit') {
    if (!manifest.phase2) throw new Error('Terminal audit requires a Phase 2 scenario');
    const report = auditTerminal(manifest.phase2.terminal, manifest.phase2.assignedGateId);
    const output = resolve(options.output ?? 'results/stage4/terminal-audit.json');
    await writeJSON(output, report);
    console.log(`SYNTHETIC: ${report.nodeCount} checkpoints, ${report.accessibleEdgeCount} accessible edges; assigned gate ${report.assignedGateId}.`);
    console.log(`Distances are invented, not Toronto Pearson measurements. Saved: ${output}`);
    return;
  }
  if (command === 'eta-evaluate') {
    const times = options.times === undefined ? undefined : options.times.split(',').map(value => {
      if (!value.trim()) throw new Error('ETA evaluation times cannot contain empty entries');
      return Number(value);
    });
    const evaluation = evaluateGateETA(manifest, times);
    const directory = resolve(options.output ?? 'results/stage4/eta');
    await writeJSON(resolve(directory, 'eta-evaluation.json'), evaluation);
    await writeFile(resolve(directory, 'eta-evaluation.csv'), csv(evaluation.rows), 'utf8');
    await writeFile(resolve(directory, 'eta-summary.csv'), csv(evaluation.summaries), 'utf8');
    for (const row of evaluation.summaries) console.log(`t=${row.asOfSeconds}s: ${row.predictedCount} forecasts, ${row.observedAtGate} observed at gate, ${row.unavailablePredictions} unavailable; MAE=${row.meanAbsoluteErrorSeconds ?? 'n/a'}s, bias=${row.meanSignedErrorSeconds ?? 'n/a'}s, RMSE=${row.rootMeanSquaredErrorSeconds ?? 'n/a'}s.`);
    console.log(`Post-run evaluation only; synthetic error samples are not calibrated confidence intervals. Saved: ${directory}`);
    return;
  }
  if (command === 'validate-trace') {
    const report = validateSimulationTrace(manifest, await readJSON(options['trace-file']));
    if (options.output) await writeJSON(resolve(options.output), report);
    console.log(`VALID TRACE: ${report.eventCount} events; ${report.seatedExactlyOnce} seated exactly once; movement, queues, service phases and metrics verified.`);
    return;
  }
  if (command === 'readiness') {
    const at = Number(options.at ?? 0);
    if (!Number.isFinite(at)) throw new Error('--at must be finite seconds');
    const snapshot = createReadinessObserver(manifest).snapshot(at);
    const output = resolve(options.output ?? 'results/readiness.json');
    await writeJSON(output, snapshot);
    console.log(`As of t=${at}s: ${snapshot.passengers.filter(p => p.readyAtGate).length} observed ready at gate; ${snapshot.passengers.filter(p => p.security.status === 'SCREENING').length} still screening.`);
    console.log(`Saved observation-only readiness and predicted ETAs: ${output}`);
    return;
  }
  if (command === 'validate') {
    console.log(`VALID: ${validation.passengerCount} unique IDs, ${validation.uniqueSeats} unique seats; clearance, timestamps, baggage and companions checked.`);
    return;
  }
  if (command === 'generate') {
    const path = resolve(options.output ?? 'data/synthetic-flight.json');
    await writeJSON(path, manifest);
    console.log(`Saved synthetic manifest: ${path}`);
    return;
  }
  deepFreeze(manifest);
  const results = command === 'simulate'
    ? [simulate(manifest, options.strategy ?? 'random', { trace: !!options.trace })]
    : compareStrategies(manifest, { trace: !!options.trace }).results;
  const directory = resolve(options.output ?? 'results');
  await writeArtifacts(directory, manifest, results);
  console.log(`\n${resultTable(results)}\n`);
  console.log(`PASS: all ${results.length} strategy invariant audits; each seated ${manifest.passengers.length} passengers exactly once.`);
  console.log('Gate wait includes pre-opening time; aisle blocking is summed across passengers.');
  console.log(`Saved manifest, comparisons and passenger timings${options.trace ? ', plus event traces' : ''}: ${directory}`);
}

main().catch(error => {
  console.error(`BoardingFlow error: ${error.message}`);
  process.exitCode = 1;
});
