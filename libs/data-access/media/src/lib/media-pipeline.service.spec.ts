import { TestBed } from '@angular/core/testing';
import { NEVER, firstValueFrom, of, take, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService, type UploadedMedia } from './media.service';
import { MediaPipeline } from './media-pipeline.service';
import type { MediaPayload } from '@trinity/util/matrix';

const KEY = {
  accountId: '@alice:example.org',
  roomId: '!room:example.org',
} as const;

function uploaded(): UploadedMedia {
  return {
    msgtype: 'm.image' as UploadedMedia['msgtype'],
    body: 'secret.png',
    mxc: null,
    file: {
      url: 'mxc://example.org/ciphertext',
      key: {} as JsonWebKey,
      iv: 'iv',
      hashes: { sha256: 'hash' },
      v: 'v2',
    },
    info: { mimetype: 'image/png', size: 4 },
  };
}

function setup() {
  const localEcho = { id: '$event' };
  const pendingEcho = {
    id: `~${KEY.roomId}:txn-1`,
    status: 'not_sent',
    getId: () => `~${KEY.roomId}:txn-1`,
  };
  const room = {
    roomId: KEY.roomId,
    hasEncryptionStateEvent: vi.fn(() => true),
    findEventById: vi.fn((id: string) => {
      if (id === '$event') return localEcho;
      if (id === pendingEcho.id) return pendingEcho;
      return undefined;
    }),
  };
  const crypto = {
    isEncryptionEnabledInRoom: vi.fn((_roomId: string) =>
      Promise.resolve(false),
    ),
  };
  const client = {
    getUserId: (): string => KEY.accountId,
    getCrypto: vi.fn((): typeof crypto | undefined => crypto),
    getRoom: vi.fn(() => room),
    makeTxnId: vi.fn(() => 'txn-1'),
    sendMessage: vi.fn((_roomId: string, _content: unknown, _txnId: string) =>
      Promise.resolve({ event_id: '$event' }),
    ),
    resendEvent: vi.fn(() => Promise.resolve({ event_id: '$event' })),
    cancelPendingEvent: vi.fn(),
  };
  const bytes = {
    uploadMedia: vi.fn(
      (
        _file: File,
        _encrypt: boolean,
        _progress?: (fraction: number) => void,
        _abortController?: AbortController,
        _accountId?: string,
        _hints?: unknown,
        _imageMetadata?: 'strip' | 'keep',
      ) => of(uploaded()),
    ),
    resolveMedia: vi.fn(() => of('blob:resolved')),
    downloadMedia: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    drop: vi.fn(),
    releaseAll: vi.fn(),
    uploadLimit: vi.fn(() => of(1024)),
  };
  const matrix = {
    clientFor: vi.fn((_accountId: string): typeof client | null => client),
    instance: client,
  };
  TestBed.configureTestingModule({
    providers: [
      MediaPipeline,
      { provide: MediaService, useValue: bytes },
      {
        provide: MatrixClientService,
        useValue: matrix,
      },
    ],
  });
  return {
    pipeline: TestBed.inject(MediaPipeline),
    bytes,
    client,
    matrix,
    room,
    crypto,
    pendingEcho,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('MediaPipeline', () => {
  it('keeps a transfer cold, encrypts for the exact Room, streams progress, and accepts its local echo', async () => {
    const { pipeline, bytes, client } = setup();
    const staged = pipeline.stage(
      new File([new Uint8Array([1, 2, 3, 4])], 'secret.png', {
        type: 'image/png',
      }),
    );
    expect(staged.kind).toBe('staged');
    if (staged.kind !== 'staged') return;

    const command = pipeline.transfer({
      key: KEY,
      media: staged.media,
      caption: 'classified',
    });
    expect(bytes.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();

    const events = await firstValueFrom(command.pipe(toArray()));

    expect(bytes.uploadMedia).toHaveBeenCalledWith(
      expect.any(File),
      true,
      expect.any(Function),
      expect.any(AbortController),
      KEY.accountId,
      undefined,
      'strip',
    );
    expect(events.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
    expect(events.some((event) => event.kind === 'progress')).toBe(true);
    expect(client.sendMessage).toHaveBeenCalledWith(
      KEY.roomId,
      expect.objectContaining({ file: expect.any(Object) }),
      'txn-1',
    );
  });

  it('encrypts the upload when the crypto store has the room as encrypted but its state lacks the event', async () => {
    const { pipeline, bytes, room, crypto } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    crypto.isEncryptionEnabledInRoom.mockResolvedValue(true);
    const staged = pipeline.stage(new File([new Uint8Array([1])], 'a.png'));
    if (staged.kind !== 'staged') return;

    await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith(KEY.roomId);
    expect(bytes.uploadMedia).toHaveBeenCalledWith(
      expect.any(File),
      true,
      expect.any(Function),
      expect.any(AbortController),
      KEY.accountId,
      undefined,
      'strip',
    );
  });

  it('uploads in the clear only when the room state and the crypto store both say unencrypted', async () => {
    const { pipeline, bytes, room } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    const staged = pipeline.stage(new File([new Uint8Array([1])], 'a.png'));
    if (staged.kind !== 'staged') return;

    await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(bytes.uploadMedia.mock.calls[0]?.[1]).toBe(false);
  });

  it('encrypts the upload when the crypto store fails to answer', async () => {
    const { pipeline, bytes, room, crypto } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    crypto.isEncryptionEnabledInRoom.mockRejectedValue(new Error('store'));
    const staged = pipeline.stage(new File([new Uint8Array([1])], 'a.png'));
    if (staged.kind !== 'staged') return;

    await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(bytes.uploadMedia.mock.calls[0]?.[1]).toBe(true);
  });

  it('refuses to upload when the crypto store is unavailable', async () => {
    const { pipeline, bytes, client, room } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    client.getCrypto.mockReturnValue(undefined);
    const staged = pipeline.stage(new File([new Uint8Array([1])], 'a.png'));
    if (staged.kind !== 'staged') return;

    const events = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(events.at(-1)).toEqual({
      kind: 'rejected',
      failure: 'send-rejected',
      retryable: true,
    });
    expect(bytes.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('sends staged media to the exact thread root through the SDK thread overload', async () => {
    const { pipeline, client } = setup();
    const staged = pipeline.stage(
      new File([new Uint8Array([1, 2, 3, 4])], 'thread.png', {
        type: 'image/png',
      }),
    );
    if (staged.kind !== 'staged') return;

    const events = await firstValueFrom(
      pipeline
        .transfer({
          key: KEY,
          threadRootId: '$thread-root',
          media: staged.media,
          caption: 'in thread',
        })
        .pipe(toArray()),
    );

    expect(events.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
    expect(client.sendMessage).toHaveBeenCalledWith(
      KEY.roomId,
      '$thread-root',
      expect.objectContaining({
        body: 'in thread',
        filename: 'secret.png',
      }),
      'txn-1',
    );
  });

  it('rejects invalid staged input as a typed terminal outcome', () => {
    const { pipeline } = setup();

    expect(pipeline.stage(new File([], 'empty.bin'))).toEqual({
      kind: 'rejected',
      failure: 'empty-file',
      retryable: false,
    });
  });

  it('presents only safe metadata while retaining encrypted source material internally', async () => {
    const { pipeline, bytes } = setup();
    const reference = pipeline.present(
      {
        kind: 'image',
        mxc: null,
        file: uploaded().file,
        filename: 'secret.png',
        mimeType: 'image/png',
        thumbnailMxc: null,
        thumbnailFile: null,
      },
      KEY.accountId,
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
      expect.objectContaining({ file: uploaded().file }),
      'full',
      KEY.accountId,
    );
    bytes.downloadMedia.mockReturnValue(
      of({ blob: new Blob(['safe']), filename: 'secret.png' }),
    );
    await expect(
      firstValueFrom(pipeline.downloadMedia(reference)),
    ).resolves.toMatchObject({ filename: 'secret.png' });
    expect(bytes.downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ file: uploaded().file }),
      KEY.accountId,
    );
  });

  it.each([
    ['a plaintext thumbnail', { thumbnailMxc: 'mxc://example.org/t' }, true],
    ['an encrypted thumbnail', { thumbnailFile: uploaded().file }, true],
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
    const { pipeline, bytes, matrix } = setup();
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
    matrix.clientFor.mockReturnValue(null);

    for (const read of reads) {
      await expect(firstValueFrom<unknown>(read)).rejects.toThrow(
        'Media reference is no longer available',
      );
    }
    expect(bytes.resolveMedia).not.toHaveBeenCalled();
    expect(bytes.downloadMedia).not.toHaveBeenCalled();
  });

  it('keeps media reads bound to their live opening Account after an Active Account switch', async () => {
    const { pipeline, bytes, client, matrix } = setup();
    const reference = pipeline.present({
      kind: 'image',
      mxc: 'mxc://example.org/photo',
      file: null,
      filename: 'photo.png',
      mimeType: 'image/png',
      thumbnailMxc: null,
      thumbnailFile: null,
    });
    matrix.instance = { ...client, getUserId: () => '@bob:example.org' };
    matrix.clientFor.mockImplementation((id) =>
      id === KEY.accountId ? client : matrix.instance,
    );
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
      KEY.accountId,
    );
    expect(bytes.downloadMedia).toHaveBeenCalledWith(
      expect.any(Object),
      KEY.accountId,
    );
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
      const first = pipeline.present(photo, KEY.accountId);
      const again = pipeline.present({ ...photo }, KEY.accountId);

      expect(first).not.toBe(again);
      expect(pipeline.sameMedia(first, again)).toBe(true);
    });

    it('tells an edit that swapped the file, its thumbnail, or its account apart', () => {
      const { pipeline } = setup();
      const first = pipeline.present(photo, KEY.accountId);

      expect(
        pipeline.sameMedia(
          first,
          pipeline.present(
            { ...photo, mxc: 'mxc://example.org/other' },
            KEY.accountId,
          ),
        ),
      ).toBe(false);
      expect(
        pipeline.sameMedia(
          first,
          pipeline.present(
            { ...photo, thumbnailMxc: 'mxc://example.org/thumb' },
            KEY.accountId,
          ),
        ),
      ).toBe(false);
      expect(
        pipeline.sameMedia(first, pipeline.present(photo, '@bob:example.org')),
      ).toBe(false);
    });

    it('compares encrypted media by the file it points at', () => {
      const { pipeline } = setup();
      const file = { url: 'mxc://example.org/cipher' } as never;
      const encrypted = { ...photo, mxc: null, file };
      const first = pipeline.present(encrypted, KEY.accountId);

      expect(
        pipeline.sameMedia(
          first,
          pipeline.present(
            {
              ...encrypted,
              file: { url: 'mxc://example.org/cipher' } as never,
            },
            KEY.accountId,
          ),
        ),
      ).toBe(true);
      expect(
        pipeline.sameMedia(
          first,
          pipeline.present(
            { ...encrypted, file: { url: 'mxc://example.org/other' } as never },
            KEY.accountId,
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
      const first = pipeline.present(encrypted, KEY.accountId);

      expect(
        pipeline.sameMedia(
          first,
          pipeline.present({ ...encrypted, file: file('b') }, KEY.accountId),
        ),
      ).toBe(false);
      expect(
        pipeline.sameMedia(
          pipeline.present(
            { ...encrypted, thumbnailFile: file('a') },
            KEY.accountId,
          ),
          pipeline.present(
            { ...encrypted, thumbnailFile: file('b') },
            KEY.accountId,
          ),
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
            pipeline.present(a, KEY.accountId),
            pipeline.present(b, KEY.accountId),
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
            KEY.accountId,
          ),
          pipeline.present(
            { ...thumbed, thumbnailMimeType: 'image/jpeg' },
            KEY.accountId,
          ),
        ),
      ).toBe(false);
    });
  });

  it('drops a rendition from the cache under the client that presented it', () => {
    const { pipeline, bytes, matrix } = setup();
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
      accountId: KEY.accountId,
    });
    // Freeing pins never needs a live Account: a signed-out one's pins still go.
    matrix.clientFor.mockReturnValue(null);
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
      const reference = pipeline.present(image, '@bob:example.org');

      await firstValueFrom(pipeline.resolveMedia(reference, 'full'));

      expect(bytes.resolveMedia).toHaveBeenCalledWith(
        image,
        'full',
        '@bob:example.org',
      );
    });

    it('defaults to the active account', async () => {
      const { pipeline, bytes, matrix } = setup();
      const reference = pipeline.present(image);

      await firstValueFrom(pipeline.resolveMedia(reference, 'full'));

      expect(matrix.clientFor).toHaveBeenCalledWith(KEY.accountId);
      expect(bytes.resolveMedia).toHaveBeenCalledWith(
        image,
        'full',
        KEY.accountId,
      );
    });

    it('sameMedia is false across accounts', () => {
      const { pipeline } = setup();

      expect(
        pipeline.sameMedia(
          pipeline.present(image, KEY.accountId),
          pipeline.present({ ...image }, '@bob:example.org'),
        ),
      ).toBe(false);
    });
  });

  it('does not start work when a synchronous progress consumer unsubscribes', async () => {
    const { pipeline, bytes, client } = setup();
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'cancel.bin'),
    );
    if (staged.kind !== 'staged') return;

    await expect(
      firstValueFrom(
        pipeline
          .transfer({ key: KEY, media: staged.media, caption: '' })
          .pipe(take(1)),
      ),
    ).resolves.toEqual({
      kind: 'progress',
      phase: 'validating',
      fraction: 0,
    });
    expect(bytes.uploadMedia).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('aborts an in-flight upload on unsubscribe and keeps the staged reference retryable', async () => {
    const { pipeline, bytes } = setup();
    let controller: AbortController | undefined;
    bytes.uploadMedia.mockImplementation(
      (_file, _encrypt, _progress, abortController) => {
        controller = abortController;
        return NEVER;
      },
    );
    const staged = pipeline.stage(new File([new Uint8Array([1])], 'retry.bin'));
    if (staged.kind !== 'staged') return;

    const subscription = pipeline
      .transfer({ key: KEY, media: staged.media, caption: '' })
      .subscribe();
    await vi.waitFor(() => expect(bytes.uploadMedia).toHaveBeenCalled());
    subscription.unsubscribe();

    expect(controller?.signal.aborted).toBe(true);
    expect(pipeline.hasStaged(staged.media)).toBe(true);
  });

  it('rotates the transaction id after cancelling a pending echo, then retries the cached upload', async () => {
    const { pipeline, bytes, client } = setup();
    client.makeTxnId.mockReturnValueOnce('txn-1').mockReturnValueOnce('txn-2');
    client.sendMessage
      .mockImplementationOnce(
        () => new Promise<{ event_id: string }>(() => undefined),
      )
      .mockResolvedValueOnce({ event_id: '$event' });
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'cancel-send.png', {
        type: 'image/png',
      }),
    );
    if (staged.kind !== 'staged') return;

    const subscription = pipeline
      .transfer({ key: KEY, media: staged.media, caption: '' })
      .subscribe();
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
    subscription.unsubscribe();
    const retry = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(client.cancelPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${KEY.roomId}:txn-1` }),
    );
    expect(client.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      'txn-1',
      'txn-2',
    ]);
    expect(bytes.uploadMedia).toHaveBeenCalledTimes(1);
    expect(retry.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
  });

  it('retries an uncertain send with the cached upload and the same transaction id', async () => {
    const { pipeline, bytes, client } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'retry.png', { type: 'image/png' }),
    );
    if (staged.kind !== 'staged') return;

    const first = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );
    const second = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(first.at(-1)).toEqual({
      kind: 'rejected',
      failure: 'send-rejected',
      retryable: true,
    });
    expect(second.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
    expect(bytes.uploadMedia).toHaveBeenCalledTimes(1);
    expect(client.makeTxnId).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0]?.[2]).toBe('txn-1');
    expect(client.resendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${KEY.roomId}:txn-1` }),
      expect.objectContaining({ roomId: KEY.roomId }),
    );
  });

  it('cancels the failed echo and uses a fresh transaction when retry changes the caption', async () => {
    const { pipeline, bytes, client } = setup();
    client.makeTxnId.mockReturnValueOnce('txn-1').mockReturnValueOnce('txn-2');
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'caption.png', {
        type: 'image/png',
      }),
    );
    if (staged.kind !== 'staged') return;

    await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: 'old caption' })
        .pipe(toArray()),
    );
    const retry = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: 'new caption' })
        .pipe(toArray()),
    );

    expect(client.cancelPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${KEY.roomId}:txn-1` }),
    );
    expect(client.resendEvent).not.toHaveBeenCalled();
    expect(client.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      'txn-1',
      'txn-2',
    ]);
    expect(client.sendMessage.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ body: 'new caption' }),
    );
    expect(bytes.uploadMedia).toHaveBeenCalledTimes(1);
    expect(retry.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
  });

  it('re-uploads stripped and sends a fresh event when a kept-metadata retry must now strip', async () => {
    const { pipeline, bytes, client } = setup();
    client.makeTxnId.mockReturnValueOnce('txn-1').mockReturnValueOnce('txn-2');
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));
    const kept = uploaded();
    const stripped = uploaded();
    stripped.file!.url = 'mxc://example.org/stripped';
    bytes.uploadMedia
      .mockImplementationOnce(() => of(kept))
      .mockImplementationOnce(() => of(stripped));
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' }),
    );
    if (staged.kind !== 'staged') return;

    const first = await firstValueFrom(
      pipeline
        .transfer({
          key: KEY,
          media: staged.media,
          caption: '',
          imageMetadata: 'keep',
        })
        .pipe(toArray()),
    );
    // The person turns Keep photo and video metadata off before retrying.
    const retry = await firstValueFrom(
      pipeline
        .transfer({
          key: KEY,
          media: staged.media,
          caption: '',
          imageMetadata: 'strip',
        })
        .pipe(toArray()),
    );

    expect(first.at(-1)).toEqual({
      kind: 'rejected',
      failure: 'send-rejected',
      retryable: true,
    });
    expect(client.cancelPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${KEY.roomId}:txn-1` }),
    );
    expect(client.resendEvent).not.toHaveBeenCalled();
    expect(bytes.uploadMedia.mock.calls.map((call) => call[6])).toEqual([
      'keep',
      'strip',
    ]);
    expect(client.sendMessage.mock.calls.map((call) => call[2])).toEqual([
      'txn-1',
      'txn-2',
    ]);
    expect(client.sendMessage.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        file: expect.objectContaining({ url: 'mxc://example.org/stripped' }),
      }),
    );
    expect(retry.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
  });

  it('does not withdraw a kept-metadata echo the SDK still marks sending', async () => {
    const { pipeline, bytes, client, pendingEcho } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' }),
    );
    if (staged.kind !== 'staged') return;

    await firstValueFrom(
      pipeline
        .transfer({
          key: KEY,
          media: staged.media,
          caption: '',
          imageMetadata: 'keep',
        })
        .pipe(toArray()),
    );
    pendingEcho.status = 'sending';
    const retry = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(retry.at(-1)).toEqual({
      kind: 'indeterminate',
      failure: 'send-in-flight',
      retryable: true,
    });
    expect(client.cancelPendingEvent).not.toHaveBeenCalled();
    expect(bytes.uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('reuses a stripped upload when a retry would keep metadata', async () => {
    const { pipeline, bytes, client } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'photo.jpg', { type: 'image/jpeg' }),
    );
    if (staged.kind !== 'staged') return;

    await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );
    const retry = await firstValueFrom(
      pipeline
        .transfer({
          key: KEY,
          media: staged.media,
          caption: '',
          imageMetadata: 'keep',
        })
        .pipe(toArray()),
    );

    expect(bytes.uploadMedia).toHaveBeenCalledTimes(1);
    expect(client.cancelPendingEvent).not.toHaveBeenCalled();
    expect(client.resendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${KEY.roomId}:txn-1` }),
      expect.objectContaining({ roomId: KEY.roomId }),
    );
    expect(retry.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
  });

  it('does not resend a retained echo while the SDK still marks it sending', async () => {
    const { pipeline, client, pendingEcho } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'still-sending.png', {
        type: 'image/png',
      }),
    );
    if (staged.kind !== 'staged') return;

    await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );
    pendingEcho.status = 'sending';
    const retry = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(retry.at(-1)).toEqual({
      kind: 'indeterminate',
      failure: 'send-in-flight',
      retryable: true,
    });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.resendEvent).not.toHaveBeenCalled();
  });

  it('reports an accepted server response without a local echo as indeterminate', async () => {
    const { pipeline, room } = setup();
    room.findEventById.mockReturnValue(undefined);
    const staged = pipeline.stage(new File([new Uint8Array([1])], 'sent.bin'));
    if (staged.kind !== 'staged') return;

    const events = await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(events.at(-1)).toEqual({
      kind: 'indeterminate',
      failure: 'local-echo-missing',
      retryable: true,
    });
  });

  it('revokes preview resources and permanently retires a released staged reference', () => {
    const { pipeline } = setup();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const staged = pipeline.stage(
      new File([new Uint8Array([1])], 'preview.png', { type: 'image/png' }),
    );
    if (staged.kind !== 'staged') return;

    pipeline.releaseStaged(staged.media);

    expect(revoke).toHaveBeenCalledWith(staged.media.previewUrl);
    expect(pipeline.hasStaged(staged.media)).toBe(false);
  });

  it('keeps capture hints on the staged reference and forwards them to the upload', async () => {
    const { pipeline, bytes } = setup();
    const hints = {
      width: 1920,
      height: 1080,
      durationMs: 12_500,
      thumbnail: {
        blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
        w: 480,
        h: 270,
      },
    };
    const staged = pipeline.stage(
      new File([new Uint8Array([1, 2, 3])], 'video.mov', {
        type: 'video/quicktime',
      }),
      hints,
    );
    if (staged.kind !== 'staged') throw new Error('not staged');

    expect(staged.media.hints).toEqual(hints);
    await firstValueFrom(
      pipeline
        .transfer({ key: KEY, media: staged.media, caption: '' })
        .pipe(toArray()),
    );

    expect(bytes.uploadMedia).toHaveBeenCalledWith(
      expect.any(File),
      true,
      expect.any(Function),
      expect.any(AbortController),
      KEY.accountId,
      hints,
      'strip',
    );
  });

  it('uploads with the image metadata policy the transfer asks for', async () => {
    const { pipeline, bytes } = setup();
    const staged = pipeline.stage(
      new File([new Uint8Array([1, 2, 3, 4])], 'photo.jpg', {
        type: 'image/jpeg',
      }),
    );
    if (staged.kind !== 'staged') throw new Error('not staged');

    await firstValueFrom(
      pipeline
        .transfer({
          key: KEY,
          media: staged.media,
          caption: '',
          imageMetadata: 'keep',
        })
        .pipe(toArray()),
    );

    expect(bytes.uploadMedia).toHaveBeenCalledWith(
      expect.any(File),
      true,
      expect.any(Function),
      expect.any(AbortController),
      KEY.accountId,
      undefined,
      'keep',
    );
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

  it('reads the upload limit through the exact account client', async () => {
    const { pipeline, bytes, matrix } = setup();

    expect(await firstValueFrom(pipeline.uploadLimit(KEY.accountId))).toBe(
      1024,
    );
    expect(matrix.clientFor).toHaveBeenCalledWith(KEY.accountId);
    expect(bytes.uploadLimit).toHaveBeenCalledWith(KEY.accountId);
  });

  it('has no limit for a missing or unknown account', async () => {
    const { pipeline, bytes, matrix } = setup();
    matrix.clientFor.mockReturnValue(null);

    expect(await firstValueFrom(pipeline.uploadLimit(null))).toBeNull();
    expect(
      await firstValueFrom(pipeline.uploadLimit('@ghost:example.org')),
    ).toBeNull();
    expect(bytes.uploadLimit).not.toHaveBeenCalled();
  });
});
