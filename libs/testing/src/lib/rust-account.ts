import { isDeepStrictEqual } from 'node:util';
import { filter, firstValueFrom, timeout } from 'rxjs';
import type { EngineTransport } from '@trinity/util/matrix';
import { StdioTransport } from './engine-stdio-transport';

interface Session {
  baseUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
}

/**
 * Starts `session` on a Rust test host and waits until it has synced and prepared its rooms.
 * Node only, for tests.
 */
export async function startRustAccount(
  transport: EngineTransport,
  session: Session,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const started = await firstValueFrom(
    transport.open('session.restorePersisted', [session, 'activate']),
  );
  if (!isDeepStrictEqual(started, { ok: true, value: null })) {
    throw new Error(
      `session.restorePersisted failed: ${JSON.stringify(started)}`,
    );
  }
  await firstValueFrom(
    transport.open('session.session', []).pipe(
      filter((snapshot) => synced(snapshot, session.userId)),
      timeout(timeoutMs),
    ),
  );
}

/**
 * Starts the test host with `user` signed in on `baseUrl`, for a Rust contract spec to dispose.
 * Node only, for tests.
 */
export async function startTesthostAccount(
  baseUrl: string,
  user: { userId: string; deviceId: string; accessToken: string },
): Promise<StdioTransport> {
  const transport = StdioTransport.start();
  try {
    const { userId, deviceId, accessToken } = user;
    await startRustAccount(transport, {
      baseUrl,
      userId,
      deviceId,
      accessToken,
    });
    return transport;
  } catch (error) {
    await transport.dispose();
    throw error;
  }
}

/** Whether a `SessionSnapshot` shows `accountId` synced with its rooms prepared. */
function synced(snapshot: unknown, accountId: string): boolean {
  if (typeof snapshot !== 'object' || snapshot === null) return false;
  const accounts: unknown = Reflect.get(snapshot, 'accounts');
  return (
    Array.isArray(accounts) &&
    accounts.some(
      (account: unknown) =>
        typeof account === 'object' &&
        account !== null &&
        Reflect.get(account, 'accountId') === accountId &&
        Reflect.get(account, 'serverSynced') === true &&
        Reflect.get(account, 'roomsPrepared') === true,
    )
  );
}
