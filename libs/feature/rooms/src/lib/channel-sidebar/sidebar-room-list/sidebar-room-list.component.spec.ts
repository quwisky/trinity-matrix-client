import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import { IdentityPresenceService } from '@trinity/data-access/identity';
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
  notifyMode: 'all' | 'mute' = 'all',
) {
  return render(SidebarRoomListComponent, {
    inputs: { rooms, activeRoomId },
    providers: [
      provideTrnIcons(),
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

  it('keeps the dot for a room marked unread', async () => {
    const { container } = await renderRows([
      room({ hasUnread: true, markedUnread: true }),
    ]);

    expect(
      container.querySelector('[data-testid="room-unread-dot"]'),
    ).not.toBeNull();
    expect(container.querySelector('[trnBadge]')).toBeNull();
  });
});

describe('sidebar-room-list.component.scss', () => {
  // Whitespace-normalised: prettier wraps the long compound selector.
  const scss = readFileSync(
    join(__dirname, 'sidebar-room-list.component.scss'),
    'utf8',
  ).replace(/\s+/g, ' ');

  it('hides the preview in compact rows and restores it in Spacious', () => {
    expect(scss).toContain(
      ":host-context(html[data-room-list='compact']) .channel__preview { display: none;",
    );
    expect(scss).toContain(
      ":host-context(html[data-room-list='compact'][data-density='spacious']) .channel__preview { display: block;",
    );
  });

  it('shrinks the avatar in compact rows', () => {
    expect(scss).toMatch(
      /:host-context\(html\[data-room-list='compact'\]\) \.channel__avatar/,
    );
  });
});
