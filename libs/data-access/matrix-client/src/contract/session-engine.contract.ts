import {
  type Observable,
  type Subscription,
  filter,
  firstValueFrom,
  take,
  tap,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MatrixSession,
  assertPlainData,
  plainEqual,
} from '@trinity/util/matrix';
import {
  type AccountNameGroup,
  EMPTY_SESSION,
  type ServerLogoutHoldUpdate,
  type SessionEngine,
  type SessionSnapshot,
} from '../lib/session-engine';

export interface SessionContractSetup {
  readonly engine: SessionEngine;
  /** A password session for a fresh account. */
  newSession(): Promise<MatrixSession>;
  /** Whether the server still accepts the session's token (whoami). */
  tokenAccepted(session: MatrixSession): Promise<boolean>;
  /** The server ends a live session with a soft logout (`M_UNKNOWN_TOKEN`, `soft_logout: true`). */
  softLogout(session: MatrixSession): Promise<void>;
  /** The server revokes the session's token without telling its client. */
  revokeToken(session: MatrixSession): Promise<void>;
  /** The password of a session from {@link newSession}. */
  passwordFor(session: MatrixSession): string;
  /** A new session for the same account on another device. */
  signInAgain(session: MatrixSession): Promise<MatrixSession>;
  /** Outside the engine, the session's account takes a display name, then creates a room. */
  createNamedRoom(
    session: MatrixSession,
    names: {
      readonly displayName: string;
      readonly roomName: string;
      readonly roomTopic: string;
    },
  ): Promise<void>;
  dispose(): Promise<void>;
}

const NOBODY = '@nobody:invalid';

export interface SessionContractTiming {
  /** How long a started account may take to complete its first sync. */
  readonly syncTimeoutMs: number;
  /** Per-test timeout; a live server needs real crypto init and a first sync per account. */
  readonly testTimeoutMs: number;
}

export function defineSessionEngineContract(
  setup: () => Promise<SessionContractSetup>,
  { syncTimeoutMs, testTimeoutMs }: SessionContractTiming,
): void {
  describe('SessionEngine contract', () => {
    let context: SessionContractSetup;
    let engine: SessionEngine;
    const recordings: Subscription[] = [];

    beforeEach(async () => {
      context = await setup();
      engine = context.engine;
    }, testTimeoutMs);

    afterEach(async () => {
      for (const recording of recordings.splice(0)) recording.unsubscribe();
      try {
        await once(engine.stop());
      } finally {
        await context.dispose();
      }
    }, testTimeoutMs);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    /** The first `session()` emission, which must be the current snapshot. */
    async function snapshot(): Promise<SessionSnapshot> {
      const first = await firstValueFrom(engine.session().pipe(take(1)));
      expect(() => assertPlainData(first)).not.toThrow();
      return first;
    }

    /** Takes a hold once the engine has it in place, recording each update and completion. */
    async function hold(accountId: string) {
      const updates: ServerLogoutHoldUpdate[] = [];
      let completed = false;
      const subscription = engine.holdServerLogout(accountId).subscribe({
        next: (update) => {
          expect(() => assertPlainData(update)).not.toThrow();
          updates.push(update);
        },
        complete: () => (completed = true),
      });
      await until(() => updates.length > 0);
      const first = updates[0];
      return {
        updates,
        completed: () => completed,
        holdId: first.kind === 'held' ? first.holdId : '',
        kinds: () => updates.map((u) => u.kind),
        unsubscribe: () => subscription.unsubscribe(),
      };
    }

    /** Subscribes until the test ends, collecting each plain-data value. */
    function record<T>(source: Observable<T>): T[] {
      const values: T[] = [];
      recordings.push(
        source.subscribe((value) => {
          expect(() => assertPlainData(value)).not.toThrow();
          values.push(value);
        }),
      );
      return values;
    }

    async function until(predicate: () => boolean): Promise<void> {
      const deadline = Date.now() + syncTimeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    async function restore(
      session: MatrixSession,
      activation: 'activate' | 'background' = 'activate',
    ): Promise<void> {
      await expect(
        once(engine.restorePersisted(session, activation)),
      ).resolves.toEqual({ ok: true, value: null });
    }

    it('starts empty', async () => {
      await expect(snapshot()).resolves.toEqual(EMPTY_SESSION);
    });

    it(
      'restores an account and makes it active',
      async () => {
        const s = await context.newSession();

        await restore(s);

        const first = await snapshot();
        expect(first.activeAccountId).toBe(s.userId);
        expect(first.accounts).toHaveLength(1);
        expect(JSON.stringify(first)).not.toContain(s.accessToken);
        const synced = await firstValueFrom(
          engine.session().pipe(
            filter((x) =>
              x.accounts.every((a) => a.serverSynced && a.roomsPrepared),
            ),
            timeout(syncTimeoutMs),
          ),
        );
        expect(['prepared', 'syncing']).toContain(synced.accounts[0].syncState);
      },
      testTimeoutMs,
    );

    it(
      "reports each account's device id",
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();

        await restore(a);
        await restore(b, 'background');

        expect(
          (await snapshot()).accounts.map(({ accountId, deviceId }) => ({
            accountId,
            deviceId,
          })),
        ).toEqual([
          { accountId: a.userId, deviceId: a.deviceId },
          { accountId: b.userId, deviceId: b.deviceId },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'restores in the background without changing the active account',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();

        await restore(a);
        await restore(b, 'background');

        const first = await snapshot();
        expect(first.activeAccountId).toBe(a.userId);
        expect(first.accounts.map((x) => x.accountId)).toEqual([
          a.userId,
          b.userId,
        ]);
      },
      testTimeoutMs,
    );

    it(
      'registers each new client with a larger generation',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const g1 = (await snapshot()).accounts[0].generation;

        await restore(a);

        const after = await snapshot();
        expect(after.accounts.map((x) => x.accountId)).toEqual([a.userId]);
        expect(after.accounts[0].generation).toBeGreaterThan(g1);
      },
      testTimeoutMs,
    );

    it(
      'joins concurrent restores of one account',
      async () => {
        const a = await context.newSession();
        const c = await context.newSession();
        await restore(c, 'background');
        const gc = (await snapshot()).accounts[0].generation;

        await expect(
          Promise.all([
            once(engine.restorePersisted(a, 'activate')),
            once(engine.restorePersisted(a, 'activate')),
          ]),
        ).resolves.toEqual([
          { ok: true, value: null },
          { ok: true, value: null },
        ]);

        const after = await snapshot();
        expect(after.accounts.map((x) => x.accountId)).toEqual([
          c.userId,
          a.userId,
        ]);
        expect(after.accounts[1].generation).toBe(gc + 1);
      },
      testTimeoutMs,
    );

    it(
      'switches between live accounts and ignores unknown ones',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();
        await restore(a);
        await restore(b, 'background');

        await once(engine.setActive(b.userId));
        expect((await snapshot()).activeAccountId).toBe(b.userId);

        await once(engine.setActive(NOBODY));
        expect((await snapshot()).activeAccountId).toBe(b.userId);
      },
      testTimeoutMs,
    );

    it(
      'activates with replace and retires the others',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();
        await restore(a);
        await restore(b, 'background');

        await expect(
          once(engine.activateAccount(a.userId, 'replace')),
        ).resolves.toEqual({ ok: true, value: null });

        const after = await snapshot();
        expect(after.accounts.map((x) => x.accountId)).toEqual([a.userId]);
        expect(after.activeAccountId).toBe(a.userId);

        const missing = await once(engine.activateAccount(NOBODY, 'keep'));
        expect(missing.ok).toBe(false);
        if (missing.ok) return;
        expect(missing.failure.code).toBe('account-not-live');
      },
      testTimeoutMs,
    );

    it(
      'rolls back a start without losing the account',
      async () => {
        const a = await context.newSession();
        await restore(a);

        await once(engine.rollbackAccountStart(a.userId));
        expect((await snapshot()).accounts).toEqual([]);

        await restore(a);
        expect((await snapshot()).activeAccountId).toBe(a.userId);
      },
      testTimeoutMs,
    );

    it(
      'removes one account and repoints the active one',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();
        await restore(a);
        await restore(b);

        await once(engine.remove(b.userId));

        const after = await snapshot();
        expect(after.accounts.map((x) => x.accountId)).toEqual([a.userId]);
        expect(after.activeAccountId).toBe(a.userId);
      },
      testTimeoutMs,
    );

    it(
      'keeps commands cold',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();
        await restore(a);
        await restore(b, 'background');

        engine.setActive(b.userId);

        expect((await snapshot()).activeAccountId).toBe(a.userId);
      },
      testTimeoutMs,
    );

    it(
      'reports the account token and server status',
      async () => {
        const s = await context.newSession();
        await restore(s);

        await expect(
          firstValueFrom(engine.accessToken(s.userId)),
        ).resolves.toEqual({
          homeserverUrl: s.baseUrl,
          accessToken: s.accessToken,
          expiresAt: null,
          refreshable: false,
        });
        await expect(
          firstValueFrom(engine.accessToken(NOBODY)),
        ).resolves.toBeNull();
        await expect(once(engine.accountStatus(s.userId))).resolves.toBe(
          'active',
        );
        await expect(once(engine.accountStatus(NOBODY))).resolves.toBe(
          'unreachable',
        );
        await expect(once(engine.roomKeysBackedUp(NOBODY))).resolves.toBeNull();
        await expect(
          once(engine.refreshAccessToken(s.userId, {})),
        ).resolves.toBe(false);
      },
      testTimeoutMs,
    );

    it(
      'emits the access token on subscribe and after each change',
      async () => {
        const a = await context.newSession();
        const seen = record(engine.accessToken(a.userId));
        await until(() => seen.length > 0);
        expect(seen).toEqual([null]);

        await restore(a);
        await until(() => seen.at(-1)?.accessToken === a.accessToken);
        expect(seen.at(-1)).toEqual({
          homeserverUrl: a.baseUrl,
          accessToken: a.accessToken,
          expiresAt: null,
          refreshable: false,
        });

        await once(engine.remove(a.userId));
        await until(() => seen.at(-1) === null);

        const again = await context.signInAgain(a);
        await restore(again);
        await until(() => seen.at(-1)?.accessToken === again.accessToken);
        // A first sync must not emit the same token again.
        await firstValueFrom(
          engine.session().pipe(
            filter((s) =>
              s.accounts.some(
                (x) =>
                  x.accountId === a.userId && x.serverSynced && x.roomsPrepared,
              ),
            ),
            timeout(syncTimeoutMs),
          ),
        );
        expect(seen.map((t) => t?.accessToken ?? null)).toEqual([
          null,
          a.accessToken,
          null,
          again.accessToken,
        ]);
      },
      testTimeoutMs,
    );

    it(
      'has no outgoing work when idle',
      async () => {
        const s = await context.newSession();
        await restore(s);

        await expect(once(engine.hasOutgoingWork())).resolves.toBe(false);
        await expect(once(engine.pendingTextMessages())).resolves.toEqual([]);
        await expect(once(engine.pauseSync())).resolves.toBeNull();
      },
      testTimeoutMs,
    );

    it(
      'signs every live account out on the server',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();
        await restore(a);
        await restore(b, 'background');

        await expect(once(engine.signOutAll())).resolves.toBeNull();

        await expect(context.tokenAccepted(a)).resolves.toBe(false);
        await expect(context.tokenAccepted(b)).resolves.toBe(false);
        // The clients stay live until the caller stops them.
        expect((await snapshot()).accounts.map((x) => x.accountId)).toEqual([
          a.userId,
          b.userId,
        ]);
        await once(engine.stop());
        await expect(snapshot()).resolves.toEqual(EMPTY_SESSION);
      },
      testTimeoutMs,
    );

    it(
      'flags an account for sign-in again without retiring it',
      async () => {
        const s = await context.newSession();
        await restore(s);

        await expect(
          once(engine.requireReauthentication(s.userId)),
        ).resolves.toBeNull();

        const after = await snapshot();
        expect(after.softLoggedOut).toEqual([s.userId]);
        expect(after.accounts.map((x) => x.accountId)).toEqual([s.userId]);
      },
      testTimeoutMs,
    );

    it(
      'flags an account that is not live and forgets it on remove',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();
        await restore(a);

        await once(engine.requireReauthentication(b.userId));
        const flagged = await snapshot();
        expect(flagged.softLoggedOut).toEqual([b.userId]);
        expect(flagged.accounts.map((x) => x.accountId)).toEqual([a.userId]);

        await once(engine.remove(b.userId));
        const removed = await snapshot();
        expect(removed.softLoggedOut).toEqual([]);
        expect(removed.accounts.map((x) => x.accountId)).toEqual([a.userId]);
      },
      testTimeoutMs,
    );

    it(
      'drops the client of an account the server soft-logs out',
      async () => {
        const a = await context.newSession();
        const b = await context.newSession();
        await restore(a);
        await restore(b, 'background');

        await context.softLogout(a);

        const after = await firstValueFrom(
          engine.session().pipe(
            filter((x) => x.softLoggedOut.includes(a.userId)),
            timeout(syncTimeoutMs),
          ),
        );
        expect(after.accounts.map((x) => x.accountId)).toEqual([b.userId]);
        expect(after.activeAccountId).toBe(b.userId);
      },
      testTimeoutMs,
    );

    it(
      'holds a dead token until released, reporting it before the request that met it',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const held = await hold(a.userId);
        expect(held.updates).toEqual([
          { kind: 'held', holdId: expect.any(String), tokenDied: false },
        ]);

        await context.revokeToken(a);
        let seen: string[] = [];
        const result = await once(
          engine
            .deactivateAccount(a.userId, false, null)
            .pipe(tap(() => (seen = held.kinds()))),
        );

        expect(seen).toContain('token-died');
        expect(!result.ok && result.failure.diagnostic.errcode).toBe(
          'M_UNKNOWN_TOKEN',
        );
        expect((await snapshot()).accounts.map((x) => x.accountId)).toEqual([
          a.userId,
        ]);
        const later = await hold(a.userId);
        expect(later.updates[0]).toMatchObject({ tokenDied: true });
        later.unsubscribe();
        expect((await snapshot()).accounts).toHaveLength(1);

        await expect(
          once(engine.releaseServerLogoutHold(held.holdId, false)),
        ).resolves.toBeNull();

        expect(held.completed()).toBe(true);
        expect((await snapshot()).accounts).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'reports a revoked token as gone, telling holds first',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const held = await hold(a.userId);
        await context.revokeToken(a);

        let seen: string[] = [];
        const status = await once(
          engine.accountStatus(a.userId).pipe(tap(() => (seen = held.kinds()))),
        );

        expect(status).toBe('gone');
        expect(seen).toContain('token-died');
        expect((await snapshot()).accounts.map((x) => x.accountId)).toEqual([
          a.userId,
        ]);
      },
      testTimeoutMs,
    );

    it(
      'releases a hold as not deleted when its subscriber leaves',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const held = await hold(a.userId);
        await context.revokeToken(a);
        await once(engine.deactivateAccount(a.userId, false, null));
        expect(held.kinds()).toContain('token-died');

        held.unsubscribe();

        // A close may land after the unsubscribe returns.
        await firstValueFrom(
          engine.session().pipe(
            filter((s) => s.accounts.length === 0),
            timeout(syncTimeoutMs),
          ),
        );
      },
      testTimeoutMs,
    );

    it(
      'deactivates with a password and leaves the dead token to the deletion cleanup',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const held = await hold(a.userId);

        const probe = await once(
          engine.deactivateAccount(a.userId, false, null),
        );
        if (probe.ok || probe.failure.code !== 'uia-required') {
          throw new Error('Expected a UIA challenge');
        }
        const { challenge } = probe.failure.params;
        expect(challenge.flows.map((f) => f.stages)).toContainEqual([
          'm.login.password',
        ]);
        await expect(
          once(
            engine.deactivateAccount(a.userId, false, {
              type: 'm.login.password',
              identifier: { type: 'm.id.user', user: a.userId },
              password: context.passwordFor(a),
              session: challenge.session ?? '',
            }),
          ),
        ).resolves.toEqual({ ok: true, value: null });
        await expect(context.tokenAccepted(a)).resolves.toBe(false);

        // The account's own sync meets the revoked token.
        await until(() => held.kinds().includes('token-died'));
        await once(engine.releaseServerLogoutHold(held.holdId, true));

        expect((await snapshot()).accounts.map((x) => x.accountId)).toEqual([
          a.userId,
        ]);
        await once(engine.remove(a.userId));
        expect((await snapshot()).accounts).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'reports a held account that leaves the device',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const held = await hold(a.userId);

        await once(engine.remove(a.userId));

        expect(held.kinds()).toEqual(['held', 'released']);
        expect(held.completed()).toBe(true);
        await expect(
          once(engine.releaseServerLogoutHold(held.holdId, false)),
        ).resolves.toBeNull();
      },
      testTimeoutMs,
    );

    it(
      'releases every hold on stop',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const held = await hold(a.userId);

        let kinds: string[] = [];
        let completed = false;
        await once(
          engine.stop().pipe(
            tap(() => {
              kinds = held.kinds();
              completed = held.completed();
            }),
          ),
        );

        expect(kinds).toEqual(['held', 'released']);
        expect(completed).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'tells its holds of a sign-in again and of a token renewed by a new client',
      async () => {
        const a = await context.newSession();
        await restore(a);
        const held = await hold(a.userId);

        await context.softLogout(a);
        await firstValueFrom(
          engine.session().pipe(
            filter((x) => x.softLoggedOut.includes(a.userId)),
            timeout(syncTimeoutMs),
          ),
        );
        await restore(a);
        expect(held.kinds()).toEqual(['held', 'signed-in-again']);

        await context.revokeToken(a);
        await once(engine.deactivateAccount(a.userId, false, null));
        expect(held.kinds()).toContain('token-died');
        const again = await context.signInAgain(a);
        await restore(again);
        expect(held.kinds().at(-1)).toBe('token-renewed');

        await once(engine.releaseServerLogoutHold(held.holdId, false));

        expect(held.completed()).toBe(true);
        expect(
          (await snapshot()).accounts.map(({ accountId, deviceId }) => ({
            accountId,
            deviceId,
          })),
        ).toEqual([{ accountId: a.userId, deviceId: again.deviceId }]);
        await expect(context.tokenAccepted(again)).resolves.toBe(true);
      },
      testTimeoutMs,
    );

    it(
      "reads a live session's own tokens, and nothing for another account",
      async () => {
        const s = await context.newSession();
        await restore(s);

        await expect(once(engine.liveCredentials(s.userId))).resolves.toEqual({
          accessToken: s.accessToken,
          refreshToken: s.refreshToken ?? null,
        });
        await expect(once(engine.liveCredentials(NOBODY))).resolves.toBeNull();
      },
      testTimeoutMs,
    );

    it(
      'logs a live session out at its homeserver',
      async () => {
        const a = await context.newSession();
        await restore(a);

        await expect(once(engine.logoutRemote(a.userId))).resolves.toEqual({
          ok: true,
          value: null,
        });

        await expect(context.tokenAccepted(a)).resolves.toBe(false);
        for (const result of [
          await once(engine.logoutRemote(NOBODY)),
          await once(engine.deactivateAccount(NOBODY, false, null)),
        ]) {
          expect(!result.ok && result.failure.code).toBe('account-not-live');
        }
      },
      testTimeoutMs,
    );

    it(
      'stops the session it logs out and keeps the account live',
      async () => {
        const a = await context.newSession();
        await restore(a);
        await firstValueFrom(
          engine.session().pipe(
            filter((s) => s.accounts.some((x) => x.serverSynced)),
            timeout(syncTimeoutMs),
          ),
        );

        await expect(once(engine.logoutRemote(a.userId))).resolves.toEqual({
          ok: true,
          value: null,
        });

        await firstValueFrom(
          engine.session().pipe(
            filter((s) =>
              s.accounts.some(
                (x) => x.accountId === a.userId && x.syncState === 'stopped',
              ),
            ),
            timeout(syncTimeoutMs),
          ),
        );
        expect(
          (await snapshot()).accounts.map(({ accountId, syncState }) => ({
            accountId,
            syncState,
          })),
        ).toEqual([{ accountId: a.userId, syncState: 'stopped' }]);
      },
      testTimeoutMs,
    );

    it(
      'logs out a session that is not live without starting it',
      async () => {
        const s = await context.newSession();

        await expect(once(engine.logoutSession(s))).resolves.toEqual({
          ok: true,
          value: null,
        });

        await expect(context.tokenAccepted(s)).resolves.toBe(false);
        await expect(snapshot()).resolves.toEqual(EMPTY_SESSION);
      },
      testTimeoutMs,
    );

    it(
      'fails to log out a session whose token is already revoked',
      async () => {
        const s = await context.newSession();
        await expect(once(engine.logoutSession(s))).resolves.toEqual({
          ok: true,
          value: null,
        });

        const again = await once(engine.logoutSession(s));

        expect(!again.ok && again.failure.code).toBe('request-failed');
        expect(!again.ok && again.failure.diagnostic.errcode).toBe(
          'M_UNKNOWN_TOKEN',
        );
      },
      testTimeoutMs,
    );

    it(
      "reads the names a live account's engine holds",
      async () => {
        const a = await context.newSession();
        await restore(a);
        const room: AccountNameGroup = {
          roomNames: ['Garden Club'],
          roomTopics: ['Roses and tulips'],
          displayNames: ['Wren Quillfeather'],
        };
        await context.createNamedRoom(a, {
          displayName: room.displayNames[0],
          roomName: room.roomNames[0],
          roomTopic: room.roomTopics[0],
        });

        const deadline = Date.now() + syncTimeoutMs;
        let groups: readonly AccountNameGroup[] = [];
        while (Date.now() <= deadline) {
          const result = await once(engine.knownNames(a.userId));
          groups = result.ok ? result.value : [];
          if (groups.some((group) => plainEqual(group, room))) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(groups).toContainEqual(room);

        const missing = await once(engine.knownNames(NOBODY));
        expect(!missing.ok && missing.failure.code).toBe('account-not-live');
      },
      testTimeoutMs,
    );

    it(
      'stops everything',
      async () => {
        const s = await context.newSession();
        await restore(s);

        await expect(once(engine.stop())).resolves.toBeNull();

        await expect(snapshot()).resolves.toEqual(EMPTY_SESSION);
      },
      testTimeoutMs,
    );
  });
}
