#!/usr/bin/env node
import { resolve } from 'node:path';
import { compareStrategies } from './compare.js';
import { generateFlight } from './generate.js';
import { deepFreeze, validateManifest } from './model.js';
import { readJSON, resultTable, writeArtifacts, writeJSON } from './io.js';
import { simulate } from './simulate.js';

const HELP = `BoardingFlow - independent SYNTHETIC boarding simulation (Node.js >=22)

Run from the BoardingFlow folder. No install step or external packages required.

  node src/cli.js generate --seed 42 --output data/synthetic-flight.json
  node src/cli.js validate --input data/synthetic-flight.json
  node src/cli.js simulate --input data/synthetic-flight.json --strategy random --output results/random --trace
  node src/cli.js compare --input data/synthetic-flight.json --output results --trace
  node src/cli.js demo --seed 42 --output results --trace

generate/demo: optional --config config/example.json (partial assumption overrides).
simulate: --strategy random | zone | baggage-aware (default random).
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
    simulate: ['input', 'strategy', 'output', 'trace'],
    compare: ['input', 'output', 'trace'],
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
  if (['validate', 'simulate', 'compare'].includes(command) && !options.input) throw new Error(`${command} requires --input`);
  if (options.seed !== undefined && !/^\d+$/.test(options.seed)) throw new Error('seed must be uint32');
  return { command, options };
}

async function main() {
  const { help, command, options } = parseArguments(process.argv.slice(2));
  if (help) { console.log(HELP); return; }
  let manifest;
  if (command === 'generate' || command === 'demo') {
    const overrides = options.config ? await readJSON(options.config) : {};
    manifest = generateFlight(Number(options.seed ?? 42), overrides);
  } else {
    manifest = await readJSON(options.input);
  }
  const validation = validateManifest(manifest);
  console.log(`BoardingFlow | SYNTHETIC | seed=${manifest.seed} | passengers=${validation.passengerCount}/${validation.capacity}`);
  console.log(`Input SHA-256: ${validation.inputHash}`);
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
