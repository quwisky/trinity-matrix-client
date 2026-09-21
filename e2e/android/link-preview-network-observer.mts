import assert from 'node:assert/strict';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

export interface LinkPreviewRequestReceipt {
  readonly url: string;
  readonly method: 'GET';
  readonly initiatorCategory: string;
  readonly authenticated: boolean;
}

export interface LinkPreviewNetworkReceipt {
  readonly matrixPreviewCount: number;
  readonly directOgCount: number;
  readonly matrixRequest: LinkPreviewRequestReceipt;
  readonly directOgRequests: readonly LinkPreviewRequestReceipt[];
}

export interface LinkPreviewNetworkObserver {
  readonly closed: boolean;
  waitForPreview(): Promise<LinkPreviewNetworkReceipt>;
  close(): Promise<void>;
}

interface RequestShape {
  readonly method?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
}

function requestShape(
  value: Readonly<Record<string, unknown>>,
): RequestShape | undefined {
  const candidate = value['request'];
  return candidate && typeof candidate === 'object'
    ? (candidate as RequestShape)
    : undefined;
}

function initiatorCategory(
  value: Readonly<Record<string, unknown>>,
): string {
  const candidate = value['initiator'];
  if (!candidate || typeof candidate !== 'object') return 'unknown';
  const type = (candidate as { readonly type?: unknown }).type;
  return typeof type === 'string' ? type : 'unknown';
}

function hasBearerAuthentication(request: RequestShape): boolean {
  if (!request.headers || typeof request.headers !== 'object') return false;
  return Object.entries(request.headers).some(
    ([name, value]) =>
      name.toLowerCase() === 'authorization' &&
      typeof value === 'string' &&
      /^Bearer\s+\S+$/u.test(value),
  );
}

function sanitizedReceipt(
  request: RequestShape,
  url: URL,
  category: string,
): LinkPreviewRequestReceipt {
  assert.equal(request.method, 'GET');
  return {
    url: `${url.origin}${url.pathname}${url.search}`,
    method: request.method,
    initiatorCategory: category,
    authenticated: hasBearerAuthentication(request),
  };
}

function exactMatrixPreview(
  url: URL,
  request: RequestShape,
  homeserverOrigin: string,
  ogUrl: string,
): boolean {
  const pathname = url.pathname;
  return (
    request.method === 'GET' &&
    url.origin === homeserverOrigin &&
    pathname === '/_matrix/client/v1/media/preview_url' &&
    url.searchParams.get('url') === ogUrl
  );
}

function exactDirectOg(url: URL): boolean {
  const ogOrigin = url.origin;
  const ogPathname = url.pathname;
  return (
    (ogOrigin === 'http://caddy:8080' ||
      ogOrigin === 'http://localhost:8080') &&
    ogPathname === '/og'
  );
}

async function closeConnection(
  connection: DevtoolsEventConnection,
  unsubscribe: () => void,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    unsubscribe();
  } catch (error) {
    failures.push(error);
  }
  try {
    await connection.send('Network.disable');
  } catch (error) {
    failures.push(error);
  }
  try {
    connection.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(
      failures,
      'Link-preview Network observer cleanup failed',
    );
  }
}

export async function openLinkPreviewNetworkObserver(
  client: AccountWorkspaceClient,
  homeserver: string,
  ogUrl: string,
  signal: AbortSignal,
): Promise<LinkPreviewNetworkObserver> {
  const connection = await client.webview.openSession();
  const homeserverOrigin = new URL(homeserver).origin;
  let matrixPreviewCount = 0;
  let matrixRequest: LinkPreviewRequestReceipt | undefined;
  let directOgCount = 0;
  let directOgRequest: LinkPreviewRequestReceipt | undefined;
  let closed = false;
  const unsubscribe = connection.on('Network.requestWillBeSent', (value) => {
    const request = requestShape(value);
    if (!request || request.method !== 'GET' || typeof request.url !== 'string') {
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    const category = initiatorCategory(value);
    if (exactMatrixPreview(url, request, homeserverOrigin, ogUrl)) {
      matrixPreviewCount += 1;
      matrixRequest = sanitizedReceipt(request, url, category);
    } else if (exactDirectOg(url)) {
      directOgCount += 1;
      directOgRequest ??= sanitizedReceipt(request, url, category);
    }
  });
  try {
    await connection.send('Network.enable');
  } catch (error) {
    await closeConnection(connection, unsubscribe).catch(() => undefined);
    throw error;
  }

  return {
    get closed() {
      return closed;
    },
    async waitForPreview() {
      assert(!closed, 'Link-preview Network observer is open');
      const observedMatrixRequest = await waitForNativeShellState(
        async () => matrixRequest,
        (candidate) => candidate !== undefined,
        'exact authenticated Matrix preview_url request for the arranged URL',
        signal,
        60_000,
      );
      assert(observedMatrixRequest);
      return {
        matrixPreviewCount,
        directOgCount,
        matrixRequest: observedMatrixRequest,
        directOgRequests: directOgRequest ? [directOgRequest] : [],
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeConnection(connection, unsubscribe);
    },
  };
}
