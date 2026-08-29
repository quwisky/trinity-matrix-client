import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EventStatus, MatrixError, ReceiptType } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { PrivacySettingsService } from '@trinity/platform-native';
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

const KEY = { accountId: '@alice:hs', roomId: '!shared:hs' } as const;

function setup(
  options: {
    readonly eventStatus?: EventStatus | null;
    readonly existingReaction?: boolean;
    readonly privateReceipt?: boolean;
    readonly policy?: ConversationMessagePolicy;
    readonly rejectWith?: unknown;
  } = {},
) {
  const event = fakeEvent({
    id: '$message',
    sender: KEY.accountId,
    status: options.eventStatus ?? undefined,
  });
  const reactions: Record<string, ReturnType<typeof fakeRelations>> = {};
  if (options.existingReaction) {
    reactions['$message'] = fakeRelations([
      ['👍', new Set([fakeReaction(KEY.accountId, '$mine')])],
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
    ],
  });
  return {
    adapter: TestBed.inject(CONVERSATION_MESSAGE_ADAPTER),
    client,
    alternateClient,
    event,
    room,
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

  it('delegates redaction governance before calling the SDK', async () => {
    const policy: ConversationMessagePolicy = {
      canRedactOthers: () => false,
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
