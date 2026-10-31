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

/** What the installed PushHandoff plugin answers for an account it has no tokens for. */
export interface UnknownAccountTokenAnswers {
  readonly current: unknown;
  readonly refresh: unknown;
  /** Each removal that names neither one account nor all of them: how it was rejected. */
  readonly malformedRemovals: readonly string[];
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
  readonly currentAfter: unknown;
}

/**
 * Store synthetic tokens through the installed plugin, read them back and remove them. Nothing here
 * sends a grant: the only revocation names another account. Run in the WebView context.
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
        await handoff.removeTokens({ userId: id });
        const currentAfter = await handoff.currentTokens(account);
        return { stored, current, revokedUnknown, currentAfter };
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
