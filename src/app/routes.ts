import {
  type DecodedShareLink,
  decodeShareLink,
  encodeShareLink,
  SHARE_ROUTES,
  type ShareRoute,
} from '../io/share-link';
import { isEmbed } from './embed';
import type { Settings } from './settings';

export type Route = ShareRoute;

export const ROUTES = SHARE_ROUTES;

export const ROUTE_TITLES: Record<Route, string> = {
  '': 'Tunnel',
  validate: 'Validation results',
  bench: 'Performance results',
};

/** Read the hash once; unknown routes and values fall back with a warning. */
export function readRoute(hash: string = location.hash): DecodedShareLink {
  return decodeShareLink(hash);
}

export function currentRoute(hash: string = location.hash): Route {
  return readRoute(hash).route;
}

/** Keep a control's link pointing at the current settings on another route. */
export function routeHash(route: Route, settings: Settings): string {
  return encodeShareLink(settings, route);
}

/** Only the tunnel has a frame view; the results routes ignore the flag. */
export function isEmbedRoute(hash: string = location.hash): boolean {
  return currentRoute(hash) === '' && isEmbed(hash);
}

/** The results pages draw no wind tunnel, so its canvas must not be announced as an image. */
export function tunnelHiddenOn(route: Route): boolean {
  return route !== '';
}

function hideTunnel(route: Route): void {
  const tunnel = document.querySelector('#tunnel');
  if (tunnelHiddenOn(route) && tunnel instanceof HTMLElement) tunnel.hidden = true;
}

/** Re-render on navigation and report the first route immediately. */
export function watchRoute(listener: (link: DecodedShareLink) => void): () => void {
  const notify = () => {
    const link = readRoute();
    hideTunnel(link.route);
    listener(link);
  };
  window.addEventListener('hashchange', notify);
  notify();
  return () => window.removeEventListener('hashchange', notify);
}
