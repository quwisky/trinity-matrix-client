import {
  type Observable,
  NEVER,
  Subject,
  concat,
  defer,
  distinctUntilChanged,
  map,
  of,
  startWith,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  type PresenceState,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  IdentityEngine,
  IgnoredUserInfo,
  PresenceInfo,
  UserProfile,
} from '../lib/identity-engine';

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const NO_PROFILE: UserProfile = { displayName: null, avatarMxc: null };

/**
 * An in-memory homeserver whose every live account receives every user's presence. A
 * user without an entry in {@link profiles} is unknown to it.
 */
export class FakeIdentityEngine implements IdentityEngine {
  private readonly changes = new Subject<void>();

  /** Accounts with a live client. */
  readonly live = new Set<string>();
  readonly profiles = new Map<string, UserProfile>();
  /** Presence the server sent, by user. */
  readonly presences = new Map<string, Omit<PresenceInfo, 'userId'>>();
  /** Each account's ignore list. */
  readonly ignored = new Map<string, readonly string[]>();
  /** A failure every command of a live account answers with instead, until cleared. */
  failure: EngineFailure | null = null;

  signIn(accountId: string, profile: UserProfile = NO_PROFILE): void {
    this.live.add(accountId);
    this.profiles.set(accountId, profile);
    this.changes.next();
  }

  /** Another device or the server changed something; every subscription re-reads. */
  changed(): void {
    this.changes.next();
  }

  ownProfile(accountId: string): Observable<UserProfile> {
    return this.watch(
      accountId,
      NO_PROFILE,
      () => this.profiles.get(accountId) ?? NO_PROFILE,
    );
  }

  profile(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<UserProfile>> {
    return this.command(
      accountId,
      () => this.profiles.get(userId) ?? NO_PROFILE,
    );
  }

  setDisplayName(
    accountId: string,
    name: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      this.updateProfile(accountId, { displayName: name });
      return null;
    });
  }

  setAvatar(accountId: string, mxc: string): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      this.updateProfile(accountId, { avatarMxc: mxc });
      return null;
    });
  }

  presence(accountId: string): Observable<readonly PresenceInfo[]> {
    return this.watch(accountId, [], () =>
      [...this.presences].map(([userId, info]) => ({ userId, ...info })),
    );
  }

  ownPresence(accountId: string): Observable<
    EngineResult<{
      readonly presence: PresenceState | null;
      readonly statusMessage: string | null;
    }>
  > {
    return this.command(accountId, () => {
      const own = this.presences.get(accountId);
      return {
        presence: own?.presence ?? null,
        statusMessage: own?.statusMessage ?? null,
      };
    });
  }

  setPresence(
    accountId: string,
    presence: PresenceState,
    statusMessage: string | null,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      this.presences.set(accountId, {
        presence,
        statusMessage,
        lastActiveAt: Date.now(),
        currentlyActive: presence === 'online',
      });
      this.changes.next();
      return null;
    });
  }

  ignoredUsers(accountId: string): Observable<readonly IgnoredUserInfo[]> {
    return this.watch(accountId, [], () =>
      (this.ignored.get(accountId) ?? []).map((userId) => ({
        userId,
        ...(this.profiles.get(userId) ?? NO_PROFILE),
      })),
    );
  }

  setIgnored(
    accountId: string,
    userId: string,
    ignored: boolean,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const current = this.ignored.get(accountId) ?? [];
      this.ignored.set(
        accountId,
        ignored
          ? [...new Set([...current, userId])]
          : current.filter((id) => id !== userId),
      );
      this.changes.next();
      return null;
    });
  }

  private updateProfile(accountId: string, patch: Partial<UserProfile>): void {
    this.profiles.set(accountId, {
      ...(this.profiles.get(accountId) ?? NO_PROFILE),
      ...patch,
    });
    this.changes.next();
  }

  private watch<T>(accountId: string, empty: T, read: () => T): Observable<T> {
    return defer(() => {
      if (!this.live.has(accountId)) return concat(of(empty), NEVER);
      return this.changes.pipe(
        startWith(undefined),
        map(read),
        distinctUntilChanged<T>(plainEqual),
      );
    });
  }

  private command<T>(
    accountId: string,
    run: () => T,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      if (!this.live.has(accountId)) return of(engineFail(NOT_LIVE));
      return of(this.failure ? engineFail(this.failure) : engineOk(run()));
    });
  }
}
