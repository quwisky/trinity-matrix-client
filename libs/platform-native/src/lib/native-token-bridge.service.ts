import { Injectable, inject } from '@angular/core';
import {
  PushHandoffBridge,
  type NativeTokenRecord,
  type NativeTokenResult,
} from '@trinity/capacitor-push';
import type { MatrixSession } from '@trinity/util/matrix';
import {
  Observable,
  TimeoutError,
  catchError,
  firstValueFrom,
  map,
  of,
  switchMap,
  timeout,
} from 'rxjs';
import {
  SessionStorageService,
  type AccountRecord,
} from './session-storage.service';

/**
 * Stands in for the refresh token in a live client once native code holds the real one. It
 * says a refresh is possible, is not a secret and is never sent or stored.
 */
export const NATIVE_REFRESH_MARKER = 'trinity-native-vault';

/** Native's 8 s app grant budget plus 5 s, so a call that can still answer does. */
const NATIVE_CALL_TIMEOUT_MS = 13_000;
/** A vault read or removal makes no grant: native waits 1 s on the lease, then one keychain call. */
const NATIVE_VAULT_STEP_TIMEOUT_MS = 3_000;

export type PreparedSession =
  | { readonly kind: 'ready'; readonly session: MatrixSession }
  | { readonly kind: 'refused' };

/** Structurally the SDK's `TokenHost`; this layer can't import the SDK. */
export interface NativeTokenHost {
  refresh(
    accessToken: string,
  ): Promise<
    | { kind: 'tokens'; accessToken: string; expiry?: Date; granted: boolean }
    | { kind: 'refused' }
    | { kind: 'transient' }
  >;
  current(): Promise<{ accessToken: string; expiry?: Date } | undefined>;
  revoke(): Promise<boolean>;
}

/** `unknown`: the call timed out and its write may still land, unlike a false or a rejection. */
type Migration = 'no-copy' | 'stored' | 'not-stored' | 'unknown';

/**
 * Moves a phone's OAuth refresh tokens into native code and answers the SDK's token host from
 * there. A native failure is transient here and never signs out, and a JS copy goes only once
 * native confirmed holding the token.
 */
@Injectable({ providedIn: 'root' })
export class NativeTokenBridge {
  private readonly handoff = inject(PushHandoffBridge);
  private readonly storage = inject(SessionStorageService);
  /** Started with the marker though native never confirmed holding this JS copy. */
  private readonly unconfirmedCopies = new Set<string>();

  /**
   * The session a client starts from. Synchronous off native, for a password account and for a
   * JS copy with no pinned endpoint, which stays on the JS path until a refresh pins one.
   */
  prepare(session: MatrixSession): Observable<PreparedSession> {
    if (
      !this.handoff.available ||
      !session.oidc ||
      (session.refreshToken && !session.oidc.tokenEndpoint)
    ) {
      return of({ kind: 'ready', session });
    }
    this.unconfirmedCopies.delete(session.userId);
    return this.migrate(session).pipe(
      switchMap((migration) =>
        bounded(
          this.handoff.currentTokens(session.userId, session.lineage ?? ''),
          null,
          NATIVE_VAULT_STEP_TIMEOUT_MS,
        ).pipe(switchMap((answer) => this.started(session, migration, answer))),
      ),
    );
  }

  /**
   * Sign-in only, once its session is saved: an unreadable record can't be migrated over and
   * would leave the new refresh token unused for good, so it goes and {@link prepare} migrates.
   * It belongs to an earlier sign-in; on a restart it may hold the only live token. Writes
   * nothing: a record stored before the client's start can outlive the JS copy it was made from.
   */
  removeUnreadableRecord(session: MatrixSession): Observable<void> {
    if (!this.handoff.available || !nativeRecord(session)) {
      return of(void 0);
    }
    const { userId } = session;
    return bounded(
      this.handoff.currentTokens(userId, session.lineage ?? ''),
      null,
      NATIVE_VAULT_STEP_TIMEOUT_MS,
    ).pipe(
      switchMap((answer) =>
        answer?.kind === 'transient'
          ? // shortcut: a removal still running natively past this timeout can delete the record
            // prepare just wrote; that needs a hung keychain and ends in a soft logout a new
            // sign-in recovers, so wait for the removal to settle if it is ever seen.
            bounded(
              this.handoff.removeTokens(userId),
              void 0,
              NATIVE_VAULT_STEP_TIMEOUT_MS,
            )
          : of(void 0),
      ),
    );
  }

  /** The session for a client that never ran {@link prepare}, such as a sign-out's. */
  detachedSession(session: MatrixSession): MatrixSession {
    return this.handoff.available && session.oidc && !session.refreshToken
      ? { ...session, refreshToken: NATIVE_REFRESH_MARKER }
      : session;
  }

  host(session: MatrixSession): NativeTokenHost {
    const { userId } = session;
    const lineage = session.lineage ?? '';
    return {
      refresh: async (accessToken) => {
        const answer = await firstValueFrom(
          bounded<NativeTokenResult>(
            this.handoff.refreshTokens(userId, lineage, accessToken),
            { kind: 'transient' },
          ),
        );
        switch (answer.kind) {
          case 'current':
          case 'rotated':
            return {
              kind: 'tokens',
              accessToken: answer.accessToken,
              expiry: expiryOf(answer.accessTokenExpiresAt),
              granted: answer.kind === 'rotated',
            };
          case 'refused':
            return { kind: 'refused' };
          case 'gone':
            return (await this.goneForGood(userId, lineage))
              ? { kind: 'refused' }
              : { kind: 'transient' };
          default:
            return { kind: 'transient' };
        }
      },
      current: async () => {
        const answer = await firstValueFrom(
          bounded(this.handoff.currentTokens(userId, lineage), null),
        );
        return answer?.kind === 'current'
          ? {
              accessToken: answer.accessToken,
              expiry: expiryOf(answer.accessTokenExpiresAt),
            }
          : undefined;
      },
      revoke: async () => {
        const { kind } = await firstValueFrom(
          bounded(this.handoff.revokeTokens(userId, lineage), {
            kind: 'transient',
          }),
        );
        if (kind === 'transient') {
          throw new Error('The native token revocation did not finish.');
        }
        return kind === 'revoked';
      },
    };
  }

  /** Never errors. True when native revoked the tokens. */
  revokeStored(session: MatrixSession): Observable<boolean> {
    return bounded(
      this.handoff.revokeTokens(session.userId, session.lineage ?? ''),
      { kind: 'transient' },
    ).pipe(map(({ kind }) => kind === 'revoked'));
  }

  /**
   * False while the JS copy is unconfirmed, and once a new sign-in holds the account: its save
   * removes this client's record before its start stops this client, and a logout here would
   * wipe the new sign-in. The registry write comes first, so this read can't miss it.
   */
  private async goneForGood(userId: string, lineage: string): Promise<boolean> {
    if (this.unconfirmedCopies.has(userId)) {
      return false;
    }
    const stored = await firstValueFrom(
      bounded<AccountRecord | null | undefined>(
        this.storage.record(userId),
        undefined,
        NATIVE_VAULT_STEP_TIMEOUT_MS,
      ),
    );
    return (
      stored === null ||
      (stored !== undefined && (stored.lineage ?? '') === lineage)
    );
  }

  private migrate(session: MatrixSession): Observable<Migration> {
    const record = nativeRecord(session);
    if (!record) {
      return of('no-copy');
    }
    return this.handoff.migrateTokens(record).pipe(
      timeout(NATIVE_CALL_TIMEOUT_MS),
      map((stored): Migration => (stored ? 'stored' : 'not-stored')),
      catchError((error: unknown) =>
        of<Migration>(error instanceof TimeoutError ? 'unknown' : 'not-stored'),
      ),
      switchMap((migration) =>
        migration === 'stored'
          ? bounded(
              this.storage.dropRefreshToken(session.userId, session.lineage),
              void 0,
            ).pipe(map(() => migration))
          : of(migration),
      ),
    );
  }

  private started(
    session: MatrixSession,
    migration: Migration,
    answer: NativeTokenResult | null,
  ): Observable<PreparedSession> {
    switch (answer?.kind) {
      case 'current':
        return of({
          kind: 'ready',
          session: {
            ...session,
            accessToken: answer.accessToken,
            accessTokenExpiresAt: answer.accessTokenExpiresAt,
            refreshToken: NATIVE_REFRESH_MARKER,
          },
        });
      case 'refused':
        return bounded(
          this.storage.invalidateToken(session.userId),
          void 0,
        ).pipe(map((): PreparedSession => ({ kind: 'refused' })));
      case 'gone':
        if (migration === 'no-copy' || migration === 'not-stored') {
          return of({ kind: 'ready', session });
        }
        break;
      case 'unavailable':
        if (migration === 'not-stored') {
          return of({ kind: 'ready', session });
        }
        break;
    }
    if (migration === 'not-stored' || migration === 'unknown') {
      this.unconfirmedCopies.add(session.userId);
    }
    return of({
      kind: 'ready',
      session: { ...session, refreshToken: NATIVE_REFRESH_MARKER },
    });
  }
}

function bounded<T>(
  call: Observable<T>,
  onFailure: T,
  timeoutMs = NATIVE_CALL_TIMEOUT_MS,
): Observable<T> {
  return call.pipe(
    timeout(timeoutMs),
    catchError(() => of(onFailure)),
  );
}

function expiryOf(epochMs: number | undefined): Date | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs);
}

/** Null when there is no JS copy to move, or no pinned endpoint for native to refresh it at. */
function nativeRecord(session: MatrixSession): NativeTokenRecord | null {
  const { oidc, refreshToken } = session;
  return oidc?.tokenEndpoint && refreshToken
    ? {
        userId: session.userId,
        lineage: session.lineage ?? '',
        accessToken: session.accessToken,
        refreshToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        tokenEndpoint: oidc.tokenEndpoint,
        revocationEndpoint: oidc.revocationEndpoint,
        clientId: oidc.clientId,
        deviceId: session.deviceId,
      }
    : null;
}
