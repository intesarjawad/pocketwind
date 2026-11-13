import { describe, expect, it, vi } from 'vitest';
import {
  type BenchReport,
  copyBandwidthGBps,
  issueUrl,
  measuredMlups,
  parseBenchParams,
  rooflineMlups,
  tierResult,
  timestampEncoder,
} from '../../../src/app/bench-page';

const report: BenchReport = {
  copyGBps: 100,
  perTier: { S: { mlups: 400, msPerStep: 1.3, rooflinePct: 62.4 } },
  adapter: { vendor: 'acme', architecture: 'gen1', device: '', description: 'Test GPU' },
  features: ['timestamp-query'],
  userAgent: 'test-agent',
  timing: 'timestamp-query',
  steps: 500,
};

describe('bench parameters', () => {
  it('defaults to tiers S, M, L and 500 steps', () => {
    expect(parseBenchParams('#/bench')).toEqual({ tiers: ['S', 'M', 'L'], steps: 500 });
  });

  it('reads tiers and steps from the hash', () => {
    expect(parseBenchParams('#/bench?tiers=L,S&steps=40')).toEqual({
      tiers: ['L', 'S'],
      steps: 40,
    });
  });

  it('drops unknown and repeated tiers and falls back on bad steps', () => {
    expect(parseBenchParams('#/bench?tiers=M,Q,M&steps=-3')).toEqual({ tiers: ['M'], steps: 500 });
    expect(parseBenchParams('#/bench?tiers=none&steps=1.5')).toEqual({
      tiers: ['S', 'M', 'L'],
      steps: 500,
    });
  });
});

describe('bench arithmetic', () => {
  it('counts a read and a write per copy pass', () => {
    // 2 x 1e9 bytes x 10 passes in 200 ms is 100 GB/s.
    expect(copyBandwidthGBps(1e9, 10, 200)).toBe(100);
  });

  it('turns bandwidth into a lattice-update ceiling for each precision', () => {
    // 156 GB/s / 156 B per update = 1000 million updates per second; 80 B halves the denominator.
    expect(rooflineMlups(156, 'f32')).toBe(1000);
    expect(rooflineMlups(80, 'f16')).toBe(1000);
  });

  it('measures million lattice updates per second', () => {
    // 1e6 cells x 100 steps in 250 ms is 4e8 updates per second.
    expect(measuredMlups(1e6, 100, 250)).toBe(400);
  });

  it('reports milliseconds per step and the share of the roofline', () => {
    expect(tierResult(1e6, 100, 250, 156)).toEqual({
      mlups: 400,
      msPerStep: 2.5,
      rooflinePct: 40,
    });
  });
});

describe('issue link', () => {
  it('prefills the bench report template with the adapter name and the report', () => {
    const url = new URL(issueUrl(report));
    expect(url.origin + url.pathname).toBe('https://github.com/intesarjawad/pocketwind/issues/new');
    expect(url.searchParams.get('template')).toBe('bench-report.yml');
    expect(url.searchParams.get('title')).toBe('Bench: acme gen1 Test GPU');
    expect(JSON.parse(url.searchParams.get('report') ?? '')).toEqual(report);
  });
});

describe('timestamp encoder', () => {
  it('stamps only the first and last pass', () => {
    const begin = vi
      .fn<GPUCommandEncoder['beginComputePass']>()
      .mockReturnValue({} as GPUComputePassEncoder);
    const querySet = {} as GPUQuerySet;
    const encoder = timestampEncoder({ beginComputePass: begin }, querySet, 3);
    for (let i = 0; i < 3; i += 1) encoder.beginComputePass();
    expect(begin.mock.calls.map(([descriptor]) => descriptor)).toEqual([
      { timestampWrites: { querySet, beginningOfPassWriteIndex: 0 } },
      {},
      { timestampWrites: { querySet, endOfPassWriteIndex: 1 } },
    ]);
  });

  it('writes both indices when there is a single pass', () => {
    const begin = vi
      .fn<GPUCommandEncoder['beginComputePass']>()
      .mockReturnValue({} as GPUComputePassEncoder);
    const querySet = {} as GPUQuerySet;
    timestampEncoder({ beginComputePass: begin }, querySet, 1).beginComputePass({ label: 'copy' });
    expect(begin).toHaveBeenCalledWith({
      label: 'copy',
      timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
    });
  });
});
