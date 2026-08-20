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
  TimelineActionsService,
  TimelineService,
} from '@trinity/data-access/timeline';
import { TrnToastService } from '@trinity/components/overlay';
import { encodeRoomSegment } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, Subject, config, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ThreadPanelService } from '../thread/thread-panel.service';
import { PinnedPanelService } from '../pinned/pinned-panel.service';
import { MessageSearchService } from '../message-search/message-search.service';
import { AccountRoutingService } from './account-routing.service';
import { MemberActionsService } from './member-actions.service';
import { MessageActionsService } from './message-actions.service';
import { RoomShellStore } from './room-shell-store';
import { ShellStatusService } from './shell-status.service';

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
  const send = vi.fn(() => of(undefined));
  const reply = vi.fn(() => of(undefined));
  const redact = vi.fn(() => of(undefined));
  const toggleReaction = vi.fn(() => of(undefined));
  const votePoll = vi.fn(() => of(undefined));
  const endPoll = vi.fn(() => of(undefined));
  const loadOlder = vi.fn(() => of(undefined));
  const setTyping = vi.fn();
  const openThread = vi.fn(() => Promise.resolve());
  const toastShow = vi.fn();

  const MOCKS: Provider[] = [
    MockProvider(TimelineService, { loadOlder, setTyping }),
    MockProvider(TimelineActionsService, {
      send,
      reply,
      redact,
      toggleReaction,
      votePoll,
      endPoll,
    }),
    MockProvider(ThreadPanelService, { open: openThread }),
    MockProvider(PinnedMessagesService),
    MockProvider(PinnedPanelService),
    MockProvider(MessageSearchService),
    MockProvider(RoomsService),
    MockProvider(TrnToastService, { show: toastShow }),
    MockProvider(AccountRoutingService),
    MockProvider(MemberActionsService),
  ];

  function build(): {
    actions: MessageActionsService;
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
      // Takes the room id and encodes it here, so the tests below read in room ids
      // rather than in base64.
      openRoom: (roomId: string) =>
        paramMap.next(convertToParamMap({ roomId: encodeRoomSegment(roomId) })),
      destroy: () => fixture.destroy(),
    };
  }

  beforeEach(() => vi.clearAllMocks());

  describe('sending', () => {
    it('sends the body with its mentions', () => {
      const { actions } = build();

      actions.onSend({ body: 'hello', mentions: [] });

      expect(send).toHaveBeenCalledWith('hello', []);
    });

    it('does not toast when a send fails, because the local echo shows it', async () => {
      // `onSend` subscribes with no error callback on purpose: a failed send is surfaced
      // by the local echo's failed/retry state, not by a toast. RxJS therefore reports the
      // error as unhandled and rethrows it asynchronously, where the app's global
      // ErrorHandler takes it. Capturing it here is not cosmetic — left uncaptured it
      // fails the whole Vitest run as an unhandled error while every test still passes,
      // which is how this reached CI.
      const { actions } = build();
      const unhandled: unknown[] = [];
      const previous = config.onUnhandledError;
      config.onUnhandledError = (error) => unhandled.push(error);

      try {
        send.mockReturnValueOnce(throwError(() => new Error('offline')));
        actions.onSend({ body: 'x', mentions: [] });
        // RxJS reports an unhandled error on a macrotask, not inline, so the handler has
        // to stay installed across one tick or the report lands on the real one.
        await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        config.onUnhandledError = previous;
      }

      expect(toastShow).not.toHaveBeenCalled();
      expect(unhandled).toHaveLength(1);
    });

    it('replies against the event being answered', () => {
      const { actions } = build();

      actions.onReply({ id: '$root', body: 'sure', mentions: [] });

      expect(reply).toHaveBeenCalledWith('$root', 'sure', []);
    });

    it('forwards typing state straight through', () => {
      const { actions } = build();

      actions.onTyping(true);
      actions.onTyping(false);

      expect(setTyping).toHaveBeenNthCalledWith(1, true);
      expect(setTyping).toHaveBeenNthCalledWith(2, false);
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
    it('opens a thread against the room that is open', () => {
      const { actions, openRoom } = build();
      openRoom('!r:hs');

      actions.onOpenThread('$root');

      expect(openThread).toHaveBeenCalledWith('!r:hs', '$root');
    });

    it('does nothing when no room is open', () => {
      const { actions } = build();

      actions.onOpenThread('$root');

      expect(openThread).not.toHaveBeenCalled();
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
