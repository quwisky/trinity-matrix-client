import {
  BehaviorSubject,
  type Observable,
  filter,
  firstValueFrom,
  tap,
  timeout,
  toArray,
} from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PresenceState, assertPlainData } from '@trinity/util/matrix';
import type { IdentityEngine, IgnoredUserInfo } from '../lib/identity-engine';

export interface IdentityContractSetup {
  readonly engine: IdentityEngine;
  /** A live, syncing account. */
  readonly alice: string;
  /** Another live account, whose profile alice reads. */
  readonly bob: string;
  /** A user id on the same server that no account has. */
  readonly unknownUser: string;
  /** A user in a room with alice, with a name and avatar that no case changes. */
  readonly knownUser: IgnoredUserInfo;
  /** Two `mxc://` URIs to set as avatars. */
  readonly avatars: readonly [string, string];
  dispose(): Promise<void>;
}

export interface IdentityContractTiming {
  /** How long a change may take to reach an emission. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface Watch<T> {
  until(predicate: (value: T) => boolean): Promise<T>;
  close(): void;
}

const NOBODY = '@nobody:invalid';

export function defineIdentityEngineContract(
  setup: () => Promise<IdentityContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: IdentityContractTiming,
): void {
  describe('IdentityEngine contract', () => {
    let context: IdentityContractSetup;
    let engine: IdentityEngine;

    beforeAll(async () => {
      context = await setup();
      engine = context.engine;
    }, 120_000);

    afterAll(() => context?.dispose(), testTimeoutMs);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    /** Waits out a rate-limited write (Synapse allows one per user per 10 s) and sends it again. */
    async function setPresence(
      accountId: string,
      presence: PresenceState,
      statusMessage: string | null,
    ) {
      for (;;) {
        const result = await once(
          engine.setPresence(accountId, presence, statusMessage),
        );
        if (result.ok || result.failure.kind !== 'rate-limit') return result;
        await new Promise((resolve) =>
          setTimeout(resolve, result.failure.diagnostic.retryAfterMs ?? 1_000),
        );
      }
    }

    function watch<T>(source: Observable<T>): Watch<T> {
      const latest$ = new BehaviorSubject<T | undefined>(undefined);
      const subscription = source
        .pipe(
          tap((value) => expect(() => assertPlainData(value)).not.toThrow()),
        )
        .subscribe(latest$);
      return {
        until: (predicate) =>
          firstValueFrom(
            latest$.pipe(
              filter((value): value is T => value !== undefined),
              filter(predicate),
              timeout(settleTimeoutMs),
            ),
          ),
        close: () => subscription.unsubscribe(),
      };
    }

    it(
      'answers with an empty snapshot for an account that is not live',
      async () => {
        const seen = await Promise.all(
          (
            [
              engine.ownProfile(NOBODY),
              engine.presence(NOBODY),
              engine.ignoredUsers(NOBODY),
            ] as Observable<unknown>[]
          ).map((snapshot) => firstValueFrom(snapshot.pipe(timeout(5_000)))),
        );
        expect(seen).toEqual([{ displayName: null, avatarMxc: null }, [], []]);

        for (const command of [
          engine.profile(NOBODY, context.bob),
          engine.setDisplayName(NOBODY, 'Nobody'),
          engine.setAvatar(NOBODY, context.avatars[0]),
          engine.ownPresence(NOBODY),
          engine.setPresence(NOBODY, 'online', null),
          engine.setIgnored(NOBODY, context.bob, true),
        ] as Observable<unknown>[]) {
          expect(await once(command)).toMatchObject({
            ok: false,
            failure: { code: 'account-not-live' },
          });
        }
      },
      testTimeoutMs,
    );

    it(
      'reads the profile another account sets, and an empty one for an unknown user',
      async () => {
        const { alice, bob, unknownUser, avatars } = context;
        const name = `Bob ${Date.now().toString(36)}`;

        expect(await once(engine.setDisplayName(bob, name))).toEqual({
          ok: true,
          value: null,
        });
        expect(await once(engine.setAvatar(bob, avatars[1]))).toEqual({
          ok: true,
          value: null,
        });

        expect(await once(engine.profile(alice, bob))).toEqual({
          ok: true,
          value: { displayName: name, avatarMxc: avatars[1] },
        });
        expect(await once(engine.profile(alice, unknownUser))).toEqual({
          ok: true,
          value: { displayName: null, avatarMxc: null },
        });
      },
      testTimeoutMs,
    );

    it(
      'follows the account’s own name and avatar',
      async () => {
        const { alice, avatars } = context;
        const name = `Alice ${Date.now().toString(36)}`;
        const own = watch(engine.ownProfile(alice));
        try {
          expect(await once(engine.setDisplayName(alice, name))).toEqual({
            ok: true,
            value: null,
          });
          await own.until((profile) => profile.displayName === name);

          await once(engine.setAvatar(alice, avatars[0]));
          expect(
            await own.until((profile) => profile.avatarMxc === avatars[0]),
          ).toEqual({ displayName: name, avatarMxc: avatars[0] });
        } finally {
          own.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'delivers the account’s own presence once it sets it, then clears its message',
      async () => {
        const { alice } = context;
        const own = watch(engine.presence(alice));
        try {
          expect(await setPresence(alice, 'unavailable', 'Lunch')).toEqual({
            ok: true,
            value: null,
          });

          const snapshot = await own.until((users) =>
            users.some(
              (user) =>
                user.userId === alice &&
                user.presence === 'unavailable' &&
                user.statusMessage === 'Lunch',
            ),
          );
          expect(snapshot.filter((user) => user.userId === alice)).toEqual([
            {
              userId: alice,
              presence: 'unavailable',
              statusMessage: 'Lunch',
              lastActiveAt: expect.toBeOneOf([null, expect.any(Number)]),
              currentlyActive: expect.any(Boolean),
            },
          ]);

          await expect
            .poll(async () => await once(engine.ownPresence(alice)), {
              timeout: settleTimeoutMs,
            })
            .toEqual({
              ok: true,
              value: { presence: 'unavailable', statusMessage: 'Lunch' },
            });

          expect(await setPresence(alice, 'online', null)).toEqual({
            ok: true,
            value: null,
          });
          await own.until((users) =>
            users.some(
              (user) =>
                user.userId === alice &&
                user.presence === 'online' &&
                user.statusMessage === null,
            ),
          );
        } finally {
          own.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'ignores and unignores users, two quick changes both landing',
      async () => {
        const { alice, bob, knownUser, unknownUser } = context;
        const ignored = watch(engine.ignoredUsers(alice));
        const byId = (users: readonly IgnoredUserInfo[]) =>
          [...users].sort((a, b) => a.userId.localeCompare(b.userId));
        const both = byId([
          knownUser,
          { userId: unknownUser, displayName: null, avatarMxc: null },
        ]);
        try {
          const [first, second] = await Promise.all([
            once(engine.setIgnored(alice, knownUser.userId, true)),
            once(engine.setIgnored(alice, unknownUser, true)),
          ]);
          expect([first, second]).toEqual([
            { ok: true, value: null },
            { ok: true, value: null },
          ]);
          expect(
            byId(await ignored.until((users) => users.length === 2)),
          ).toEqual(both);

          expect(
            await once(engine.setIgnored(alice, knownUser.userId, true)),
          ).toEqual({ ok: true, value: null });
          expect(byId(await ignored.until(() => true))).toEqual(both);

          expect(await once(engine.setIgnored(alice, bob, false))).toEqual({
            ok: true,
            value: null,
          });
          await once(engine.setIgnored(alice, knownUser.userId, false));
          expect(
            await ignored.until((users) =>
              users.every((user) => user.userId !== knownUser.userId),
            ),
          ).toEqual([
            { userId: unknownUser, displayName: null, avatarMxc: null },
          ]);
          await once(engine.setIgnored(alice, unknownUser, false));
          await ignored.until((users) => users.length === 0);

          expect(
            await once(engine.setIgnored(alice, unknownUser, false)),
          ).toEqual({ ok: true, value: null });
          expect(await ignored.until(() => true)).toEqual([]);
        } finally {
          ignored.close();
        }
      },
      testTimeoutMs,
    );
  });
}
