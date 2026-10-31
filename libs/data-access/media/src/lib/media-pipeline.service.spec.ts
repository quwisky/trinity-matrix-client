import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, take, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SNAPSHOT } from '@trinity/data-access/matrix-client';
import {
  engineOk,
  mediaCaptionFields,
  type MediaPayload,
} from '@trinity/util/matrix';
import { FakeMediaEngine } from '../contract/fake-media-engine';
import { strippedMedia } from './image-metadata/strip-file-metadata';
import type { AttachmentOutcome, TransferUpdate } from './media-engine';
import { MEDIA_ENGINE } from './media-engine.token';
import { describeMedia } from './media-processing';
import { MediaService } from './media.service';
import { MediaPipeline } from './media-pipeline.service';
import type { MediaTransferRequest } from './media-pipeline.models';
import { sessionWith } from './media.spec-harness';

// The WebView probe needs a real decoder; these specs give it the measurements directly.
vi.mock('./media-processing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media-processing')>()),
  describeMedia: vi.fn(() => Promise.resolve({ dims: {}, thumbnail: null })),
}));

// Wrapped so a spec can make stripping fail; it keeps doing the real work otherwise.
vi.mock('./image-metadata/strip-file-metadata', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('./image-metadata/strip-file-metadata')
    >();
  return { ...real, strippedMedia: vi.fn(real.strippedMedia) };
});

const ALICE = '@alice:example.org';
const BOB = '@bob:example.org';

const ENCRYPTED_FILE = {
  url: 'mxc://example.org/ciphertext',
  key: {} as JsonWebKey,
  iv: 'iv',
  hashes: { sha256: 'hash' },
  v: 'v2',
};

function setup(options: { encrypted?: boolean } = {}) {
  const engine = new FakeMediaEngine();
  const roomId = engine.addRoom(options.encrypted ?? true);
  const session = signal(sessionWith(ALICE, [ALICE, BOB]));
  const bytes = {
    resolveMedia: vi.fn(() => of('blob:resolved')),
    downloadMedia: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    drop: vi.fn(),
    releaseAll: vi.fn(),
    uploadLimit: vi.fn(() => of(1024)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: MEDIA_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
      { provide: MediaService, useValue: bytes },
    ],
  });
  const pipeline = TestBed.inject(MediaPipeline);
  const key = { accountId: ALICE, roomId };
  return {
    pipeline,
    engine,
    bytes,
    session,
    key,
    roomId,
    /** Stages a small file; throws if staging refuses it. */
    stage(name = 'photo.png', type = 'image/png', hints?: object) {
      const staged = pipeline.stage(
        new File([new Uint8Array([1, 2, 3, 4])], name, { type }),
        hints,
      );
      if (staged.kind !== 'staged') throw new Error('not staged');
      return staged.media;
    },
    /** Runs a transfer to the room to completion, returning every event. */
    run(request: Omit<MediaTransferRequest, 'key'>) {
      return firstValueFrom(
        pipeline.transfer({ key, ...request }).pipe(toArray()),
      );
    },
    /** The engine key the pipeline sends a staged file to the room under. */
    attachmentKey(id: string, imageMetadata: 'strip' | 'keep' = 'strip') {
      return JSON.stringify([id, ALICE, roomId, null, imageMetadata]);
    },
  };
}

const SENT = { kind: 'sent', eventId: expect.stringMatching(/^\$event/) };
const SEND_REJECTED = {
  kind: 'rejected',
  failure: 'send-rejected',
  retryable: true,
} as const;
const VALIDATING = { kind: 'progress', phase: 'validating', fraction: 0 };

afterEach(() => {
  vi.clearAllMocks();
  TestBed.resetTestingModule();
});

describe('MediaPipeline', () => {
  it('keeps a transfer cold, then validates, encrypts, uploads and sends it to the exact room', async () => {
    const { pipeline, engine, key, roomId, stage } = setup();
    const media = stage('secret.png');

    const command = pipeline.transfer({ key, media, caption: 'classified' });
    expect(engine.uploads).toBe(0);
    const events = await firstValueFrom(command.pipe(toArray()));

    expect(events).toEqual([
      VALIDATING,
      { kind: 'progress', phase: 'encrypting', fraction: 0 },
      { kind: 'progress', phase: 'uploading', fraction: 1 },
      { kind: 'progress', phase: 'sending', fraction: 1 },
      SENT,
    ]);
    expect(engine.messages(roomId)).toEqual([
      {
        msgtype: 'm.image',
        body: 'classified',
        hasThumbnail: false,
        threadRootId: null,
      },
    ]);
    expect(pipeline.hasStaged(media)).toBe(false);
  });

  it('rejects the send when the engine fails closed on an encrypted room without crypto', async () => {
    const { engine, stage, run } = setup();
    engine.crypto = false;

    const events = await run({ media: stage(), caption: '' });

    expect(events).toEqual([VALIDATING, SEND_REJECTED]);
    expect(engine.uploads).toBe(0);
  });

  it('rejects a conversation that is gone before any progress', async () => {
    const { pipeline, stage } = setup();
    const media = stage();

    for (const key of [
      { accountId: ALICE, roomId: '!gone:example.org' },
      { accountId: '@ghost:example.org', roomId: '!gone:example.org' },
    ]) {
      expect(
        await firstValueFrom(
          pipeline.transfer({ key, media, caption: '' }).pipe(toArray()),
        ),
      ).toEqual([
        {
          kind: 'rejected',
          failure: 'conversation-unavailable',
          retryable: false,
        },
      ]);
    }
  });

  it('sends staged media to the exact thread root', async () => {
    const { engine, roomId, stage, run } = setup();

    const events = await run({
      threadRootId: '$thread-root',
      media: stage('thread.png'),
      caption: 'in thread',
    });

    expect(events.at(-1)).toEqual(SENT);
    expect(engine.messages(roomId)).toEqual([
      expect.objectContaining({
        body: 'in thread',
        threadRootId: '$thread-root',
      }),
    ]);
  });

  it('rejects invalid staged input as a typed terminal outcome', () => {
    const { pipeline } = setup();

    expect(pipeline.stage(new File([], 'empty.bin'))).toEqual({
      kind: 'rejected',
      failure: 'empty-file',
      retryable: false,
    });
  });

  it('rejects a released staged reference as unavailable', async () => {
    const { pipeline, stage, run } = setup();
    const media = stage();
    pipeline.releaseStaged(media);

    expect(await run({ media, caption: '' })).toEqual([
      {
        kind: 'rejected',
        failure: 'staged-media-unavailable',
        retryable: false,
      },
    ]);
  });

  it('presents only safe metadata while retaining encrypted source material internally', async () => {
    const { pipeline, bytes } = setup();
    const reference = pipeline.present(
      {
        kind: 'image',
        mxc: null,
        file: ENCRYPTED_FILE,
        filename: 'secret.png',
        mimeType: 'image/png',
        thumbnailMxc: null,
        thumbnailFile: null,
      },
      ALICE,
    );

    expect(reference).toMatchObject({
      kind: 'image',
      filename: 'secret.png',
      mimeType: 'image/png',
    });
    expect(reference).not.toHaveProperty('file');
    expect(reference).not.toHaveProperty('mxc');
    expect(reference).not.toHaveProperty('key');
    await expect(
      firstValueFrom(pipeline.resolveMedia(reference, 'full')),
    ).resolves.toBe('blob:resolved');
    expect(bytes.resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ file: ENCRYPTED_FILE }),
      'full',
      ALICE,
    );
    bytes.downloadMedia.mockReturnValue(
      of({ blob: new Blob(['safe']), filename: 'secret.png' }),
    );
    await expect(
      firstValueFrom(pipeline.downloadMedia(reference)),
    ).resolves.toMatchObject({ filename: 'secret.png' });
    expect(bytes.downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ file: ENCRYPTED_FILE }),
      ALICE,
    );
  });

  it.each([
    ['a plaintext thumbnail', { thumbnailMxc: 'mxc://example.org/t' }, true],
    ['an encrypted thumbnail', { thumbnailFile: ENCRYPTED_FILE }, true],
    ['no thumbnail', {}, false],
  ])(
    'presents whether the event bundles a thumbnail (%s)',
    (_name, thumb, has) => {
      const { pipeline } = setup();
      const reference = pipeline.present({
        kind: 'video',
        mxc: 'mxc://example.org/clip',
        file: null,
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        thumbnailMxc: null,
        thumbnailFile: null,
        ...thumb,
      });

      // The thumbnail's source stays opaque; only whether it exists is safe to show.
      expect(reference.hasThumbnail ?? false).toBe(has);
      expect(reference).not.toHaveProperty('thumbnailMxc');
      expect(reference).not.toHaveProperty('thumbnailFile');
    },
  );

  it('rejects reads once the source Account client is removed', async () => {
    const { pipeline, bytes, session } = setup();
    const reference = pipeline.present({
      kind: 'image',
      mxc: 'mxc://example.org/photo',
      file: null,
      filename: 'photo.png',
      mimeType: 'image/png',
      thumbnailMxc: null,
      thumbnailFile: null,
    });
    bytes.downloadMedia.mockReturnValue(
      of({ blob: new Blob(['photo']), filename: 'photo.png' }),
    );
    const reads = [
      pipeline.resolveMedia(reference, 'thumbnail'),
      pipeline.resolveMedia(reference, 'full'),
      pipeline.downloadMedia(reference),
    ];
    session.set(sessionWith(null, []));

    for (const read of reads) {
      await expect(firstValueFrom<unknown>(read)).rejects.toThrow(
        'Media reference is no longer available',
      );
    }
    expect(bytes.resolveMedia).not.toHaveBeenCalled();
    expect(bytes.downloadMedia).not.toHaveBeenCalled();
  });

  it('keeps media reads bound to their live opening Account after an Active Account switch', async () => {
    const { pipeline, bytes, session } = setup();
    const reference = pipeline.present({
      kind: 'image',
      mxc: 'mxc://example.org/photo',
      file: null,
      filename: 'photo.png',
      mimeType: 'image/png',
      thumbnailMxc: null,
      thumbnailFile: null,
    });
    session.set(sessionWith(BOB, [ALICE, BOB]));
    bytes.downloadMedia.mockReturnValue(
      of({ blob: new Blob(['photo']), filename: 'photo.png' }),
    );
    pipeline.releaseAll();

    await expect(
      firstValueFrom(pipeline.resolveMedia(reference, 'full')),
    ).resolves.toBe('blob:resolved');
    await expect(
      firstValueFrom(pipeline.downloadMedia(reference)),
    ).resolves.toMatchObject({ filename: 'photo.png' });
    expect(bytes.resolveMedia).toHaveBeenCalledWith(
      expect.any(Object),
      'full',
      ALICE,
    );
    expect(bytes.downloadMedia).toHaveBeenCalledWith(expect.any(Object), ALICE);
  });

  describe('sameMedia', () => {
    const photo = {
      kind: 'image' as const,
      mxc: 'mxc://example.org/photo',
      file: null,
      filename: 'photo.png',
      mimeType: 'image/png',
      thumbnailMxc: null,
      thumbnailFile: null,
    };

    it('tells one message presented twice (a receipt or reaction re-projected it) as the same media', () => {
      const { pipeline } = setup();
      const first = pipeline.present(photo, ALICE);
      const again = pipeline.present({ ...photo }, ALICE);

      expect(first).not.toBe(again);
      expect(pipeline.sameMedia(first, again)).toBe(true);
    });

    it('tells an edit that swapped the file, its thumbnail, or its account apart', () => {
      const { pipeline } = setup();
      const first = pipeline.present(photo, ALICE);

      expect(
        pipeline.sameMedia(
          first,
          pipeline.present({ ...photo, mxc: 'mxc://example.org/other' }, ALICE),
        ),
      ).toBe(false);
      expect(
        pipeline.sameMedia(
          first,
          pipeline.present(
            { ...photo, thumbnailMxc: 'mxc://example.org/thumb' },
            ALICE,
          ),
        ),
      ).toBe(false);
      expect(pipeline.sameMedia(first, pipeline.present(photo, BOB))).toBe(
        false,
      );
    });

    it('compares encrypted media by the file it points at', () => {
      const { pipeline } = setup();
      const file = { url: 'mxc://example.org/cipher' } as never;
      const encrypted = { ...photo, mxc: null, file };
      const first = pipeline.present(encrypted, ALICE);

      expect(
        pipeline.sameMedia(
          first,
          pipeline.present(
            {
              ...encrypted,
              file: { url: 'mxc://example.org/cipher' } as never,
            },
            ALICE,
          ),
        ),
      ).toBe(true);
      expect(
        pipeline.sameMedia(
          first,
          pipeline.present(
            { ...encrypted, file: { url: 'mxc://example.org/other' } as never },
            ALICE,
          ),
        ),
      ).toBe(false);
    });

    it('tells encrypted media at one file.url apart by its key material', () => {
      const { pipeline } = setup();
      const file = (k: string) => ({
        url: 'mxc://example.org/cipher',
        key: { k } as JsonWebKey,
        iv: `iv-${k}`,
        hashes: { sha256: `hash-${k}` },
        v: 'v2',
      });
      const encrypted = { ...photo, mxc: null, file: file('a') };
      const first = pipeline.present(encrypted, ALICE);

      expect(
        pipeline.sameMedia(
          first,
          pipeline.present({ ...encrypted, file: file('b') }, ALICE),
        ),
      ).toBe(false);
      expect(
        pipeline.sameMedia(
          pipeline.present({ ...encrypted, thumbnailFile: file('a') }, ALICE),
          pipeline.present({ ...encrypted, thumbnailFile: file('b') }, ALICE),
        ),
      ).toBe(false);
    });

    const cipher = {
      url: 'mxc://example.org/cipher',
      key: { k: 'k1' } as JsonWebKey,
      iv: 'iv1',
      hashes: { sha256: 'h1' },
      v: 'v2',
    };

    it.each([
      ['key', { key: { k: 'k2' } as JsonWebKey }],
      ['iv', { iv: 'iv2' }],
      ['hash', { hashes: { sha256: 'h2' } }],
      ['version', { v: 'v1' }],
    ])(
      'tells an encrypted file or thumbnail apart by its %s alone',
      (_, change) => {
        const { pipeline } = setup();
        const changed = { ...cipher, ...change };
        const encrypted = { ...photo, mxc: null, file: cipher };
        const same = (a: MediaPayload, b: MediaPayload) =>
          pipeline.sameMedia(
            pipeline.present(a, ALICE),
            pipeline.present(b, ALICE),
          );

        expect(same(encrypted, { ...encrypted, file: changed })).toBe(false);
        expect(
          same(
            { ...encrypted, thumbnailFile: cipher },
            { ...encrypted, thumbnailFile: changed },
          ),
        ).toBe(false);
      },
    );

    it('tells a thumbnail declared with another type apart', () => {
      const { pipeline } = setup();
      const thumbed = { ...photo, thumbnailMxc: 'mxc://example.org/thumb' };

      expect(
        pipeline.sameMedia(
          pipeline.present(
            { ...thumbed, thumbnailMimeType: 'image/png' },
            ALICE,
          ),
          pipeline.present(
            { ...thumbed, thumbnailMimeType: 'image/jpeg' },
            ALICE,
          ),
        ),
      ).toBe(false);
    });
  });

  it('drops a rendition from the cache under the account that presented it', () => {
    const { pipeline, bytes, session } = setup();
    const media = {
      kind: 'image' as const,
      mxc: 'mxc://example.org/photo',
      file: null,
      filename: 'photo.png',
      mimeType: 'image/png',
      thumbnailMxc: null,
      thumbnailFile: null,
    };
    const reference = pipeline.present(media);

    pipeline.drop(reference, 'full', 'blob:photo');

    expect(bytes.drop).toHaveBeenCalledExactlyOnceWith('blob:photo', {
      media,
      variant: 'full',
      accountId: ALICE,
    });
    // Freeing pins never needs a live Account: a signed-out one's pins still go.
    session.set(sessionWith(null, []));
    pipeline.drop(reference, 'full', 'blob:other');
    expect(bytes.unpin).toHaveBeenCalledWith('blob:other');
  });

  describe('present(media, accountId)', () => {
    const image = {
      kind: 'image' as const,
      mxc: 'mxc://example.org/photo',
      file: null,
      filename: 'photo.png',
      mimeType: 'image/png',
      thumbnailMxc: null,
      thumbnailFile: null,
    };

    it('resolves through the presenting account while it is live', async () => {
      const { pipeline, bytes } = setup();
      const reference = pipeline.present(image, BOB);

      await firstValueFrom(pipeline.resolveMedia(reference, 'full'));

      expect(bytes.resolveMedia).toHaveBeenCalledWith(image, 'full', BOB);
    });

    it('defaults to the active account', async () => {
      const { pipeline, bytes } = setup();
      const reference = pipeline.present(image);

      await firstValueFrom(pipeline.resolveMedia(reference, 'full'));

      expect(bytes.resolveMedia).toHaveBeenCalledWith(image, 'full', ALICE);
    });

    it('sameMedia is false across accounts', () => {
      const { pipeline } = setup();

      expect(
        pipeline.sameMedia(
          pipeline.present(image, ALICE),
          pipeline.present({ ...image }, BOB),
        ),
      ).toBe(false);
    });
  });

  it('does not start work when a synchronous progress consumer unsubscribes', async () => {
    const { pipeline, engine, key, roomId, stage } = setup();

    await expect(
      firstValueFrom(
        pipeline.transfer({ key, media: stage(), caption: '' }).pipe(take(1)),
      ),
    ).resolves.toEqual(VALIDATING);
    await new Promise((resolve) => setTimeout(resolve));

    expect(engine.uploads).toBe(0);
    expect(engine.messages(roomId)).toEqual([]);
  });

  it('stops an upload on unsubscribe and keeps the staged reference retryable', async () => {
    const { pipeline, engine, key, roomId, stage, run } = setup();
    const media = stage();

    await firstValueFrom(
      pipeline.transfer({ key, media, caption: '' }).pipe(take(2)),
    );
    await new Promise((resolve) => setTimeout(resolve));

    expect(engine.messages(roomId)).toEqual([]);
    expect(pipeline.hasStaged(media)).toBe(true);
    expect((await run({ media, caption: '' })).at(-1)).toEqual(SENT);
  });

  it('withdraws the echo when unsubscribed during the send, then retries the retained upload', async () => {
    const { pipeline, engine, key, roomId, stage, run } = setup();
    const media = stage();

    await new Promise<void>((resolve) => {
      const subscription = pipeline
        .transfer({ key, media, caption: '' })
        .subscribe((event) => {
          if (event.kind === 'progress' && event.phase === 'sending') {
            // Once the send is under way, before the server answers.
            queueMicrotask(() => {
              subscription.unsubscribe();
              resolve();
            });
          }
        });
    });
    const retry = await run({ media, caption: '' });

    expect(engine.withdrawn).toBe(1);
    expect(engine.uploads).toBe(1);
    expect(retry).toEqual([
      VALIDATING,
      { kind: 'progress', phase: 'sending', fraction: 1 },
      SENT,
    ]);
    expect(engine.messages(roomId)).toHaveLength(1);
  });

  it('retries a failed send with the retained upload', async () => {
    const { engine, roomId, stage, run } = setup();
    engine.sendFailures = 1;
    const media = stage();

    const first = await run({ media, caption: '' });
    const second = await run({ media, caption: '' });

    expect(first.at(-2)).toEqual({
      kind: 'progress',
      phase: 'sending',
      fraction: 1,
    });
    expect(first.at(-1)).toEqual(SEND_REJECTED);
    expect(second.at(-1)).toEqual(SENT);
    expect(engine.uploads).toBe(1);
    expect(engine.withdrawn).toBe(0);
    expect(engine.messages(roomId)).toHaveLength(1);
  });

  it('withdraws the failed echo and reuses the upload when a retry changes the caption', async () => {
    const { engine, roomId, stage, run } = setup();
    engine.sendFailures = 1;
    const media = stage();

    await run({ media, caption: 'old caption' });
    const retry = await run({ media, caption: 'new caption' });

    expect(engine.withdrawn).toBe(1);
    expect(engine.uploads).toBe(1);
    expect(retry.at(-1)).toEqual(SENT);
    expect(engine.messages(roomId)).toEqual([
      expect.objectContaining({ body: 'new caption' }),
    ]);
  });

  it('re-uploads stripped and withdraws the kept echo when a kept-metadata retry must now strip', async () => {
    const { engine, roomId, stage, run, attachmentKey } = setup();
    engine.sendFailures = 1;
    const media = stage('photo.jpg', 'image/jpeg');
    const send = vi.spyOn(engine, 'sendAttachment');

    const first = await run({ media, caption: '', imageMetadata: 'keep' });
    // The person turns Keep photo and video metadata off before retrying.
    const retry = await run({ media, caption: '', imageMetadata: 'strip' });

    expect(first.at(-1)).toEqual(SEND_REJECTED);
    expect(send.mock.calls.map(([, , request]) => request.metadata)).toEqual([
      'kept',
      'stripped',
    ]);
    expect(send.mock.calls[1]?.[2].supersedes).toBe(
      attachmentKey(media.id, 'keep'),
    );
    expect(engine.withdrawn).toBe(1);
    expect(engine.uploads).toBe(2);
    expect(retry.at(-1)).toEqual(SENT);
    expect(engine.messages(roomId)).toHaveLength(1);
  });

  it('does not withdraw a kept-metadata echo the engine still marks sending', async () => {
    const { engine, stage, run, attachmentKey } = setup();
    engine.sendFailures = 1;
    const media = stage('photo.jpg', 'image/jpeg');

    await run({ media, caption: '', imageMetadata: 'keep' });
    engine.markSending(attachmentKey(media.id, 'keep'));
    const retry = await run({ media, caption: '' });

    expect(retry).toEqual([
      VALIDATING,
      { kind: 'indeterminate', failure: 'send-in-flight', retryable: true },
    ]);
    expect(engine.withdrawn).toBe(0);
    expect(engine.uploads).toBe(1);
  });

  it('reuses a stripped upload when a retry would keep metadata', async () => {
    const { engine, stage, run } = setup();
    engine.sendFailures = 1;
    const media = stage('photo.jpg', 'image/jpeg');

    await run({ media, caption: '' });
    const retry = await run({ media, caption: '', imageMetadata: 'keep' });

    expect(engine.uploads).toBe(1);
    expect(engine.withdrawn).toBe(0);
    expect(retry.at(-1)).toEqual(SENT);
  });

  it('does not resend a retained echo while the engine still marks it sending', async () => {
    const { engine, roomId, stage, run, attachmentKey } = setup();
    engine.sendFailures = 1;
    const media = stage();

    await run({ media, caption: '' });
    engine.markSending(attachmentKey(media.id));
    const retry = await run({ media, caption: '' });

    expect(retry.at(-1)).toEqual({
      kind: 'indeterminate',
      failure: 'send-in-flight',
      retryable: true,
    });
    expect(engine.messages(roomId)).toEqual([]);
  });

  it('reports a send the engine cannot confirm as indeterminate and keeps the file staged', async () => {
    const { engine, stage, run } = setup();
    vi.spyOn(engine, 'sendAttachment').mockReturnValue(
      of<TransferUpdate<AttachmentOutcome>>({
        kind: 'done',
        result: engineOk({
          kind: 'indeterminate',
          reason: 'local-echo-missing',
        }),
      }),
    );
    const media = stage();

    expect(await run({ media, caption: '' })).toEqual([
      VALIDATING,
      { kind: 'indeterminate', failure: 'local-echo-missing', retryable: true },
    ]);
  });

  it('rejects the upload when the engine cannot upload the file', async () => {
    const { engine, stage, run } = setup();
    engine.uploadLimitBytes = 1;

    const events = await run({ media: stage(), caption: '' });

    expect(events.at(-1)).toEqual({
      kind: 'rejected',
      failure: 'upload-rejected',
      retryable: true,
    });
  });

  it('keeps retained uploads for the two latest conversations of a staged file', async () => {
    const { pipeline, engine, stage } = setup();
    engine.sendFailures = 3;
    const media = stage();
    const rooms = [engine.addRoom(), engine.addRoom(), engine.addRoom()];
    const keyFor = (roomId: string) =>
      JSON.stringify([media.id, ALICE, roomId, null, 'strip']);

    for (const roomId of rooms) {
      await firstValueFrom(
        pipeline
          .transfer({ key: { accountId: ALICE, roomId }, media, caption: '' })
          .pipe(toArray()),
      );
    }

    expect(rooms.map((roomId) => engine.retains(keyFor(roomId)))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('revokes preview resources, forgets retained uploads and retires a released staged reference', async () => {
    const { pipeline, engine, stage, run, attachmentKey } = setup();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    engine.sendFailures = 1;
    const media = stage('preview.png');
    await run({ media, caption: '' });
    expect(engine.retains(attachmentKey(media.id))).toBe(true);

    pipeline.releaseStaged(media);

    expect(revoke).toHaveBeenCalledWith(media.previewUrl);
    expect(engine.retains(attachmentKey(media.id))).toBe(false);
    expect(engine.withdrawn).toBe(0);
    expect(pipeline.hasStaged(media)).toBe(false);
  });

  it('describes the file with its capture hints and sends what they measured', async () => {
    const { engine, roomId, stage, run } = setup();
    const poster = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
    const hints = {
      width: 1920,
      height: 1080,
      durationMs: 12_500,
      thumbnail: { blob: poster, w: 480, h: 270 },
    };
    vi.mocked(describeMedia).mockResolvedValueOnce({
      dims: { w: 1920, h: 1080, durationMs: 12_500 },
      thumbnail: { blob: poster, w: 480, h: 270 },
    });
    const send = vi.spyOn(engine, 'sendAttachment');
    const media = stage('video.mov', 'video/quicktime', hints);

    expect(media.hints).toEqual(hints);
    await run({ media, caption: '' });

    expect(describeMedia).toHaveBeenCalledWith(expect.any(File), hints);
    expect(send.mock.calls[0]?.[2]).toMatchObject({
      filename: 'video.mov',
      mimeType: 'video/quicktime',
      msgtype: 'm.video',
      info: { w: 1920, h: 1080, durationMs: 12_500 },
      thumbnail: { mimeType: 'image/jpeg', w: 480, h: 270 },
    });
    expect(engine.messages(roomId)).toEqual([
      expect.objectContaining({ msgtype: 'm.video', hasThumbnail: true }),
    ]);
  });

  it('renders the caption fields', async () => {
    const { engine, stage, run } = setup();
    const send = vi.spyOn(engine, 'sendAttachment');

    await run({ media: stage('pic.png'), caption: 'a **bold** one' });

    expect(send.mock.calls[0]?.[2].captionFields).toEqual(
      mediaCaptionFields('pic.png', 'a **bold** one'),
    );
  });

  it('falls back to attachment for a nameless file', async () => {
    const { engine, stage, run } = setup();
    const send = vi.spyOn(engine, 'sendAttachment');

    await run({ media: stage(''), caption: '' });

    expect(send.mock.calls[0]?.[2].captionFields).toEqual({
      body: 'attachment',
    });
  });

  it('hands over the file as picked when the transfer keeps its metadata', async () => {
    const { engine, stage, run } = setup();
    const send = vi.spyOn(engine, 'sendAttachment');
    const media = stage('photo.jpg', 'image/jpeg');

    await run({ media, caption: '', imageMetadata: 'keep' });

    expect(strippedMedia).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[2].metadata).toBe('kept');
  });

  it('marks a file whose strip failed, which an encrypted room refuses as an upload failure', async () => {
    const { engine, stage, run } = setup();
    vi.mocked(strippedMedia).mockRejectedValueOnce(new Error('unreadable'));
    const send = vi.spyOn(engine, 'sendAttachment');

    const events = await run({ media: stage(), caption: '' });

    expect(send.mock.calls[0]?.[2].metadata).toBe('strip-failed');
    expect(events).toEqual([
      VALIDATING,
      { kind: 'rejected', failure: 'upload-rejected', retryable: true },
    ]);
    expect(engine.uploads).toBe(0);
  });

  it('sends a file whose strip failed as picked in a plain room', async () => {
    const { engine, stage, run } = setup({ encrypted: false });
    vi.mocked(strippedMedia).mockRejectedValueOnce(new Error('unreadable'));

    const events = await run({ media: stage(), caption: '' });

    expect(events.at(-1)).toEqual(SENT);
    expect(engine.uploads).toBe(1);
  });

  it('previews a staged video from its hinted thumbnail and releases that preview', () => {
    const { pipeline } = setup();
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:poster');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const poster = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'video.mp4', { type: 'video/mp4' }),
      { thumbnail: { blob: poster, w: 480, h: 270 } },
    );
    if (staged.kind !== 'staged') throw new Error('not staged');

    expect(create).toHaveBeenCalledWith(poster);
    expect(staged.media.previewUrl).toBe('blob:poster');
    pipeline.releaseStaged(staged.media);
    expect(revoke).toHaveBeenCalledWith('blob:poster');
  });

  it('has no preview for a video staged without a thumbnail', () => {
    const { pipeline } = setup();
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' }),
    );
    if (staged.kind !== 'staged') throw new Error('not staged');

    expect(staged.media.previewUrl).toBeNull();
    expect(staged.media.hints).toBeUndefined();
  });

  it('reads the upload limit through the exact account', async () => {
    const { pipeline, bytes } = setup();

    expect(await firstValueFrom(pipeline.uploadLimit(ALICE))).toBe(1024);
    expect(bytes.uploadLimit).toHaveBeenCalledWith(ALICE);
  });

  it('has no limit for a missing or unknown account', async () => {
    const { pipeline, bytes } = setup();

    expect(await firstValueFrom(pipeline.uploadLimit(null))).toBeNull();
    expect(
      await firstValueFrom(pipeline.uploadLimit('@ghost:example.org')),
    ).toBeNull();
    expect(bytes.uploadLimit).not.toHaveBeenCalled();
  });
});
