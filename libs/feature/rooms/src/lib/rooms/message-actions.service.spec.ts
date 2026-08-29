import { TestBed } from '@angular/core/testing';
import { Component, inject, type Provider } from '@angular/core';
import {
  ActivatedRoute,
  convertToParamMap,
  type ParamMap,
} from '@angular/router';
import { PinnedMessagesService } from '@trinity/data-access/pinned';
import { RoomsService } from '@trinity/data-access/rooms';
import {
  ConversationRuntime,
  TimelineActionsService,
  type ConversationTextSendOutcome,
} from '@trinity/data-access/timeline';
import { TrnToastService } from '@trinity/components/overlay';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, Observable, Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { AccountRoutingService } from './account-routing.service';
import { MemberActionsService } from './member-actions.service';
import { MessageActionsService } from './message-actions.service';
import { RoomShellStore } from './room-shell-store';
import { ShellStatusService } from './shell-status.service';
import { ConversationTimelineStub } from '../testing/conversation-timeline.stub';

/**
 * The composer and timeline half of MessageActionsService.
 *
 * These nine methods were the largest coverage hole left by the #62 decomposition: the
 * page spec drives editing, pinning and search, but never sending, replying, reacting,
 * deleting, voting, typing or paginating. They are also the methods where a silent
 * regression is most expensive, since the timeline's local echo is what a user sees
 * instead of an error.
 *
 * The service is page-scoped, so it is instantiated through a host component rather than
 * `TestBed.inject` — the same reason `shell-invariants.spec.ts` renders.
 */
@Component({
  template: '',
  providers: [RoomShellStore, ShellStatusService, MessageActionsService],
})
class HostComponent {
  // Read off the component, not TestBed.inject: a component `providers:` entry lives in
  // the element injector and the TestBed module injector cannot see it.
  readonly actions = inject(MessageActionsService);
}

describe('MessageActionsService', () => {
  const redact = vi.fn(() => of(undefined));
  const toggleReaction = vi.fn(() => of(undefined));
  const votePoll = vi.fn(() => of(undefined));
  const endPoll = vi.fn(() => of(undefined));
  const sendSticker = vi.fn(() => of(undefined));
  const loadOlder = vi.fn(() => of(undefined));
  const setTyping = vi.fn();
  const setDraft = vi.fn();
  const submitText = vi.fn<() => Observable<ConversationTextSendOutcome>>(() =>
    of({ kind: 'sent', eventId: '$sent' }),
  );
  const toastShow = vi.fn();
  let roomEncrypted = false;

  const MOCKS: Provider[] = [
    {
      provide: ConversationTimelineStub,
      useValue: {
        loadOlder,
        setTyping,
        openRoomId: null,
        get roomEncrypted() {
          return roomEncrypted;
        },
      },
    },
    {
      provide: ConversationRuntime,
      useFactory: () => ({
        timeline: inject(ConversationTimelineStub),
        compose: { setDraft, submit: submitText, setTyping },
      }),
    },
    MockProvider(TimelineActionsService, {
      redact,
      toggleReaction,
      votePoll,
      endPoll,
      sendSticker,
    }),
    MockProvider(PinnedMessagesService),
    MockProvider(RoomsService),
    MockProvider(TrnToastService, { show: toastShow }),
    MockProvider(AccountRoutingService),
    MockProvider(MemberActionsService),
  ];

  function build(): {
    actions: MessageActionsService;
    store: RoomShellStore;
    openRoom: (roomId: string) => void;
    destroy: () => void;
  } {
    // The open room is the URL: `RoomShellStore.activeRoomId` derives from
    // `/rooms/:roomId` and nothing writes it, so a room is opened here by pushing the
    // segment the router would. A BehaviorSubject because the store reads this through
    // `toSignal` in a field initializer — a stream that did not replay would leave every
    // store built in this file stuck at `null`. One per `build()`, so a room opened in one
    // test cannot leak into the next one's empty route.
    const paramMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    TestBed.configureTestingModule({
      providers: [
        ...MOCKS,
        {
          provide: ActivatedRoute,
          useValue: { paramMap } as unknown as ActivatedRoute,
        },
      ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return {
      actions: fixture.componentInstance.actions,
      // From the HOST's injector: the store is in `HostComponent.providers`, page-scoped
      // exactly as it is in production, so the module injector does not have it.
      store: fixture.debugElement.injector.get(RoomShellStore),
      // Takes the room id and encodes it here, so the tests below read in room ids
      // rather than in base64.
      openRoom: (roomId: string) =>
        paramMap.next(convertToParamMap({ roomId: encodeRoomSegment(roomId) })),
      destroy: () => fixture.destroy(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    roomEncrypted = false;
  });

  describe('sending', () => {
    it('sends the body with its mentions', () => {
      const { actions } = build();

      actions.onSend({ body: 'hello', mentions: [] });

      expect(setDraft).toHaveBeenCalledWith('hello');
      expect(submitText).toHaveBeenCalledWith([]);
    });

    it('does not toast for a typed send rejection because the local echo owns retry UI', () => {
      const { actions } = build();
      submitText.mockReturnValueOnce(
        of({ kind: 'rejected', failure: 'send-rejected', retryable: true }),
      );
      actions.onSend({ body: 'x', mentions: [] });

      expect(toastShow).not.toHaveBeenCalled();
    });

    it('warns that sticker media stays public in an encrypted room', () => {
      roomEncrypted = true;
      const { actions } = build();
      const sticker = {
        shortcode: 'party',
        url: 'mxc://hs/party',
        body: 'Party',
        mimetype: 'image/png',
        width: 32,
        height: 32,
        info: { mimetype: 'image/png', w: 32, h: 32 },
        usage: ['sticker'] as const,
        packId: '!pack:hs:fun',
        packName: 'Fun',
      };

      actions.onSendSticker(sticker);

      expect(toastShow).toHaveBeenCalledWith(
        'Sticker images are public homeserver media, even in encrypted rooms.',
        { duration: 6000 },
      );
      expect(sendSticker).toHaveBeenCalledWith(sticker);
    });
  });

  describe('per-message actions report their own failure', () => {
    // Each of these routes through runAction, whose only job is to turn a failed
    // Observable into one specific danger toast. A shared helper is exactly where a
    // wrong message survives review, so the text is asserted per action.
    const cases: {
      name: string;
      run: (a: MessageActionsService) => void;
      stub: Mock;
      message: string;
    }[] = [
      {
        name: 'delete',
        run: (a) => a.onDelete('$1'),
        stub: redact,
        message: 'Could not delete the message.',
      },
      {
        name: 'react',
        run: (a) => a.onReact({ id: '$1', key: '👍' }),
        stub: toggleReaction,
        message: 'Could not update the reaction.',
      },
      {
        name: 'poll vote',
        run: (a) => a.onPollVote({ pollId: '$p', answerId: 'a' }),
        stub: votePoll,
        message: 'Could not cast your vote.',
      },
      {
        name: 'poll end',
        run: (a) => a.onPollEnd('$p'),
        stub: endPoll,
        message: 'Could not end the poll.',
      },
    ];

    for (const { name, run, stub, message } of cases) {
      it(`toasts when ${name} fails`, () => {
        const { actions } = build();
        stub.mockReturnValueOnce(throwError(() => new Error('nope')));

        run(actions);

        expect(toastShow).toHaveBeenCalledWith(
          message,
          expect.objectContaining({ variant: 'destructive' }),
        );
      });

      it(`stays quiet when ${name} succeeds`, () => {
        const { actions } = build();

        run(actions);

        expect(toastShow).not.toHaveBeenCalled();
      });
    }
  });

  describe('threads and pagination', () => {
    it('shows the thread in the shell\u2019s right-hand slot', () => {
      // The thread is no longer a dialog opened for a room id — it is what the one slot is
      // showing, and the panel takes its room from the same open room the timeline renders.
      // So the room is not an argument to assert any more; what is assertable is that the
      // slot holds this thread, and (below) that nothing opens without a room at all.
      const { actions, store, openRoom } = build();
      openRoom('!r:hs');

      actions.onOpenThread('$root');

      expect(store.rightPanel()).toEqual({
        kind: 'thread',
        rootEventId: '$root',
      });
    });

    it('does nothing when no room is open', () => {
      const { actions, store } = build();
      const before = store.rightPanel();

      actions.onOpenThread('$root');

      // Reference identity, so this fails for ANY write to the slot, not just a thread.
      expect(store.rightPanel()).toBe(before);
    });

    it('paginates older history', () => {
      const { actions } = build();

      actions.loadOlder();

      expect(loadOlder).toHaveBeenCalled();
    });
  });

  it('drops an in-flight action when the page is destroyed', () => {
    // Every method here pipes through takeUntilDestroyed(destroyRef), which is only
    // correct because the service is page-provided — a root-provided one would keep the
    // subscription alive past teardown and toast into a dead page. Emitting the failure
    // AFTER destroy is what tells the two apart.
    const { actions, destroy } = build();
    const pending = new Subject<void>();
    redact.mockReturnValueOnce(pending.asObservable() as never);

    actions.onDelete('$1');
    destroy();
    pending.error(new Error('too late'));

    expect(toastShow).not.toHaveBeenCalled();
  });
});
