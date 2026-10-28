import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DraftStoreService,
  PrivacySettingsService,
} from '@trinity/platform-native';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import {
  CONVERSATION_MESSAGE_ADAPTER,
  CONVERSATION_MESSAGE_POLICY,
} from './conversation-message-adapter.service';
import type {
  ConversationMessagePolicy,
  ConversationRedactionDecision,
} from './conversation-messages';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { conversationDraftKey, threadDraftKey } from './conversation-draft-key';

const KEY = { accountId: '@alice:hs', roomId: '!shared:hs' } as const;
/** The id a row shows for the local echo of `txn-1`. */
const ECHO = `~${KEY.roomId}:txn-1`;
const MESSAGE = { eventId: '$message', transactionId: null } as const;
const LIVE = { threadRootId: null } as const;

function failure(
  code:
    | 'request-failed'
    | 'account-not-live'
    | 'message-unavailable'
    | 'not-cancellable',
  kind: EngineFailure['kind'] = 'unexpected',
): EngineResult<never> {
  return engineFail({ kind, code, diagnostic: { kind } } as EngineFailure);
}

function setup(
  options: {
    readonly privateReceipt?: boolean;
    readonly policy?: ConversationMessagePolicy;
    readonly result?: EngineResult<null>;
  } = {},
) {
  const reply = () => of(options.result ?? engineOk(null));
  const engine = {
    toggleReaction: vi.fn(reply),
    redact: vi.fn(reply),
    retrySend: vi.fn(reply),
    cancelSend: vi.fn(reply),
    sendReceipt: vi.fn(reply),
  };
  const drafts = { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
  const policy: ConversationMessagePolicy = options.policy ?? {
    canRedactOthers: () => true,
    canSendMessages: () => true,
    authorizeRedaction: () => ({ kind: 'allowed' }),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: TIMELINE_ENGINE, useValue: engine },
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
    engine,
    drafts,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('ConversationMessageAdapter', () => {
  it('keeps reaction commands cold and passes the exact Account and item', async () => {
    const { adapter, engine } = setup();
    const command = adapter.toggleReaction({
      key: KEY,
      messageId: '$message',
      reaction: ' 👍 ',
    });

    expect(engine.toggleReaction).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'applied',
      operation: 'reaction',
    });
    expect(engine.toggleReaction).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      MESSAGE,
      '👍',
      LIVE,
    );
  });

  it('refuses a blank reaction without reaching the engine', async () => {
    const { adapter, engine } = setup();

    await expect(
      firstValueFrom(
        adapter.toggleReaction({
          key: KEY,
          messageId: '$message',
          reaction: ' ',
        }),
      ),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'reaction',
      failure: 'invalid-reaction',
      retryable: false,
    });
    expect(engine.toggleReaction).not.toHaveBeenCalled();
  });

  it('delegates redaction governance before calling the engine', async () => {
    const policy: ConversationMessagePolicy = {
      canRedactOthers: () => false,
      canSendMessages: () => true,
      authorizeRedaction: vi.fn((): ConversationRedactionDecision => ({
        kind: 'rejected',
        failure: 'not-allowed',
      })),
    };
    const { adapter, engine } = setup({ policy });

    await expect(
      firstValueFrom(adapter.redact({ key: KEY, messageId: '$message' })),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'redaction',
      failure: 'not-allowed',
      retryable: false,
    });
    expect(engine.redact).not.toHaveBeenCalled();
  });

  it('redacts an echo by its transaction id', async () => {
    const { adapter, engine } = setup();

    await firstValueFrom(adapter.redact({ key: KEY, messageId: ECHO }));

    expect(engine.redact).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      { eventId: null, transactionId: 'txn-1' },
      LIVE,
    );
  });

  it('classifies engine failures without exposing error metadata', async () => {
    const outcome = async (result: EngineResult<null>) => {
      TestBed.resetTestingModule();
      const { adapter } = setup({ result });
      return firstValueFrom(
        adapter.toggleReaction({
          key: KEY,
          messageId: '$message',
          reaction: '👍',
        }),
      );
    };

    await expect(
      outcome(failure('request-failed', 'rate-limit')),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'reaction',
      failure: 'request-rejected',
      retryable: true,
    });
    await expect(
      outcome(failure('request-failed', 'authentication')),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'reaction',
      failure: 'request-rejected',
      retryable: false,
    });
    await expect(outcome(failure('account-not-live'))).resolves.toMatchObject({
      failure: 'conversation-unavailable',
      retryable: false,
    });
    await expect(
      outcome(failure('message-unavailable')),
    ).resolves.toMatchObject({
      failure: 'message-unavailable',
      retryable: false,
    });
  });

  it('retries only an echo, by its transaction id', async () => {
    const echo = setup();
    await expect(
      firstValueFrom(echo.adapter.retry({ key: KEY, messageId: ECHO })),
    ).resolves.toEqual({ kind: 'applied', operation: 'retry' });
    expect(echo.engine.retrySend).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      'txn-1',
    );

    TestBed.resetTestingModule();
    const sent = setup();
    await expect(
      firstValueFrom(sent.adapter.retry({ key: KEY, messageId: '$message' })),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'retry',
      failure: 'event-not-retryable',
      retryable: false,
    });
    expect(sent.engine.retrySend).not.toHaveBeenCalled();
  });

  it('cancels only an echo, and keeps the draft when the send may have left', async () => {
    const echo = setup();
    await expect(
      firstValueFrom(echo.adapter.cancel({ key: KEY, messageId: ECHO })),
    ).resolves.toEqual({ kind: 'applied', operation: 'cancel' });
    expect(echo.engine.cancelSend).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      'txn-1',
    );

    TestBed.resetTestingModule();
    const sent = setup();
    await expect(
      firstValueFrom(sent.adapter.cancel({ key: KEY, messageId: '$message' })),
    ).resolves.toMatchObject({
      kind: 'rejected',
      failure: 'event-not-retryable',
    });
    expect(sent.engine.cancelSend).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    const sending = setup({ result: failure('not-cancellable') });
    await expect(
      firstValueFrom(sending.adapter.cancel({ key: KEY, messageId: ECHO })),
    ).resolves.toMatchObject({
      kind: 'rejected',
      failure: 'event-not-retryable',
    });
    expect(sending.drafts.releaseWaiting).not.toHaveBeenCalled();
  });

  it('row cancel releases the held draft', async () => {
    const room = setup();
    await firstValueFrom(room.adapter.cancel({ key: KEY, messageId: ECHO }));
    expect(room.drafts.releaseWaiting).toHaveBeenCalledWith(
      conversationDraftKey(KEY),
      'txn-1',
    );

    TestBed.resetTestingModule();
    const thread = setup();
    await firstValueFrom(
      thread.adapter.cancel({
        key: KEY,
        messageId: ECHO,
        threadRootId: '$root',
      }),
    );
    expect(thread.engine.cancelSend).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      'txn-1',
    );
    expect(thread.drafts.releaseWaiting).toHaveBeenCalledWith(
      threadDraftKey('$root'),
      'txn-1',
    );
  });

  it('sends a privacy-aware receipt with the fully-read marker', async () => {
    const { adapter, engine } = setup({ privateReceipt: true });

    await expect(
      firstValueFrom(adapter.acknowledge({ key: KEY, messageId: '$message' })),
    ).resolves.toEqual({ kind: 'applied', operation: 'receipt' });
    expect(engine.sendReceipt).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      '$message',
      { threadRootId: null, visibility: 'private', fullyRead: true },
    );
  });

  it('acknowledge in a thread sends no fully-read marker', async () => {
    const { adapter, engine } = setup();

    await firstValueFrom(
      adapter.acknowledge({
        key: KEY,
        threadRootId: '$thread-root',
        messageId: '$message',
      }),
    );

    expect(engine.sendReceipt).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      '$message',
      { threadRootId: '$thread-root', visibility: 'public', fullyRead: false },
    );
  });

  it('refuses a receipt on a message the engine cannot acknowledge', async () => {
    const { adapter } = setup({ result: failure('message-unavailable') });

    await expect(
      firstValueFrom(adapter.acknowledge({ key: KEY, messageId: ECHO })),
    ).resolves.toEqual({
      kind: 'rejected',
      operation: 'receipt',
      failure: 'message-unavailable',
      retryable: false,
    });
  });

  it('passes the thread root to reactions and redactions', async () => {
    const { adapter, engine } = setup();
    const thread = { threadRootId: '$thread-root' };

    await firstValueFrom(
      adapter.toggleReaction({
        key: KEY,
        ...thread,
        messageId: '$message',
        reaction: '👍',
      }),
    );
    await firstValueFrom(
      adapter.redact({ key: KEY, ...thread, messageId: '$message' }),
    );

    expect(engine.toggleReaction).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      MESSAGE,
      '👍',
      thread,
    );
    expect(engine.redact).toHaveBeenCalledWith(
      KEY.accountId,
      KEY.roomId,
      MESSAGE,
      thread,
    );
  });
});
