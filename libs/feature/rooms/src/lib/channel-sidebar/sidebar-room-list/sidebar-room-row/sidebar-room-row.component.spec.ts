import { signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import { IdentityPresenceService } from '@trinity/data-access/identity';
import { RoomNotificationsService } from '@trinity/data-access/notifications';
import { ContentReportingService } from '@trinity/data-access/room-administration';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import {
  SidebarRoomRowComponent,
  type SidebarRoomAction,
} from './sidebar-room-row.component';
import { roomSummary as room } from '../../../testing/room-summary.fixture';

async function renderRow(
  inputs: Record<string, unknown> = {},
  offers: (accountId: string, kind: string) => boolean = () => true,
) {
  const modeForAccounts = vi.fn(() => 'all' as const);
  const actions: SidebarRoomAction[] = [];
  const result = await render(SidebarRoomRowComponent, {
    inputs: { room: room(), avatarSize: 36, ...inputs },
    on: { action: (a: SidebarRoomAction) => actions.push(a) },
    providers: [
      provideTrnIcons(),
      MockProvider(RoomNotificationsService, { modeForAccounts }),
      MockProvider(ContentReportingService, { offers }),
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

  it('offers Report room beside Leave room', async () => {
    const { container, fixture, actions } = await renderRow();

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();
    const report = document.querySelector<HTMLElement>(
      '[data-testid="room-report"]',
    )!;
    expect(report.textContent?.trim()).toBe('Report room');
    expect(report.nextElementSibling?.getAttribute('data-testid')).toBe(
      'room-leave',
    );
    report.click();

    expect(actions).toEqual([{ kind: 'report', room: room() }]);
  });

  it("leaves out Report room once the row's account has no room reports", async () => {
    const offers = vi.fn(() => false);
    const { container, fixture } = await renderRow({}, offers);

    container.querySelector<HTMLElement>('.channel__menu')!.click();
    fixture.detectChanges();

    expect(document.querySelector('[data-testid="room-report"]')).toBeNull();
    expect(offers).toHaveBeenCalledWith('@me:hs', 'room');
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

  it('marks a preview that arrived unencrypted with the shared not-encrypted mark', async () => {
    const { container, fixture } = await renderRow({
      room: room({ lastMessage: 'hello', lastMessageMark: 'unencrypted' }),
    });
    const preview = container.querySelector('.channel__preview')!;
    expect(
      preview.querySelector('[data-testid="unencrypted-mark-unencrypted"]'),
    ).not.toBeNull();
    expect(preview.textContent).toContain('hello');

    fixture.componentRef.setInput(
      'room',
      room({ lastMessage: 'old news', lastMessageMark: 'unencrypted-history' }),
    );
    fixture.detectChanges();
    expect(
      preview.querySelector(
        '[data-testid="unencrypted-mark-unencrypted-history"]',
      ),
    ).not.toBeNull();

    fixture.componentRef.setInput(
      'room',
      room({ lastMessage: 'hello', lastMessageMark: null }),
    );
    fixture.detectChanges();
    expect(
      container.querySelector('.channel__preview trn-unencrypted-mark'),
    ).toBeNull();
  });

  it("names the row's button with the mark's label only when the preview is marked", async () => {
    const { getByRole, fixture } = await renderRow({
      room: room({ lastMessage: 'hello', lastMessageMark: 'unencrypted' }),
    });
    const select = () => getByRole('button', { name: /general.*hello/ });
    expect(select()).toHaveAccessibleName(/Not encrypted.*hello/);

    fixture.componentRef.setInput(
      'room',
      room({ lastMessage: 'hello', lastMessageMark: null }),
    );
    fixture.detectChanges();
    expect(select()).not.toHaveAccessibleName(/Not encrypted/);
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
