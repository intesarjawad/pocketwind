import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const tokenProperties = new Set([
  'color',
  'background',
  'border-color',
  'fill',
  'font-family',
  'font-size',
  'line-height',
  'letter-spacing',
  'margin',
  'padding',
  'gap',
  'border-radius',
  'box-shadow',
  'transition',
  'animation',
]);
const allowedValues = new Set(['0', 'none', 'auto', 'inherit', 'currentcolor', '100%']);

/** @param {string} directory @returns {string[]} */
function cssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
  });
}

/** @param {string} source */
function withoutComments(source) {
  // Preserve offsets and newlines so diagnostics point into the original file.
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\//g, (match) =>
    match.startsWith('/*') ? match.replace(/[^\n]/g, ' ') : match,
  );
}

/** @param {string} source */
function* declarations(source) {
  let start = 0;
  let parentheses = 0;
  const tokens = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[();{}]/g;
  for (const match of source.matchAll(tokens)) {
    const character = match[0];
    if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (parentheses === 0 && /^[;{}]$/.test(character)) {
      if (character !== '{') yield { text: source.slice(start, match.index), start };
      start = match.index + 1;
    }
  }
}

/** @param {string} value */
function usesTokens(value) {
  const normalized = value.replace(/\s*!important\s*$/i, '').trim();
  return (
    /\bvar\(\s*--[\w-]+/.test(normalized) ||
    normalized.split(/\s+/).every((part) => allowedValues.has(part.toLowerCase()))
  );
}

/** @param {string} path */
function lintFile(path) {
  if (basename(path) === 'tokens.css') return [];
  const source = withoutComments(readFileSync(path, 'utf8'));
  const diagnostics = [];
  for (const declaration of declarations(source)) {
    const match = /^\s*([\w-]+)\s*:\s*([\s\S]*)$/.exec(declaration.text);
    if (!match) continue;
    const [, property = '', value = ''] = match;
    if (!tokenProperties.has(property.toLowerCase()) || usesTokens(value)) continue;
    const offset = declaration.start + declaration.text.search(/\S/);
    const line = source.slice(0, offset).split('\n').length;
    diagnostics.push(`${path}:${line}: ${property} must use var(--...) or an allowed keyword`);
  }
  return diagnostics;
}

try {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node scripts/token-lint.mjs <styles-directory>');
  const files = cssFiles(directory);
  const diagnostics = files.flatMap(lintFile);
  if (diagnostics.length > 0) {
    process.stderr.write(`${diagnostics.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Token lint: checked ${files.length} CSS files.\n`);
  }
} catch (error) {
  process.stderr.write(`Token lint: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
