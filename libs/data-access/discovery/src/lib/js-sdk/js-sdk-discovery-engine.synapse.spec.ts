import { Injector } from '@angular/core';
import { ClientEvent, type MatrixClient, createClient } from 'matrix-js-sdk';
import { afterAll, beforeAll, describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineDiscoveryEngineContract } from '../../contract/discovery-engine.contract';
import { discoverySynapseFixture } from '../../contract/discovery-synapse-fixture';
import { JsSdkDiscoveryEngine } from './js-sdk-discovery-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl)('JsSdkDiscoveryEngine against Synapse', () => {
  // Stopping a client aborts its in-flight /sync long-poll and the SDK leaves that rejection
  // unhandled; Vitest would fail the run for it, so only that abort is kept from Vitest.
  let listeners: NodeJS.UnhandledRejectionListener[] = [];
  let syncing: MatrixClient | undefined;
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
    syncing?.stopClient();
    process.removeListener('unhandledRejection', ignoreSyncAbort);
    for (const listener of listeners)
      process.on('unhandledRejection', listener);
  });

  defineDiscoveryEngineContract(async () => {
    const { me, ...fixture } = await discoverySynapseFixture(
      baseUrl as string,
      serverName,
      secret,
    );
    const client = createClient({
      baseUrl: baseUrl as string,
      userId: me.userId,
      accessToken: me.accessToken,
    });
    const synced = new Promise<void>((resolve) => {
      const check = () => {
        if (
          client.getRoom(fixture.joinedRoom.roomId)?.getMyMembership() ===
          'join'
        ) {
          client.off(ClientEvent.Sync, check);
          resolve();
        }
      };
      client.on(ClientEvent.Sync, check);
    });
    await client.startClient({ initialSyncLimit: 1 });
    syncing = client;
    await synced;
    const engine = Injector.create({
      providers: [
        {
          provide: JS_SDK_CLIENTS,
          useValue: {
            clientFor: (id: string) => (id === me.userId ? client : null),
          },
        },
        JsSdkDiscoveryEngine,
      ],
    }).get(JsSdkDiscoveryEngine);
    return { engine, accountId: me.userId, ...fixture };
  });
});
