import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineMediaEngineContract } from '../../contract/media-engine.contract';
import { JsSdkMediaEngine } from './js-sdk-media-engine';
import { mediaSynapseFixture } from '../../contract/media-synapse-fixture';
import {
  baseUrl,
  secret,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// Runs the media contract against a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS is set.
describe.skipIf(!baseUrl)('JsSdkMediaEngine against Synapse', () => {
  useSynapseSuite();

  // jsdom cannot fetch a blob: URL, so the object-URL registry is kept here and read back.
  const blobs = new Map<string, Blob>();
  let minted = 0;
  beforeEach(() => {
    blobs.clear();
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:synapse/${++minted}`;
      blobs.set(url, blob as Blob);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      blobs.delete(url);
    });
  });

  defineMediaEngineContract(
    async () => {
      const fixture = await mediaSynapseFixture(baseUrl as string, secret);
      const session = await startSession(fixture.alice);
      const client = TestBed.inject(JS_SDK_CLIENTS).clientFor(session.userId);
      if (!client) throw new Error('No live client for alice');
      const uploads = vi.spyOn(client, 'uploadContent');
      // initRustCrypto is stubbed, so stand in a probe that reads the room's state.
      const crypto = vi.spyOn(client, 'getCrypto').mockReturnValue({
        isEncryptionEnabledInRoom: async (roomId: string) =>
          client.getRoom(roomId)?.hasEncryptionStateEvent() ?? false,
      } as never);

      return {
        engine: TestBed.inject(JsSdkMediaEngine),
        alice: session.userId,
        read: async (url) => {
          const blob = blobs.get(url);
          if (!blob) throw new Error(`No bytes behind ${url}`);
          return new Uint8Array(await blob.arrayBuffer());
        },
        stored: fixture.stored,
        room: async (encrypted) => {
          const room_id = await fixture.createRoom(encrypted);
          await vi.waitFor(
            () => {
              const seen = client.getRoom(room_id);
              if (!seen || seen.hasEncryptionStateEvent() !== encrypted) {
                throw new Error(`Waiting for ${room_id}`);
              }
            },
            { timeout: 30_000, interval: 100 },
          );
          return room_id;
        },
        messages: fixture.messages,
        dropNextSendResponse: () => {
          const realFetch = globalThis.fetch;
          const drop = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input, init) => {
              const response = await realFetch(input, init);
              const url = input instanceof Request ? input.url : String(input);
              if (!url.includes('/send/m.room.message/')) return response;
              drop.mockRestore();
              throw new TypeError('Failed to fetch');
            });
        },
        uploads: () => uploads.mock.calls.length,
        withoutCrypto: () => {
          crypto.mockReturnValue(undefined);
        },
        dispose: () => session.dispose(),
      };
    },
    { testTimeoutMs: 180_000 },
  );
});
