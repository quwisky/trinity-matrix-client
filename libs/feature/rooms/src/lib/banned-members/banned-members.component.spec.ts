import {
  RoomActionPermissionsService,
  RoomMembersService,
  RoomModerationService,
  type BannedMember,
} from '@trinity/data-access/room-administration';
import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { TrnToastService } from '@trinity/components/overlay';
import { BannedMembersComponent } from './banned-members.component';

async function build(
  bans: BannedMember[],
  over: { unban?: Mock; canUnban?: boolean } = {},
) {
  const unban = over.unban ?? vi.fn(() => of(undefined));
  const banned = signal<readonly BannedMember[]>(bans);
  const toastShow = vi.fn();
  const { fixture, container } = await render(BannedMembersComponent, {
    inputs: { roomId: '!r:hs' },
    providers: [
      MockProvider(RoomModerationService, { unban }),
      MockProvider(RoomMembersService, {
        bannedFor: () => banned.asReadonly(),
      }),
      MockProvider(RoomActionPermissionsService, {
        unban: () => ({
          available: over.canUnban ?? true,
          reason:
            over.canUnban === false
              ? 'You need permission to unban this member.'
              : null,
        }),
      }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    unban,
    banned,
    toastShow,
  };
}

describe('BannedMembersComponent', () => {
  it('shows the empty state when no one is banned', async () => {
    const { container } = await build([]);
    expect(
      container.querySelector('[data-testid=banned-members-empty]'),
    ).not.toBeNull();
  });

  it('lists each banned member with their reason', async () => {
    const { container } = await build([
      { userId: '@bob:hs', roomDisplayName: 'Bob', reason: 'spam' },
    ]);
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('spam');
    expect(
      container.querySelectorAll('[data-testid=banned-member]'),
    ).toHaveLength(1);
  });

  it('waits for the authoritative sync echo after unban succeeds', async () => {
    const { cmp, fixture, container, unban, banned, toastShow } = await build([
      { userId: '@bob:hs', roomDisplayName: 'Bob', reason: null },
    ]);

    cmp.unban({ userId: '@bob:hs', roomDisplayName: 'Bob', reason: null });
    fixture.detectChanges();

    expect(unban).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    expect(cmp.banned()).toHaveLength(1);
    expect(cmp.isPending('@bob:hs')).toBe(true);
    expect(
      container.querySelector('[data-testid=banned-members-empty]'),
    ).toBeNull();
    expect(toastShow).toHaveBeenCalledWith(
      'Unbanned Bob.',
      expect.objectContaining({ variant: 'success' }),
    );

    banned.set([]);
    fixture.detectChanges();

    expect(cmp.banned()).toHaveLength(0);
    expect(cmp.isPending('@bob:hs')).toBe(false);
    expect(
      container.querySelector('[data-testid=banned-members-empty]'),
    ).not.toBeNull();
  });

  it('reconciles remote ban changes while the panel is open', async () => {
    const { cmp, fixture, banned } = await build([]);

    banned.set([{ userId: '@bob:hs', roomDisplayName: 'Bob', reason: 'spam' }]);
    fixture.detectChanges();

    expect(cmp.banned()).toEqual([
      { userId: '@bob:hs', roomDisplayName: 'Bob', reason: 'spam' },
    ]);
  });

  it('keeps the member and toasts an error when the unban fails', async () => {
    const unban = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, toastShow } = await build(
      [{ userId: '@bob:hs', roomDisplayName: 'Bob', reason: null }],
      { unban },
    );

    cmp.unban({ userId: '@bob:hs', roomDisplayName: 'Bob', reason: null });

    expect(cmp.banned()).toHaveLength(1); // not removed on failure
    expect(cmp.isPending('@bob:hs')).toBe(false); // cleared
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not unban'),
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('ignores a second unban click while one is already in flight', async () => {
    // A never-completing unban keeps the row pending; a re-click must not re-call.
    const unban = vi.fn(() => NEVER);
    const { cmp } = await build(
      [{ userId: '@bob:hs', roomDisplayName: 'Bob', reason: null }],
      { unban },
    );

    cmp.unban({ userId: '@bob:hs', roomDisplayName: 'Bob', reason: null });
    expect(cmp.isPending('@bob:hs')).toBe(true);
    cmp.unban({ userId: '@bob:hs', roomDisplayName: 'Bob', reason: null });

    expect(unban).toHaveBeenCalledTimes(1);
  });

  it('keeps an unavailable unban action focusable and blocks activation', async () => {
    const { container, unban } = await build(
      [{ userId: '@bob:hs', roomDisplayName: 'Bob', reason: null }],
      { canUnban: false },
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="banned-member-unban"]',
    )!;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-description')).toBe(
      'You need permission to unban this member.',
    );
    button.click();

    expect(unban).not.toHaveBeenCalled();
  });
});
