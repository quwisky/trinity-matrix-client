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
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of, Subject, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NotificationInboxComponent } from './notification-inbox.component';

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

    it('does not loop with no client, where a refresh leaves it idle', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.status.set('idle');
      });

      settle();
      settle();

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
      const { inbox, settle } = await renderInbox();
      const region = screen.getByRole('status');
      expect(region.textContent?.trim()).toBe('');

      inbox.status.set('loading');
      settle();
      expect(screen.getByRole('status')).toBe(region);
      expect(region.textContent).toContain('Loading your inbox');

      inbox.status.set('failed');
      settle();
      expect(region.textContent).toContain("Couldn't load your inbox");
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

    it('is disabled while anything is loading', async () => {
      const { inbox, settle } = await renderInbox((fake) => {
        fake.hasMore.set(true);
        fake.mentions.set([row('$m')]);
      });
      const button = (): HTMLButtonElement =>
        byId('inbox-load-more') as HTMLButtonElement;
      expect(button().disabled).toBe(false);

      inbox.status.set('loading');
      settle();
      expect(button().disabled).toBe(true);
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

const PAGE = (roomId: string, eventId: string) => ({
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
  next_token: null,
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
    } = {
      isInitialized: first !== null,
      instance: first,
      activeUserId: signal(first?.getUserId() ?? null),
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

  it('stays idle with no client, without looping', async () => {
    const { inbox, settle } = await renderReal(null);
    const refresh = vi.spyOn(inbox, 'refresh');

    await settle();
    await settle();

    expect(inbox.status()).toBe('idle');
    expect(refresh).not.toHaveBeenCalled();
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
