import assert from 'node:assert/strict';
import type { MaestroWebview } from './maestro-webview.mts';

const GIF_BASE64 =
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PREVIEW_URL = 'https://media.klipy.com/e2e-preview/trinity.gif';
const FULL_URL = 'https://media.klipy.com/e2e-full/trinity.gif';
const MAX_REQUESTS = 64;

const activeConnections = new WeakSet<MaestroWebview>();

export interface GifProviderResponse {
  readonly contentType: 'application/json' | 'image/gif';
  readonly body: string;
}

export interface GifProviderRequest {
  readonly host: 'api.klipy.com' | 'media.klipy.com';
  readonly path: string;
  readonly kind: 'api' | 'media';
}

export interface GifProviderFixture {
  readonly requests: readonly GifProviderRequest[];
  close(): Promise<void>;
}

export function gifProviderResponse(
  input: string,
): GifProviderResponse | undefined {
  const url = new URL(input);
  if (url.protocol !== 'https:') return undefined;
  if (url.hostname === 'api.klipy.com') {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            id: 'e2e-1',
            content_description: 'e2e gif',
            media_formats: {
              gif: { url: FULL_URL, dims: [1, 1] },
              tinygif: { url: PREVIEW_URL, dims: [1, 1] },
            },
          },
        ],
      }),
    };
  }
  if (url.hostname === 'media.klipy.com') {
    return {
      contentType: 'image/gif',
      body: Buffer.from(GIF_BASE64, 'base64').toString('binary'),
    };
  }
  return undefined;
}

function pausedRequest(value: Readonly<Record<string, unknown>>): {
  readonly requestId: string;
  readonly url: string;
} {
  const requestId = value['requestId'];
  const request = value['request'];
  assert(typeof requestId === 'string', 'GIF Fetch request id is present');
  assert(request && typeof request === 'object', 'GIF Fetch request is present');
  const url = (request as Readonly<Record<string, unknown>>)['url'];
  assert(typeof url === 'string', 'GIF Fetch request URL is present');
  return { requestId, url };
}

export async function createGifProviderFixture(
  webview: MaestroWebview,
): Promise<GifProviderFixture> {
  assert(
    !activeConnections.has(webview),
    'Only one GIF Fetch controller may own a WebView',
  );
  activeConnections.add(webview);
  const connection = await webview.openSession();
  const requests: GifProviderRequest[] = [];
  let closed = false;
  let eventFailure: unknown;
  let work = Promise.resolve();

  const handle = async (
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const paused = pausedRequest(value);
    const response = gifProviderResponse(paused.url);
    if (!response) {
      await connection.send('Fetch.continueRequest', {
        requestId: paused.requestId,
      });
      return;
    }
    const url = new URL(paused.url);
    assert(
      url.hostname === 'api.klipy.com' || url.hostname === 'media.klipy.com',
      'GIF fixture only records pinned hosts',
    );
    assert(requests.length < MAX_REQUESTS, 'GIF fixture request bound exceeded');
    requests.push({
      host: url.hostname,
      path: url.pathname,
      kind: url.hostname === 'api.klipy.com' ? 'api' : 'media',
    });
    await connection.send('Fetch.fulfillRequest', {
      requestId: paused.requestId,
      responseCode: 200,
      responsePhrase: 'OK',
      responseHeaders: [
        { name: 'Content-Type', value: response.contentType },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(response.body, 'binary').toString('base64'),
    });
  };

  const unsubscribe = connection.on('Fetch.requestPaused', (value) => {
    if (closed) return;
    work = work.then(() => handle(value)).catch((error: unknown) => {
      eventFailure ??= error;
    });
  });

  try {
    await connection.send('Fetch.enable', {
      patterns: [
        {
          urlPattern: 'https://api.klipy.com/*',
          requestStage: 'Request',
        },
        {
          urlPattern: 'https://media.klipy.com/*',
          requestStage: 'Request',
        },
      ],
    });
  } catch (error) {
    unsubscribe();
    activeConnections.delete(webview);
    connection.close();
    throw error;
  }

  const throwIfFailed = (): void => {
    if (eventFailure !== undefined) throw eventFailure;
  };

  return {
    get requests() {
      throwIfFailed();
      return [...requests];
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribe();
      const failures: unknown[] = [];
      try {
        await work;
        throwIfFailed();
      } catch (error) {
        failures.push(error);
      }
      try {
        await connection.send('Fetch.disable');
      } catch (error) {
        failures.push(error);
      } finally {
        activeConnections.delete(webview);
        connection.close();
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          'GIF provider fixture cleanup failed',
        );
      }
    },
  };
}
