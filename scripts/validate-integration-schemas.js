import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!['--validator-dir', '--examples'].includes(flag) || !process.argv[i + 1]
      || process.argv[i + 1].startsWith('--') || Object.hasOwn(options, flag)) {
    throw new Error('Usage: node scripts/validate-integration-schemas.js --validator-dir directory [--examples output-directory]');
  }
  options[flag] = process.argv[i + 1];
}
if (!options['--validator-dir']) throw new Error('Provide an external Ajv installation; see docs/TEAM_HANDOFF.md. No project dependency is required.');
const require = createRequire(join(resolve(options['--validator-dir']), 'package.json'));
const Ajv2020 = require('ajv/dist/2020.js');
const ajv = new Ajv2020({ allErrors: true, strict: true });
require('ajv-formats')(ajv);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const schema = read(join(project, 'schemas/backend-contract.schema.json'));
ajv.addSchema(schema);
for (const name of Object.keys(schema.$defs)) ajv.getSchema(`${schema.$id}#/$defs/${name}`);
const validate = (name, data) => {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert.ok(check(data), `${name}: ${JSON.stringify(check.errors)}`);
};
const examples = resolve(options['--examples'] ?? join(project, 'examples/integration/output'));
const mapping = { 'manifest.json': 'Manifest', 'comparison.json': 'Comparison',
  'readiness-0.json': 'ReadinessSnapshot', 'readiness-early.json': 'ReadinessSnapshot',
  'recommendations-adaptive.json': 'RecommendationEnvelope', 'policy-preview.json': 'PolicyAdvisory',
  'eta-evaluation.json': 'ETAEvaluation', 'benchmark.json': 'Benchmark', 'index.json': 'ExampleIndex' };
let count = 0;
for (const file of readdirSync(examples)) {
  const type = mapping[file] ?? (file.startsWith('events-') ? 'TraceEnvelope' : file.startsWith('timings-') ? 'Result' : null);
  if (!type) throw new Error(`Unexpected example file: ${file}`);
  validate(type, read(join(examples, file))); count++;
}
validate('ConfigurationOverrides', read(join(project, 'examples/integration/generation.json')));
validate('PolicyConfiguration', read(join(project, 'examples/integration/policy.json')));
count += 2;
const reject = (name, data) => assert.equal(ajv.getSchema(`${schema.$id}#/$defs/${name}`)(data), false, name);
const manifest = read(join(examples, 'manifest.json')); manifest.schemaVersion = 999; reject('Manifest', manifest);
const trace = read(join(examples, 'events-random.json')); trace.events[0].futureSecret = 1; reject('TraceEnvelope', trace);
const readiness = read(join(examples, 'readiness-0.json')); readiness.passengers[0].gateArrivalSeconds = 999; reject('ReadinessSnapshot', readiness);
const metrics = read(join(examples, 'comparison.json')).results[0].metrics; metrics.meanGateWaitSeconds = 'minutes'; reject('Metrics', metrics);
const recommendation = read(join(examples, 'recommendations-adaptive.json')).recommendations[0]; recommendation.action = 'BOARD_NOW'; reject('Recommendation', recommendation);
console.log(`PASS: ${Object.keys(schema.$defs).length} schema definitions compile; ${count} JSON files validate; 5 malformed/version/leakage examples are rejected.`);
