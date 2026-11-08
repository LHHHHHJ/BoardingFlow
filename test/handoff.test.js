import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { manifestHash, validateManifest } from '../src/model.js';
import { validateScenario } from '../src/scenarios.js';
import { validateSimulationTrace, TRACE_EVENT_TYPES } from '../src/trace.js';
import { auditResult } from '../src/simulate.js';
import { createReadinessObserver } from '../src/readiness.js';
import { generateIntegrationExamples } from '../scripts/generate-integration-examples.js';

const root = new URL('../examples/integration/output/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../schemas/backend-contract.schema.json', import.meta.url), 'utf8'));
const index = read('index.json');
const manifest = read('manifest.json');
const fields = (value, definition) => {
  for (const name of definition.required) assert.ok(Object.hasOwn(value, name), `Missing contract field ${name}`);
  for (const name of Object.keys(value)) assert.ok(Object.hasOwn(definition.properties, name), `Unknown contract field ${name}`);
};

test('handoff fixtures have verified file fingerprints, one input and all five successful strategies', () => {
  for (const [name, hash] of Object.entries(index.files)) assert.equal(createHash('sha256').update(readFileSync(new URL(name, root))).digest('hex'), hash);
  validateManifest(manifest); validateScenario(manifest);
  assert.equal(manifest.passengers.length, 18);
  assert.equal(manifest.config.aircraft.rows, 3);
  assert.equal(manifestHash(manifest), index.inputHash);
  const comparison = read('comparison.json');
  assert.deepEqual(comparison.results.map(r => r.strategy), index.strategies);
  for (const r of comparison.results) {
    assert.equal(r.inputHash, index.inputHash); assert.equal(r.metrics.constraintViolationCount, 0);
    fields(r.metrics, schema.$defs.Metrics);
  }
  assert.deepEqual(Object.keys(comparison.results[0].metrics).sort(), Object.keys(schema.$defs.Metrics.properties).sort());
});

test('handoff five real traces replay without collisions and cover all 19 event contracts', () => {
  const types = new Set();
  for (const strategy of index.strategies) {
    const trace = read(`events-${strategy}.json`);
    assert.equal(validateSimulationTrace(manifest, trace).seatedExactlyOnce, 18);
    const result = read(`timings-${strategy}.json`);
    assert.equal(auditResult(manifest, result).passed, true);
    assert.deepEqual(trace.metrics, result.metrics);
    for (const event of trace.events) {
      const definition = schema.$defs.TraceEvent.oneOf.find(d => d.properties.type.const === event.type);
      assert.ok(definition); fields(event, definition); types.add(event.type);
    }
  }
  assert.deepEqual([...types].sort(), [...TRACE_EVENT_TYPES].sort());
  assert.ok(read('events-random.json').events.some((e, i, a) => i && e.sequence < a[i - 1].sequence), 'Playback must use eventIndex rather than sequence');
});

test('handoff readiness artifacts contain observed status and predictions without manifest truth', () => {
  for (const file of ['readiness-early.json', 'readiness-0.json']) {
    const snapshot = read(file);
    assert.deepEqual(snapshot, createReadinessObserver(manifest).snapshot(snapshot.asOfSeconds));
    for (const p of snapshot.passengers) {
      fields(p, schema.$defs.ReadyPassenger);
      assert.ok(!Object.hasOwn(p, 'behavior') && !Object.hasOwn(p, 'gateArrivalSeconds'));
      if (p.security.status === 'SCREENING') assert.equal(p.security.clearedAtSeconds, null);
      for (const t of [p.gateObservedAtSeconds, p.checkIn.clearedAtSeconds, p.security.scanAtSeconds, p.security.clearedAtSeconds]) assert.ok(t === null || t <= snapshot.asOfSeconds);
    }
  }
  const unseen = createReadinessObserver(manifest).snapshot(-10000);
  assert.ok(unseen.passengers.every(p => p.prediction.estimatedGateArrivalSeconds === null && !p.readyAtGate));
});

test('handoff recommendation and timing exports retain advisory semantics and shared identities', () => {
  const envelope = read('recommendations-adaptive.json');
  assert.equal(envelope.inputHash, index.inputHash);
  for (const r of envelope.recommendations) {
    fields(r, schema.$defs.Recommendation);
    assert.equal(r.executionAuthorization, 'NONE_ADVISORY_ONLY');
    if (r.action === 'RELEASE') {
      assert.ok(r.memberIds.length);
      assert.equal(r.releaseInterval.forecastOnly, true);
      assert.ok(r.releaseInterval.minimumDurationSeconds >= 0);
    } else assert.equal(r.unitId, null);
  }
  for (const strategy of index.strategies) for (const t of read(`timings-${strategy}.json`).passengerTimings) fields(t, schema.$defs.Timing);
  assert.equal(read('benchmark.json').summaries[0].strategies[0].metrics.totalBoardingSeconds.sampleSD, null);
});

test('handoff generator supports all three existing scenarios and reproduces the checked fixture', () => {
  const temp = mkdtempSync(join(tmpdir(), 'boardingflow-handoff-test-'));
  try {
    for (const scenario of ['normal', 'security-delays', 'late-arrivals']) {
      const output = join(temp, scenario);
      const generated = generateIntegrationExamples({ output, scenario });
      assert.equal(generated.scenarioName, scenario);
      const comparison = JSON.parse(readFileSync(join(output, 'comparison.json')));
      assert.ok(comparison.results.every(r => r.metrics.passengerCount === 18 && r.metrics.constraintViolationCount === 0));
      if (scenario === 'normal') for (const name of Object.keys(index.files).filter(p => p !== 'benchmark.json')) assert.deepEqual(JSON.parse(readFileSync(join(output, name))), read(name));
    }
    assert.throws(() => generateIntegrationExamples({ output: temp, scenario: 'invented' }), /Unknown/);
  } finally {
    const target = resolve(temp);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('boardingflow-handoff-test-'));
    rmSync(target, { recursive: true, force: true });
  }
});
