import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strategies = ['random', 'zone', 'baggage-aware', 'wilma', 'adaptive'];
const scenarios = ['normal', 'security-delays', 'late-arrivals'];

// A small contract fixture, not a performance experiment. Every payload is
// emitted by the CLI; only JSON whitespace is compacted when copying files.
export function generateIntegrationExamples({ backend = project,
  output = join(project, 'examples/integration/output'), scenario = 'normal' } = {}) {
  if (!scenarios.includes(scenario)) throw new Error('Unknown integration example scenario');
  backend = resolve(backend);
  output = resolve(output);
  const temporary = mkdtempSync(join(tmpdir(), 'boardingflow-integration-'));
  const cli = (...args) => execFileSync(process.execPath, [join(backend, 'src/cli.js'), ...args],
    { cwd: backend, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  try {
    cli('stage6', '--seeds', '42', '--cases', scenario,
      '--config', join(project, 'examples/integration/generation.json'),
      '--policy-config', join(project, 'examples/integration/policy.json'),
      '--output', temporary, '--trace');
    const directory = join(temporary, scenario, 'seed-42');
    const manifest = join(directory, 'manifest.json');
    cli('validate', '--input', manifest);
    cli('readiness', '--input', manifest, '--at', '-700', '--output', join(directory, 'readiness-early.json'));
    cli('policy-preview', '--input', manifest, '--at', '0', '--strategy', 'adaptive', '--output', join(directory, 'policy-preview.json'));
    for (const strategy of strategies) cli('validate-trace', '--input', manifest,
      '--trace-file', join(directory, `events-${strategy}.json`));
    const files = ['manifest.json', 'comparison.json', 'readiness-0.json', 'readiness-early.json',
      'recommendations-adaptive.json', 'policy-preview.json', 'eta-evaluation.json',
      ...strategies.flatMap(s => [`events-${s}.json`, `timings-${s}.json`])];
    const benchmark = read(join(temporary, 'comparison.json'));
    const payloads = Object.fromEntries(files.map(name => [name, read(join(directory, name))]));
    payloads['benchmark.json'] = benchmark;
    // Never remove unrelated files in the requested output folder.
    mkdirSync(output, { recursive: true });
    const hashes = {};
    for (const [name, value] of Object.entries(payloads)) {
      const text = `${JSON.stringify(value)}\n`;
      writeFileSync(join(output, name), text);
      hashes[name] = createHash('sha256').update(text).digest('hex');
    }
    const index = { exampleBundleVersion: 1, dataKind: 'SYNTHETIC',
      baselineReferenceCommit: '7e081741979b193ddfc6bbd8ce4dd17948b91381',
      seed: 42, scenarioName: scenario, passengerCount: 18,
      inputHash: benchmark.experiments[0].inputHash, strategies, files: hashes,
      note: 'Three-row integration fixture, not the 180-passenger benchmark. CLI-produced payloads; only whitespace is compacted. No real airport authorization or measurements.' };
    writeFileSync(join(output, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    return index;
  } finally {
    const target = resolve(temporary);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('boardingflow-integration-')) {
      throw new Error('Refusing unexpected temporary cleanup target');
    }
    rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!['--backend', '--output', '--scenario'].includes(flag) || !process.argv[i + 1]
        || process.argv[i + 1].startsWith('--') || Object.hasOwn(options, flag.slice(2))) {
      throw new Error('Usage: node scripts/generate-integration-examples.js [--backend directory] [--output directory] [--scenario normal|security-delays|late-arrivals]');
    }
    options[flag.slice(2)] = process.argv[i + 1];
  }
  const index = generateIntegrationExamples(options);
  console.log(`PASS: ${index.passengerCount} synthetic passengers, five validated traces, zero violations; input ${index.inputHash}`);
}
