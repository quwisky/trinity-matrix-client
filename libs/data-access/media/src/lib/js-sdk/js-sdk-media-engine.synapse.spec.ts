import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { assertProgressThenResult } from '@trinity/util/matrix';
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

  async function open() {
    const fixture = await mediaSynapseFixture(baseUrl as string, secret);
    const session = await startSession(fixture.alice);
    const client = TestBed.inject(JS_SDK_CLIENTS).clientFor(session.userId);
    if (!client) throw new Error('No live client for alice');
    const room = async (encrypted: boolean) => {
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
    };
    return { fixture, session, client, room };
  }

  it('fails closed with encryption-unavailable in an encrypted room without crypto', async () => {
    const { fixture, session, client, room } = await open();
    const crypto = vi.spyOn(client, 'getCrypto').mockReturnValue(undefined);
    const upload = vi.spyOn(client, 'uploadContent');
    const roomId = await room(true);

    const { progress, result } = await assertProgressThenResult(
      TestBed.inject(JsSdkMediaEngine).sendAttachment(session.userId, roomId, {
        attachmentKey: 'no-crypto',
        threadRootId: null,
        file: new Blob([new Uint8Array([1])], { type: 'image/png' }),
        filename: 'photo.png',
        mimeType: 'image/png',
        msgtype: 'm.image',
        info: { w: 1, h: 1, durationMs: null },
        thumbnail: null,
        caption: '',
        captionFields: { body: 'photo.png' },
        metadata: 'stripped',
      }),
    );

    expect(crypto).toHaveBeenCalled();
    expect(progress).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'encryption-unavailable' },
    });
    expect(await fixture.messages(roomId)).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    await session.dispose();
  }, 180_000);

  defineMediaEngineContract(
    async () => {
      const { fixture, session, client, room } = await open();
      let uploaded = 0;
      let gate: Promise<void> | null = null;
      const forward = client.uploadContent.bind(client);
      vi.spyOn(client, 'uploadContent').mockImplementation(
        async (file, options) => {
          const held = gate;
          if (held) {
            const signal = options?.abortController?.signal;
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(new Error('Upload aborted'));
              if (signal?.aborted) return abort();
              signal?.addEventListener('abort', abort, { once: true });
              void held.then(resolve);
            });
          }
          uploaded++;
          return forward(file, options);
        },
      );
      // initRustCrypto is stubbed, so stand in a probe that reads the room's state.
      vi.spyOn(client, 'getCrypto').mockReturnValue({
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
        room,
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
        // A 400, not a 5xx: the SDK's scheduler retries a 5xx after the one-shot spy is gone.
        refuseNextSend: () => {
          const realFetch = globalThis.fetch;
          const refuse = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input, init) => {
              const url = input instanceof Request ? input.url : String(input);
              if (!url.includes('/send/m.room.message/')) {
                return realFetch(input, init);
              }
              refuse.mockRestore();
              return new Response('{"errcode":"M_UNKNOWN"}', { status: 400 });
            });
        },
        holdUploads: () => {
          let release!: () => void;
          gate = new Promise<void>((resolve) => (release = resolve));
          return () => {
            gate = null;
            release();
          };
        },
        uploads: () => uploaded,
        dispose: () => session.dispose(),
      };
    },
    { testTimeoutMs: 180_000 },
  );
});
