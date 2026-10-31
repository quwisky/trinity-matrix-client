import { TestBed } from '@angular/core/testing';
import { firstValueFrom, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import {
  assertProgressThenResult,
  mediaCaptionFields,
} from '@trinity/util/matrix';
import type { AttachmentRequest } from '../media-engine';
import { JsSdkMediaEngine } from './js-sdk-media-engine';

const ALICE = '@alice:hs';
const ROOM = '!room:hs';

function setup() {
  const localEcho = { id: '$event' };
  const pendingEcho = {
    id: `~${ROOM}:txn-1`,
    status: 'not_sent',
    getId: () => `~${ROOM}:txn-1`,
  };
  const room = {
    roomId: ROOM,
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
  let uploaded = 0;
  const client = {
    getVersions: vi.fn().mockResolvedValue({ versions: ['v1.11'] }),
    getMediaConfig: vi.fn().mockResolvedValue({}),
    uploadContent: vi.fn(
      (_body: Blob, _options: { abortController?: AbortController }) =>
        Promise.resolve({ content_uri: `mxc://hs/up${++uploaded}` }),
    ),
    getCrypto: vi.fn((): typeof crypto | undefined => crypto),
    getRoom: vi.fn((id: string) => (id === ROOM ? room : null)),
    makeTxnId: vi.fn(() => 'txn-1'),
    sendMessage: vi.fn((..._args: unknown[]) =>
      Promise.resolve({ event_id: '$event' }),
    ),
    resendEvent: vi.fn(() => Promise.resolve({ event_id: '$event' })),
    cancelPendingEvent: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => (id === ALICE ? client : null) },
      },
    ],
  });
  return {
    engine: TestBed.inject(JsSdkMediaEngine),
    client,
    room,
    crypto,
    pendingEcho,
  };
}

function attachment(
  overrides: Partial<AttachmentRequest> = {},
): AttachmentRequest {
  return {
    attachmentKey: 'key',
    threadRootId: null,
    file: new Blob([new Uint8Array([1, 2, 3, 4])]),
    filename: 'secret.png',
    mimeType: 'image/png',
    msgtype: 'm.image',
    info: { w: 4, h: 2, durationMs: null },
    thumbnail: null,
    caption: '',
    captionFields: mediaCaptionFields(
      overrides.filename ?? 'secret.png',
      overrides.caption ?? '',
    ),
    metadata: 'stripped',
    ...overrides,
  };
}

/** The content passed to the n-th sendMessage (thread or not). */
function sentContent(
  client: ReturnType<typeof setup>['client'],
  n = 0,
): Record<string, unknown> {
  const call = client.sendMessage.mock.calls[n] ?? [];
  return call[call.length - 2] as Record<string, unknown>;
}

function txnIds(client: ReturnType<typeof setup>['client']): unknown[] {
  return client.sendMessage.mock.calls.map((call) => call[call.length - 1]);
}

async function run(
  engine: JsSdkMediaEngine,
  request: AttachmentRequest,
  roomId = ROOM,
) {
  return assertProgressThenResult(
    engine.sendAttachment(ALICE, roomId, request),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('JsSdkMediaEngine.sendAttachment', () => {
  it('stays cold, encrypts for an encrypted room and sends the file with its info', async () => {
    const { engine, client } = setup();
    const command = engine.sendAttachment(
      ALICE,
      ROOM,
      attachment({ caption: 'classified' }),
    );
    expect(client.uploadContent).not.toHaveBeenCalled();

    const { progress, result } = await assertProgressThenResult(command);

    expect(progress[0]).toEqual({
      kind: 'progress',
      phase: 'encrypting',
      fraction: 0,
    });
    expect(progress.at(-1)).toMatchObject({ phase: 'sending' });
    expect(result).toEqual({
      ok: true,
      value: { kind: 'sent', eventId: '$event' },
    });
    expect(client.uploadContent.mock.calls[0]?.[1]).toMatchObject({
      includeFilename: false,
      type: 'application/octet-stream',
    });
    expect(client.sendMessage).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({
        msgtype: 'm.image',
        body: 'classified',
        filename: 'secret.png',
        file: expect.objectContaining({ url: 'mxc://hs/up1' }),
        info: { mimetype: 'image/png', size: 4, w: 4, h: 2 },
      }),
      'txn-1',
    );
  });

  it('encrypts when the crypto store has the room as encrypted but its state lacks the event', async () => {
    const { engine, client, room, crypto } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    crypto.isEncryptionEnabledInRoom.mockResolvedValue(true);

    await run(engine, attachment());

    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledWith(ROOM);
    expect(sentContent(client)).toHaveProperty('file');
  });

  it('uploads in the clear only when the room state and the crypto store both say unencrypted', async () => {
    const { engine, client, room } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);

    await run(
      engine,
      attachment({
        thumbnail: {
          blob: new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
          mimeType: 'image/jpeg',
          w: 2,
          h: 1,
        },
      }),
    );

    expect(client.uploadContent.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ name: 'thumbnail', type: 'image/jpeg' }),
      expect.objectContaining({ name: 'secret.png', type: 'image/png' }),
    ]);
    expect(sentContent(client)).toMatchObject({
      url: 'mxc://hs/up2',
      info: {
        thumbnail_url: 'mxc://hs/up1',
        thumbnail_info: { mimetype: 'image/jpeg', w: 2, h: 1, size: 1 },
      },
    });
  });

  it('encrypts when the crypto store fails to answer', async () => {
    const { engine, client, room, crypto } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    crypto.isEncryptionEnabledInRoom.mockRejectedValue(new Error('store'));

    await run(engine, attachment());

    expect(sentContent(client)).toHaveProperty('file');
  });

  it('fails closed with encryption-unavailable when the crypto store is unavailable', async () => {
    const { engine, client, room } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    client.getCrypto.mockReturnValue(undefined);

    const { progress, result } = await run(engine, attachment());

    expect(progress).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'encryption-unavailable' },
    });
    expect(client.uploadContent).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a file whose strip failed in an encrypted room, before any upload', async () => {
    const { engine, client } = setup();

    const { progress, result } = await run(
      engine,
      attachment({ metadata: 'strip-failed' }),
    );

    expect(progress).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'request-failed' },
    });
    expect(client.uploadContent).not.toHaveBeenCalled();
  });

  it('sends a file whose strip failed in a plain room', async () => {
    const { engine, client, room } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);

    const { result } = await run(
      engine,
      attachment({ metadata: 'strip-failed' }),
    );

    expect(result.ok).toBe(true);
    expect(client.uploadContent).toHaveBeenCalledTimes(1);
  });

  it('sends to the exact thread root through the SDK thread overload', async () => {
    const { engine, client } = setup();

    await run(
      engine,
      attachment({ threadRootId: '$thread-root', caption: 'in thread' }),
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      ROOM,
      '$thread-root',
      expect.objectContaining({ body: 'in thread', filename: 'secret.png' }),
      'txn-1',
    );
  });

  it('answers conversation-unavailable for an unknown room and account-not-live for an unknown account', async () => {
    const { engine } = setup();

    const noRoom = await run(engine, attachment(), '!gone:hs');
    const nobody = await assertProgressThenResult(
      engine.sendAttachment('@nobody:hs', ROOM, attachment()),
    );

    expect([noRoom.result, nobody.result]).toMatchObject([
      { ok: false, failure: { code: 'conversation-unavailable' } },
      { ok: false, failure: { code: 'account-not-live' } },
    ]);
  });

  it('aborts an in-flight upload on unsubscribe', async () => {
    const { engine, client } = setup();
    let controller: AbortController | undefined;
    client.uploadContent.mockImplementation((_body, options) => {
      controller = options.abortController;
      return new Promise(() => undefined);
    });

    const subscription = engine
      .sendAttachment(ALICE, ROOM, attachment())
      .subscribe();
    await vi.waitFor(() => expect(client.uploadContent).toHaveBeenCalled());
    subscription.unsubscribe();

    expect(controller?.signal.aborted).toBe(true);
  });

  it('rotates the transaction id after cancelling a pending echo, then retries the retained upload', async () => {
    const { engine, client } = setup();
    client.makeTxnId.mockReturnValueOnce('txn-1').mockReturnValueOnce('txn-2');
    client.sendMessage
      .mockImplementationOnce(
        () => new Promise<{ event_id: string }>(() => undefined),
      )
      .mockResolvedValueOnce({ event_id: '$event' });

    const subscription = engine
      .sendAttachment(ALICE, ROOM, attachment())
      .subscribe();
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
    subscription.unsubscribe();
    const retry = await run(engine, attachment());

    expect(client.cancelPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${ROOM}:txn-1` }),
    );
    expect(txnIds(client)).toEqual(['txn-1', 'txn-2']);
    expect(client.uploadContent).toHaveBeenCalledTimes(1);
    expect(retry.result).toMatchObject({ ok: true, value: { kind: 'sent' } });
  });

  it('retries an uncertain send with the retained upload and the same transaction id', async () => {
    const { engine, client } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));

    const first = await run(engine, attachment());
    const second = await run(engine, attachment());

    expect(first.progress.at(-1)).toMatchObject({ phase: 'sending' });
    expect(first.result).toMatchObject({
      ok: false,
      failure: { code: 'request-failed' },
    });
    expect(second.result).toMatchObject({ ok: true, value: { kind: 'sent' } });
    expect(client.uploadContent).toHaveBeenCalledTimes(1);
    expect(client.makeTxnId).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.resendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${ROOM}:txn-1` }),
      expect.objectContaining({ roomId: ROOM }),
    );
  });

  it('sends the caption fields it is given', async () => {
    const { engine, client } = setup();

    await run(
      engine,
      attachment({ captionFields: { body: 'given' }, caption: 'other' }),
    );

    expect(sentContent(client)).toMatchObject({ body: 'given' });
  });

  it('cancels the failed echo and uses a fresh transaction when a retry changes the caption', async () => {
    const { engine, client } = setup();
    client.makeTxnId.mockReturnValueOnce('txn-1').mockReturnValueOnce('txn-2');
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));

    await run(engine, attachment({ caption: 'old caption' }));
    const retry = await run(engine, attachment({ caption: 'new caption' }));

    expect(client.cancelPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${ROOM}:txn-1` }),
    );
    expect(client.resendEvent).not.toHaveBeenCalled();
    expect(txnIds(client)).toEqual(['txn-1', 'txn-2']);
    expect(sentContent(client, 1)).toMatchObject({ body: 'new caption' });
    expect(client.uploadContent).toHaveBeenCalledTimes(1);
    expect(retry.result).toMatchObject({ ok: true, value: { kind: 'sent' } });
  });

  it('withdraws the superseded echo, uploads again and sends a fresh event', async () => {
    const { engine, client } = setup();
    client.makeTxnId.mockReturnValueOnce('txn-1').mockReturnValueOnce('txn-2');
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));

    await run(engine, attachment({ attachmentKey: 'kept', metadata: 'kept' }));
    const retry = await run(
      engine,
      attachment({ attachmentKey: 'stripped', supersedes: 'kept' }),
    );

    expect(client.cancelPendingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `~${ROOM}:txn-1` }),
    );
    expect(client.resendEvent).not.toHaveBeenCalled();
    expect(client.uploadContent).toHaveBeenCalledTimes(2);
    expect(txnIds(client)).toEqual(['txn-1', 'txn-2']);
    expect(sentContent(client, 1)).toMatchObject({
      file: expect.objectContaining({ url: 'mxc://hs/up2' }),
    });
    expect(retry.result).toMatchObject({ ok: true, value: { kind: 'sent' } });
  });

  it('does not withdraw a superseded echo the SDK still marks sending', async () => {
    const { engine, client, pendingEcho } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));

    await run(engine, attachment({ attachmentKey: 'kept', metadata: 'kept' }));
    pendingEcho.status = 'sending';
    const retry = await run(
      engine,
      attachment({ attachmentKey: 'stripped', supersedes: 'kept' }),
    );

    expect(retry.progress).toEqual([]);
    expect(retry.result).toEqual({
      ok: true,
      value: { kind: 'indeterminate', reason: 'send-in-flight' },
    });
    expect(client.cancelPendingEvent).not.toHaveBeenCalled();
    expect(client.uploadContent).toHaveBeenCalledTimes(1);
  });

  it('does not resend a retained echo while the SDK still marks it sending', async () => {
    const { engine, client, pendingEcho } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));

    await run(engine, attachment());
    pendingEcho.status = 'sending';
    const retry = await run(engine, attachment());

    expect(retry.result).toEqual({
      ok: true,
      value: { kind: 'indeterminate', reason: 'send-in-flight' },
    });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.resendEvent).not.toHaveBeenCalled();
  });

  it('reports an accepted server response without a local echo as indeterminate', async () => {
    const { engine, room } = setup();
    room.findEventById.mockReturnValue(undefined);

    const { result } = await run(engine, attachment());

    expect(result).toEqual({
      ok: true,
      value: { kind: 'indeterminate', reason: 'local-echo-missing' },
    });
  });

  it('forgets a retained upload without withdrawing its echo', async () => {
    const { engine, client } = setup();
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost'));

    await run(engine, attachment());
    const forgotten = await firstValueFrom(
      engine.forgetAttachment('key').pipe(toArray()),
    );
    await run(engine, attachment());

    expect(forgotten).toEqual([null]);
    expect(client.cancelPendingEvent).not.toHaveBeenCalled();
    expect(client.uploadContent).toHaveBeenCalledTimes(2);
  });

  it('sends without a thumbnail when the thumbnail upload fails', async () => {
    const { engine, client, room } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    client.uploadContent.mockRejectedValueOnce(new Error('thumbnail lost'));

    const { result } = await run(
      engine,
      attachment({
        thumbnail: {
          blob: new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
          mimeType: 'image/jpeg',
          w: 2,
          h: 1,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(sentContent(client)).not.toHaveProperty('info.thumbnail_url');
  });

  it('answers an upload failure before any sending progress', async () => {
    const { engine, client, room } = setup();
    room.hasEncryptionStateEvent.mockReturnValue(false);
    client.uploadContent.mockRejectedValueOnce(new Error('upload lost'));

    const { progress, result } = await run(engine, attachment());

    expect(progress.map((update) => update.phase)).not.toContain('sending');
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'request-failed' },
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
