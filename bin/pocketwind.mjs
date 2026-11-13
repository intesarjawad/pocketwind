#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  badPort,
  bannerLines,
  MIN_NODE_MAJOR,
  nodeTooOld,
  openFailed,
  portInUse,
  siteMissing,
  unknownArgument,
} from './messages.mjs';

/** Must equal `base` in vite.config.ts. */
const BASE_PATH = '/pocketwind/';
const DEFAULT_PORT = 4317;
const HOST = '127.0.0.1';
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.stl': 'model/stl',
};

/** @param {string} text */
function fail(text) {
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

/** @param {string[]} args */
function parseArgs(args) {
  let port = DEFAULT_PORT;
  let open = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--no-open') open = false;
    else if (arg === '--port') {
      const value = args[++i] ?? '';
      port = Number(value);
      if (!/^\d+$/.test(value) || port > 65535) fail(badPort(value));
    } else fail(unknownArgument(arg));
  }
  return { port, open };
}

/** Maps a raw request target to a file inside dist/, or null when it is outside the site. */
function resolveRequest(target = '') {
  const rawPath = target.split(/[?#]/)[0] ?? '';
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!path.startsWith(BASE_PATH) || path.includes('\0')) return null;
  const file = resolve(DIST, path.slice(BASE_PATH.length));
  const inside = relative(DIST, file);
  return inside === '..' || inside.startsWith(`..${sep}`) || resolve(inside) === inside
    ? null
    : file;
}

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function handle(req, res) {
  const plain = (/** @type {number} */ status, /** @type {string} */ text) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : text);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed');
  if (req.url === '/') {
    res.writeHead(302, { location: BASE_PATH });
    return res.end();
  }
  let file = resolveRequest(req.url);
  if (!file) return plain(404, 'Not found');
  try {
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const { size } = await stat(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': size,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    plain(404, 'Not found');
  }
}

/** @param {string} url */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(command ?? '', args, { stdio: 'ignore', detached: true });
  child.on('error', () => process.stderr.write(`${openFailed(url)}\n`));
  child.unref();
}

function main() {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write(
      'Usage: pocketwind [--port <0-65535>] [--no-open]\n\nServe the built tunnel locally. Port 0 chooses a free port.\n  --port     Listening port (default 4317)\n  --no-open  Do not open the browser\n  --help, -h Show this help\n',
    );
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    fail(nodeTooOld(process.versions.node));
  }
  const { port, open } = parseArgs(process.argv.slice(2));
  if (!existsSync(resolve(DIST, 'index.html'))) fail(siteMissing);
  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.on('error', (/** @type {NodeJS.ErrnoException} */ error) => {
    fail(error.code === 'EADDRINUSE' ? portInUse(port) : error.message);
  });
  server.listen(port, HOST, () => {
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    const url = `http://${HOST}:${bound}${BASE_PATH}`;
    process.stdout.write(`${bannerLines(url).join('\n')}\n`);
    if (open) openBrowser(url);
  });
}

main();
