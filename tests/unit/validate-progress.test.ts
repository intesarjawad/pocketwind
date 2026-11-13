import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { validationProgress } from '../../scripts/validate-progress';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pocketwind-progress-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('resumes exact completed measurements and their original campaign date', () => {
  const path = join(directory, 'progress.local');
  const run = { forces: [{ step: 8, fx: 0.12345678901234566 }], msPerStep: Math.PI };
  const progress = validationProgress(path, 'source-and-machine', false, '2026-11-12T00:00:00Z');
  progress.write('case-parameters', run);
  const resumed = validationProgress(path, 'source-and-machine', true, '2026-11-13T00:00:00Z');
  expect(resumed.read('case-parameters')).toEqual(run);
  expect(resumed.read('another-case')).toBeUndefined();
  expect(resumed.date).toBe('2026-11-12T00:00:00Z');
  expect(JSON.parse(readFileSync(path, 'utf8')).entries).toEqual({ 'case-parameters': run });
});

it('rejects a different source or machine instead of reusing stale results', () => {
  const path = join(directory, 'progress.local');
  validationProgress(path, 'old-numerics', false, '2026-11-12T00:00:00Z');
  expect(() => validationProgress(path, 'new-numerics', true, '2026-11-12T00:00:00Z')).toThrow(
    'source or machine',
  );
});

it('starts fresh without resume and rejects malformed progress with resume', () => {
  const path = join(directory, 'progress.local');
  writeFileSync(path, '{"key":"same","date":null,"entries":[]}');
  expect(() => validationProgress(path, 'same', true, '2026-11-12T00:00:00Z')).toThrow(
    'Invalid validation progress',
  );
  expect(
    validationProgress(path, 'same', false, '2026-11-12T00:00:00Z').read('case'),
  ).toBeUndefined();
});
