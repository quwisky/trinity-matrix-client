import type { Page } from '@playwright/test';

/**
 * Whether a `blob:` URL can still be loaded in the page. The media cache revokes the URL of a
 * rendition it drops; an image already decoded stays on screen, so this is how a journey sees
 * that the bytes were released (or, for a URL still shown elsewhere, that they were not). It
 * loads the URL into a fresh element of `kind`: the app's CSP allows `blob:` for images and
 * media but not for `fetch`.
 */
export function isBlobAlive(
  page: Page,
  url: string,
  kind: 'image' | 'video' | 'audio',
): Promise<boolean> {
  return page.evaluate(
    ({ blobUrl, tag }) =>
      new Promise<boolean>((resolve) => {
        if (tag === 'image') {
          const image = new Image();
          image.onload = () => resolve(true);
          image.onerror = () => resolve(false);
          image.src = blobUrl;
          return;
        }
        const media = document.createElement(tag);
        media.preload = 'metadata';
        media.onloadedmetadata = () => resolve(true);
        media.onerror = () => resolve(false);
        media.src = blobUrl;
      }),
    { blobUrl: url, tag: kind },
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
