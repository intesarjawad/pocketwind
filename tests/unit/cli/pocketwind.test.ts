import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const bin = join(root, 'bin/pocketwind.mjs');
const children: ChildProcess[] = [];

function start(args: string[]): ChildProcess {
  const child = spawn(process.execPath, [bin, '--no-open', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function collect(stream: NodeJS.ReadableStream | null, until: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(
      () => reject(new Error(`no output matching ${until}: ${text}`)),
      10_000,
    );
    stream?.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (until.test(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    });
  });
}

async function serve(): Promise<{ child: ChildProcess; origin: string; banner: string }> {
  const child = start(['--port', '0']);
  const banner = await collect(child.stdout, /Ctrl\+C/);
  const origin = /^(http:\/\/127\.0\.0\.1:\d+)\/pocketwind\/$/m.exec(banner)?.[1];
  if (!origin) throw new Error(`no URL in banner: ${banner}`);
  return { child, origin, banner };
}

/** Sends the target untouched; fetch would normalize `..` away. */
function rawGet(origin: string, target: string): Promise<number> {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(() => {
  if (existsSync(join(root, 'dist/index.html'))) return;
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: root,
    stdio: 'ignore',
  });
}, 180_000);

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe('pocketwind command', () => {
  it('prints usage and exits successfully for help without starting a server', () => {
    for (const flag of ['--help', '-h']) {
      const help = spawnSync(process.execPath, [bin, flag], { encoding: 'utf8', timeout: 2000 });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage: pocketwind');
      expect(help.stdout).toContain('--no-open');
      expect(help.stderr).toBe('');
    }
  });

  it('serves index.html under the base path with the right type', async () => {
    const { origin, banner } = await serve();
    expect(banner.split('\n').slice(1, 3)).toEqual([
      'Runs on this machine. Nothing leaves it.',
      'Press Ctrl+C to stop.',
    ]);
    const response = await fetch(`${origin}/pocketwind/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('<html');
  });

  it('serves the worker chunk as JavaScript', async () => {
    const { origin } = await serve();
    const worker = readdirSync(join(root, 'dist/assets')).find((name) =>
      /^worker-.*\.js$/.test(name),
    );
    expect(worker).toBeDefined();
    const response = await fetch(`${origin}/pocketwind/assets/${worker}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('answers 404 to paths that leave dist or the base path', async () => {
    const { origin } = await serve();
    expect(await rawGet(origin, '/pocketwind/../package.json')).toBe(404);
    expect(await rawGet(origin, '/pocketwind/%2e%2e/package.json')).toBe(404);
    expect(await rawGet(origin, '/pocketwind/assets/../../package.json')).toBe(404);
    expect(await rawGet(origin, '/package.json')).toBe(404);
    expect(await rawGet(origin, '/pocketwind/missing.js')).toBe(404);
  });

  it('exits 1 with a message when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const child = start(['--port', String(port)]);
      const errors = collect(child.stderr, /already in use/);
      const code = new Promise((resolve) => child.on('exit', resolve));
      expect(await errors).toBe(
        `Port ${port} is already in use. Run \`npx pocketwind --port <number>\` with a free port.\n`,
      );
      expect(await code).toBe(1);
    } finally {
      blocker.close();
    }
  });

  it('keeps BASE_PATH equal to the Vite base', () => {
    const vite = /base:\s*'([^']+)'/.exec(readFileSync(join(root, 'vite.config.ts'), 'utf8'));
    const server = /const BASE_PATH = '([^']+)'/.exec(readFileSync(bin, 'utf8'));
    expect(vite?.[1]).toBe('/pocketwind/');
    expect(server?.[1]).toBe(vite?.[1]);
  });
});
