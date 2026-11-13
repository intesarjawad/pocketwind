export const MIN_NODE_MAJOR = 20;

/** @param {string} url */
export function bannerLines(url) {
  return [url, 'Runs on this machine. Nothing leaves it.', 'Press Ctrl+C to stop.'];
}

/** @param {string} version */
export function nodeTooOld(version) {
  return `Node ${version} is too old. Install Node ${MIN_NODE_MAJOR} or newer, then run \`npx pocketwind\` again.`;
}

/** @param {number} port */
export function portInUse(port) {
  return `Port ${port} is already in use. Run \`npx pocketwind --port <number>\` with a free port.`;
}

/** @param {string} value */
export function badPort(value) {
  return `"${value}" is not a port number. Use \`--port\` with a whole number from 0 to 65535.`;
}

/** @param {string} argument */
export function unknownArgument(argument) {
  return `Unknown option ${argument}. Use \`--port <number>\` or \`--no-open\`.`;
}

export const siteMissing =
  'The packaged site is missing. Reinstall with `npm install pocketwind`, or run `npm run build` in a checkout.';

/** @param {string} url */
export function openFailed(url) {
  return `Could not open a browser. Open ${url} yourself.`;
}
