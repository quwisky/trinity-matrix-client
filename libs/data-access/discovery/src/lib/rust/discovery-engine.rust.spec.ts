import { firstValueFrom, tap } from 'rxjs';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  ServerLogoutHoldUpdate,
  SessionEngine,
} from '@trinity/data-access/matrix-client';
import {
  type StdioTransport,
  startTesthostAccount,
  testhostBinaryAvailable,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineDiscoveryEngineContract } from '../../contract/discovery-engine.contract';
import { discoverySynapseFixture } from '../../contract/discovery-synapse-fixture';
import type { DiscoveryEngine } from '../discovery-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust DiscoveryEngine against Synapse',
  () => {
    let transport: StdioTransport | undefined;
    afterAll(async () => {
      await transport?.dispose();
    });

    defineDiscoveryEngineContract(async () => {
      const { me, ...fixture } = await discoverySynapseFixture(
        baseUrl as string,
        serverName,
        secret,
      );
      // Started after the fixture, so the first sync already holds the joined room.
      transport = await startTesthostAccount(baseUrl as string, me);
      return {
        engine: proxyEngine<DiscoveryEngine>('discovery', transport),
        accountId: me.userId,
        ...fixture,
      };
    });

    it('reports a dead token to a hold before a room preview answers', async () => {
      const { me, unjoinedRoom } = await discoverySynapseFixture(
        baseUrl as string,
        serverName,
        secret,
      );
      const host = await startTesthostAccount(baseUrl as string, me);
      try {
        const session = proxyEngine<SessionEngine>('session', host);
        const updates: ServerLogoutHoldUpdate[] = [];
        const held = session
          .holdServerLogout(me.userId)
          .subscribe((update) => updates.push(update));
        while (updates.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const revoked = await fetch(`${baseUrl}/_matrix/client/v3/logout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${me.accessToken}` },
        });
        expect(revoked.ok).toBe(true);

        let seen: string[] = [];
        // By id, so the raw room summary is the first request.
        const preview = await firstValueFrom(
          proxyEngine<DiscoveryEngine>('discovery', host)
            .previewRoom(me.userId, unjoinedRoom.roomId, [])
            .pipe(tap(() => (seen = updates.map((u) => u.kind)))),
        );

        expect(seen).toContain('token-died');
        expect(preview.ok).toBe(false);
        held.unsubscribe();
      } finally {
        await host.dispose();
      }
    }, 120_000);
  },
);
