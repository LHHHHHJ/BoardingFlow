import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csv, duration } from '../src/io.js';
import { auditResult } from '../src/simulate.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => execFileSync(process.execPath, ['src/cli.js', ...args], { cwd: project, encoding: 'utf8' });
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
function cleanup(directory) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('boardingflow-'));
  rmSync(target, { recursive: true, force: true });
}

test('CLI incremental workflow generates, validates, simulates and compares saved input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-test-'));
  try {
    const input = join(directory, 'synthetic.json');
    const output = join(directory, 'comparison');
    assert.match(cli('generate', '--seed', '42', '--output', input), /Saved synthetic manifest/);
    assert.match(cli('validate', '--input', input), /180 unique seats/);
    assert.match(cli('simulate', '--input', input, '--strategy', 'random', '--output', join(directory, 'single')), /PASS/);
    assert.match(cli('compare', '--input', input, '--output', output, '--trace'), /all 3 strategy invariant audits/);
    const manifest = readJSON(input);
    const summary = readJSON(join(output, 'comparison.json'));
    assert.equal(summary.results.length, 3);
    assert.equal(new Set(summary.results.map(r => r.inputHash)).size, 1);
    assert.equal(readFileSync(join(output, 'passengers.csv'), 'utf8').trim().split('\n').length, 181);
    const standalone = readJSON(join(directory, 'single', 'timings-random.json'));
    assert.deepEqual(standalone, readJSON(join(output, 'timings-random.json')));
    for (const result of summary.results) {
      const savedResult = readJSON(join(output, `timings-${result.strategy}.json`));
      assert.ok(auditResult(manifest, savedResult).passed);
      const trace = readJSON(join(output, `events-${result.strategy}.json`));
      assert.ok(trace.events.length > 180);
      assert.equal(trace.inputHash, result.inputHash);
    }
  } finally {
    // This unique, test-created directory is the only removal target.
    cleanup(directory);
  }
});

test('demo exports byte-for-byte reproducible artifacts, including all traces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-repeat-'));
  try {
    cli('demo', '--output', directory, '--seed', '42', '--trace');
    const files = readdirSync(directory);
    const first = new Map(files.map(file => [file, readFileSync(join(directory, file))]));
    cli('demo', '--output', directory, '--seed', '42', '--trace');
    for (const file of files) assert.deepEqual(readFileSync(join(directory, file)), first.get(file), file);
  } finally {
    cleanup(directory);
  }
});

test('CLI applies configuration overrides and rejects malformed arguments or files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-config-'));
  try {
    const input = join(directory, 'configured.json');
    cli('generate', '--config', 'config/example.json', '--output', input);
    assert.equal(readJSON(input).config.generation.overheadBagProbability, 0.8);
    for (const args of [
      ['compare'], ['generate', '--seed', '-1'], ['generate', '--seed', 'abc'],
      ['generate', '--output'], ['generate', '--typo', '1'], ['no-such-command'],
      ['generate', '--seed', '1', '--seed', '2'], ['validate', '--input', join(directory, 'missing.json')]
    ]) {
      const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: project, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /BoardingFlow error/);
    }
    assert.match(cli('--help'), /No install step/);
  } finally {
    cleanup(directory);
  }
});

test('CSV export quotes commas, embedded quotes and newlines', () => {
  assert.equal(csv([{ a: 'x,y', b: 'say "hi"', c: 'two\nlines' }]), 'a,b,c\n"x,y","say ""hi""","two\nlines"\n');
  assert.equal(duration(59.6), '1:00');
});

test('reusing an output directory removes stale generated strategy files and traces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boardingflow-stale-'));
  try {
    cli('demo', '--output', directory, '--trace');
    cli('simulate', '--input', join(directory, 'manifest.json'), '--output', directory);
    const files = readdirSync(directory);
    assert.ok(!files.some(file => file.startsWith('events-')));
    assert.ok(!files.some(file => file.startsWith('timings-zone') || file.startsWith('timings-baggage-aware')));
    assert.ok(files.includes('timings-random.json'));
  } finally {
    cleanup(directory);
  }
});
