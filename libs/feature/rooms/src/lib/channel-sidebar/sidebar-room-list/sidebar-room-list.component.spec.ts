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
import type { RoomSummary } from '@trinity/data-access/room-library';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { SidebarRoomListComponent } from './sidebar-room-list.component';

function room(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: '!a:hs',
    accountId: '@me:hs',
    accountIds: ['@me:hs'],
    name: 'general',
    initial: 'G',
    avatarMxc: null,
    topic: '',
    memberCount: 0,
    encrypted: false,
    unreadCount: 0,
    highlightCount: 0,
    hasUnread: false,
    markedUnread: false,
    lastMessage: '',
    activityTs: 0,
    favourite: false,
    lowPriority: false,
    ...over,
  };
}

async function renderRows(
  rooms: RoomSummary[],
  activeRoomId: string | null = null,
  notifyMode: 'all' | 'mute' | 'mentions' | 'mixed' = 'all',
  style: RoomListStyle = 'rich',
  extra: Record<string, unknown> = {},
) {
  return render(SidebarRoomListComponent, {
    inputs: { rooms, activeRoomId, ...extra },
    providers: [
      provideTrnIcons(),
      { provide: ROOM_LIST_STYLE, useValue: signal(style) },
      MockProvider(RoomNotificationsService, {
        modeForAccounts: vi.fn(() => notifyMode),
      }),
      {
        provide: IdentityPresenceService,
        useValue: { presenceFor: () => signal('offline') },
      },
    ],
  });
}

describe('SidebarRoomListComponent rows', () => {
  it('re-reads the notification level of only the rows whose summary object changed', async () => {
    const a = room({ id: '!a:hs' });
    const b = room({ id: '!b:hs', name: 'other' });
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
      [room({ id: '!a:hs' }), room({ id: '!b:hs', name: 'other' })],
      '!a:hs',
    );

    const rows = container.querySelectorAll('.channel');
    expect(rows[0].classList).toContain('channel--selected');
    expect(rows[1].classList).not.toContain('channel--selected');
  });

  it('marks plain unread with the marker and no badge', async () => {
    const { container } = await renderRows([
      room({ hasUnread: true, unreadCount: 5 }),
    ]);

    expect(container.querySelector('.channel--unread')).not.toBeNull();
    expect(container.querySelector('[trnBadge]')).toBeNull();
  });

  it('shows a danger badge with the mention count', async () => {
    const { container } = await renderRows([
      room({ hasUnread: true, unreadCount: 4, highlightCount: 2 }),
    ]);

    const badge = container.querySelector('[trnBadge]')!;
    expect(badge.textContent!.trim()).toBe('2');
    expect(badge.getAttribute('data-variant')).toBe('danger');
  });

  it('says "unread" to assistive tech for a plain unread row', async () => {
    const { container } = await renderRows([
      room({ hasUnread: true, unreadCount: 3 }),
    ]);

    expect(
      container.querySelector('.channel .sr-only')?.textContent?.trim(),
    ).toBe(', unread');
  });

  it('says the mention count inside the row button, not "unread"', async () => {
    const { container } = await renderRows([
      room({ hasUnread: true, unreadCount: 4, highlightCount: 2 }),
    ]);

    expect(
      container.querySelector('.channel .sr-only')?.textContent?.trim(),
    ).toBe(', 2 mentions');
  });

  it('adds no hidden unread text to a read row', async () => {
    const { container } = await renderRows([room()]);

    expect(container.querySelector('.channel .sr-only')).toBeNull();
  });

  it.each([
    ['mute', true],
    ['mentions', false],
    ['mixed', false],
    ['all', false],
  ] as const)('notify mode %s dims the row: %s', async (mode, dimmed) => {
    const { container } = await renderRows([room()], null, mode);

    expect(container.querySelector('.channel--muted') !== null).toBe(dimmed);
  });

  it('keeps the danger badge on a muted room', async () => {
    const { container } = await renderRows(
      [room({ hasUnread: true, highlightCount: 1 })],
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
    const { container } = await renderRows([room()]);

    expect(
      container.querySelector('trn-avatar')!.getAttribute('data-exact-size'),
    ).toBe('36');
  });

  it('draws a 20px avatar in compact rows', async () => {
    const { container } = await renderRows([room()], null, 'all', 'compact');

    expect(
      container.querySelector('trn-avatar')!.getAttribute('data-exact-size'),
    ).toBe('20');
  });

  it('keeps the presence dot and account badge at their floors in compact rows', async () => {
    const { container } = await renderRows(
      [room({ directUserId: '@bob:hs' })],
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
      [room({ hasUnread: true, highlightCount: 1 })],
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
      room({ hasUnread: true, markedUnread: true }),
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
    expect(open.getAttribute('aria-label')).toBe('Preview invite to Book club');
    expect(open.querySelector('button')).toBeNull();
    // Accept and Decline stay their own tab stops, siblings of the preview button.
    expect(open.closest('.invite')!.querySelectorAll('button')).toHaveLength(3);
    open.click();

    expect(previewed).toHaveBeenCalledWith(invite);
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
