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
});
