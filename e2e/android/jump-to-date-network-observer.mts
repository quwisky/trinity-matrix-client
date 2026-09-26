import assert from 'node:assert/strict';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import type { MaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

export interface JumpToDateLookupReceipt {
  readonly method: 'GET';
  readonly origin: string;
  readonly pathname: string;
  readonly roomId: string;
  readonly direction: 'f';
  readonly timestamp: number;
}

export interface JumpToDateNetworkObserver {
  readonly closed: boolean;
  readonly matchCount: number;
  waitForLookup(): Promise<JumpToDateLookupReceipt>;
  close(): Promise<void>;
}

function matchingLookup(
  value: Readonly<Record<string, unknown>>,
  homeserverOrigin: string,
  roomId: string,
): JumpToDateLookupReceipt | undefined {
  const requestValue = value['request'];
  if (!requestValue || typeof requestValue !== 'object') return undefined;
  const request = requestValue as {
    readonly method?: unknown;
    readonly url?: unknown;
  };
  if (request.method !== 'GET' || typeof request.url !== 'string') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }
  const pathname = url.pathname;
  const segments = pathname.split('/');
  const roomSegment = segments.at(-2);
  const timestampText = url.searchParams.get('ts');
  const timestamp = timestampText === null ? Number.NaN : Number(timestampText);
  if (
    url.origin !== homeserverOrigin ||
    !pathname.endsWith('/timestamp_to_event') ||
    roomSegment === undefined ||
    decodeURIComponent(roomSegment) !== roomId ||
    url.searchParams.get('dir') !== 'f' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    return undefined;
  }
  return {
    method: 'GET',
    origin: url.origin,
    pathname,
    roomId,
    direction: 'f',
    timestamp,
  };
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
      'Jump-to-date Network observer cleanup failed',
    );
  }
}

export async function openJumpToDateNetworkObserver(
  client: AccountWorkspaceClient,
  homeserver: string,
  roomId: string,
  signal: AbortSignal,
): Promise<JumpToDateNetworkObserver> {
  const connection = await client.webview.openSession();
  const homeserverOrigin = new URL(homeserver).origin;
  const receipts: JumpToDateLookupReceipt[] = [];
  let closed = false;
  const unsubscribe = connection.on('Network.requestWillBeSent', (value) => {
    const receipt = matchingLookup(value, homeserverOrigin, roomId);
    if (receipt) receipts.push(receipt);
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
    get matchCount() {
      return receipts.length;
    },
    async waitForLookup() {
      assert(!closed, 'Jump-to-date Network observer is open');
      const receipt = await waitForNativeShellState(
        async () => receipts.at(-1),
        (candidate) => candidate !== undefined,
        'exact forward timestamp_to_event request for the arranged Room',
        signal,
        60_000,
      );
      assert(receipt);
      return receipt;
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeConnection(connection, unsubscribe);
    },
  };
}

export async function readDeviceLocalDate(
  device: MaestroDevice,
): Promise<string> {
  const date = (await device.adb('shell', 'date', '+%F')).trim();
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/u, 'Device date is YYYY-MM-DD');
  return date;
}
