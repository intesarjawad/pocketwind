import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, webkit } from '@playwright/test';
import { build, preview } from 'vite';
import { probeCapabilities } from './probe-capabilities';
import { type AdapterProbe, requireF16, updateProbeTable } from './probe-report';

async function probeAdapters(): Promise<void> {
  const reportPath = 'docs/browser-support.md';
  const document = await readFile(reportPath, 'utf8');
  if (!existsSync('dist/index.html')) await build();
  const server = await preview({ preview: { host: '127.0.0.1', port: 0, open: false } });
  const probes: AdapterProbe[] = [];
  try {
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Vite preview has no local URL. Check the preview configuration.');
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: false });
      try {
        const page = await browser.newPage();
        // The validation route leaves adapter creation to the probe.
        await page.goto(`${url}#/validate`);
        const result = await page.evaluate(probeCapabilities);
        probes.push({ engine: engine.name(), browserVersion: browser.version(), ...result });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  await writeFile(reportPath, updateProbeTable(document, probes, new Date().toISOString()));
  process.stdout.write(`${JSON.stringify(probes, null, 2)}\n`);
  requireF16(probes);
}

probeAdapters().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
