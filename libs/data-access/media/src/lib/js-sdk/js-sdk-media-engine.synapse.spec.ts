import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineMediaEngineContract } from '../../contract/media-engine.contract';
import { JsSdkMediaEngine } from './js-sdk-media-engine';
import {
  baseUrl,
  cs,
  localpart,
  room,
  register,
  startSession,
  useSynapseSuite,
} from './synapse.spec-harness';

// jsdom serves no crypto .wasm and has no IndexedDB (the sync store falls back to memory).
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

function filenameOf(disposition: string): string | null {
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

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
      const session = await startSession(await register(localpart('alice')));
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
        stored: async (mxc) => {
          const res = await fetch(
            `${baseUrl}/_matrix/client/v1/media/download/${mxc.slice('mxc://'.length)}`,
            { headers: { authorization: `Bearer ${session.accessToken}` } },
          );
          if (!res.ok)
            throw new Error(`Synapse download failed: ${res.status}`);
          return {
            filename: filenameOf(res.headers.get('content-disposition') ?? ''),
            mimeType: (res.headers.get('content-type') ?? '')
              .split(';')[0]
              .trim(),
          };
        },
        room: async (encrypted) => {
          const { room_id } = (await cs(
            session.accessToken,
            'POST',
            '/createRoom',
            {
              preset: 'private_chat',
              ...(encrypted
                ? {
                    initial_state: [
                      {
                        type: 'm.room.encryption',
                        state_key: '',
                        content: { algorithm: 'm.megolm.v1.aes-sha2' },
                      },
                    ],
                  }
                : {}),
            },
          )) as { room_id: string };
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
        messages: async (roomId) => {
          const { chunk } = (await cs(
            session.accessToken,
            'GET',
            `${room(roomId)}/messages?dir=f&limit=100`,
          )) as {
            chunk: { type: string; content: Record<string, unknown> }[];
          };
          return chunk
            .filter(
              (event) =>
                event.type === 'm.room.message' &&
                typeof event.content['msgtype'] === 'string',
            )
            .map(({ content }) => {
              const info = content['info'] as
                Record<string, unknown> | undefined;
              return {
                msgtype: String(content['msgtype']),
                body: String(content['body']),
                hasThumbnail: Boolean(
                  info?.['thumbnail_url'] ?? info?.['thumbnail_file'],
                ),
              };
            });
        },
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
