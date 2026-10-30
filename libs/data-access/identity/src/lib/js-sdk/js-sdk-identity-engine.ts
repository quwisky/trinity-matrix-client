import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  EventType,
  type MatrixClient,
  type MatrixEvent,
  type User,
  UserEvent,
} from 'matrix-js-sdk';
import {
  NEVER,
  Observable,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  from,
  map,
  of,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  type PresenceState,
  engineRequestFailure,
  engineFail,
  engineOk,
  plainEqual,
  toPresenceState,
} from '@trinity/util/matrix';
import type {
  IdentityEngine,
  IgnoredUserInfo,
  PresenceInfo,
  UserProfile,
} from '../identity-engine';

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const NO_PROFILE: UserProfile = { displayName: null, avatarMxc: null };

function isNotFound(error: unknown): boolean {
  const e = error as { httpStatus?: unknown; errcode?: unknown } | null;
  return e?.httpStatus === 404 || e?.errcode === 'M_NOT_FOUND';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// A User the SDK knows no name for carries its user id as the display name.
function nameOf(user: User | null): string | null {
  return user?.displayName && user.displayName !== user.userId
    ? user.displayName
    : null;
}

// The SDK seeds every room member as offline with lastPresenceTs 0 and sets it only
// when a presence event arrives.
function received(user: User | null): user is User {
  return !!user?.lastPresenceTs;
}

// The SDK keeps the last non-empty status message, so a cleared one is read from the
// latest presence event.
function statusOf(user: User): string | null {
  return stringOrNull(user.events.presence?.getContent()['status_msg']) || null;
}

function presenceOf(user: User): PresenceInfo {
  return {
    userId: user.userId,
    presence: toPresenceState(user.presence),
    statusMessage: statusOf(user),
    // Same anchor as the SDK's getLastActiveTs().
    lastActiveAt:
      typeof user.lastActiveAgo === 'number'
        ? user.lastPresenceTs - user.lastActiveAgo
        : null,
    currentlyActive: user.currentlyActive === true,
  };
}

/** {@link IdentityEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkIdentityEngine implements IdentityEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);
  private readonly ignoreWrites = new WeakMap<MatrixClient, Promise<unknown>>();

  // The SDK never re-emits profile events for the account's own user (its User is built
  // without a re-emitter), so each sync re-reads it.
  ownProfile(accountId: string): Observable<UserProfile> {
    return this.watch(
      accountId,
      NO_PROFILE,
      (client, changed) => {
        client.on(ClientEvent.Sync, changed);
        return () => client.off(ClientEvent.Sync, changed);
      },
      (client) => {
        const user = client.getUser(accountId);
        return {
          displayName: nameOf(user),
          avatarMxc: user?.avatarUrl || null,
        };
      },
    );
  }

  profile(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<UserProfile>> {
    return this.request(accountId, async (client) => {
      try {
        const info = await client.getProfileInfo(userId);
        return {
          displayName: stringOrNull(info.displayname),
          avatarMxc: stringOrNull(info.avatar_url),
        };
      } catch (error) {
        if (isNotFound(error)) return NO_PROFILE;
        throw error;
      }
    });
  }

  setDisplayName(
    accountId: string,
    name: string,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.setDisplayName(name);
      return null;
    });
  }

  setAvatar(accountId: string, mxc: string): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.setAvatarUrl(mxc);
      return null;
    });
  }

  presence(accountId: string): Observable<readonly PresenceInfo[]> {
    return this.watch(
      accountId,
      [],
      (client, changed) => {
        const onEvent = (event: MatrixEvent): void => {
          if (event.getType() === EventType.Presence) changed();
        };
        client.on(ClientEvent.Event, onEvent);
        return () => client.off(ClientEvent.Event, onEvent);
      },
      (client) => client.getUsers().filter(received).map(presenceOf),
    );
  }

  ownPresence(accountId: string): Observable<
    EngineResult<{
      readonly presence: PresenceState | null;
      readonly statusMessage: string | null;
    }>
  > {
    return this.request(accountId, async (client) => {
      const own = client.getUser(accountId);
      return received(own)
        ? {
            presence: toPresenceState(own.presence),
            statusMessage: statusOf(own),
          }
        : { presence: null, statusMessage: null };
    });
  }

  setPresence(
    accountId: string,
    presence: PresenceState,
    statusMessage: string | null,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, async (client) => {
      await client.setPresence({
        presence,
        ...(statusMessage === null ? {} : { status_msg: statusMessage }),
      });
      return null;
    });
  }

  ignoredUsers(accountId: string): Observable<readonly IgnoredUserInfo[]> {
    return this.watch(
      accountId,
      [],
      (client, changed) => {
        client.on(ClientEvent.AccountData, changed);
        client.on(UserEvent.DisplayName, changed);
        client.on(UserEvent.AvatarUrl, changed);
        return () => {
          client.off(ClientEvent.AccountData, changed);
          client.off(UserEvent.DisplayName, changed);
          client.off(UserEvent.AvatarUrl, changed);
        };
      },
      (client) =>
        client.getIgnoredUsers().map((userId) => {
          const known = client.getUser(userId);
          return {
            userId,
            displayName: nameOf(known),
            avatarMxc: known?.avatarUrl || null,
          };
        }),
    );
  }

  setIgnored(
    accountId: string,
    userId: string,
    ignored: boolean,
  ): Observable<EngineResult<null>> {
    return this.request(accountId, (client) => {
      // The list is read-modify-write and setIgnoredUsers resolves only after the server
      // echoes it, so each write waits for the one before or quick changes undo each other.
      const run = (this.ignoreWrites.get(client) ?? Promise.resolve()).then(
        async () => {
          const current = client.getIgnoredUsers();
          await client.setIgnoredUsers(
            ignored
              ? [...new Set([...current, userId])]
              : current.filter((id) => id !== userId),
          );
          return null;
        },
      );
      this.ignoreWrites.set(
        client,
        run.catch(() => undefined),
      );
      return run;
    });
  }

  /** A whole snapshot on subscribe, then one per burst of `attach`'s changes. */
  private watch<T>(
    accountId: string,
    empty: T,
    attach: (client: MatrixClient, changed: () => void) => () => void,
    read: (client: MatrixClient) => T,
  ): Observable<T> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(empty), NEVER);
      return new Observable<T>((subscriber) => {
        const queue = coalesce(() => subscriber.next(read(client)));
        const detach = attach(client, () => queue.schedule());
        subscriber.next(read(client));
        return () => {
          queue.cancel();
          detach();
        };
      }).pipe(distinctUntilChanged<T>(plainEqual));
    });
  }

  // The client is looked up on subscribe: a client read earlier is stale after a re-login.
  private request<T>(
    accountId: string,
    run: (client: MatrixClient) => Promise<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      return from(run(client)).pipe(
        map((value) => engineOk(value)),
        catchError((error: unknown) =>
          of(engineFail(engineRequestFailure(error))),
        ),
      );
    });
  }
}
