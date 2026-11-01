import { createServer, type ServerResponse } from 'node:http';
import { browser } from '@wdio/globals';

/** `.invalid` never resolves, so a renderer that read anything would fail. */
const UNREACHABLE_HOMESERVER = 'https://unreachable.invalid';

/**
 * Replace one account's push handoff entry, through the app's own PushHandoff plugin, with a
 * token that expired a minute ago on a homeserver that cannot be reached. That is what an
 * OAuth account's entry amounts to once Trinity has been closed for longer than one token
 * lifetime. A renderer that tried to read would fail and show "New message". Run in the
 * WebView context.
 */
export async function storeExpiredPushAccount(userId: string): Promise<void> {
  const result = await browser.execute(
    async (id: string, homeserverUrl: string): Promise<string | null> => {
      const handoff = (
        window as typeof window & {
          Capacitor?: {
            Plugins?: {
              PushHandoff?: {
                setAccount(options: Record<string, unknown>): Promise<void>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.PushHandoff;
      if (!handoff) {
        return 'PushHandoff is unavailable';
      }
      try {
        await handoff.setAccount({
          userId: id,
          homeserverUrl,
          accessToken: 'expired-token',
          sound: true,
          accessTokenExpiresAt: Date.now() - 60_000,
        });
        return null;
      } catch (error: unknown) {
        return String(error);
      }
    },
    userId,
    UNREACHABLE_HOMESERVER,
  );
  if (typeof result === 'string') throw new Error(result);
}

/** One call on an installed Capacitor plugin, as it resolved. Run in the WebView context. */
export async function pluginCall(
  plugin: string,
  method: string,
  options: unknown,
): Promise<unknown> {
  const result = await browser.execute(
    async (
      pluginName: string,
      name: string,
      argument: unknown,
    ): Promise<{ answer: unknown } | { failure: string }> => {
      const installed = (
        window as typeof window & {
          Capacitor?: {
            Plugins?: Record<
              string,
              Record<string, (options: unknown) => Promise<unknown>>
            >;
          };
        }
      ).Capacitor?.Plugins?.[pluginName];
      if (!installed) return { failure: `${pluginName} is unavailable` };
      try {
        return { answer: await installed[name]?.(argument) };
      } catch (error: unknown) {
        return { failure: String(error) };
      }
    },
    plugin,
    method,
    options,
  );
  if ('failure' in result)
    throw new Error(`${plugin}.${method}: ${result.failure}`);
  return result.answer;
}

/** What {@link startPushStub}'s provider and homeserver saw. */
export interface PushStubCounts {
  readonly grants: number;
  readonly spentSends: number;
  readonly staleBearers: number;
}

/** A local token endpoint and homeserver that a push's refresh and reads reach. */
export interface PushStub {
  readonly url: string;
  counts(): PushStubCounts;
  close(): Promise<void>;
}

const STUB_PORT = 8449;
const STUB_REFRESH_TOKEN = 'e2e-stub-refresh';
const STUB_ROTATED_ACCESS_TOKEN = 'e2e-stub-rotated-access';

/**
 * A provider that spends its refresh token on receipt, and a homeserver that takes only the token
 * it rotated to and answers every event read with `text`. Plain HTTP on loopback: Android's native
 * code does not trust the run's Caddy CA, and reaches this port by ADB reverse (`run.mts`) under a
 * debug-only network security config. The Simulator shares the host's loopback.
 */
export async function startPushStub(
  text: string,
  sender: string,
): Promise<PushStub> {
  const counts = { grants: 0, spentSends: 0, staleBearers: 0 };
  let refreshToken: string | null = STUB_REFRESH_TOKEN;
  const answer = (
    response: ServerResponse,
    status: number,
    body: unknown,
  ): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (form.get('refresh_token') !== refreshToken) {
          counts.spentSends += 1;
          answer(response, 400, { error: 'invalid_grant' });
          return;
        }
        refreshToken = null;
        counts.grants += 1;
        answer(response, 200, {
          access_token: STUB_ROTATED_ACCESS_TOKEN,
          refresh_token: 'e2e-stub-rotated-refresh',
          expires_in: 300,
        });
      } else if (
        request.headers.authorization !== `Bearer ${STUB_ROTATED_ACCESS_TOKEN}`
      ) {
        counts.staleBearers += 1;
        answer(response, 401, { errcode: 'M_UNKNOWN_TOKEN' });
      } else if (request.url?.includes('/state/m.room.member/')) {
        answer(response, 200, { displayname: sender });
      } else {
        answer(response, 200, {
          type: 'm.room.message',
          sender: '@stub-sender:unknown.invalid',
          content: { msgtype: 'm.text', body: text },
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(STUB_PORT, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${STUB_PORT}`,
    counts: () => ({ ...counts }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Give one synthetic account what an OAuth account has once Trinity has been closed for longer
 * than a token lifetime: a tokenless handoff entry, an unencrypted stored room, and an expired vault
 * record whose token endpoint is `stub`. No sign-in is needed, but wait for the sign-in page first:
 * the startup sweep would remove this record. Run in the WebView context.
 */
export async function storeExpiredOAuthAccount(
  stub: PushStub,
  userId: string,
  room: { readonly roomId: string; readonly name: string },
): Promise<void> {
  const result = await browser.execute(
    async (
      id: string,
      url: string,
      refreshToken: string,
      stored: { readonly roomId: string; readonly name: string },
    ): Promise<string | null> => {
      const handoff = (
        window as typeof window & {
          Capacitor?: {
            Plugins?: {
              PushHandoff?: {
                migrateTokens(options: unknown): Promise<{ stored: boolean }>;
                setAccount(options: unknown): Promise<void>;
                setRooms(options: unknown): Promise<void>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.PushHandoff;
      if (!handoff) return 'PushHandoff is unavailable';
      try {
        const { stored: migrated } = await handoff.migrateTokens({
          userId: id,
          lineage: 'L',
          accessToken: 'e2e-stub-expired-access',
          refreshToken,
          accessTokenExpiresAt: Date.now() - 60_000,
          tokenEndpoint: `${url}/token`,
          clientId: 'e2e-stub-client',
          deviceId: 'E2ESTUB',
        });
        if (!migrated) return 'the vault did not store the record';
        await handoff.setAccount({
          userId: id,
          homeserverUrl: url,
          sound: true,
        });
        await handoff.setRooms({
          userId: id,
          rooms: [{ ...stored, direct: false, encrypted: false }],
        });
        return null;
      } catch (error: unknown) {
        return String(error);
      }
    },
    userId,
    stub.url,
    STUB_REFRESH_TOKEN,
    room,
  );
  if (typeof result === 'string') throw new Error(result);
}

/** What the installed PushHandoff plugin answers for an account it has no tokens for. */
export interface UnknownAccountTokenAnswers {
  readonly current: unknown;
  readonly refresh: unknown;
  /** Each removal that names neither one account nor all of them: how it was rejected. */
  readonly malformedRemovals: readonly string[];
  /** Each sweep without a list of user ids: how it was rejected. */
  readonly malformedSweeps: readonly string[];
}

/**
 * Call the token methods on the installed plugin directly, so a method the host failed to
 * register or a worker that never resolves fails here. Run in the WebView context.
 */
export async function tokenAnswersForUnknownAccount(
  userId: string,
): Promise<UnknownAccountTokenAnswers> {
  const result = await browser.execute(
    async (id: string): Promise<UnknownAccountTokenAnswers | string> => {
      const handoff = (
        window as typeof window & {
          Capacitor?: {
            Plugins?: {
              PushHandoff?: {
                currentTokens(options: unknown): Promise<unknown>;
                refreshTokens(options: unknown): Promise<unknown>;
                removeTokens(options: unknown): Promise<unknown>;
                removeTokensExcept(options: unknown): Promise<unknown>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.PushHandoff;
      if (!handoff) {
        return 'PushHandoff is unavailable';
      }
      try {
        return {
          current: await handoff.currentTokens({ userId: id, lineage: 'L' }),
          refresh: await handoff.refreshTokens({
            userId: id,
            lineage: 'L',
            tokenSeen: 'unused',
          }),
          malformedRemovals: await Promise.all(
            [
              {},
              { userId: 7 },
              { userId: '' },
              { all: false },
              { all: 1 },
              { userId: id, all: true },
            ].map((options) =>
              handoff.removeTokens(options).then(
                () => 'resolved',
                (error: unknown) => String(error),
              ),
            ),
          ),
          malformedSweeps: await Promise.all(
            [{}, { userIds: id }, { userIds: [7] }, { userIds: [''] }].map(
              (options) =>
                handoff.removeTokensExcept(options).then(
                  () => 'resolved',
                  (error: unknown) => String(error),
                ),
            ),
          ),
        };
      } catch (error: unknown) {
        return String(error);
      }
    },
    userId,
  );
  if (typeof result === 'string') throw new Error(result);
  return result;
}

/** Each answer of one no-network trip through the vault's write path, in order. */
export interface TokenRoundTrip {
  readonly stored: unknown;
  readonly current: unknown;
  readonly revokedUnknown: unknown;
  readonly sweepKeeping: unknown;
  readonly currentKept: unknown;
  readonly currentAfter: unknown;
  readonly sweepOfAll: unknown;
  readonly currentSwept: unknown;
  readonly currentAfterAll: unknown;
}

/**
 * Store synthetic tokens through the installed plugin, read them back, remove them, then store and
 * sweep them. Nothing here sends a grant: the only revocation names another account. This empties
 * the app's vault. Run in the WebView context.
 */
export async function tokenRoundTrip(
  userId: string,
  otherUserId: string,
  record: Record<string, unknown>,
): Promise<TokenRoundTrip> {
  const result = await browser.execute(
    async (
      id: string,
      otherId: string,
      tokens: Record<string, unknown>,
    ): Promise<TokenRoundTrip | string> => {
      const handoff = (
        window as typeof window & {
          Capacitor?: {
            Plugins?: {
              PushHandoff?: {
                migrateTokens(options: unknown): Promise<unknown>;
                currentTokens(options: unknown): Promise<unknown>;
                revokeTokens(options: unknown): Promise<unknown>;
                removeTokens(options: unknown): Promise<unknown>;
                removeTokensExcept(options: unknown): Promise<unknown>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.PushHandoff;
      if (!handoff) {
        return 'PushHandoff is unavailable';
      }
      const account = { userId: id, lineage: tokens['lineage'] };
      try {
        const stored = await handoff.migrateTokens({ ...tokens, userId: id });
        const current = await handoff.currentTokens(account);
        const revokedUnknown = await handoff.revokeTokens({
          ...account,
          userId: otherId,
        });
        const sweepKeeping = await handoff.removeTokensExcept({
          userIds: [id],
        });
        const currentKept = await handoff.currentTokens(account);
        await handoff.removeTokens({ userId: id });
        const currentAfter = await handoff.currentTokens(account);
        await handoff.migrateTokens({ ...tokens, userId: id });
        const sweepOfAll = await handoff.removeTokensExcept({ userIds: [] });
        const currentSwept = await handoff.currentTokens(account);
        await handoff.migrateTokens({ ...tokens, userId: id });
        await handoff.removeTokens({ all: true });
        const currentAfterAll = await handoff.currentTokens(account);
        return {
          stored,
          current,
          revokedUnknown,
          sweepKeeping,
          currentKept,
          currentAfter,
          sweepOfAll,
          currentSwept,
          currentAfterAll,
        };
      } catch (error: unknown) {
        return String(error);
      }
    },
    userId,
    otherUserId,
    record,
  );
  if (typeof result === 'string') throw new Error(result);
  return result;
}
