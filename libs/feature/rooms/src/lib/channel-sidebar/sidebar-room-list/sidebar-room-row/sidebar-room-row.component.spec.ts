import { signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import { RoomNotificationsService } from '@trinity/data-access/notifications';
import type { RoomSummary } from '@trinity/data-access/room-library';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import {
  SidebarRoomRowComponent,
  type SidebarRoomAction,
} from './sidebar-room-row.component';

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

async function renderRow(inputs: Record<string, unknown> = {}) {
  const modeForAccounts = vi.fn(() => 'all' as const);
  const actions: SidebarRoomAction[] = [];
  const result = await render(SidebarRoomRowComponent, {
    inputs: { room: room(), avatarSize: 36, ...inputs },
    on: { action: (a: SidebarRoomAction) => actions.push(a) },
    providers: [
      provideTrnIcons(),
      MockProvider(RoomNotificationsService, { modeForAccounts }),
      {
        provide: IdentityPresenceService,
        useValue: { presenceFor: () => signal('online') },
      },
    ],
  });
  return { ...result, modeForAccounts, actions };
}

describe('SidebarRoomRowComponent', () => {
  it('emits one select action carrying the room', async () => {
    const { container, actions } = await renderRow();

    container.querySelector<HTMLElement>('.channel')!.click();

    expect(actions).toEqual([{ kind: 'select', room: room() }]);
  });

  it('emits favourite from the kebab menu', async () => {
    const { container, fixture, actions } = await renderRow();

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="room-favourite"]')!
      .click();

    expect(actions).toEqual([{ kind: 'favourite', room: room() }]);
  });

  it('emits a notify action with the chosen level', async () => {
    const { container, fixture, actions } = await renderRow();

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLElement>('[data-testid="room-notify"]')!.click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="room-notify-mute"]')!
      .click();

    expect(actions).toEqual([{ kind: 'notify', room: room(), mode: 'mute' }]);
  });

  it('reads the notification level once, not on every change detection', async () => {
    const { fixture, modeForAccounts } = await renderRow();
    expect(modeForAccounts).toHaveBeenCalledTimes(1);

    // An input the level does not depend on changes: the row re-renders, the level is kept.
    fixture.componentRef.setInput('typing', ['Bob']);
    fixture.detectChanges();
    fixture.detectChanges();

    expect(modeForAccounts).toHaveBeenCalledTimes(1);
  });

  it.each([
    [99, '99'],
    [100, '99+'],
  ])('labels %i mentions as %s on the badge', async (highlightCount, label) => {
    const { container } = await renderRow({
      room: room({
        hasUnread: true,
        unreadCount: highlightCount,
        highlightCount,
      }),
    });

    expect(container.querySelector('[trnBadge]')!.textContent!.trim()).toBe(
      label,
    );
  });

  it('shows the typing notice in place of the preview', async () => {
    const { container, fixture } = await renderRow({
      room: room({ lastMessage: 'hello' }),
    });
    expect(container.querySelector('.channel__preview')!.textContent).toContain(
      'hello',
    );

    fixture.componentRef.setInput('typing', ['Bob']);
    fixture.detectChanges();

    expect(
      container.querySelector('.channel__preview--typing')!.textContent,
    ).toContain('Bob');
  });
});
