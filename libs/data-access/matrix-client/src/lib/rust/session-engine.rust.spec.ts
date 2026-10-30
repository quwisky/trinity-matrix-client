import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Observable,
  first,
  firstValueFrom,
  tap,
  timeout,
  toArray,
} from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { StdioTransport, testhostBinaryAvailable } from '@trinity/testing';
import { type MatrixSession, proxyEngine } from '@trinity/util/matrix';
import { defineSessionEngineContract } from '../../contract/session-engine.contract';
import { sessionSynapseFixture } from '../../contract/session-synapse-fixture';
import type { SessionEngine, SessionSnapshot } from '../session-engine';

// Runs the session engine contract against the Rust test host and a live Synapse; skipped
// unless TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const syncTimeoutMs = 90_000;
const testTimeoutMs = 180_000;

/** A test host over `store`, or over fresh stores and a fresh key. Only a fresh one removes its stores. */
async function startHost(store?: { dir: string; key: string }) {
  const dir = store?.dir ?? (await mkdtemp(join(tmpdir(), 'trinity-engine-')));
  const transport = StdioTransport.start({
    env: {
      ...process.env,
      TRINITY_ENGINE_DATA_DIR: dir,
      TRINITY_ENGINE_STORE_KEY: store?.key ?? randomBytes(32).toString('hex'),
    },
  });
  return {
    transport,
    engine: proxyEngine<SessionEngine>('session', transport),
    dispose: async () => {
      await transport.dispose();
      if (!store) await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The device's published `ed25519` key once its keys have not changed for `settleMs`: the upload
 * follows the first sync, so a new identity uploaded late still changes the answer.
 */
async function publishedEd25519Key(
  session: MatrixSession,
  settleMs = 3_000,
): Promise<string | undefined> {
  let last: string | undefined;
  let unchangedSince = Date.now();
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/keys/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ device_keys: { [session.userId]: [] } }),
    });
    if (!res.ok) throw new Error(`keys/query answered ${res.status}`);
    const body = (await res.json()) as {
      device_keys?: Record<
        string,
        Record<string, { keys?: Record<string, string> }>
      >;
    };
    const keys = body.device_keys?.[session.userId]?.[session.deviceId]?.keys;
    const seen = JSON.stringify(keys ?? null);
    if (seen !== last) {
      last = seen;
      unchangedSince = Date.now();
    } else if (keys && Date.now() - unchangedSince >= settleMs) {
      return keys[`ed25519:${session.deviceId}`];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust SessionEngine against Synapse',
  () => {
    const synapse = sessionSynapseFixture(baseUrl, secret);
    beforeAll(() => synapse.waitForBackgroundUpdates(), 120_000);

    defineSessionEngineContract(
      async () => {
        const { transport, engine, dispose } = await startHost();
        return {
          engine,
          newSession: synapse.newSession,
          tokenAccepted: synapse.tokenAccepted,
          softLogout: async (session) => {
            await firstValueFrom(
              transport.open('testhost.serverLogout', [session.userId, true]),
            );
          },
          revokeToken: synapse.revokeToken,
          passwordFor: synapse.passwordFor,
          signInAgain: synapse.signInAgain,
          createNamedRoom: synapse.createNamedRoom,
          dispose,
        };
      },
      { syncTimeoutMs, testTimeoutMs },
    );

    it(
      "shows each command's effect in an open session() subscription before the reply",
      async () => {
        const host = await startHost();
        const seen: SessionSnapshot[] = [];
        const subscription = host.engine
          .session()
          .subscribe((snapshot) => seen.push(snapshot));
        /** The reply of `command`, by when `session()` must already show `effect`. */
        const after = <T>(
          command: Observable<T>,
          effect: (shown: SessionSnapshot | undefined) => boolean,
        ) =>
          firstValueFrom(
            command.pipe(tap(() => expect(effect(seen.at(-1))).toBe(true))),
          );
        const lists = (s: SessionSnapshot | undefined, id: string) =>
          s?.accounts.some((account) => account.accountId === id) ?? false;
        try {
          const a = await synapse.newSession();
          const b = await synapse.newSession();
          const { engine } = host;

          await after(engine.restorePersisted(a, 'activate'), (s) =>
            lists(s, a.userId),
          );
          await after(engine.restorePersisted(b, 'background'), (s) =>
            lists(s, b.userId),
          );
          await after(
            engine.setActive(b.userId),
            (s) => s?.activeAccountId === b.userId,
          );
          await after(
            engine.remove(b.userId),
            (s) => !lists(s, b.userId) && s?.activeAccountId === a.userId,
          );
        } finally {
          subscription.unsubscribe();
          await firstValueFrom(host.engine.stop());
          await host.dispose();
        }
      },
      testTimeoutMs,
    );

    it(
      'reports false for a live account without a key backup',
      async () => {
        const { engine, dispose } = await startHost();
        try {
          const a = await synapse.newSession();
          await expect(
            firstValueFrom(engine.restorePersisted(a, 'activate')),
          ).resolves.toEqual({ ok: true, value: null });
          await firstValueFrom(
            engine.session().pipe(
              first((s) =>
                s.accounts.some(
                  (account) =>
                    account.accountId === a.userId && account.serverSynced,
                ),
              ),
              timeout(syncTimeoutMs),
            ),
          );

          await expect(
            firstValueFrom(engine.roomKeysBackedUp(a.userId).pipe(toArray())),
          ).resolves.toEqual([false]);
        } finally {
          await firstValueFrom(engine.stop());
          await dispose();
        }
      },
      testTimeoutMs,
    );

    it(
      'keeps its store across an engine restart',
      async () => {
        const store = {
          dir: await mkdtemp(join(tmpdir(), 'trinity-engine-')),
          key: randomBytes(32).toString('hex'),
        };
        const a = await synapse.newSession();
        const serverSynced = (s: SessionSnapshot) =>
          s.accounts.some(
            (account) => account.accountId === a.userId && account.serverSynced,
          );
        try {
          const host1 = await startHost(store);
          let keyBefore: string | undefined;
          try {
            await firstValueFrom(host1.engine.restorePersisted(a, 'activate'));
            await firstValueFrom(
              host1.engine
                .session()
                .pipe(first(serverSynced), timeout(syncTimeoutMs)),
            );
            keyBefore = await publishedEd25519Key(a);
            await firstValueFrom(host1.engine.stop());
          } finally {
            await host1.dispose();
          }
          expect(keyBefore).toBeTruthy();

          const host2 = await startHost(store);
          try {
            await expect(
              firstValueFrom(host2.engine.restorePersisted(a, 'activate')),
            ).resolves.toEqual({ ok: true, value: null });
            await expect(
              firstValueFrom(host2.engine.accountStatus(a.userId)),
            ).resolves.toBe('active');
            await firstValueFrom(
              host2.engine
                .session()
                .pipe(first(serverSynced), timeout(syncTimeoutMs)),
            );
            await expect(publishedEd25519Key(a)).resolves.toBe(keyBefore);
          } finally {
            await firstValueFrom(host2.engine.stop());
            await host2.dispose();
          }
        } finally {
          await rm(store.dir, { recursive: true, force: true });
        }
      },
      testTimeoutMs,
    );
  },
);
