import { describe, expect, it } from 'vitest';
import { buildCases, smokeCase } from '../../../src/validation/cases';
import { caseHash, gridCheckHash } from '../../../src/validation/links';

function hashOf(id: string): string {
  const spec = [...buildCases(), smokeCase()].find((entry) => entry.id === id);
  if (!spec) throw new Error(`Case ${id} is missing.`);
  return caseHash(spec);
}

describe('case links', () => {
  it('starts the tier-L Ahmed default for six flow-throughs of 5120 steps', () => {
    expect(hashOf('ahmed-25-L-reg-default')).toBe(
      '#/?p=ahmed-25&t=L&st=f32&op=reg&w=bb&v=40&len=1044&ax=x&sg=1&up=z&fl=1&les=1&lc=128&auto=1&stopAt=30720',
    );
  });

  it('gives the laminar sphere its Reynolds number instead of a speed below the slider', () => {
    expect(hashOf('sphere-re-100-S-trt')).toBe(
      '#/?p=sphere&t=S&st=f32&op=trt&w=bb&v=5&len=100&ax=x&sg=1&up=z&fl=0&re=100&les=0&lc=16&auto=1&stopAt=15360',
    );
  });

  it('turns LES on and the floor off for the shape classes', () => {
    expect(hashOf('cube-S')).toBe(
      '#/?p=cube&t=S&st=f32&op=reg&w=bb&v=40&len=200&ax=x&sg=1&up=z&fl=0&les=1&lc=12.8&auto=1&stopAt=15360',
    );
    expect(hashOf('sphere-S')).toContain('&re=20000&les=1&');
  });

  it('runs the confinement cube on the XL grid at its tier-L size in cells', () => {
    expect(hashOf('cube-confinement-trt')).toContain('&t=XL&');
    expect(hashOf('cube-confinement-trt')).toContain('&lc=25.6&');
  });

  it('adds the inlet speed and the stilts switch only where a row varies them', () => {
    expect(hashOf('sensitivity-u-lu-0.1')).toContain('&ulu=0.1&');
    expect(hashOf('sensitivity-u-lu-0.1')).not.toContain('stilts');
    expect(hashOf('sensitivity-stilts-excluded')).toContain('&stilts=0&');
    expect(hashOf('ahmed-25-L-reg-default')).not.toContain('ulu');
    expect(hashOf('ahmed-25-L-reg-default')).not.toContain('stilts');
  });

  it('stops the smoke case after two flow-throughs', () => {
    expect(hashOf('smoke-ahmed-25-S')).toMatch(/&stopAt=5120$/);
  });

  it('opens a preset on its grid check', () => {
    expect(gridCheckHash('ahmed-25')).toBe('#/?p=ahmed-25&gc=1&auto=1');
  });
});
