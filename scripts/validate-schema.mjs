import { readFileSync } from 'node:fs';
import process from 'node:process';

const REQUIRED_DEFAULT_GROUPS = new Set(['validation', 'shape-class', 'laminar', 'confinement']);
const FACTOR_NAMES = ['operator', 'walls', 'storage'];
const ROW_SECTIONS = ['laminar', 'validation', 'confinement', 'sensitivity'];
const ARRAY_SECTIONS = [
  'verification',
  'laminar',
  'validation',
  'confinement',
  'convergence',
  'sensitivity',
  'gridCheck',
  'crossDevice',
  'skipped',
];
const TIERS = ['S', 'M', 'L', 'XL'];
const SHAPE_TIERS = ['S', 'M', 'L'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * @param {unknown} value
 * @returns {Record<string, string[]> | null}
 */
function readFactors(value) {
  if (!isRecord(value)) return null;
  /** @type {Record<string, string[]>} */
  const factors = {};
  for (const name of FACTOR_NAMES) {
    const levels = value[name];
    if (!isStringArray(levels) || levels.length === 0) return null;
    factors[name] = levels;
  }
  return factors;
}

/**
 * @param {string} path
 * @returns {unknown | null}
 */
function load(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `validate-schema: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} index
 * @returns {{ errors: string[], group: string, key: string, caseId: string, tier: string }}
 */
function rowIdentity(row, index) {
  const errors = [];
  const group = typeof row.group === 'string' ? row.group : '';
  const caseId = typeof row.case === 'string' ? row.case : '';
  const tier = typeof row.tier === 'string' ? row.tier : '';
  if (caseId === '') errors.push(`row ${index} has no case name.`);
  if (tier === '') errors.push(`row ${index} has no tier.`);
  return { errors, group, key: `${caseId}\u0000${tier}`, caseId, tier };
}

/**
 * @param {unknown} variant
 * @param {Record<string, string[]> | null} factors
 * @returns {string[]}
 */
function checkVariantName(variant, factors) {
  if (variant === undefined || variant === null) return [];
  if (typeof variant !== 'string') return ['has a non-string variant.'];
  if (variant === 'default') return [];
  if (!variant.startsWith('flip-')) return [`has unknown variant ${variant}.`];
  const factor = variant.slice('flip-'.length);
  const levels = FACTOR_NAMES.includes(factor) ? factors?.[factor] : undefined;
  if (!FACTOR_NAMES.includes(factor)) return [`has unknown variant ${variant}.`];
  if (levels === undefined || levels.length !== 2) {
    return [`flips ${factor}, which has no second level.`];
  }
  return [];
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} index
 * @param {Record<string, string[]> | null} factors
 * @param {string} key
 * @param {Map<string, Set<string>>} seenVariants
 * @returns {string[]}
 */
function checkVariant(row, index, factors, key, seenVariants) {
  const variant = row.variant;
  const errors = checkVariantName(variant, factors).map((message) => `row ${index} ${message}`);
  if (typeof variant !== 'string') return errors;
  const seen = seenVariants.get(key) ?? new Set();
  if (seen.has(variant)) errors.push(`row ${index} repeats variant ${variant}.`);
  seen.add(variant);
  seenVariants.set(key, seen);
  if (variant === 'default' && row.isDefault !== true) {
    errors.push(`row ${index} variant default is not isDefault.`);
  }
  if (variant !== 'default' && row.isDefault === true) {
    errors.push(
      `row ${index} flips ${variant.slice('flip-'.length)} but is marked as the default.`,
    );
  }
  return errors;
}

/**
 * @param {unknown} row
 * @param {number} index
 * @param {Record<string, string[]> | null} factors
 * @param {Map<string, Set<string>>} seenVariants
 * @param {Map<string, number>} seenDefaults
 * @returns {string[]}
 */
function checkRow(row, index, factors, seenVariants, seenDefaults) {
  if (!isRecord(row)) return [`row ${index} is not an object.`];
  const identity = rowIdentity(row, index);
  const errors = [...identity.errors];
  if (REQUIRED_DEFAULT_GROUPS.has(identity.group) && typeof row.isDefault !== 'boolean') {
    errors.push(`row ${index} (${identity.caseId} ${identity.tier}) has no boolean isDefault.`);
  }
  if (row.isDefault === true) {
    seenDefaults.set(identity.key, (seenDefaults.get(identity.key) ?? 0) + 1);
  }
  errors.push(...checkVariant(row, index, factors, identity.key, seenVariants));
  return errors;
}

/**
 * @param {Map<string, number>} seenDefaults
 * @returns {string[]}
 */
function checkDefaultCounts(seenDefaults) {
  const errors = [];
  for (const [key, count] of seenDefaults) {
    if (count <= 1) continue;
    const [caseId, tier] = key.split('\u0000');
    errors.push(`${caseId} has ${count} default rows at tier ${tier}.`);
  }
  return errors;
}

/**
 * @typedef {object} Requirement
 * @property {string} label
 * @property {(row: Record<string, unknown>) => boolean} test
 * @property {string} skipCase
 * @property {string} [tier]
 * @property {string} [operator]
 */

/**
 * @param {Requirement} requirement
 * @param {readonly Record<string, unknown>[]} rows
 * @param {readonly Record<string, unknown>[]} skipped
 * @returns {boolean}
 */
function isSatisfied(requirement, rows, skipped) {
  if (rows.some(requirement.test)) return true;
  return skipped.some(
    (skip) =>
      skip.case === requirement.skipCase &&
      (skip.tier === undefined || skip.tier === requirement.tier) &&
      (skip.operator === undefined || skip.operator === requirement.operator),
  );
}

/**
 * @param {readonly unknown[]} items
 * @returns {Record<string, unknown>[]}
 */
function records(items) {
  return items.filter(isRecord);
}

/**
 * @param {string} group
 * @param {string} caseId
 * @param {string} tier
 * @param {string} [operator]
 * @returns {Requirement}
 */
function caseRequirement(group, caseId, tier, operator) {
  const where = operator === undefined ? `tier ${tier}` : `${operator} at tier ${tier}`;
  return {
    label: `${group} ${caseId} lacks a row or a skip reason for ${where}.`,
    test: (row) =>
      row.group === group &&
      row.case === caseId &&
      row.tier === tier &&
      (operator === undefined || row.operator === operator),
    skipCase: caseId,
    tier,
    ...(operator === undefined ? {} : { operator }),
  };
}

/**
 * @param {string} name
 * @param {string} tier
 * @param {boolean} [stilts]
 * @returns {Requirement}
 */
function sensitivityRequirement(name, tier, stilts) {
  return {
    label: `sensitivity ${name}${stilts === undefined ? '' : stilts ? ' (stilts included)' : ' (stilts excluded)'} lacks a row or a skip reason.`,
    test: (row) =>
      row.group === 'sensitivity' &&
      row.sensitivity === name &&
      (stilts === undefined || row.stilts === stilts),
    skipCase: `sensitivity-${name}`,
    tier,
  };
}

/**
 * @param {Record<string, string[]>} factors
 * @returns {Requirement[]}
 */
function requiredCases(factors) {
  /** @type {Requirement[]} */
  const required = [];
  for (const tier of TIERS) {
    required.push({
      ...caseRequirement('validation', 'ahmed-25', tier),
      test: (row) =>
        row.group === 'validation' &&
        row.case === 'ahmed-25' &&
        row.tier === tier &&
        row.isDefault === true,
    });
  }
  required.push(caseRequirement('validation', 'ahmed-35', 'L'));
  for (const caseId of ['cube', 'sphere']) {
    for (const tier of SHAPE_TIERS) required.push(caseRequirement('shape-class', caseId, tier));
  }
  for (const operator of factors.operator ?? []) {
    required.push(...operatorRequirements(operator));
  }
  required.push(
    sensitivityRequirement('domain', 'XL'),
    sensitivityRequirement('body-length', 'L'),
    sensitivityRequirement('inlet-speed', 'M'),
    sensitivityRequirement('stilts', 'L', true),
    sensitivityRequirement('stilts', 'L', false),
  );
  return required;
}

/**
 * @param {string} operator
 * @returns {Requirement[]}
 */
function operatorRequirements(operator) {
  return [
    ...SHAPE_TIERS.map((tier) => caseRequirement('laminar', 'sphere-re-100', tier, operator)),
    caseRequirement('confinement', 'cube-confinement', 'XL', operator),
    caseRequirement('confinement', 'sphere-confinement', 'XL', operator),
  ];
}

/**
 * @param {readonly Record<string, unknown>[]} rows
 * @param {readonly Record<string, unknown>[]} skipped
 * @param {Record<string, string[]>} factors
 * @returns {string[]}
 */
function checkAhmedVariants(rows, skipped, factors) {
  const expected = [
    'default',
    ...FACTOR_NAMES.filter((name) => (factors[name]?.length ?? 0) === 2).map(
      (name) => `flip-${name}`,
    ),
  ].sort();
  const actual = rows
    .filter((row) => row.group === 'validation' && row.case === 'ahmed-25' && row.tier === 'L')
    .map((row) => (typeof row.variant === 'string' ? row.variant : '(none)'))
    .sort();
  const covered = [
    ...actual,
    ...skipped
      .filter((skip) => skip.case === 'ahmed-25' && skip.tier === 'L')
      .map((skip) => (typeof skip.variant === 'string' ? skip.variant : 'default')),
  ];
  const complete = expected.every((variant) => covered.includes(variant));
  const unexpected = actual.some((variant) => !expected.includes(variant));
  if (complete && !unexpected) return [];
  return [
    `tier-L Ahmed 25 variants are ${actual.join(', ') || 'missing'}; expected ${expected.join(', ')}.`,
  ];
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {readonly Record<string, unknown>[]} rows
 * @param {Record<string, string[]>} factors
 * @returns {string[]}
 */
function checkRequiredAll(parsed, rows, factors) {
  const skipped = records(/** @type {unknown[]} */ (parsed.skipped));
  const errors = checkAhmedVariants(rows, skipped, factors);
  if (/** @type {unknown[]} */ (parsed.verification).length === 0) {
    errors.push('verification has no rows.');
  }
  for (const requirement of requiredCases(factors)) {
    if (!isSatisfied(requirement, rows, skipped)) errors.push(requirement.label);
  }
  const convergence = records(/** @type {unknown[]} */ (parsed.convergence));
  const convergenceSkipped = skipped.some(
    (skip) => skip.case === 'ahmed-25' && skip.group === 'convergence',
  );
  if (!convergence.some((row) => row.case === 'ahmed-25') && !convergenceSkipped) {
    errors.push('convergence has no Ahmed 25 estimate or skip reason.');
  }
  const gridCheck = /** @type {unknown[]} */ (parsed.gridCheck);
  if (gridCheck.length === 0 && !skipped.some((skip) => skip.group === 'grid-check')) {
    errors.push('gridCheck has no rows or skip reason.');
  }
  return errors;
}

/**
 * @param {readonly Record<string, unknown>[]} rows
 * @param {readonly Record<string, unknown>[]} skipped
 * @param {Record<string, string[]>} factors
 * @returns {string[]}
 */
function checkRequiredOperators(rows, skipped, factors) {
  return (factors.operator ?? [])
    .flatMap(operatorRequirements)
    .filter((requirement) => !isSatisfied(requirement, rows, skipped))
    .map((requirement) => requirement.label);
}

/**
 * @param {readonly unknown[]} crossDevice
 * @returns {string[]}
 */
function checkCrossDevice(crossDevice) {
  const nonApple = records(crossDevice).some(
    (row) =>
      isRecord(row.adapter) &&
      typeof row.adapter.vendor === 'string' &&
      row.adapter.vendor.toLowerCase() !== 'apple',
  );
  return nonApple ? [] : ['crossDevice has no row from a non-Apple adapter.'];
}

/**
 * @param {Record<string, unknown>} parsed
 * @returns {string[]}
 */
function checkEnvelope(parsed) {
  const errors = [];
  if (parsed.schemaVersion !== 1) errors.push('schemaVersion must be 1.');
  if (typeof parsed.commit !== 'string' || parsed.commit === '') {
    errors.push('commit must be a non-empty string.');
  }
  if (typeof parsed.date !== 'string') errors.push('date must be a string.');
  const machine = parsed.machine;
  if (
    !isRecord(machine) ||
    !isRecord(machine.adapter) ||
    !isStringArray(machine.features) ||
    !isRecord(machine.limits) ||
    typeof machine.userAgent !== 'string'
  ) {
    errors.push('machine must have adapter, features, limits and userAgent.');
  }
  for (const name of ARRAY_SECTIONS) {
    if (!Array.isArray(parsed[name])) errors.push(`${name} must be an array.`);
  }
  return errors;
}

/**
 * @param {string} name
 * @param {unknown} row
 * @param {number} index
 * @returns {string | null}
 */
function sectionRowError(name, row, index) {
  if (!isRecord(row)) return `${name} row ${index} is not an object.`;
  if (name === 'skipped') {
    return typeof row.reason === 'string' ? null : `skipped entry ${index} has no reason.`;
  }
  if (typeof row.commit !== 'string') return `${name} row ${index} has no commit.`;
  if (name === 'gridCheck' && row.kind !== 'band' && row.kind !== 'no-band') {
    return `gridCheck row ${index} must be band or no-band.`;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} parsed
 * @returns {string[]}
 */
function checkSectionRows(parsed) {
  return ARRAY_SECTIONS.flatMap((name) => {
    const section = parsed[name];
    if (!Array.isArray(section)) return [];
    return section.flatMap((row, index) => sectionRowError(name, row, index) ?? []);
  });
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {Record<string, string[]> | null} factors
 * @param {Set<string>} flags
 * @returns {string[]}
 */
function checkRows(parsed, factors, flags) {
  const rows = ROW_SECTIONS.flatMap((name) => {
    const section = parsed[name];
    return Array.isArray(section) ? section : [];
  });
  /** @type {Map<string, Set<string>>} */
  const seenVariants = new Map();
  /** @type {Map<string, number>} */
  const seenDefaults = new Map();
  const errors = rows.flatMap((row, index) =>
    checkRow(row, index, factors, seenVariants, seenDefaults),
  );
  errors.push(...checkDefaultCounts(seenDefaults));
  if (factors === null) return errors;
  const rowRecords = records(rows);
  const skipped = Array.isArray(parsed.skipped) ? records(parsed.skipped) : [];
  if (flags.has('--require-all')) errors.push(...checkRequiredAll(parsed, rowRecords, factors));
  if (flags.has('--require-operators')) {
    errors.push(...checkRequiredOperators(rowRecords, skipped, factors));
  }
  return errors;
}

/**
 * @param {string[]} argv
 */
function run(argv) {
  const flags = new Set(argv.filter((argument) => argument.startsWith('--')));
  const known = new Set(['--require-all', '--require-operators', '--require-cross-device']);
  const path =
    argv.find((argument) => !argument.startsWith('--')) ?? 'public/validation/results.json';
  const parsed = load(path);
  if (!isRecord(parsed)) {
    process.stderr.write('validate-schema: results must be a JSON object.\n');
    process.exitCode = 1;
    return;
  }

  const factors = readFactors(parsed.factors);
  const errors = [...flags]
    .filter((flag) => !known.has(flag))
    .map((flag) => `unknown option ${flag}.`);
  errors.push(
    ...checkEnvelope(parsed),
    ...checkSectionRows(parsed),
    ...checkRows(parsed, factors, flags),
  );
  if (factors === null) {
    errors.push('factors must list non-empty operator, walls and storage arrays.');
  }
  if (flags.has('--require-cross-device')) {
    errors.push(...checkCrossDevice(Array.isArray(parsed.crossDevice) ? parsed.crossDevice : []));
  }

  const unique = [...new Set(errors)];
  if (unique.length > 0) {
    for (const error of unique) process.stderr.write(`validate-schema: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`validate-schema: ${path} is valid.\n`);
}

run(process.argv.slice(2));
