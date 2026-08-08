/**
 * Build identity and the escape hatch for a service worker that will not update.
 *
 * Browser-only, so it sits outside `src/utils` — that directory is compiled as
 * part of the MCP server too.
 */

export const APP_VERSION = __APP_VERSION__;
export const BUILD_TIME = __BUILD_TIME__;

export function formatBuildTime(iso: string = BUILD_TIME): string {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Throws away the service worker and every cache it filled, then reloads from
 * the network.
 *
 * `autoUpdate` normally handles this, but a worker that failed to activate — or
 * a precache holding an old `index.html` — leaves the app pinned to a build the
 * user cannot get rid of by reloading. The cache-busting query keeps the
 * document itself from coming back out of the HTTP cache.
 */
export async function forceUpdateApp(): Promise<void> {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }

  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }

  const { origin, pathname, hash } = window.location;
  window.location.replace(`${origin}${pathname}?reload=${Date.now()}${hash}`);
}
