import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EventStatus, MatrixError, ReceiptType } from 'matrix-js-sdk';
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
import { conversationDraftKey, threadDraftKey } from './conversation-draft-key';

const KEY = { accountId: '@alice:hs', roomId: '!shared:hs' } as const;

function setup(
  options: {
    readonly eventStatus?: EventStatus | null;
    readonly existingReaction?: boolean;
    /** A second own reaction with the same key, as another device can race one in. */
    readonly duplicateReaction?: boolean;
    readonly privateReceipt?: boolean;
    readonly policy?: ConversationMessagePolicy;
    readonly rejectWith?: unknown;
  } = {},
) {
  const event = Object.assign(
    fakeEvent({
      id: '$message',
      sender: KEY.accountId,
      status: options.eventStatus ?? undefined,
    }),
    { getTxnId: () => 'txn-1' },
  );
  const drafts = { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
  const reactions: Record<string, ReturnType<typeof fakeRelations>> = {};
  if (options.existingReaction) {
    reactions['$message'] = fakeRelations([
      [
        '👍',
        new Set([
          fakeReaction(KEY.accountId, '$mine'),
          ...(options.duplicateReaction
            ? [fakeReaction(KEY.accountId, '$mine2')]
            : []),
        ]),
      ],
    ]);
  }
  const room = {
    ...fakeRoom([event], reactions),
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
    alternateClient,
    event,
    room,
    drafts,
  };
}

afterEach(() => TestBed.resetTestingModule());

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
    expect(sent.drafts.releaseWaiting).not.toHaveBeenCalled();
  });

  it('row cancel releases the held draft', async () => {
    const room = setup({ eventStatus: EventStatus.NOT_SENT });
    await firstValueFrom(
      room.adapter.cancel({ key: KEY, messageId: '$message' }),
    );
    expect(room.drafts.releaseWaiting).toHaveBeenCalledWith(
      conversationDraftKey(KEY),
      'txn-1',
    );

    TestBed.resetTestingModule();
    const thread = setup({ eventStatus: EventStatus.NOT_SENT });
    await firstValueFrom(
      thread.adapter.cancel({
        key: KEY,
        messageId: '$message',
        threadRootId: '$root',
      }),
    );
    expect(thread.drafts.releaseWaiting).toHaveBeenCalledWith(
      threadDraftKey('$root'),
      'txn-1',
    );
  });

  it('sends privacy-aware receipts and the persisted read marker together', async () => {
    const { adapter, client, event } = setup({ privateReceipt: true });

    await expect(
      firstValueFrom(adapter.acknowledge({ key: KEY, messageId: '$message' })),
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

  it('uses thread-scoped SDK overloads and does not move the room read marker', async () => {
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
    await firstValueFrom(
      adapter.acknowledge({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: '$message',
      }),
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
});
