import { TestBed } from '@angular/core/testing';
import { MatrixClient, type Room } from 'matrix-js-sdk';
import { beforeEach, describe, vi } from 'vitest';
import { defineRoomAdministrationEngineContract } from '../../contract/room-administration-engine.contract';
import { roomAdministrationSynapseFixture } from '../../contract/room-administration-synapse-fixture';
import { JsSdkRoomAdministrationEngine } from './js-sdk-room-administration-engine';
import {
  baseUrl,
  secret,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the room administration contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)(
  'JsSdkRoomAdministrationEngine against Synapse',
  () => {
    useSynapseSuite();

    // Rust crypto is stubbed (no .wasm in jsdom); this stands in for the crypto store's
    // room-encryption record that turning encryption on reads and writes.
    beforeEach(() => {
      const encrypted = new Set<string>();
      vi.spyOn(MatrixClient.prototype, 'getCrypto').mockReturnValue({
        isEncryptionEnabledInRoom: async (roomId: string) =>
          encrypted.has(roomId),
        onCryptoEvent: async (target: Room) => {
          encrypted.add(target.roomId);
        },
      } as never);
    });

    defineRoomAdministrationEngineContract(
      async () => {
        const { alice, ...fixture } = await roomAdministrationSynapseFixture(
          baseUrl as string,
          secret,
        );
        const session = await startSession(alice);

        return {
          ...fixture,
          engine: TestBed.inject(JsSdkRoomAdministrationEngine),
          alice: session.userId,
          dispose: () => session.dispose(),
        };
      },
      { settleTimeoutMs: 30_000, testTimeoutMs: 180_000 },
    );
  },
);
