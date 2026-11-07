#!/usr/bin/env node
import { resolve } from 'node:path';
import { compareStrategies } from './compare.js';
import { generateFlight } from './generate.js';
import { deepFreeze, validateManifest } from './model.js';
import { readJSON, resultTable, writeArtifacts, writeJSON } from './io.js';
import { simulate } from './simulate.js';
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

generate/demo: optional --config config/example.json (partial assumption overrides).
Stage 1 mix/group example: --config config/stage1.example.json.
audit-dataset: reports class/mix/group sizes and allowance vs actual carry-on;
  exits 1 if the 180-passenger Stage 1 checklist is incomplete, while saving the report.
simulate: --strategy random | zone | baggage-aware (default random).
baselines: always random/zone/baggage-aware; synthetic Phase 1 arrival stress cases.
  Optional --seeds comma-separated uint32s, --cases normal,all-at-gate,late-arrivals,
  --config partial generation/simulator overrides; case arrival overrides take precedence.
simulate/compare: reuse the complete config and passenger behavior stored in the input.
--trace writes cell movement and row service events; --help prints this message.
node --test runs the automated checks.
`;

function parseArguments(argv) {
  if (!argv.length || argv.includes('--help')) return { help: true };
  const [command, ...flags] = argv;
  const allowed = {
    generate: ['seed', 'config', 'output'],
    validate: ['input'],
    'audit-dataset': ['input', 'output'],
    'validate-trace': ['input', 'trace-file', 'output'],
    simulate: ['input', 'strategy', 'output', 'trace'],
    compare: ['input', 'output', 'trace'],
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
  if (['validate', 'simulate', 'compare', 'audit-dataset', 'validate-trace'].includes(command) && !options.input) throw new Error(`${command} requires --input`);
  if (command === 'validate-trace' && !options['trace-file']) throw new Error('validate-trace requires --trace-file');
  if (options.seed !== undefined && !/^\d+$/.test(options.seed)) throw new Error('seed must be uint32');
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
    manifest = generateFlight(Number(options.seed ?? 42), overrides);
  } else {
    manifest = await readJSON(options.input);
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
  const validation = validateManifest(manifest);
  console.log(`BoardingFlow | SYNTHETIC | seed=${manifest.seed} | passengers=${validation.passengerCount}/${validation.capacity}`);
  console.log(`Input SHA-256: ${validation.inputHash}`);
  if (command === 'validate-trace') {
    const report = validateSimulationTrace(manifest, await readJSON(options['trace-file']));
    if (options.output) await writeJSON(resolve(options.output), report);
    console.log(`VALID TRACE: ${report.eventCount} events; ${report.seatedExactlyOnce} seated exactly once; movement, queues, service phases and metrics verified.`);
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
