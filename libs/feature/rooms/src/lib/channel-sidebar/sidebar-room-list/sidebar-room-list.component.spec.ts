import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTrnIcons } from '@trinity/components/foundations';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import {
  ROOM_LIST_STYLE,
  type RoomListStyle,
} from '@trinity/data-access/room-library';
import { RoomNotificationsService } from '@trinity/data-access/notifications';
import { ContentReportingService } from '@trinity/data-access/room-administration';
import type { RoomSummary } from '@trinity/data-access/room-library';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { SidebarRoomListComponent } from './sidebar-room-list.component';
import {
  InviteActionsService,
  type InviteAnswered,
} from '../../rooms/invite-actions.service';
import { Subject } from 'rxjs';
import { roomSummary } from '../../testing/room-summary.fixture';
import { setScrollGeometry } from '../../testing/scroll-geometry.stub';

async function renderRows(
  rooms: RoomSummary[],
  activeRoomId: string | null = null,
  notifyMode: 'all' | 'mute' | 'mentions' | 'mixed' = 'all',
  style: RoomListStyle = 'rich',
  extra: Record<string, unknown> = {},
  offers: (accountId: string, kind: string) => boolean = () => true,
  answers?: Subject<InviteAnswered>,
) {
  return render(SidebarRoomListComponent, {
    inputs: { rooms, activeRoomId, ...extra },
    providers: [
      provideTrnIcons(),
      { provide: ROOM_LIST_STYLE, useValue: signal(style) },
      MockProvider(RoomNotificationsService, {
        modeForAccounts: vi.fn(() => notifyMode),
      }),
      MockProvider(ContentReportingService, { offers }),
      ...(answers
        ? [MockProvider(InviteActionsService, { answered: answers })]
        : []),
      {
        provide: IdentityPresenceService,
        useValue: { presenceFor: () => signal('offline') },
      },
    ],
  });
}

describe('SidebarRoomListComponent rows', () => {
  it('re-reads the notification level of only the rows whose summary object changed', async () => {
    const a = roomSummary({ id: '!a:hs' });
    const b = roomSummary({ id: '!b:hs', name: 'other' });
    const { fixture } = await renderRows([a, b]);
    const modeFor = TestBed.inject(RoomNotificationsService)
      .modeForAccounts as ReturnType<typeof vi.fn>;
    modeFor.mockClear();

    fixture.componentRef.setInput('rooms', [a, { ...b, name: 'renamed' }]);
    fixture.detectChanges();

    expect(modeFor.mock.calls.map(([id]) => id)).toEqual(['!b:hs']);
  });

  it('marks the selected room', async () => {
    const { container } = await renderRows(
      [
        roomSummary({ id: '!a:hs' }),
        roomSummary({ id: '!b:hs', name: 'other' }),
      ],
      '!a:hs',
    );

    const rows = container.querySelectorAll('.channel');
    expect(rows[0].classList).toContain('channel--selected');
    expect(rows[1].classList).not.toContain('channel--selected');
  });

  it('marks plain unread with the marker and no badge', async () => {
    const { container } = await renderRows([
      roomSummary({ hasUnread: true, unreadCount: 5 }),
    ]);

    expect(container.querySelector('.channel--unread')).not.toBeNull();
    expect(container.querySelector('[trnBadge]')).toBeNull();
  });

  it('shows a danger badge with the mention count', async () => {
    const { container } = await renderRows([
      roomSummary({ hasUnread: true, unreadCount: 4, highlightCount: 2 }),
    ]);

    const badge = container.querySelector('[trnBadge]')!;
    expect(badge.textContent!.trim()).toBe('2');
    expect(badge.getAttribute('data-variant')).toBe('danger');
  });

  it('says "unread" to assistive tech for a plain unread row', async () => {
    const { container } = await renderRows([
      roomSummary({ hasUnread: true, unreadCount: 3 }),
    ]);

    expect(
      container.querySelector('.channel .sr-only')?.textContent?.trim(),
    ).toBe(', unread');
  });

  it('says the mention count inside the row button, not "unread"', async () => {
    const { container } = await renderRows([
      roomSummary({ hasUnread: true, unreadCount: 4, highlightCount: 2 }),
    ]);

    expect(
      container.querySelector('.channel .sr-only')?.textContent?.trim(),
    ).toBe(', 2 mentions');
  });

  it('adds no hidden unread text to a read row', async () => {
    const { container } = await renderRows([roomSummary()]);

    expect(container.querySelector('.channel .sr-only')).toBeNull();
  });

  it.each([
    ['mute', true],
    ['mentions', false],
    ['mixed', false],
    ['all', false],
  ] as const)('notify mode %s dims the row: %s', async (mode, dimmed) => {
    const { container } = await renderRows([roomSummary()], null, mode);

    expect(container.querySelector('.channel--muted') !== null).toBe(dimmed);
  });

  it('keeps the danger badge on a muted room', async () => {
    const { container } = await renderRows(
      [roomSummary({ hasUnread: true, highlightCount: 1 })],
      null,
      'mute',
    );

    expect(
      container.querySelector('[data-testid="room-muted"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[trnBadge]')!.getAttribute('data-variant'),
    ).toBe('danger');
  });

  it('draws a 36px avatar in rich rows', async () => {
    const { container } = await renderRows([roomSummary()]);

    expect(
      container.querySelector('trn-avatar')!.getAttribute('data-exact-size'),
    ).toBe('36');
  });

  it('draws a 20px avatar in compact rows', async () => {
    const { container } = await renderRows(
      [roomSummary()],
      null,
      'all',
      'compact',
    );

    expect(
      container.querySelector('trn-avatar')!.getAttribute('data-exact-size'),
    ).toBe('20');
  });

  it('keeps the presence dot and account badge at their floors in compact rows', async () => {
    const { container } = await renderRows(
      [roomSummary({ directUserId: '@bob:hs' })],
      null,
      'all',
      'compact',
      {
        accountBadges: new Map([
          ['@me:hs', { id: '@me:hs', initial: 'M', name: 'Me' }],
        ]),
      },
    );

    const dot = container.querySelector<HTMLElement>('.presence-dot')!;
    const badge = container.querySelector<HTMLElement>(
      '[data-testid="account-badge"]',
    )!;
    expect(dot.style.width).toBe('8px');
    expect(badge.style.width).toBe('14px');
  });

  it('dims a muted room but keeps its mention badge outside the dimmed parts', async () => {
    const { container } = await renderRows(
      [roomSummary({ hasUnread: true, highlightCount: 1 })],
      null,
      'mute',
    );

    expect(container.querySelector('.channel--muted')).not.toBeNull();
    const badge = container.querySelector('[trnBadge]')!;
    expect(badge.closest('.channel__avatar, .channel__text')).toBeNull();
    expect(
      /\.channel--muted \{ color: var\(--trinity-text-muted\)/.exec(scssText()),
    ).not.toBeNull();
  });

  it('keeps the dot for a room marked unread', async () => {
    const { container } = await renderRows([
      roomSummary({ hasUnread: true, markedUnread: true }),
    ]);

    expect(
      container.querySelector('[data-testid="room-unread-dot"]'),
    ).not.toBeNull();
    expect(container.querySelector('[trnBadge]')).toBeNull();
  });

  it('previews an invite from its row, separately from Accept and Decline', async () => {
    const invite = {
      roomId: '!inv:hs',
      accountId: '@me:hs',
      name: 'Book club',
      initial: 'B',
      avatarMxc: null,
      inviterId: '@ann:hs',
      inviterName: 'Ann',
      isSpace: false,
      isDirect: false,
    };
    const { fixture, container } = await renderRows([], null, 'all', 'rich', {
      invites: [invite],
    });
    const previewed = vi.fn();
    fixture.componentInstance.previewInvite.subscribe(previewed);

    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="invite-open"]',
    )!;
    // The name carries the visible "Room · from Ann" line (label in name).
    expect(open.getAttribute('aria-label')).toBe(
      'Preview invite to Book club, Room from Ann',
    );
    expect(open.querySelector('button')).toBeNull();
    // Accept, Decline and Decline and report stay their own tab stops, beside the preview.
    expect(open.closest('.invite')!.querySelectorAll('button')).toHaveLength(4);
    open.click();

    expect(previewed).toHaveBeenCalledWith(invite);
  });
});

describe('SidebarRoomListComponent invite reporting', () => {
  const invite = (roomId: string, name: string) => ({
    roomId,
    accountId: '@me:hs',
    name,
    initial: name[0],
    avatarMxc: null,
    inviterId: '@ann:hs',
    inviterName: 'Ann',
    isSpace: false,
    isDirect: false,
  });

  it('offers Decline and report, named for the room, beside Decline', async () => {
    const book = invite('!b:hs', 'Book club');
    const { fixture, container } = await renderRows([], null, 'all', 'rich', {
      invites: [book],
    });
    const reported = vi.fn();
    fixture.componentInstance.declineAndReport.subscribe(reported);

    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Decline and report Book club"]',
    )!;
    expect(button).not.toBeNull();
    button.click();

    expect(reported).toHaveBeenCalledWith(book);
  });

  it("hides Decline and report once the account's server takes no room reports", async () => {
    const offers = vi.fn(() => false);
    const { container } = await renderRows(
      [],
      null,
      'all',
      'rich',
      { invites: [invite('!b:hs', 'Book club')] },
      offers,
    );

    expect(
      container.querySelector('[aria-label="Decline and report Book club"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Decline invite to Book club"]'),
    ).not.toBeNull();
    expect(offers).toHaveBeenCalledWith('@me:hs', 'room');
  });

  it('waits for the report dialogs to finish before moving focus on', async () => {
    const book = invite('!b:hs', 'Book club');
    const chess = invite('!c:hs', 'Chess');
    const answers = new Subject<InviteAnswered>();
    const { fixture, container } = await renderRows(
      [],
      null,
      'all',
      'rich',
      { invites: [book, chess] },
      () => true,
      answers,
    );
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Decline and report Book club"]',
      )!
      .click();
    // The "Report sent" dialog holds focus while sync removes the row.
    const overlay = document.createElement('div');
    overlay.className = 'cdk-overlay-container';
    const dialogButton = document.createElement('button');
    overlay.append(dialogButton);
    document.body.append(overlay);
    dialogButton.focus();
    fixture.componentRef.setInput('invites', [chess]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(dialogButton);

    overlay.remove();
    answers.next({ roomId: '!b:hs', declined: true });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Preview invite to Chess, Room from Ann',
    );
  });

  it('forgets the row when the person keeps the invite', async () => {
    const book = invite('!b:hs', 'Book club');
    const chess = invite('!c:hs', 'Chess');
    const answers = new Subject<InviteAnswered>();
    const { fixture, container } = await renderRows(
      [],
      null,
      'all',
      'rich',
      { invites: [book, chess] },
      () => true,
      answers,
    );
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Decline and report Book club"]',
      )!
      .click();
    answers.next({ roomId: '!b:hs', declined: false });
    (document.activeElement as HTMLElement | null)?.blur();

    fixture.componentRef.setInput('invites', [chess]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to the next invite once a handled row disappears', async () => {
    const book = invite('!b:hs', 'Book club');
    const chess = invite('!c:hs', 'Chess');
    const { fixture, container } = await renderRows([], null, 'all', 'rich', {
      invites: [book, chess],
    });
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Decline and report Book club"]',
      )!
      .click();

    fixture.componentRef.setInput('invites', [chess]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Preview invite to Chess, Room from Ann',
    );
  });
});

function scssText(): string {
  return readFileSync(
    join(__dirname, 'sidebar-room-row', 'sidebar-room-row.component.scss'),
    'utf8',
  ).replace(/\s+/g, ' ');
}

describe('sidebar-room-row.component.scss', () => {
  // Whitespace-normalised: prettier wraps the long compound selector.
  const scss = scssText();

  // A long press on a room row would select its name and offer Copy / Look Up / Translate.
  it('keeps a long press on a room row from selecting its name', () => {
    const row = scss.match(/ \.channel \{ @include interactive-row; ([^}]*)\}/);
    expect(row?.[1]).toContain('user-select: none;');
    expect(row?.[1]).toContain('-webkit-touch-callout: none;');
  });

  it('hides the preview in compact rows and restores it in Spacious', () => {
    expect(scss).toContain(
      ":host-context(html[data-room-list='compact']) .channel__preview { display: none;",
    );
    expect(scss).toContain(
      ":host-context(html[data-room-list='compact'][data-density='spacious']) .channel__preview { display: block;",
    );
  });

  it('does not scale the avatar with CSS', () => {
    expect(scss).not.toContain('zoom');
  });
});

describe('SidebarRoomListComponent windowing (#1312)', () => {
  const many = (
    n: number,
    over: (i: number) => Partial<RoomSummary> = () => ({}),
  ) =>
    Array.from({ length: n }, (_, i) =>
      roomSummary({ id: `!r${i}:hs`, name: `room ${i}`, ...over(i) }),
    );
  /** A scroll element with a real-looking viewport; jsdom has no layout. */
  function scroller(height = 600): HTMLElement {
    const el = document.createElement('div');
    let top = 0;
    setScrollGeometry(el, {
      clientHeight: height,
      scrollTop: {
        get: () => top,
        set: (v: number) => (top = v),
      },
    });
    document.body.append(el);
    return el;
  }
  const rows = (container: Element) =>
    container.querySelectorAll('.channel-row');
  const names = (container: Element) =>
    [...container.querySelectorAll('.channel__name')].map((n) =>
      n.textContent?.trim(),
    );

  it('renders only the rooms near the viewport of a long list', async () => {
    const { container } = await renderRows(many(300), null, 'all', 'rich', {
      scroller: scroller(),
    });
    TestBed.tick();

    // 300 rows would be ~5,000 nodes kept in every room switch's style pass.
    expect(rows(container).length).toBeGreaterThan(0);
    expect(rows(container).length).toBeLessThan(100);
    expect(names(container)).toContain('room 0');
    expect(names(container)).not.toContain('room 299');
  });

  it('renders the end of the list once it is scrolled there', async () => {
    const el = scroller();
    const { container } = await renderRows(many(300), null, 'all', 'rich', {
      scroller: el,
    });
    TestBed.tick();

    el.scrollTop = 1_000_000;
    el.dispatchEvent(new Event('scroll'));
    TestBed.tick();

    expect(names(container)).toContain('room 299');
    expect(names(container)).not.toContain('room 0');
    expect(rows(container).length).toBeLessThan(100);
  });

  it('keeps the section labels with the rooms they head', async () => {
    const rooms = many(300, (i) => ({ favourite: i < 3 }));
    const { container } = await renderRows(rooms, null, 'all', 'rich', {
      scroller: scroller(),
    });
    TestBed.tick();

    expect(container.querySelector('.category')?.textContent).toContain(
      'Favourites',
    );
    expect(names(container).slice(0, 3)).toEqual([
      'room 0',
      'room 1',
      'room 2',
    ]);
    expect(rows(container).length).toBeLessThan(100);
  });

  it('renders every room when it has no scroll element to window against', async () => {
    const { container } = await renderRows(many(120));
    TestBed.tick();

    expect(rows(container).length).toBe(120);
  });
});

describe('SidebarRoomListComponent empty state', () => {
  it("says 'Loading rooms…' instead of 'No rooms here yet.' while loading", async () => {
    const { container, fixture } = await renderRows([], null, 'all', 'rich', {
      loading: true,
    });
    const empty = () =>
      container
        .querySelector('[data-testid=room-list-empty]')!
        .textContent!.trim();

    expect(empty()).toBe('Loading rooms…');

    fixture.componentRef.setInput('loading', false);
    fixture.detectChanges();
    expect(empty()).toBe('No rooms here yet.');
  });

  it('still says nothing matched a filter while loading', async () => {
    const { container } = await renderRows([], null, 'all', 'rich', {
      loading: true,
      filterActive: true,
    });

    expect(
      container.querySelector('[data-testid=room-list-empty]')!.textContent,
    ).toContain('No rooms match your filter.');
  });
});
