import { type Observable, firstValueFrom, tap, timeout } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type {
  ServerLogoutHoldUpdate,
  SessionEngine,
} from '@trinity/data-access/matrix-client';
import {
  StdioTransport,
  startRustAccount,
  startTesthostAccount,
  synapseRequest,
  testhostBinaryAvailable,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineIdentityEngineContract } from '../../contract/identity-engine.contract';
import {
  type IdentitySynapseFixture,
  identitySynapseFixture,
} from '../../contract/identity-synapse-fixture';
import type { IdentityEngine, UserProfile } from '../identity-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] ?? '';
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const timing = { settleTimeoutMs: 20_000, testTimeoutMs: 60_000 };
const extraTimeoutMs = 120_000;

/** What `source` delivers from now on: its values, and its error or completion in `ended`. */
function recording<T>(source: Observable<T>) {
  const values: T[] = [];
  const ended: unknown[] = [];
  const subscription = source.subscribe({
    next: (value) => values.push(value),
    error: (error: unknown) => ended.push(error),
    complete: () => ended.push('complete'),
  });
  return {
    values,
    ended,
    /** Waits until the latest value meets `predicate`. */
    shows: (
      predicate: (value: T) => boolean,
      timeoutMs = timing.settleTimeoutMs,
    ) =>
      expect
        .poll(() => values.at(-1), { timeout: timeoutMs })
        .toSatisfy((value) => value !== undefined && predicate(value)),
    close: () => subscription.unsubscribe(),
  };
}

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust IdentityEngine against Synapse',
  () => {
    defineIdentityEngineContract(async () => {
      const { alice, bob, ...fixture } = await identitySynapseFixture(
        baseUrl,
        serverName,
        secret,
      );
      const transport = StdioTransport.start();
      try {
        // The second 'activate' only moves the active account; every identity call names its own.
        for (const { userId, deviceId, accessToken } of [alice, bob]) {
          await startRustAccount(transport, {
            baseUrl,
            userId,
            deviceId,
            accessToken,
          });
        }
      } catch (error) {
        await transport.dispose();
        throw error;
      }
      return {
        engine: proxyEngine<IdentityEngine>('identity', transport),
        alice: alice.userId,
        bob: bob.userId,
        ...fixture,
        dispose: () => transport.dispose(),
      };
    }, timing);

    describe('beyond the contract', () => {
      /** Runs `body` on a fresh fixture with alice alone on her own test host. */
      async function withAlice(
        body: (
          context: Pick<IdentitySynapseFixture, 'alice' | 'bob'> & {
            identity: IdentityEngine;
            session: SessionEngine;
          },
        ) => Promise<void>,
      ): Promise<void> {
        const { alice, bob } = await identitySynapseFixture(
          baseUrl,
          serverName,
          secret,
        );
        const host = await startTesthostAccount(baseUrl, alice);
        try {
          await body({
            alice,
            bob,
            identity: proxyEngine<IdentityEngine>('identity', host),
            session: proxyEngine<SessionEngine>('session', host),
          });
        } finally {
          await host.dispose();
        }
      }

      it(
        'ends its streams quietly and replies fast on a restart and a remove',
        () =>
          withAlice(async ({ alice, identity, session }) => {
            const { userId, deviceId, accessToken } = alice;
            // Synapse names a new user after its localpart. A late member event can tick another
            // read, but a re-read returns the same value and `follow` drops duplicates, so the
            // snapshots stay unchanged.
            const named = (own: UserProfile) => own.displayName !== null;
            const own = recording(identity.ownProfile(userId));
            const streams = [
              own,
              recording(identity.presence(userId)),
              recording(identity.ignoredUsers(userId)),
            ];
            try {
              await Promise.all(
                streams.map((stream) => stream.shows(() => true)),
              );
              await own.shows(named);
              const before = streams.map((stream) => [...stream.values]);

              expect(
                await firstValueFrom(
                  session
                    .restorePersisted(
                      { baseUrl, userId, deviceId, accessToken },
                      'activate',
                    )
                    .pipe(timeout(15_000)),
                ),
              ).toEqual({ ok: true, value: null });
              const fresh = recording(identity.ownProfile(userId));
              streams.push(fresh);
              await fresh.shows(named);
              before.push([...fresh.values]);
              expect(
                await firstValueFrom(
                  session.remove(userId).pipe(timeout(15_000)),
                ),
              ).toBeNull();
              await new Promise((resolve) => setTimeout(resolve, 1_000));

              expect(streams.map((stream) => stream.values)).toEqual(before);
              expect(streams.map((stream) => stream.ended)).toEqual([
                [],
                [],
                [],
                [],
              ]);
            } finally {
              for (const stream of streams) stream.close();
            }
          }),
        extraTimeoutMs,
      );

      it(
        'reports a dead token to a hold before the request that met it answers',
        () =>
          withAlice(async ({ alice, identity, session }) => {
            const updates: ServerLogoutHoldUpdate[] = [];
            const held = session
              .holdServerLogout(alice.userId)
              .subscribe((update) => updates.push(update));
            try {
              await expect.poll(() => updates.length).toBeGreaterThan(0);
              await synapseRequest(
                baseUrl,
                alice.accessToken,
                'POST',
                '/logout',
                {},
              );

              let seen: string[] = [];
              // Not `profile`: Synapse answers a profile without checking the token.
              const answer = await firstValueFrom(
                identity
                  .ownPresence(alice.userId)
                  .pipe(tap(() => (seen = updates.map((u) => u.kind)))),
              );

              expect(seen).toContain('token-died');
              expect(answer.ok).toBe(false);
            } finally {
              held.unsubscribe();
            }
          }),
        extraTimeoutMs,
      );

      it(
        'follows a name another session sets',
        () =>
          withAlice(async ({ alice, identity }) => {
            const own = recording(identity.ownProfile(alice.userId));
            try {
              await own.shows((profile) => profile.displayName !== null);
              const name = `Elsewhere ${Date.now().toString(36)}`;
              await synapseRequest(
                baseUrl,
                alice.accessToken,
                'PUT',
                `/profile/${encodeURIComponent(alice.userId)}/displayname`,
                { displayname: name },
              );

              await own.shows(
                (profile) => profile.displayName === name,
                30_000,
              );
            } finally {
              own.close();
            }
          }),
        extraTimeoutMs,
      );

      it(
        'lists only the account’s own presence',
        () =>
          withAlice(async ({ alice, bob, identity }) => {
            await synapseRequest(
              baseUrl,
              bob.accessToken,
              'PUT',
              `/presence/${encodeURIComponent(bob.userId)}/status`,
              { presence: 'online', status_msg: 'Away' },
            );
            const presence = recording(identity.presence(alice.userId));
            try {
              expect(
                await firstValueFrom(
                  identity.setPresence(alice.userId, 'online', null),
                ),
              ).toEqual({ ok: true, value: null });

              await presence.shows((users) =>
                users.some((user) => user.userId === alice.userId),
              );
              expect(
                presence.values.at(-1)?.map((user) => user.userId),
              ).toEqual([alice.userId]);
            } finally {
              presence.close();
            }
          }),
        extraTimeoutMs,
      );
    });
  },
);
