import { assertProgressThenResult } from '@trinity/util/matrix';
import { describe, expect, it } from 'vitest';
import { FakeMediaEngine } from './fake-media-engine';
import { defineMediaEngineContract } from './media-engine.contract';

defineMediaEngineContract(
  async () => {
    const engine = new FakeMediaEngine();
    return {
      engine,
      alice: engine.alice,
      read: (url) => engine.read(url),
      stored: (mxc) => engine.stored(mxc),
      room: async (encrypted) => engine.addRoom(encrypted),
      messages: async (roomId) =>
        engine.messages(roomId).map(({ msgtype, body, hasThumbnail }) => ({
          msgtype,
          body,
          hasThumbnail,
        })),
      dropNextSendResponse: () => {
        engine.dropNextSendResponse = true;
      },
      uploads: () => engine.uploads,
      withoutCrypto: () => {
        engine.crypto = false;
      },
      dispose: async () => undefined,
    };
  },
  { testTimeoutMs: 5_000 },
);

describe('FakeMediaEngine', () => {
  it('counts an upload unsubscribed before its result as aborted', () => {
    const engine = new FakeMediaEngine();

    engine
      .upload(engine.alice, new Blob(['x']), {
        filename: null,
        mimeType: 'text/plain',
        encrypt: false,
      })
      .subscribe()
      .unsubscribe();

    expect(engine.aborted).toBe(1);
  });

  it('mints no URL for content unsubscribed before its result', async () => {
    const engine = new FakeMediaEngine();
    const { result } = await assertProgressThenResult(
      engine.upload(engine.alice, new Blob(['x']), {
        filename: null,
        mimeType: 'text/plain',
        encrypt: false,
      }),
    );
    if (!result.ok || result.value.kind !== 'plain') throw new Error('upload');

    engine
      .content(engine.alice, {
        source: { kind: 'plain', mxc: result.value.mxc },
        format: { kind: 'file' },
        mimeType: 'image/png',
        downscaleTo: null,
      })
      .subscribe()
      .unsubscribe();
    await Promise.resolve();

    expect(engine.liveUrls()).toEqual([]);
  });

  it('withdraws an echo still waiting to send when unsubscribed', async () => {
    const engine = new FakeMediaEngine();
    const roomId = engine.addRoom();
    const updates = engine.sendAttachment(engine.alice, roomId, {
      attachmentKey: 'k',
      threadRootId: null,
      file: new Blob(['x']),
      filename: 'x.bin',
      mimeType: 'application/octet-stream',
      msgtype: 'm.file',
      info: { w: null, h: null, durationMs: null },
      thumbnail: null,
      caption: '',
      metadata: 'kept',
    });
    let reachedSend!: () => void;
    const sending = new Promise<void>((resolve) => (reachedSend = resolve));
    const subscription = updates.subscribe((update) => {
      if (update.kind === 'progress' && update.phase === 'sending') {
        reachedSend();
      }
    });
    await sending;
    subscription.unsubscribe();

    expect(engine.withdrawn).toBe(1);
    expect(engine.messages(roomId)).toEqual([]);
  });
});
