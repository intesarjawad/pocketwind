export interface AdapterProbe {
  engine: string;
  browserVersion: string;
  userAgent: string;
  status: 'available' | 'missing-api' | 'no-adapter' | 'device-rejected';
  features: string[];
  limits: Record<string, number>;
}

const TABLE_START = '<!-- adapter-probe:start -->';
const TABLE_END = '<!-- adapter-probe:end -->';

function tableCell(value: string): string {
  return value.replaceAll('|', '&#124;').replaceAll(/\r?\n/g, ' ');
}

export function updateProbeTable(
  document: string,
  probes: AdapterProbe[],
  measuredAt: string,
): string {
  const start = document.indexOf(TABLE_START);
  const end = document.indexOf(TABLE_END);
  if (start < 0 || end < start) {
    throw new Error(
      'Adapter table markers are missing or out of order in docs/browser-support.md.',
    );
  }
  const rows = probes.map((probe) => {
    const limits = Object.entries(probe.limits)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}: ${value}`)
      .join('<br>');
    return `| ${[
      probe.engine,
      probe.browserVersion,
      probe.status,
      probe.features.join(', ') || 'none',
      limits || 'none',
      probe.userAgent,
    ]
      .map(tableCell)
      .join(' | ')} |`;
  });
  const table = [
    TABLE_START,
    `Measured: ${measuredAt}`,
    '',
    '| Engine | Browser version | Status | Features | Limits | User agent |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    TABLE_END,
  ].join('\n');
  return document.slice(0, start) + table + document.slice(end + TABLE_END.length);
}

export function requireF16(probes: AdapterProbe[]): void {
  const unavailable = probes.filter(
    (probe) => probe.status !== 'available' || !probe.features.includes('shader-f16'),
  );
  if (unavailable.length > 0) {
    throw new Error(
      `shader-f16 is unavailable in ${unavailable.map((probe) => probe.engine).join(', ')}. Open the GPU diagnostics and check docs/browser-support.md.`,
    );
  }
}
