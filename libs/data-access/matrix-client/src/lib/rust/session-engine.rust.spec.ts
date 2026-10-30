import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Observable, firstValueFrom, tap } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { StdioTransport, testhostBinaryAvailable } from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineSessionEngineContract } from '../../contract/session-engine.contract';
import { sessionSynapseFixture } from '../../contract/session-synapse-fixture';
import type { SessionEngine, SessionSnapshot } from '../session-engine';

// Runs the session engine contract against the Rust test host and a live Synapse; skipped
// unless TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const testTimeoutMs = 180_000;

/** A fresh test host with its own stores and key. */
async function startHost() {
  const dir = await mkdtemp(join(tmpdir(), 'trinity-engine-'));
  const transport = StdioTransport.start({
    env: {
      ...process.env,
      TRINITY_ENGINE_DATA_DIR: dir,
      TRINITY_ENGINE_STORE_KEY: randomBytes(32).toString('hex'),
    },
  });
  return {
    transport,
    engine: proxyEngine<SessionEngine>('session', transport),
    dispose: async () => {
      await transport.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
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
      { syncTimeoutMs: 90_000, testTimeoutMs },
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
  },
);
