import type { Page } from '@playwright/test';

/** How long a probe waits for the element to load or fail before the journey fails. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Whether a `blob:` URL can still be loaded in the page. The media cache revokes the URL of a
 * rendition it drops; an image already decoded stays on screen, so this is how a journey sees
 * that the bytes were released (or, for a URL still shown elsewhere, that they were not). It
 * loads the URL into a fresh element of `kind`: the app's CSP allows `blob:` for images and
 * media but not for `fetch`. An element that neither loads nor fails within
 * {@link PROBE_TIMEOUT_MS} rejects, so a stuck probe can never read as "revoked".
 *
 * For a clip passed to {@link playToEnd}, the positive control is the clip itself: an element
 * just loaded and played it from this very URL, so a probe that now fails to load it shows
 * the URL was revoked, not that the probe cannot load media.
 */
export function isBlobAlive(
  page: Page,
  url: string,
  kind: 'image' | 'video' | 'audio',
): Promise<boolean> {
  return page.evaluate(
    ({ blobUrl, tag, timeoutMs }) =>
      new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `isBlobAlive: ${tag} ${blobUrl} neither loaded nor failed in ${timeoutMs} ms`,
              ),
            ),
          timeoutMs,
        );
        const settle = (alive: boolean) => {
          clearTimeout(timer);
          resolve(alive);
        };
        if (tag === 'image') {
          const image = new Image();
          image.onload = () => settle(true);
          image.onerror = () => settle(false);
          image.src = blobUrl;
          return;
        }
        const media = document.createElement(tag);
        media.preload = 'metadata';
        media.onloadedmetadata = () => settle(true);
        media.onerror = () => settle(false);
        media.src = blobUrl;
      }),
    { blobUrl: url, tag: kind, timeoutMs: PROBE_TIMEOUT_MS },
  );
}

/**
 * Start a clip with `start` and wait until a `<video>` or `<audio>` of `kind` plays to its
 * end. Resolves with the `blob:` URL it played. The listener is armed before `start` runs, so
 * a clip short enough to end at once is not missed.
 */
export async function playToEnd(
  page: Page,
  kind: 'video' | 'audio',
  start: () => Promise<void>,
): Promise<string> {
  const token = `__ended${Math.random().toString(36).slice(2)}`;
  await page.evaluate(
    ({ key, tag }) => {
      const store = window as unknown as Record<string, string | undefined>;
      document.addEventListener(
        'ended',
        (event) => {
          const media = event.target as HTMLMediaElement;
          if (media.localName === tag && store[key] === undefined) {
            store[key] = media.currentSrc || media.src;
          }
        },
        { capture: true },
      );
    },
    { key: token, tag: kind },
  );
  await start();
  const handle = await page.waitForFunction(
    (key) => (window as unknown as Record<string, string | undefined>)[key],
    token,
    { timeout: 60_000 },
  );
  return (await handle.jsonValue()) as string;
}
