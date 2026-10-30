import { Injector } from '@angular/core';
import {
  ClientEvent,
  type MatrixClient,
  SyncState,
  createClient,
} from 'matrix-js-sdk';
import { afterAll, beforeAll, describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineIdentityEngineContract } from '../../contract/identity-engine.contract';
import { identitySynapseFixture } from '../../contract/identity-synapse-fixture';
import { JsSdkIdentityEngine } from './js-sdk-identity-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

function startSyncing(client: MatrixClient): Promise<void> {
  const synced = new Promise<void>((resolve) => {
    const check = (state: SyncState) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        client.off(ClientEvent.Sync, check);
        resolve();
      }
    };
    client.on(ClientEvent.Sync, check);
  });
  return client.startClient({ initialSyncLimit: 1 }).then(() => synced);
}

async function setUpJs() {
  const { alice, bob, ...fixture } = await identitySynapseFixture(
    baseUrl as string,
    serverName,
    secret,
  );
  const jsClient = (user: typeof alice) =>
    createClient({
      baseUrl: baseUrl as string,
      userId: user.userId,
      accessToken: user.accessToken,
      deviceId: user.deviceId,
    });
  const aliceClient = jsClient(alice);
  const bobClient = jsClient(bob);
  await Promise.all([startSyncing(aliceClient), startSyncing(bobClient)]);

  const clients = new Map([
    [alice.userId, aliceClient],
    [bob.userId, bobClient],
  ]);
  const engine = Injector.create({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => clients.get(id) ?? null },
      },
      JsSdkIdentityEngine,
    ],
  }).get(JsSdkIdentityEngine);
  return {
    engine,
    alice: alice.userId,
    bob: bob.userId,
    ...fixture,
    dispose: () => {
      aliceClient.stopClient();
      bobClient.stopClient();
      return Promise.resolve();
    },
  };
}

describe.skipIf(!baseUrl)('JsSdkIdentityEngine against Synapse', () => {
  // Stopping a client aborts its in-flight /sync long-poll and the SDK leaves that rejection
  // unhandled; Vitest would fail the run for it, so only that abort is kept from Vitest.
  let listeners: NodeJS.UnhandledRejectionListener[] = [];
  const ignoreSyncAbort = (reason: unknown, promise: Promise<unknown>) => {
    if ((reason as { name?: string } | null)?.name === 'AbortError') return;
    for (const listener of listeners) listener(reason, promise);
  };
  beforeAll(() => {
    listeners = process.listeners(
      'unhandledRejection',
    ) as NodeJS.UnhandledRejectionListener[];
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', ignoreSyncAbort);
  });
  afterAll(() => {
    process.removeListener('unhandledRejection', ignoreSyncAbort);
    for (const listener of listeners)
      process.on('unhandledRejection', listener);
  });

  defineIdentityEngineContract(setUpJs, {
    settleTimeoutMs: 20_000,
    testTimeoutMs: 60_000,
  });
});
