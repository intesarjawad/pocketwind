import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  caseScales,
  gridCheckViscosity,
  isUnattended,
  unattendedRequest,
} from '../../../src/app/case-run';
import { decodeShareLink } from '../../../src/io/share-link';
import { U_LU } from '../../../src/lbm/units';
import { buildCases, smokeCase } from '../../../src/validation/cases';
import { caseHash, gridCheckHash } from '../../../src/validation/links';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unattended runs', () => {
  it('leaves an ordinary visit to the tunnel', () => {
    expect(isUnattended('#/?p=ahmed-25&t=L')).toBe(false);
    expect(isUnattended('#/?p=ahmed-25&auto=1&stopAt=8')).toBe(true);
  });

  it('reads the runner parameters with the tunnel defaults where a case leaves them out', () => {
    expect(unattendedRequest('#/?p=ahmed-25&auto=1&stopAt=5120')).toEqual({
      kind: 'case',
      parameters: {
        stopAtSteps: 5120,
        re: null,
        les: true,
        lengthCells: null,
        uLu: U_LU,
        supportsInForce: false,
      },
    });
    expect(
      unattendedRequest('#/?p=sphere&auto=1&stopAt=8&re=100&les=0&lc=12.8&ulu=0.1&stilts=1'),
    ).toMatchObject({
      parameters: { re: 100, les: false, lengthCells: 12.8, uLu: 0.1, supportsInForce: true },
    });
  });

  it('turns the grid check hash into a grid check', () => {
    expect(unattendedRequest(gridCheckHash('sphere'))).toEqual({ kind: 'grid-check' });
  });

  it('refuses a run that would never stop or a malformed parameter', () => {
    expect(() => unattendedRequest('#/?auto=1')).toThrow(/stopAt/);
    expect(() => unattendedRequest('#/?auto=1&stopAt=10.5')).toThrow(/stopAt/);
    expect(() => unattendedRequest('#/?auto=1&stopAt=8&re=-1')).toThrow(/re=-1/);
    expect(() => unattendedRequest('#/?auto=1&stopAt=8&les=yes')).toThrow(/les=yes/);
  });
});

describe('case links seen by the page', () => {
  const specs = [...buildCases(), smokeCase()];

  it('opens every case without an ignored parameter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const spec of specs) decodeShareLink(caseHash(spec));
    expect(warn).not.toHaveBeenCalled();
  });

  it('reproduces every case at the speed, cell size and Reynolds number it is scored on', () => {
    for (const spec of specs) {
      const hash = caseHash(spec);
      const request = unattendedRequest(hash);
      if (request.kind !== 'case') throw new Error(`${spec.id} is not a case.`);
      const { parameters } = request;
      const settings = decodeShareLink(hash).settings;
      expect(settings.tier, spec.id).toBe(spec.tier);
      expect(parameters.stopAtSteps, spec.id).toBe(spec.steps);
      expect(parameters.les, spec.id).toBe(spec.les);
      expect(parameters.uLu, spec.id).toBe(spec.uLu);
      expect(parameters.lengthCells, spec.id).toBeCloseTo(spec.bodyLengthCells, 9);
      const scales = caseScales(settings, parameters, spec.bodyLengthCells);
      expect(scales.speedMps / spec.speedMps, spec.id).toBeCloseTo(1, 9);
      expect(scales.cellSizeM / spec.cellSizeM, spec.id).toBeCloseTo(1, 9);
      if (spec.re !== null) expect(scales.re / spec.re, spec.id).toBeCloseTo(1, 9);
    }
  });

  it('sets the lattice viscosity from the case Reynolds number without the interactive floor', () => {
    const ahmed = specs.find((spec) => spec.id === 'ahmed-25-L-reg-default');
    if (ahmed === undefined || ahmed.re === null)
      throw new Error('The tier-L Ahmed case is missing.');
    const hash = caseHash(ahmed);
    const request = unattendedRequest(hash);
    if (request.kind !== 'case') throw new Error('The Ahmed case is not a case.');
    const scales = caseScales(decodeShareLink(hash).settings, request.parameters, 128);
    expect(scales.viscosityLu).toBeCloseTo((U_LU * 128) / ahmed.re, 15);
    expect(scales.viscosityLu).toBeLessThan(1e-5);
  });
});

describe('grid refinement physics', () => {
  it('keeps the coarse-grid Re 320 at 64, 96 and 128 cells', () => {
    for (const lengthCells of [64, 96, 128]) {
      const viscosity = gridCheckViscosity(320, lengthCells);
      expect((U_LU * lengthCells) / viscosity).toBeCloseTo(320, 12);
    }
  });
});
