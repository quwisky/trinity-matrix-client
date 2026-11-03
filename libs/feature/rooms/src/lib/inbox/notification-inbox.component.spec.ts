import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  MentionInboxPreferences,
  MentionIndexService,
  NotificationInboxService,
  type InboxLoadResult,
  type InboxRow,
} from '@trinity/data-access/notifications';
import { fireEvent, render, screen, within } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, Subject, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationInboxComponent } from './notification-inbox.component';

const platform = vi.hoisted(() => ({ mobile: false }));

vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

afterEach(() => {
  platform.mobile = false;
});

const row = (eventId: string, extra: Partial<InboxRow> = {}): InboxRow => ({
  accountId: '@me:hs',
  eventId,
  roomId: '!r:hs',
  roomName: `Room ${eventId}`,
  senderName: 'Alice',
  ts: 1_700_000_000_000,
  preview: { kind: 'text', text: `Text ${eventId}` },
  unread: false,
  threadRootId: null,
  ...extra,
});

type Status = 'idle' | 'loading' | 'ready' | 'failed';

function fakeInbox() {
  return {
    all: signal<readonly InboxRow[]>([]),
    mentions: signal<readonly InboxRow[]>([]),
    uncheckedCount: signal(0),
    status: signal<Status>('ready'),
    serverListFailed: signal(false),
    serverHasMore: signal(false),
    hasMore: signal(false),
    lastLoad: signal<InboxLoadResult | null>(null),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn((): Observable<void> => of(undefined)),
    loadMore: vi.fn((): Observable<void> => of(undefined)),
  };
}
type FakeInbox = ReturnType<typeof fakeInbox>;

async function renderInbox(
  arrange: (inbox: FakeInbox) => void = () => undefined,
  inputs: { activeRoomId?: string | null; showSwitcher?: boolean } = {},
  recording = true,
) {
  const inbox = fakeInbox();
  arrange(inbox);
  const rendered = await render(NotificationInboxComponent, {
    inputs,
    providers: [
      provideTrnIcons(),
      { provide: NotificationInboxService, useValue: inbox },
      MockProvider(MentionIndexService, {
        recording: signal(recording).asReadonly(),
      }),
    ],
  });
  const settle = (): void => {
    TestBed.tick();
    rendered.fixture.detectChanges();
  };
  settle();
  return { ...rendered, inbox, settle };
}

const byId = (id: string): HTMLElement => screen.getByTestId(id);
const rowsShown = (): HTMLElement[] => screen.queryAllByTestId('inbox-row');
const text = (): string => document.body.textContent ?? '';

const SERVER_LINE = "Couldn't load your server's list. Try again.";
const ALL_NOTE = 'Your server may only keep these for a short time.';
const NOT_RECORDING_NOTE =
  'Older mentions and mentions in encrypted rooms may be missing.';

describe('NotificationInboxComponent', () => {
  describe('tabs', () => {
    it('opens on Mentions, and offers All', async () => {
      await renderInbox((inbox) => {
        inbox.mentions.set([row('$m')]);
        inbox.all.set([row('$m'), row('$a')]);
      });

      expect(byId('inbox-tab-mentions').getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(byId('inbox-tab-all').getAttribute('aria-selected')).toBe('false');
      expect(rowsShown()).toHaveLength(1);
    });

    it('shows every notification on All', async () => {
      const { settle } = await renderInbox((inbox) => {
        inbox.mentions.set([row('$m')]);
        inbox.all.set([row('$m'), row('$a')]);
      });

      byId('inbox-tab-all').click();
      settle();

      expect(rowsShown()).toHaveLength(2);
    });

    it('does not change the list while arrowing between tabs', async () => {
      const { settle } = await renderInbox((inbox) => {
        inbox.mentions.set([row('$m')]);
        inbox.all.set([row('$m'), row('$a')]);
      });

      fireEvent.keyDown(byId('inbox-tab-mentions'), { key: 'ArrowRight' });
      settle();

      expect(document.activeElement).toBe(byId('inbox-tab-all'));
      expect(rowsShown()).toHaveLength(1);
    });

    it('shares one scroller, which a tab change returns to the top', async () => {
      const { settle } = await renderInbox((inbox) => {
        inbox.all.set([row('$a')]);
      });
      const scroller = byId('inbox-scroll');
      scroller.scrollTop = 300;

      byId('inbox-tab-all').click();
      settle();

      expect(byId('inbox-scroll')).toBe(scroller);
      expect(scroller.scrollTop).toBe(0);
    });
  });

  describe('leaving and returning', () => {
    it('restores scroll when the list pane returns', async () => {
      const { fixture, settle } = await renderInbox();
      const scroller = byId('inbox-scroll');
      scroller.scrollTop = 400;
      fireEvent.scroll(scroller);

      fixture.componentRef.setInput('paneHidden', true);
      scroller.scrollTop = 0;
      settle();
      expect(scroller.scrollTop).toBe(0);

      fixture.componentRef.setInput('paneHidden', false);
      settle();

      expect(scroller.scrollTop).toBe(400);
    });

    it('takes no position from an engine resetting the hidden list', async () => {
      const { fixture, settle } = await renderInbox();
      const scroller = byId('inbox-scroll');
      scroller.scrollTop = 400;
      fireEvent.scroll(scroller);

      fixture.componentRef.setInput('paneHidden', true);
      settle();
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      fixture.componentRef.setInput('paneHidden', false);
      settle();

      expect(scroller.scrollTop).toBe(400);
    });

    it('returns to the top after a tab change, not to the old position', async () => {
      const { fixture, settle } = await renderInbox();
      const scroller = byId('inbox-scroll');
      scroller.scrollTop = 400;
      fireEvent.scroll(scroller);
      byId('inbox-tab-all').click();
      settle();

      fixture.componentRef.setInput('paneHidden', true);
      settle();
      fixture.componentRef.setInput('paneHidden', false);
      settle();

      expect(scroller.scrollTop).toBe(0);
    });

    it("keeps the open room's row current when a tap on another room opens nothing", async () => {
      const { settle } = await renderInbox(
        (inbox) => {
          inbox.mentions.set([
            row('$open', { roomId: '!open:hs' }),
            row('$left', { roomId: '!left:hs' }),
          ]);
        },
        { activeRoomId: '!open:hs' },
      );
      rowsShown()[0].click();
      settle();

      rowsShown()[1].click();
      settle();

      expect(
        rowsShown().map((shown) => shown.getAttribute('aria-current')),
      ).toEqual(['true', null]);
    });
  });

  describe('loading', () => {
    it('connects and refreshes on open, and disconnects on destroy', async () => {
      const { inbox, fixture } = await renderInbox((fake) => {
        fake.status.set('idle');
      });

      expect(inbox.connect).toHaveBeenCalledOnce();
      expect(inbox.refresh).toHaveBeenCalledOnce();
      expect(inbox.disconnect).not.toHaveBeenCalled();

      fixture.destroy();

      expect(inbox.disconnect).toHaveBeenCalledOnce();
    });

    it('stops listening to a load when it goes away', async () => {
      const load = new Subject<void>();
      const { fixture } = await renderInbox((fake) => {
        fake.status.set('idle');
        fake.refresh.mockReturnValue(load);
      });
      expect(load.observed).toBe(true);

      fixture.destroy();

      expect(load.observed).toBe(false);
    });

    it('does not load again while the load is running or done', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('idle');
      });

      for (const status of ['loading', 'ready'] as const) {
        inbox.status.set(status);
        settle();
      }

      expect(inbox.refresh).toHaveBeenCalledOnce();
    });

    it('fires once as a load moves through its statuses', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('idle');
        fake.refresh.mockImplementation(() => {
          fake.status.set('loading');
          return of(undefined);
        });
      });

      for (const status of ['ready', 'failed', 'loading', 'ready'] as const) {
        inbox.status.set(status);
        settle();
      }

      expect(inbox.refresh).toHaveBeenCalledOnce();
    });

    it('stays out of what a refresh reads, so nothing else re-fires it', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('idle');
        fake.refresh.mockImplementation(() => {
          fake.hasMore();
          return of(undefined);
        });
      });

      inbox.hasMore.set(true);
      settle();

      expect(inbox.status()).toBe('idle');
      expect(inbox.refresh).toHaveBeenCalledOnce();
    });

    it('does not retry a failure by itself, and does when asked', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('failed');
      });
      settle();
      expect(inbox.refresh).not.toHaveBeenCalled();

      screen.getByRole('button', { name: 'Try again' }).click();

      expect(inbox.refresh).toHaveBeenCalledOnce();
    });

    it('keeps focus in the panel when Try again removes itself', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('failed');
      });
      const tryAgain = screen.getByRole('button', { name: 'Try again' });
      tryAgain.focus();

      tryAgain.click();
      inbox.status.set('loading');
      settle();

      expect(tryAgain.isConnected).toBe(false);
      expect(document.activeElement).toBe(
        screen.getByRole('tabpanel', { name: 'Mentions' }),
      );
    });

    it('loads again when an account switch leaves it idle', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('idle');
      });
      inbox.status.set('ready');
      settle();

      inbox.status.set('idle');
      settle();

      expect(inbox.refresh).toHaveBeenCalledTimes(2);
    });

    it('refreshes from the header', async () => {
      const { inbox } = await renderInbox();

      const refresh = screen.getByRole('button', { name: 'Refresh' });
      expect(refresh.getAttribute('data-testid')).toBe('inbox-refresh');
      refresh.click();

      expect(inbox.refresh).toHaveBeenCalledOnce();
    });

    it('announces loading and failure in a region that stays', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('loading');
        fake.refresh.mockReturnValue(of(undefined));
      });
      const region = screen.getByRole('status');
      inbox.status.set('idle');
      settle();
      inbox.status.set('ready');
      settle();

      inbox.status.set('loading');
      settle();
      expect(screen.getByRole('status')).toBe(region);
      expect(region.textContent).toContain('Loading your inbox');

      inbox.status.set('failed');
      settle();
      expect(region.textContent).toContain("Couldn't load your inbox");
    });

    it.each<[string, (fake: FakeInbox) => void, string]>([
      ['one row', (fake) => fake.mentions.set([row('$m')]), '1 mention.'],
      [
        'more rows',
        (fake) => fake.mentions.set([row('$m'), row('$n')]),
        '2 mentions.',
      ],
      [
        'rows and more to load',
        (fake) => {
          fake.mentions.set([row('$m')]);
          fake.hasMore.set(true);
        },
        '1 mention so far.',
      ],
      ['nothing', () => undefined, 'No mentions.'],
      [
        'nothing yet and more to load',
        (fake) => fake.hasMore.set(true),
        'No mentions so far.',
      ],
    ])('announces a finished load with %s', async (_name, arrange, words) => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('loading');
        arrange(fake);
      });
      expect(screen.getByRole('status').textContent).toContain('Loading');

      inbox.status.set('ready');
      settle();

      expect(screen.getByRole('status').textContent?.trim()).toBe(words);
    });

    it('announces the unchecked messages, not "No mentions", when the screen does', async () => {
      await renderInbox((fake) => fake.uncheckedCount.set(2));

      expect(screen.getByRole('status').textContent?.trim()).toBe(
        "2 messages couldn't be checked because this device doesn't have their keys.",
      );
    });

    it.each<[string, (fake: FakeInbox) => void, string]>([
      [
        'there are rows',
        (fake) => {
          fake.uncheckedCount.set(2);
          fake.mentions.set([row('$m')]);
        },
        '1 mention.',
      ],
      [
        'Load more can still find some',
        (fake) => {
          fake.uncheckedCount.set(2);
          fake.hasMore.set(true);
        },
        'No mentions so far.',
      ],
    ])(
      'announces the count, not the unchecked messages, when %s',
      async (_name, arrange, words) => {
        await renderInbox(arrange);

        expect(screen.getByRole('status').textContent?.trim()).toBe(words);
      },
    );

    it('counts notifications on All', async () => {
      const { settle } = await renderInbox((fake) => {
        fake.all.set([row('$a'), row('$b')]);
      });

      byId('inbox-tab-all').click();
      settle();

      expect(screen.getByRole('status').textContent?.trim()).toBe(
        '2 notifications.',
      );
    });

    it('says nothing new as rows land or a row opens', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('loading');
      });
      const region = screen.getByRole('status');
      const changes = vi.fn();
      const observer = new MutationObserver(changes);
      observer.observe(region, {
        childList: true,
        characterData: true,
        subtree: true,
      });

      inbox.mentions.set([row('$m')]);
      settle();
      inbox.mentions.set([row('$m'), row('$n')]);
      settle();
      expect(observer.takeRecords()).toHaveLength(0);

      inbox.status.set('ready');
      settle();
      expect(observer.takeRecords()).not.toHaveLength(0);

      rowsShown()[0].click();
      inbox.uncheckedCount.set(1);
      settle();
      expect(observer.takeRecords()).toHaveLength(0);
      observer.disconnect();
    });

    it('shows a loading line when there is nothing else to show', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('loading');
      });
      expect(byId('inbox-loading')).toBeTruthy();

      inbox.mentions.set([row('$m')]);
      settle();
      expect(screen.queryByTestId('inbox-loading')).toBeNull();
    });
  });

  describe('header', () => {
    it('has no back button inside', async () => {
      await renderInbox();

      expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
      expect(screen.queryByTestId('back-to-rooms')).toBeNull();
    });

    it('is titled Inbox', async () => {
      await renderInbox();

      expect(text()).toContain('Inbox');
    });

    it('offers the switcher only when asked', async () => {
      const opened = vi.fn();
      const { fixture } = await renderInbox(undefined, { showSwitcher: true });
      fixture.componentInstance.openSwitcher.subscribe(opened);

      byId('open-switcher').click();

      expect(opened).toHaveBeenCalledOnce();
    });

    it('labels the switcher by its shortcut on desktop', async () => {
      await renderInbox(undefined, { showSwitcher: true });
      expect(byId('open-switcher').getAttribute('aria-label')).toBe(
        'Search (Ctrl/Cmd+K)',
      );
    });

    it('labels the switcher plainly on a phone, which has no shortcut', async () => {
      platform.mobile = true;
      await renderInbox(undefined, { showSwitcher: true });
      expect(byId('open-switcher').getAttribute('aria-label')).toBe('Search');
    });

    it('leaves the switcher out by default', async () => {
      await renderInbox();

      expect(screen.queryByTestId('open-switcher')).toBeNull();
    });
  });

  describe('notes', () => {
    it('notes on All: "Your server may only keep these for a short time."', async () => {
      const { settle } = await renderInbox();
      expect(text()).not.toContain(ALL_NOTE);

      byId('inbox-tab-all').click();
      settle();

      expect(text()).toContain(ALL_NOTE);
    });

    it('notes on Mentions when not recording: "Older mentions and mentions in encrypted rooms may be missing."', async () => {
      const { settle } = await renderInbox(undefined, {}, false);
      expect(text()).toContain(NOT_RECORDING_NOTE);

      byId('inbox-tab-all').click();
      settle();

      expect(text()).not.toContain(NOT_RECORDING_NOTE);
    });

    it('leaves the recording note out while recording', async () => {
      await renderInbox();

      expect(text()).not.toContain(NOT_RECORDING_NOTE);
    });

    it('says "2 messages couldn\'t be checked because this device doesn\'t have their keys."', async () => {
      await renderInbox((inbox) => inbox.uncheckedCount.set(2));

      expect(text()).toContain(
        "2 messages couldn't be checked because this device doesn't have their keys.",
      );
    });

    it('says it in the singular for one message', async () => {
      await renderInbox((inbox) => inbox.uncheckedCount.set(1));

      expect(text()).toContain(
        "1 message couldn't be checked because this device doesn't have its keys.",
      );
    });

    it('says nothing about unchecked messages at zero, or on All', async () => {
      const { inbox, settle } = await renderInbox();
      expect(text()).not.toContain("couldn't be checked");

      inbox.uncheckedCount.set(2);
      byId('inbox-tab-all').click();
      settle();

      expect(text()).not.toContain("couldn't be checked");
    });
  });

  describe('empty and failure states', () => {
    it('shows the empty line "No mentions. When someone mentions you, it shows up here."', async () => {
      await renderInbox();

      expect(text()).toContain(
        'No mentions. When someone mentions you, it shows up here.',
      );
    });

    it('does not say "No mentions" while Load more can still find some', async () => {
      await renderInbox((fake) => fake.hasMore.set(true));

      expect(screen.queryByTestId('inbox-empty')).toBeNull();
      expect(byId('inbox-load-more')).toBeTruthy();
    });

    it('does not say "No notifications." while Load more can still find some', async () => {
      const { settle } = await renderInbox((fake) => {
        fake.serverHasMore.set(true);
      });

      byId('inbox-tab-all').click();
      settle();

      expect(screen.queryByTestId('inbox-empty')).toBeNull();
    });

    it('does not say "No mentions" beside messages it could not check', async () => {
      await renderInbox((fake) => fake.uncheckedCount.set(2));

      expect(screen.queryByTestId('inbox-empty')).toBeNull();
      expect(text()).toContain("couldn't be checked");
    });

    it('shows "No notifications." when All is empty', async () => {
      const { settle } = await renderInbox();

      byId('inbox-tab-all').click();
      settle();

      expect(text()).toContain('No notifications.');
    });

    it('shows no empty line while idle or loading', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('loading');
      });
      expect(text()).not.toContain('No mentions.');

      inbox.status.set('idle');
      settle();

      expect(text()).not.toContain('No mentions.');
    });

    it('shows "Couldn\'t load your inbox" with Try again when nothing can show', async () => {
      const { inbox } = await renderInbox((fake) => {
        fake.status.set('failed');
      });

      expect(byId('inbox-failed').textContent).toContain(
        "Couldn't load your inbox",
      );
      expect(text()).not.toContain('No mentions.');
      expect(screen.queryByTestId('inbox-load-more')).toBeNull();

      screen.getByRole('button', { name: 'Try again' }).click();
      expect(inbox.refresh).toHaveBeenCalledOnce();
    });

    it('shows the server line above index rows when the list failed', async () => {
      const { inbox } = await renderInbox((fake) => {
        fake.serverListFailed.set(true);
        fake.mentions.set([row('$m')]);
      });

      const line = byId('inbox-server-failed');
      expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe(SERVER_LINE);
      expect(
        line.compareDocumentPosition(rowsShown()[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      screen.getByRole('button', { name: 'Try again.' }).click();
      expect(inbox.refresh).toHaveBeenCalledOnce();
    });

    it('does not call a failed All tab empty when Mentions has rows', async () => {
      const { settle } = await renderInbox((fake) => {
        fake.serverListFailed.set(true);
        fake.mentions.set([row('$m')]);
      });

      byId('inbox-tab-all').click();
      settle();

      expect(byId('inbox-server-failed')).toBeTruthy();
      expect(text()).not.toContain('No notifications.');
    });
  });

  describe('load more', () => {
    it('loads more for the tab showing', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.serverHasMore.set(true);
        fake.hasMore.set(true);
      });

      byId('inbox-load-more').click();
      expect(inbox.loadMore).toHaveBeenLastCalledWith('mentions');

      byId('inbox-tab-all').click();
      settle();
      byId('inbox-load-more').click();
      expect(inbox.loadMore).toHaveBeenLastCalledWith('all');
    });

    it('keeps Load more focusable while loading, and ignores presses until done', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
        fake.mentions.set([row('$m')]);
      });
      const more = byId('inbox-load-more');
      more.focus();

      inbox.status.set('loading');
      settle();

      expect(more.hasAttribute('disabled')).toBe(false);
      expect(more.getAttribute('aria-disabled')).toBe('true');
      expect(document.activeElement).toBe(more);
    });

    it('moves focus to the last row when the last page takes Load more away', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
        fake.mentions.set([row('$m1'), row('$m2')]);
      });
      const more = byId('inbox-load-more');
      more.focus();

      more.click();
      inbox.hasMore.set(false);
      settle();

      expect(more.isConnected).toBe(false);
      expect(document.activeElement).toBe(rowsShown()[1]);
    });

    it('moves focus to the panel when the last page leaves no rows', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
      });
      const more = byId('inbox-load-more');
      more.focus();

      more.click();
      inbox.hasMore.set(false);
      settle();

      expect(document.activeElement).toBe(
        screen.getByRole('tabpanel', { name: 'Mentions' }),
      );
    });

    it('follows hasMore on Mentions and serverHasMore on All', async () => {
      const { settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
        fake.serverHasMore.set(false);
      });
      expect(byId('inbox-load-more')).toBeTruthy();

      byId('inbox-tab-all').click();
      settle();

      expect(screen.queryByTestId('inbox-load-more')).toBeNull();
    });

    it('hides Load more at the end', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
      });
      expect(byId('inbox-load-more')).toBeTruthy();

      inbox.hasMore.set(false);
      inbox.lastLoad.set({ kind: 'end', tab: 'mentions' });
      settle();

      expect(screen.queryByTestId('inbox-load-more')).toBeNull();
    });

    it('is unavailable, yet focusable, while anything is loading', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
        fake.mentions.set([row('$m')]);
      });
      const button = byId('inbox-load-more');
      expect(button.getAttribute('aria-disabled')).toBeNull();

      inbox.status.set('loading');
      settle();
      expect(button.getAttribute('aria-disabled')).toBe('true');
      inbox.loadMore.mockClear();
      button.click();
      expect(inbox.loadMore).not.toHaveBeenCalled();
    });

    it('says "Checked 150 more notifications and found no more mentions." and keeps Load more', async () => {
      const { settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
        fake.serverHasMore.set(true);
        fake.lastLoad.set({ kind: 'limit', checked: 150, tab: 'mentions' });
      });
      const line = 'Checked 150 more notifications and found no more mentions.';

      expect(text()).toContain(line);
      expect(byId('inbox-load-more')).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain(line);

      byId('inbox-tab-all').click();
      settle();

      expect(text()).not.toContain(line);
    });

    it.each<[string, InboxLoadResult]>([
      ['nothing was checked', { kind: 'limit', checked: 0, tab: 'mentions' }],
      ['All asked', { kind: 'limit', checked: 50, tab: 'all' }],
      ['rows were found', { kind: 'found', tab: 'mentions' }],
      ['the end came', { kind: 'end', tab: 'mentions' }],
    ])('leaves the limit line out when %s', async (_name, result) => {
      await renderInbox((fake) => fake.lastLoad.set(result));

      expect(text()).not.toContain('Checked');
    });

    it('repeats the server line above Load more, retrying that page', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.serverListFailed.set(true);
        fake.serverHasMore.set(true);
        fake.all.set([row('$a')]);
      });

      byId('inbox-tab-all').click();
      settle();

      const line = byId('inbox-more-failed');
      expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe(SERVER_LINE);
      expect(
        rowsShown()[0].compareDocumentPosition(line) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        line.compareDocumentPosition(byId('inbox-load-more')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      within(line)
        .getByRole('button', { name: 'Try again loading more' })
        .click();

      expect(inbox.loadMore).toHaveBeenCalledExactlyOnceWith('all');
      expect(inbox.refresh).not.toHaveBeenCalled();
    });

    it.each<[string, (fake: FakeInbox) => void]>([
      [
        'the list has not failed',
        (fake) => {
          fake.serverHasMore.set(true);
          fake.hasMore.set(true);
          fake.mentions.set([row('$m')]);
        },
      ],
      [
        'there is nothing more to load',
        (fake) => {
          fake.serverListFailed.set(true);
          fake.mentions.set([row('$m')]);
        },
      ],
      [
        'there are no rows',
        (fake) => {
          fake.serverListFailed.set(true);
          fake.serverHasMore.set(true);
          fake.hasMore.set(true);
        },
      ],
      [
        'only the index has more, so Load more would not ask the server',
        (fake) => {
          fake.serverListFailed.set(true);
          fake.hasMore.set(true);
          fake.mentions.set([row('$m')]);
        },
      ],
    ])('does not repeat the server line when %s', async (_name, arrange) => {
      await renderInbox(arrange);

      expect(screen.queryByTestId('inbox-more-failed')).toBeNull();
    });

    it('keeps the top line and Load more when only the index has more', async () => {
      await renderInbox((fake) => {
        fake.serverListFailed.set(true);
        fake.hasMore.set(true);
        fake.mentions.set([row('$m')]);
      });

      expect(byId('inbox-server-failed')).toBeTruthy();
      expect(byId('inbox-load-more')).toBeTruthy();
    });

    it('keeps the visible words on the bottom retry', async () => {
      await renderInbox((fake) => {
        fake.serverListFailed.set(true);
        fake.serverHasMore.set(true);
        fake.hasMore.set(true);
        fake.mentions.set([row('$m')]);
      });

      const retry = within(byId('inbox-more-failed')).getByRole('button', {
        name: 'Try again loading more',
      });
      expect(retry.textContent?.trim()).toBe('Try again.');
      expect(
        within(byId('inbox-server-failed')).getByRole('button', {
          name: 'Try again.',
        }),
      ).toBeTruthy();
    });

    it('shows the server line when Load more failed, and keeps the rows', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
        fake.mentions.set([row('$m')]);
      });
      inbox.serverListFailed.set(true);
      settle();

      expect(byId('inbox-server-failed')).toBeTruthy();
      expect(rowsShown()).toHaveLength(1);
      expect(byId('inbox-load-more')).toBeTruthy();
    });
  });

  describe('rows', () => {
    it('shows "Encrypted message", "Preview unavailable" and "New message" for those previews', async () => {
      await renderInbox((inbox) => {
        inbox.mentions.set([
          row('$e', { preview: { kind: 'encrypted' } }),
          row('$u', { preview: { kind: 'unavailable' } }),
          row('$h', { preview: { kind: 'hidden' } }),
        ]);
      });

      expect(rowsShown().map((shown) => shown.textContent)).toEqual([
        expect.stringContaining('Encrypted message'),
        expect.stringContaining('Preview unavailable'),
        expect.stringContaining('New message'),
      ]);
    });

    it('renders a hostile body, sender and room as text', async () => {
      const hostile = '<img src=x onerror=alert(1)>';
      const { container } = await renderInbox((inbox) => {
        inbox.mentions.set([
          row('$m', {
            roomName: hostile,
            senderName: hostile,
            preview: { kind: 'text', text: hostile },
          }),
        ]);
      });

      expect(container.querySelector('img')).toBeNull();
      expect(rowsShown()[0].textContent).toContain(hostile);
    });

    it('shows the unread dot with a screen-reader word', async () => {
      await renderInbox((inbox) => {
        inbox.mentions.set([row('$u', { unread: true }), row('$r')]);
      });

      const [unread, read] = rowsShown();
      expect(unread.querySelector('[data-testid=inbox-row-dot]')).toBeTruthy();
      expect(unread.textContent).toContain('unread');
      expect(read.querySelector('[data-testid=inbox-row-dot]')).toBeNull();
    });

    it("clears a row's dot once it is opened", async () => {
      const opened = vi.fn();
      const unread = row('$u', { unread: true });
      const { fixture, inbox, settle } = await renderInbox((fake) => {
        fake.mentions.set([unread]);
      });
      fixture.componentInstance.openRow.subscribe(opened);

      rowsShown()[0].click();
      settle();

      expect(opened).toHaveBeenCalledWith(unread);
      expect(
        rowsShown()[0].querySelector('[data-testid=inbox-row-dot]'),
      ).toBeNull();

      inbox.mentions.set([{ ...unread }]);
      settle();

      expect(
        rowsShown()[0].querySelector('[data-testid=inbox-row-dot]'),
      ).toBeNull();
    });

    it('marks the last row opened while its room is the active one', async () => {
      const { fixture, settle } = await renderInbox(
        (inbox) => {
          inbox.mentions.set([
            row('$a', { roomId: '!a:hs' }),
            row('$b', { roomId: '!b:hs' }),
          ]);
        },
        { activeRoomId: '!b:hs' },
      );
      const current = (): (string | null)[] =>
        rowsShown().map((shown) => shown.getAttribute('aria-current'));
      expect(current()).toEqual([null, null]);

      rowsShown()[0].click();
      settle();
      expect(current()).toEqual([null, null]);

      fixture.componentRef.setInput('activeRoomId', '!a:hs');
      settle();
      expect(current()).toEqual(['true', null]);

      rowsShown()[1].click();
      fixture.componentRef.setInput('activeRoomId', '!b:hs');
      settle();
      expect(current()).toEqual([null, 'true']);
    });
  });
});

const PAGE = (
  roomId: string,
  eventId: string,
  nextToken: string | null = null,
) => ({
  notifications: [
    {
      room_id: roomId,
      read: false,
      ts: 1,
      event: {
        event_id: eventId,
        room_id: roomId,
        sender: '@alice:hs',
        type: 'm.room.message',
        origin_server_ts: 1,
        content: { body: 'hello' },
      },
    },
  ],
  next_token: nextToken,
});

interface FakeClient {
  readonly getUserId: () => string;
  readonly getCrypto: () => undefined;
  readonly getRoom: () => null;
  readonly getSyncState: () => null;
  readonly getSyncStateData: () => null;
  readonly http: { readonly authedRequest: ReturnType<typeof vi.fn> };
}

/** Without an event mapper a row reads as unreachable, naming its room by ID. */
const fakeClient = (
  userId: string,
  answer: () => Promise<unknown>,
): FakeClient => ({
  getUserId: () => userId,
  getCrypto: () => undefined,
  getRoom: () => null,
  getSyncState: () => null,
  getSyncStateData: () => null,
  http: { authedRequest: vi.fn(answer) },
});

describe('NotificationInboxComponent on the real service', () => {
  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve));

  async function renderReal(first: FakeClient | null) {
    const matrix: {
      isInitialized: boolean;
      instance: FakeClient | null;
      activeUserId: WritableSignal<string | null>;
      serverSynced: WritableSignal<boolean>;
      roomsPrepared: () => boolean;
    } = {
      isInitialized: first !== null,
      instance: first,
      activeUserId: signal(first?.getUserId() ?? null),
      serverSynced: signal(false),
      roomsPrepared: () => true,
    };
    const rendered = await render(NotificationInboxComponent, {
      providers: [
        provideTrnIcons(),
        { provide: MatrixClientService, useValue: matrix },
        MockProvider(MentionInboxPreferences, {
          recordAllowed: signal(false).asReadonly(),
        }),
        MockProvider(MentionIndexService, {
          recording: signal(false).asReadonly(),
        }),
      ],
    });
    const settle = async (): Promise<void> => {
      TestBed.tick();
      await flush();
      await flush();
      TestBed.tick();
      rendered.fixture.detectChanges();
    };
    await settle();
    const inbox = TestBed.inject(NotificationInboxService);
    return { ...rendered, matrix, inbox, settle };
  }

  it('reloads for the new account after a switch, dropping the old rows', async () => {
    const a = fakeClient('@a:hs', () => Promise.resolve(PAGE('!a:hs', '$a')));
    const b = fakeClient('@b:hs', () => Promise.resolve(PAGE('!b:hs', '$b')));
    const { matrix, settle } = await renderReal(a);
    byId('inbox-tab-all').click();
    await settle();
    expect(a.http.authedRequest).toHaveBeenCalledOnce();
    expect(rowsShown().map((shown) => shown.textContent)).toEqual([
      expect.stringContaining('!a:hs'),
    ]);

    matrix.instance = b;
    matrix.activeUserId.set('@b:hs');
    await settle();

    expect(a.http.authedRequest).toHaveBeenCalledOnce();
    expect(b.http.authedRequest).toHaveBeenCalledOnce();
    expect(rowsShown().map((shown) => shown.textContent)).toEqual([
      expect.stringContaining('!b:hs'),
    ]);
  });

  it('stays idle with no client, asking once', async () => {
    const refresh = vi.spyOn(NotificationInboxService.prototype, 'refresh');
    const { inbox, settle } = await renderReal(null);

    await settle();
    await settle();

    expect(inbox.status()).toBe('idle');
    expect(refresh).toHaveBeenCalledOnce();
    refresh.mockRestore();
  });

  it('asks once for a load that finishes', async () => {
    const refresh = vi.spyOn(NotificationInboxService.prototype, 'refresh');
    const a = fakeClient('@a:hs', () => Promise.resolve(PAGE('!a:hs', '$a')));
    const { inbox, settle } = await renderReal(a);

    await settle();

    expect(inbox.status()).toBe('ready');
    expect(refresh).toHaveBeenCalledOnce();
    refresh.mockRestore();
  });

  it('loads once more, unasked, when the first server sync can name its rows', async () => {
    const a = fakeClient('@a:hs', () => Promise.resolve(PAGE('!a:hs', '$a')));
    const { matrix, inbox, settle } = await renderReal(a);
    expect(a.http.authedRequest).toHaveBeenCalledOnce();

    matrix.serverSynced.set(true);
    await settle();
    await settle();

    expect(a.http.authedRequest).toHaveBeenCalledTimes(2);
    expect(inbox.status()).toBe('ready');
  });

  it('does not say "No mentions" when the first page held none but more remain', async () => {
    const a = fakeClient('@a:hs', () =>
      Promise.resolve(PAGE('!a:hs', '$a', 'next')),
    );
    const { inbox } = await renderReal(a);

    expect(inbox.status()).toBe('ready');
    expect(inbox.mentions()).toHaveLength(0);
    expect(inbox.hasMore()).toBe(true);
    expect(screen.queryByTestId('inbox-empty')).toBeNull();
    expect(byId('inbox-load-more')).toBeTruthy();
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      'No mentions so far.',
    );
  });

  it('keeps the loaded pages when Load more fails, and retries that page', async () => {
    const answers = [
      () => Promise.resolve(PAGE('!a:hs', '$a', 'second')),
      () => Promise.reject(new Error('down')),
      () => Promise.resolve(PAGE('!b:hs', '$b')),
    ];
    const a = fakeClient('@a:hs', () => answers.shift()!());
    const { inbox, settle } = await renderReal(a);
    byId('inbox-tab-all').click();
    await settle();

    byId('inbox-load-more').click();
    await settle();

    expect(inbox.status()).toBe('ready');
    expect(inbox.serverListFailed()).toBe(true);
    expect(rowsShown()).toHaveLength(1);
    expect(byId('inbox-server-failed')).toBeTruthy();

    within(byId('inbox-more-failed'))
      .getByRole('button', { name: 'Try again loading more' })
      .click();
    await settle();

    expect(a.http.authedRequest).toHaveBeenLastCalledWith(
      'GET',
      '/notifications',
      expect.objectContaining({ from: 'second' }),
    );
    expect(rowsShown()).toHaveLength(2);
    expect(screen.queryByTestId('inbox-more-failed')).toBeNull();
    expect(screen.queryByTestId('inbox-server-failed')).toBeNull();
  });

  it('shows the failure once, and retries only when asked', async () => {
    const down = fakeClient('@a:hs', () => Promise.reject(new Error('down')));
    const { inbox, settle } = await renderReal(down);

    await settle();
    await settle();

    expect(inbox.status()).toBe('failed');
    expect(down.http.authedRequest).toHaveBeenCalledOnce();

    screen.getByRole('button', { name: 'Try again' }).click();
    await settle();

    expect(down.http.authedRequest).toHaveBeenCalledTimes(2);
  });

  it('drops the rows when it goes away', async () => {
    const a = fakeClient('@a:hs', () => Promise.resolve(PAGE('!a:hs', '$a')));
    const { fixture, inbox } = await renderReal(a);
    expect(inbox.all()).toHaveLength(1);

    fixture.destroy();

    expect(inbox.all()).toHaveLength(0);
    expect(inbox.status()).toBe('idle');
  });
});
