import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fails unless the bundle in <dist>/assets/*.js was built with the current source commit and
// numerics hash, so a build stamped "dev" can never be packed or published.

const scripts = dirname(fileURLToPath(import.meta.url));
// Values the build ids take when they could not be computed.
const unusable = new Set(['', 'dev', 'unknown']);

/** @param {string} label @param {string} script */
function expectedId(label, script) {
  const result = spawnSync('sh', [join(scripts, script)], { encoding: 'utf8' });
  const id = result.stdout.trim();
  if (result.status !== 0 || unusable.has(id)) {
    const reason = result.stderr.trim() || `printed "${id}"`;
    throw new Error(`cannot compute the ${label} (${script}): ${reason}`);
  }
  return id;
}

/** @param {string} directory */
function bundleSource(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.js'));
  } catch {
    throw new Error(`${directory} is missing; run npm run build first`);
  }
  if (names.length === 0) throw new Error(`${directory} has no .js files; run npm run build first`);
  return names.map((name) => readFileSync(join(directory, name), 'utf8')).join('\n');
}

/** @param {string} source @param {string} id */
function containsQuoted(source, id) {
  return ['"', "'", '`'].some((quote) => source.includes(`${quote}${id}${quote}`));
}

try {
  const assets = join(process.argv[2] ?? 'dist', 'assets');
  const ids = [
    { label: 'source commit', id: expectedId('source commit', 'source-commit.sh') },
    { label: 'numerics hash', id: expectedId('numerics hash', 'numerics-hash.sh') },
  ];
  const source = bundleSource(assets);
  const missing = ids.filter(({ id }) => !containsQuoted(source, id));
  if (missing.length > 0) {
    const names = missing.map(({ label, id }) => `${label} ${id}`).join(' and ');
    throw new Error(`${assets}/*.js lacks the ${names}; rebuild with both ids set (npm pack does)`);
  }
  process.stdout.write(`Build ids: ${ids.map(({ label, id }) => `${label} ${id}`).join(', ')}.\n`);
} catch (error) {
  process.stderr.write(`Build ids: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
