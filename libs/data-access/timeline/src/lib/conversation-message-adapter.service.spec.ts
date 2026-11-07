import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ConnectionError,
  EventStatus,
  MatrixError,
  MatrixEvent,
  ReceiptType,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  DraftStoreService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import {
  CONVERSATION_MESSAGE_ADAPTER,
  CONVERSATION_MESSAGE_POLICY,
} from './conversation-message-adapter.service';
import { conversationDraftKey, threadDraftKey } from './conversation-draft-key';
import type {
  ConversationMessagePolicy,
  ConversationRedactionDecision,
} from './conversation-messages';
import {
  fakeEvent,
  fakeReaction,
  fakeRelations,
  fakeRoom,
} from './timeline.spec-harness';

const KEY = { accountId: '@alice:hs', roomId: '!shared:hs' } as const;

function setup(
  options: {
    readonly eventStatus?: EventStatus | null;
    readonly existingReaction?: boolean;
    /** Id of the own reaction; a local echo's is `~!room:txn` until the server answers. */
    readonly reactionId?: string;
    /** A second own reaction with the same key, as another device can race one in. */
    readonly duplicateReaction?: boolean;
    readonly privateReceipt?: boolean;
    readonly policy?: ConversationMessagePolicy;
    readonly rejectWith?: unknown;
    readonly withNewer?: boolean;
    /** A real SDK echo in place of the fake `$message`. */
    readonly echo?: MatrixEvent;
  } = {},
) {
  const event =
    (options.echo as unknown as ReturnType<typeof fakeEvent>) ??
    fakeEvent({
      id: '$message',
      sender: KEY.accountId,
      status: options.eventStatus ?? undefined,
    });
  const newer = fakeEvent({ id: '$newer', sender: KEY.accountId });
  const reactions: Record<string, ReturnType<typeof fakeRelations>> = {};
  if (options.existingReaction) {
    reactions['$message'] = fakeRelations([
      [
        '👍',
        new Set([
          fakeReaction(KEY.accountId, options.reactionId ?? '$mine'),
          ...(options.duplicateReaction
            ? [fakeReaction(KEY.accountId, '$mine2')]
            : []),
        ]),
      ],
    ]);
  }
  const room = {
    ...fakeRoom(options.withNewer ? [event, newer] : [event], reactions),
    roomId: KEY.roomId,
  };
  const alternateRoom = { ...room };
  const failure = options.rejectWith;
  const action = () =>
    failure === undefined ? Promise.resolve({}) : Promise.reject(failure);
  const client = {
    getUserId: vi.fn(() => KEY.accountId),
    getRoom: vi.fn(() => room),
    sendEvent: vi.fn(action),
    redactEvent: vi.fn(action),
    resendEvent: vi.fn(action),
    cancelPendingEvent: vi.fn(),
    sendReadReceipt: vi.fn(action),
    setRoomReadMarkers: vi.fn(action),
  };
  const alternateClient = {
    ...client,
    getUserId: vi.fn(() => '@other:hs'),
    getRoom: vi.fn(() => alternateRoom),
    sendEvent: vi.fn(action),
  };
  const drafts = { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
  const policy: ConversationMessagePolicy = options.policy ?? {
    canRedactOthers: () => true,
    canSendMessages: () => true,
    authorizeRedaction: () => ({ kind: 'allowed' }),
  };
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MatrixClientService,
        useValue: {
          clientFor: (accountId: string) =>
            accountId === KEY.accountId ? client : alternateClient,
        },
      },
      {
        provide: PrivacySettingsService,
        useValue: {
          sendReadReceipts: signal(!options.privateReceipt).asReadonly(),
        },
      },
      { provide: CONVERSATION_MESSAGE_POLICY, useValue: policy },
      { provide: DraftStoreService, useValue: drafts },
    ],
  });
  return {
    adapter: TestBed.inject(CONVERSATION_MESSAGE_ADAPTER),
    client,
    drafts,
    alternateClient,
    event,
    newer,
    room,
  };
}

afterEach(() => {
  vi.useRealTimers();
  TestBed.resetTestingModule();
});

/** Start a receipt, let the 1 s debounce pass and return its outcome. */
async function settle<T>(outcome: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1_000);
  return outcome;
}

describe('MatrixConversationMessageAdapter', () => {
  it('keeps reaction commands cold and resolves the exact Account client', async () => {
    const { adapter, client, alternateClient } = setup();
    const command = adapter.toggleReaction({
      key: KEY,
      messageId: '$message',
      reaction: '👍',
    });

    expect(client.sendEvent).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'applied',
      operation: 'reaction',
    });
    expect(client.sendEvent).toHaveBeenCalledWith(
      KEY.roomId,
      'm.reaction',
      expect.objectContaining({
        'm.relates_to': expect.objectContaining({
          event_id: '$message',
          key: '👍',
        }),
      }),
    );
    expect(alternateClient.sendEvent).not.toHaveBeenCalled();
  });

  it('re-reads SDK-authoritative relations and redacts an existing reaction', async () => {
    const { adapter, client } = setup({ existingReaction: true });

    await firstValueFrom(
      adapter.toggleReaction({
        key: KEY,
        messageId: '$message',
        reaction: '👍',
      }),
    );

    expect(client.redactEvent).toHaveBeenCalledWith(KEY.roomId, '$mine');
    expect(client.sendEvent).not.toHaveBeenCalled();
  });

  it('removes every own reaction with the key, not just the first', async () => {
    const { adapter, client } = setup({
      existingReaction: true,
      duplicateReaction: true,
    });

    await firstValueFrom(
      adapter.toggleReaction({
        key: KEY,
        messageId: '$message',
        reaction: '👍',
      }),
    );

    expect(client.redactEvent.mock.calls).toEqual([
      [KEY.roomId, '$mine'],
      [KEY.roomId, '$mine2'],
    ]);
  });

  it('delegates redaction governance before calling the SDK', async () => {
    const policy: ConversationMessagePolicy = {
      canRedactOthers: () => false,
      canSendMessages: () => true,
      authorizeRedaction: vi.fn((): ConversationRedactionDecision => ({
        kind: 'rejected',
        failure: 'not-allowed',
      })),
    };
    const { adapter, client } = setup({ policy });

    await expect(
      firstValueFrom(adapter.redact({ key: KEY, messageId: '$message' })),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'redaction',
      failure: 'not-allowed',
      retryable: false,
    });
    expect(client.redactEvent).not.toHaveBeenCalled();
  });

  it('classifies expected request failures without exposing error metadata', async () => {
    const transient = setup({
      rejectWith: new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429),
    });

    await expect(
      firstValueFrom(
        transient.adapter.toggleReaction({
          key: KEY,
          messageId: '$message',
          reaction: '👍',
        }),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'reaction',
      failure: 'request-rejected',
      retryable: true,
    });
  });

  it('retries only SDK events whose send state is retryable', async () => {
    const failed = setup({ eventStatus: EventStatus.NOT_SENT });
    await expect(
      firstValueFrom(failed.adapter.retry({ key: KEY, messageId: '$message' })),
    ).resolves.toMatchObject({ kind: 'applied', operation: 'retry' });
    expect(failed.client.resendEvent).toHaveBeenCalledWith(
      failed.event,
      failed.room,
    );

    TestBed.resetTestingModule();
    const sent = setup({ eventStatus: EventStatus.SENT });
    await expect(
      firstValueFrom(sent.adapter.retry({ key: KEY, messageId: '$message' })),
    ).resolves.toMatchObject({
      kind: 'rejected',
      failure: 'event-not-retryable',
      retryable: false,
    });
  });

  // A refused send's Retry, offline: the SDK marks the row waiting and the next sync resends it,
  // so putting its text back in the composer would let Send post it twice.
  describe('a retry that fails offline', () => {
    async function retryOffline(
      content: Record<string, unknown>,
      threadRootId?: string,
    ) {
      const echo = new MatrixEvent({
        event_id: '~!shared:hs:txn-1',
        type: 'm.room.message',
        content,
      });
      echo.setTxnId('txn-1');
      echo.setStatus(EventStatus.NOT_SENT);
      const { adapter, client, drafts } = setup({ echo });
      client.resendEvent.mockImplementation(() => {
        echo.error = new ConnectionError('offline') as never;
        echo.setStatus(EventStatus.NOT_SENT);
        return Promise.reject(echo.error);
      });
      const outcome = await firstValueFrom(
        adapter.retry({
          key: KEY,
          messageId: '~!shared:hs:txn-1',
          threadRootId,
        }),
      );
      return { outcome, echo, drafts };
    }

    it('counts as sent and keeps its text until the echo is sent', async () => {
      const { outcome, echo, drafts } = await retryOffline({
        msgtype: 'm.emote',
        body: 'waves',
      });

      expect(outcome).toEqual({ kind: 'applied', operation: 'retry' });
      expect(drafts.holdWaiting).toHaveBeenCalledWith(
        conversationDraftKey(KEY),
        'txn-1',
        '/me waves',
      );
      echo.setStatus(EventStatus.SENDING);
      expect(drafts.releaseWaiting).not.toHaveBeenCalled();
      echo.setStatus(EventStatus.SENT);
      echo.setStatus(null);
      expect(drafts.releaseWaiting).toHaveBeenCalledOnce();
      expect(drafts.releaseWaiting).toHaveBeenCalledWith(
        conversationDraftKey(KEY),
        'txn-1',
      );
    });

    it('lets its text go when the waiting echo is cancelled', async () => {
      const { echo, drafts } = await retryOffline({
        msgtype: 'm.text',
        body: 'hello',
      });

      echo.setStatus(EventStatus.CANCELLED);

      expect(drafts.releaseWaiting).toHaveBeenCalledWith(
        conversationDraftKey(KEY),
        'txn-1',
      );
    });

    it('keeps a thread reply under the thread composer key', async () => {
      const { outcome, drafts } = await retryOffline(
        { msgtype: 'm.text', body: 'hello' },
        '$root',
      );

      expect(outcome).toEqual({ kind: 'applied', operation: 'retry' });
      expect(drafts.holdWaiting).toHaveBeenCalledWith(
        threadDraftKey('$root'),
        'txn-1',
        'hello',
      );
    });

    it('holds nothing for a waiting echo without composer text', async () => {
      const { outcome, drafts } = await retryOffline({
        msgtype: 'm.notice',
        body: 'bot says',
      });

      expect(outcome).toEqual({ kind: 'applied', operation: 'retry' });
      expect(drafts.holdWaiting).not.toHaveBeenCalled();
    });
  });

  // #1868: the SDK keeps a resent echo where it was first added, but the server stamps it with
  // the time of the resend, so a 11:09 message sat above an 11:08 one.
  it('moves a retried echo to the end of the timeline, where its new send time belongs', async () => {
    const { adapter, room } = setup({
      eventStatus: EventStatus.NOT_SENT,
    });
    const newer = fakeEvent({ id: '$newer', sender: '@bob:hs' });
    const order = room.getLiveTimeline().getEvents();
    order.push(newer);

    await firstValueFrom(adapter.retry({ key: KEY, messageId: '$message' }));

    expect(order.map((e) => e.getId())).toEqual(['$newer', '$message']);
  });

  it('cancels only a NOT_SENT echo', async () => {
    const waiting = setup({ eventStatus: EventStatus.NOT_SENT });
    await expect(
      firstValueFrom(
        waiting.adapter.cancel({ key: KEY, messageId: '$message' }),
      ),
    ).resolves.toMatchObject({ kind: 'applied', operation: 'cancel' });
    expect(waiting.client.cancelPendingEvent).toHaveBeenCalledWith(
      waiting.event,
    );

    TestBed.resetTestingModule();
    const sent = setup({ eventStatus: EventStatus.SENT });
    await expect(
      firstValueFrom(sent.adapter.cancel({ key: KEY, messageId: '$message' })),
    ).resolves.toMatchObject({
      kind: 'rejected',
      failure: 'event-not-retryable',
    });
    expect(sent.client.cancelPendingEvent).not.toHaveBeenCalled();
  });

  it('sends privacy-aware receipts and the persisted read marker together', async () => {
    vi.useFakeTimers();
    const { adapter, client, event } = setup({ privateReceipt: true });

    await expect(
      settle(
        firstValueFrom(
          adapter.acknowledge({ key: KEY, messageId: '$message' }),
        ),
      ),
    ).resolves.toMatchObject({ kind: 'applied', operation: 'receipt' });
    expect(client.sendReadReceipt).toHaveBeenCalledWith(
      event,
      ReceiptType.ReadPrivate,
    );
    expect(client.setRoomReadMarkers).toHaveBeenCalledWith(
      KEY.roomId,
      '$message',
    );
  });

  describe('read receipt debounce', () => {
    it('sends one receipt for the newest message after a burst', async () => {
      vi.useFakeTimers();
      const { adapter, client, newer } = setup({ withNewer: true });

      adapter.acknowledge({ key: KEY, messageId: '$message' }).subscribe();
      await vi.advanceTimersByTimeAsync(400);
      adapter.acknowledge({ key: KEY, messageId: '$newer' }).subscribe();
      await vi.advanceTimersByTimeAsync(500);
      expect(client.sendReadReceipt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(client.sendReadReceipt).toHaveBeenCalledTimes(1);
      expect(client.sendReadReceipt).toHaveBeenCalledWith(
        newer,
        ReceiptType.Read,
      );
      expect(client.setRoomReadMarkers).toHaveBeenCalledTimes(1);
    });

    it('still sends every second or so while acks keep arriving', async () => {
      vi.useFakeTimers();
      const { adapter, client } = setup({ withNewer: true });

      for (let elapsed = 0; elapsed < 5_000; elapsed += 300) {
        adapter.acknowledge({ key: KEY, messageId: '$newer' }).subscribe();
        await vi.advanceTimersByTimeAsync(300);
      }

      expect(client.sendReadReceipt.mock.calls.length).toBeGreaterThanOrEqual(
        4,
      );
    });

    it('keeps the room and thread receipts separate', async () => {
      vi.useFakeTimers();
      const { adapter, client } = setup({ withNewer: true });

      adapter.acknowledge({ key: KEY, messageId: '$message' }).subscribe();
      adapter
        .acknowledge({
          key: KEY,
          messageId: '$newer',
          threadRootId: '$thread-root',
        })
        .subscribe();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(client.sendReadReceipt).toHaveBeenCalledTimes(2);
      expect(client.setRoomReadMarkers).toHaveBeenCalledTimes(1);
    });

    it('flushes a waiting receipt when the room closes', async () => {
      vi.useFakeTimers();
      const { adapter, client } = setup();

      adapter.acknowledge({ key: KEY, messageId: '$message' }).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.sendReadReceipt).not.toHaveBeenCalled();
      adapter.flushReceipts();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sendReadReceipt).toHaveBeenCalledTimes(1);
    });

    it('flushes a waiting receipt when the tab goes hidden', async () => {
      vi.useFakeTimers();
      const { adapter, client } = setup();
      const hidden = vi.spyOn(document, 'visibilityState', 'get');
      hidden.mockReturnValue('hidden');

      adapter.acknowledge({ key: KEY, messageId: '$message' }).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.sendReadReceipt).not.toHaveBeenCalled();
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sendReadReceipt).toHaveBeenCalledTimes(1);
      hidden.mockRestore();
    });

    it('flushes a waiting receipt when the injector is destroyed', async () => {
      vi.useFakeTimers();
      const { adapter, client } = setup();

      adapter.acknowledge({ key: KEY, messageId: '$message' }).subscribe();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.sendReadReceipt).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sendReadReceipt).toHaveBeenCalledTimes(1);
    });

    it('flushes a waiting receipt of another room when a different room acknowledges', async () => {
      vi.useFakeTimers();
      const { adapter, client } = setup({ withNewer: true });

      adapter.acknowledge({ key: KEY, messageId: '$message' }).subscribe();
      adapter
        .acknowledge({
          key: { ...KEY, roomId: '!other:hs' },
          messageId: '$newer',
        })
        .subscribe();
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sendReadReceipt).toHaveBeenCalledTimes(1);
    });
  });

  it('uses thread-scoped SDK overloads and does not move the room read marker', async () => {
    vi.useFakeTimers();
    const { adapter, client, event } = setup();

    await firstValueFrom(
      adapter.toggleReaction({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: '$message',
        reaction: '👍',
      }),
    );
    await firstValueFrom(
      adapter.redact({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: '$message',
      }),
    );
    await settle(
      firstValueFrom(
        adapter.acknowledge({
          key: KEY,
          threadRootId: '$thread-root',
          messageId: '$message',
        }),
      ),
    );

    expect(client.sendEvent).toHaveBeenCalledWith(
      KEY.roomId,
      '$thread-root',
      'm.reaction',
      expect.any(Object),
    );
    expect(client.redactEvent).toHaveBeenCalledWith(
      KEY.roomId,
      '$thread-root',
      '$message',
    );
    expect(client.sendReadReceipt).toHaveBeenCalledWith(
      event,
      ReceiptType.Read,
    );
    expect(client.setRoomReadMarkers).not.toHaveBeenCalled();
  });

  it('redacts a thread reaction with a server id through the thread overload', async () => {
    const { adapter, client } = setup({ existingReaction: true });

    await firstValueFrom(
      adapter.toggleReaction({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: '$message',
        reaction: '👍',
      }),
    );

    expect(client.redactEvent.mock.calls).toEqual([
      [KEY.roomId, '$thread-root', '$mine'],
    ]);
  });

  it('does nothing on a double-tap while the first reaction is still pending', async () => {
    const { adapter, client } = setup({
      existingReaction: true,
      reactionId: '~!shared:hs:txn1',
    });

    const outcome = await firstValueFrom(
      adapter.toggleReaction({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: '$message',
        reaction: '👍',
      }),
    );

    expect(outcome).toEqual({ kind: 'applied', operation: 'reaction' });
    expect(client.redactEvent).not.toHaveBeenCalled();
    expect(client.sendEvent).not.toHaveBeenCalled();
  });

  it('redacts only the server id when own reactions are pending and sent', async () => {
    const { adapter, client } = setup({
      existingReaction: true,
      reactionId: '~!shared:hs:txn1',
      duplicateReaction: true,
    });

    const outcome = await firstValueFrom(
      adapter.toggleReaction({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: '$message',
        reaction: '👍',
      }),
    );

    expect(outcome).toEqual({ kind: 'applied', operation: 'reaction' });
    expect(client.redactEvent.mock.calls).toEqual([
      [KEY.roomId, '$thread-root', '$mine2'],
    ]);
  });

  it('refuses to delete a pending thread message without redacting the thread root', async () => {
    const pending = '~!shared:hs:txn2';
    const { adapter, client } = setup();
    // The SDK throws synchronously for a pending id in the two-argument form.
    client.redactEvent.mockImplementation(() => {
      throw new Error('pending events are unavailable');
    });

    const outcome = await firstValueFrom(
      adapter.redact({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: pending,
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'rejected',
      operation: 'redaction',
      failure: 'request-rejected',
    });
    expect(client.redactEvent.mock.calls).toEqual([[KEY.roomId, pending]]);
  });
});
