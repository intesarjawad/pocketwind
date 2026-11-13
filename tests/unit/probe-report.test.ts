import { describe, expect, it } from 'vitest';
import { type AdapterProbe, requireF16, updateProbeTable } from '../../scripts/probe-report';

const document =
  'Before\n<!-- adapter-probe:start -->\nOld table\n<!-- adapter-probe:end -->\nAfter\n';
const available: AdapterProbe = {
  engine: 'chromium',
  browserVersion: 'test-version',
  userAgent: 'test|agent\nline',
  status: 'available',
  features: ['shader-f16', 'timestamp-query'],
  limits: { maxBufferSize: 256 * 1024 * 1024 },
};

describe('adapter probe report', () => {
  it('replaces only the marked table with measured capabilities', () => {
    const result = updateProbeTable(document, [available], '2026-11-05T00:00:00Z');
    expect(result).toMatch(/^Before\n<!-- adapter-probe:start -->/);
    expect(result).toMatch(/<!-- adapter-probe:end -->\nAfter\n$/);
    expect(result).not.toContain('Old table');
    expect(result).toContain('Measured: 2026-11-05T00:00:00Z');
    expect(result).toContain('shader-f16, timestamp-query');
    expect(result).toContain('maxBufferSize: 268435456');
    expect(result).toContain('test&#124;agent line');
  });

  it('rejects missing or reversed markers rather than overwriting the document', () => {
    expect(() => updateProbeTable('No table', [], 'now')).toThrow('markers');
    expect(() =>
      updateProbeTable('<!-- adapter-probe:end --><!-- adapter-probe:start -->', [], 'now'),
    ).toThrow('markers');
  });

  it('fails the M5 acceptance when either engine lacks f16 or a device', () => {
    expect(() => requireF16([available, { ...available, engine: 'webkit' }])).not.toThrow();
    expect(() => requireF16([available, { ...available, engine: 'webkit', features: [] }])).toThrow(
      'webkit',
    );
    expect(() => requireF16([{ ...available, status: 'device-rejected' }])).toThrow('chromium');
  });
});
