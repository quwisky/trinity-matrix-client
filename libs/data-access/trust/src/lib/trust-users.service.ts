import {
  Injectable,
  computed,
  inject,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  CryptoEvent,
  type UserVerificationStatus,
} from 'matrix-js-sdk/lib/crypto-api';
import { defer, from, type Observable } from 'rxjs';
import {
  TrustCryptoPort,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  TrustOperationError,
  recoverTrustOperation,
  type TrustOperation,
} from './trust-operation-error';
import { displayText } from './trust-display-text';

/**
 * Another person's cross-signing identity as this Account sees it. A changed identity is
 * `verified-identity-changed` when this Account had verified the old one, else
 * `identity-changed` until acknowledged.
 */
export type UserTrust =
  'verified' | 'unverified' | 'identity-changed' | 'verified-identity-changed';

const toUserTrust = (
  status: Pick<
    UserVerificationStatus,
    'isCrossSigningVerified' | 'wasCrossSigningVerified' | 'needsUserApproval'
  >,
): UserTrust =>
  status.isCrossSigningVerified()
    ? 'verified'
    : status.wasCrossSigningVerified()
      ? 'verified-identity-changed'
      : status.needsUserApproval
        ? 'identity-changed'
        : 'unverified';

/**
 * One session of another person: its device name, or its id when the server hides the name.
 * Both are safe to show. A name can say anything, so the card always shows the id beside it.
 */
export interface UserSession {
  readonly deviceId: string;
  readonly name: string;
}

export interface UncheckedUserSession extends UserSession {
  readonly verified?: never;
}

export interface CheckedUserSession extends UserSession {
  readonly verified: boolean;
}

/**
 * Another person's sessions. `unknown` has nothing to count yet. `unchecked` has no per-session
 * state because this Account does not currently trust the person, so a session has nothing to
 * be verified against. `checked` is only for a person this Account has verified.
 */
export type UserSessions =
  | { readonly kind: 'unknown' | 'loading' | 'failed' }
  | {
      readonly kind: 'unchecked';
      readonly sessions: readonly UncheckedUserSession[];
    }
  | {
      readonly kind: 'checked';
      readonly sessions: readonly CheckedUserSession[];
      readonly notVerified: number;
    };

type SessionsRead =
  | { readonly kind: 'unknown' | 'loading' | 'failed' }
  | { readonly kind: 'read'; readonly sessions: readonly CheckedUserSession[] };

interface SessionsEntry {
  readonly read: WritableSignal<SessionsRead | null>;
  readonly view: Signal<UserSessions | null>;
  generation: number;
  /** The row is open: only then may a read use the network for an untracked user. */
  opened: boolean;
  holders: number;
}

const byName = (a: UserSession, b: UserSession): number =>
  a.name.localeCompare(b.name) || a.deviceId.localeCompare(b.deviceId);

/** What a member's session list may claim is decided here, from the person's trust alone. */
const toUserSessions = (
  read: SessionsRead | null,
  trust: UserTrust | null,
): UserSessions | null => {
  if (read?.kind !== 'read') return read;
  if (trust !== 'verified') {
    return {
      kind: 'unchecked',
      sessions: read.sessions
        .map(({ deviceId, name }) => ({ deviceId, name }))
        .sort(byName),
    };
  }
  return {
    kind: 'checked',
    sessions: [...read.sessions].sort(
      (a, b) => Number(a.verified) - Number(b.verified) || byName(a, b),
    ),
    notVerified: read.sessions.filter((session) => !session.verified).length,
  };
};

/** Projects the active Account's verification view of other users; unknown while detached. */
@Injectable({ providedIn: 'root' })
export class TrustUsersService {
  private readonly cryptoPort = inject(TrustCryptoPort);

  /** One writable signal per tracked user id, updated in place as trust changes. */
  private readonly states = new Map<string, WritableSignal<UserTrust | null>>();
  /** Per-user read generation, so an older read cannot overwrite a newer status. */
  private readonly generations = new Map<string, number>();
  private readonly sessions = new Map<string, SessionsEntry>();

  private readonly onTrustChanged = (
    userId: string,
    status: UserVerificationStatus,
  ): void => {
    const state = this.states.get(userId);
    if (!state) return;
    this.nextGeneration(userId);
    state.set(toUserTrust(status));
    this.rereadSessions(userId);
  };

  private readonly onDevicesUpdated = (users: string[]): void => {
    for (const userId of users) this.rereadSessions(userId);
  };

  /**
   * The event is bound by hand because it carries the user and the new status. Reset keeps
   * an Account switch or a released projection from exposing the previous Account's view.
   */
  private readonly projection = this.cryptoPort.project({
    id: 'crypto.users',
    bind: (client) => {
      client.on(CryptoEvent.UserTrustStatusChanged, this.onTrustChanged);
      client.on(CryptoEvent.DevicesUpdated, this.onDevicesUpdated);
    },
    unbind: (client) => {
      client.off(CryptoEvent.UserTrustStatusChanged, this.onTrustChanged);
      client.off(CryptoEvent.DevicesUpdated, this.onDevicesUpdated);
    },
    rebuild: (client) => {
      for (const userId of this.states.keys()) void this.read(userId, client);
      for (const [userId, entry] of this.sessions) {
        void this.readSessions(userId, entry, client);
      }
    },
    reset: () => {
      for (const [userId, state] of this.states) {
        this.nextGeneration(userId);
        state.set(null);
      }
      for (const entry of this.sessions.values()) {
        entry.generation += 1;
        entry.read.set(null);
      }
    },
  });

  /** Cold user-trust projection retained by the named session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /**
   * Reactive trust for a user; null while the projection or crypto is unavailable. The
   * returned signal is cached per user id and reused on later calls.
   */
  userTrust(userId: string): Signal<UserTrust | null> {
    let state = this.states.get(userId);
    if (!state) {
      state = signal<UserTrust | null>(null);
      this.states.set(userId, state);
      const client = this.projection.client();
      if (client) void this.read(userId, client);
    }
    return state.asReadonly();
  }

  /**
   * Reactive sessions for a user, from the device's own copy until {@link loadUserSessions};
   * null while the projection or crypto is unavailable. Pair with {@link retainUserSessions}.
   */
  userSessions(userId: string): Signal<UserSessions | null> {
    return this.sessionsEntry(userId).view;
  }

  /** Keep a user's sessions while a surface shows them; call the result to let them go. */
  retainUserSessions(userId: string): () => void {
    const entry = this.sessionsEntry(userId);
    entry.holders += 1;
    return () => {
      entry.holders -= 1;
      if (entry.holders > 0) return;
      entry.generation += 1;
      this.sessions.delete(userId);
    };
  }

  /**
   * The row opened: read a user's sessions over the network if the device has no copy, since
   * `getUserDeviceInfo` makes a request for an untracked user. Also the retry after a failure.
   */
  loadUserSessions(userId: string): void {
    const entry = this.sessions.get(userId);
    const client = this.projection.client();
    if (!entry || !client) return;
    if (entry.opened && entry.read()?.kind !== 'failed') return;
    entry.opened = true;
    if (entry.read()?.kind !== 'read') entry.read.set({ kind: 'loading' });
    void this.readSessions(userId, entry, client);
  }

  /** The row closed: later reads stay on the device's own copy until it opens again. */
  closeUserSessions(userId: string): void {
    const entry = this.sessions.get(userId);
    if (entry) entry.opened = false;
  }

  /** Accept a changed identity as this person's own (pin it). Cold; runs as the active Account. */
  acknowledgeIdentity(userId: string): Observable<void> {
    return this.identityAction('acknowledge-identity', userId, (crypto) =>
      crypto.pinCurrentUserIdentity(userId),
    );
  }

  /**
   * Stop requiring a previously verified person to be verified, accepting their new identity as
   * unverified. Cold; runs as the active Account.
   */
  withdrawVerification(userId: string): Observable<void> {
    return this.identityAction('withdraw-verification', userId, (crypto) =>
      crypto.withdrawVerificationRequirement(userId),
    );
  }

  /** Run one identity change, then re-read the user so their state updates without the event. */
  private identityAction(
    operation: TrustOperation,
    userId: string,
    run: (
      crypto: NonNullable<ReturnType<TrustMatrixClient['getCrypto']>>,
    ) => Promise<void>,
  ): Observable<void> {
    return defer(() => {
      const { client, crypto } = this.cryptoPort.active();
      if (!crypto) {
        throw new TrustOperationError(
          operation,
          'not-ready',
          'retry',
          'Encryption is still starting. Try again in a moment.',
        );
      }
      // Settle the re-read before completing, so the caller's busy state outlasts it.
      return from(
        run(crypto).then(() =>
          this.states.has(userId) ? this.read(userId, client) : undefined,
        ),
      );
    }).pipe(recoverTrustOperation(operation));
  }

  private sessionsEntry(userId: string): SessionsEntry {
    const existing = this.sessions.get(userId);
    if (existing) return existing;
    const trust = this.userTrust(userId);
    const read = signal<SessionsRead | null>(null);
    const entry: SessionsEntry = {
      read,
      view: computed(() => toUserSessions(read(), trust())),
      generation: 0,
      opened: false,
      holders: 0,
    };
    this.sessions.set(userId, entry);
    const client = this.projection.client();
    if (client) void this.readSessions(userId, entry, client);
    return entry;
  }

  private rereadSessions(userId: string): void {
    const entry = this.sessions.get(userId);
    const client = this.projection.client();
    if (entry && client) void this.readSessions(userId, entry, client);
  }

  private readSessions(
    userId: string,
    entry: SessionsEntry,
    client: TrustMatrixClient,
  ): Promise<void> {
    const generation = ++entry.generation;
    const crypto = client.getCrypto();
    if (!crypto) {
      entry.read.set(null);
      return Promise.resolve();
    }
    const { opened } = entry;
    if (!entry.read()) {
      entry.read.set({ kind: opened ? 'loading' : 'unknown' });
    }
    const settle = (read: SessionsRead): void => {
      if (entry.generation === generation) entry.read.set(read);
    };
    // A closed row's local read knows nothing about an untracked user, so it keeps their list.
    const noAnswer = (): SessionsRead => {
      const current = entry.read();
      return current?.kind === 'read' ? current : { kind: 'unknown' };
    };
    return crypto
      .getUserDeviceInfo([userId], opened)
      .then((devices) =>
        Promise.all(
          [...(devices.get(userId)?.values() ?? [])]
            // shortcut: the SDK's read for an untracked user drops `dehydrated`, so such a device
            // counts as a session; filter there too once the SDK passes the flag on.
            .filter((device) => !device.dehydrated)
            .map(async (device) => {
              const shownId = displayText(device.deviceId) ?? device.deviceId;
              return {
                deviceId: shownId,
                name: displayText(device.displayName) ?? shownId,
                // Not isVerified(): an emoji check's local trust outlives the owner's identity.
                verified:
                  (
                    await crypto
                      .getDeviceVerificationStatus(userId, device.deviceId)
                      .catch(() => null)
                  )?.crossSigningVerified ?? false,
              };
            }),
        ),
      )
      .then(
        (sessions) =>
          settle(
            sessions.length > 0 || opened
              ? { kind: 'read', sessions }
              : noAnswer(),
          ),
        () => settle(opened ? { kind: 'failed' } : noAnswer()),
      );
  }

  private read(userId: string, client: TrustMatrixClient): Promise<void> {
    const generation = this.nextGeneration(userId);
    const state = this.states.get(userId);
    const crypto = client.getCrypto();
    if (!crypto) {
      state?.set(null);
      return Promise.resolve();
    }
    return crypto.getUserVerificationStatus(userId).then(
      (status) => this.settle(userId, generation, toUserTrust(status)),
      // The card reads trust decoratively; a failed read degrades to unverified.
      () => this.settle(userId, generation, 'unverified'),
    );
  }

  private settle(userId: string, generation: number, trust: UserTrust): void {
    if (this.generations.get(userId) === generation) {
      this.states.get(userId)?.set(trust);
    }
  }

  private nextGeneration(userId: string): number {
    const next = (this.generations.get(userId) ?? 0) + 1;
    this.generations.set(userId, next);
    return next;
  }
}
