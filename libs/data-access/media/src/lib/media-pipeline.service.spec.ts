import { TestBed } from '@angular/core/testing';
import { NEVER, firstValueFrom, of, take, toArray } from 'rxjs';
import type { MatrixClient } from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { MediaService, type UploadedMedia } from './media.service';
import { MediaPipeline } from './media-pipeline.service';

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
  const client = {
    getUserId: (): string => KEY.accountId,
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
      ) => of(uploaded()),
    ),
    resolveMedia: vi.fn(() => of('blob:resolved')),
    downloadMedia: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    releaseAll: vi.fn(),
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
    pendingEcho,
  };
}

afterEach(() => TestBed.resetTestingModule());

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
      client,
    );
    expect(events.at(-1)).toEqual({ kind: 'sent', eventId: '$event' });
    expect(events.some((event) => event.kind === 'progress')).toBe(true);
    expect(client.sendMessage).toHaveBeenCalledWith(
      KEY.roomId,
      expect.objectContaining({ file: expect.any(Object) }),
      'txn-1',
    );
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
    const { pipeline, bytes, client } = setup();
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
      client as unknown as MatrixClient,
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
      client,
    );
    bytes.downloadMedia.mockReturnValue(
      of({ blob: new Blob(['safe']), filename: 'secret.png' }),
    );
    await expect(
      firstValueFrom(pipeline.downloadMedia(reference)),
    ).resolves.toMatchObject({ filename: 'secret.png' });
    expect(bytes.downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ file: uploaded().file }),
      client,
    );
  });

  it.each(['removed', 'replaced'])(
    'rejects reads created before the source Account client is %s',
    async (transition) => {
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
      bytes.downloadMedia.mockReturnValue(
        of({ blob: new Blob(['photo']), filename: 'photo.png' }),
      );
      const reads = [
        pipeline.resolveMedia(reference, 'thumbnail'),
        pipeline.resolveMedia(reference, 'full'),
        pipeline.downloadMedia(reference),
      ];
      matrix.clientFor.mockReturnValue(
        transition === 'removed' ? null : { ...client },
      );

      for (const read of reads) {
        await expect(firstValueFrom<unknown>(read)).rejects.toThrow(
          'Media reference is no longer available',
        );
      }
      expect(bytes.resolveMedia).not.toHaveBeenCalled();
      expect(bytes.downloadMedia).not.toHaveBeenCalled();
    },
  );

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
      client,
    );
    expect(bytes.downloadMedia).toHaveBeenCalledWith(
      expect.any(Object),
      client,
    );
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

  it('aborts an in-flight upload on unsubscribe and keeps the staged reference retryable', () => {
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
});
