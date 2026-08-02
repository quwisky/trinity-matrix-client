import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TrnToastService } from '@trinity/helm/overlay';
import {
  RoomModerationService,
  type BannedMember,
} from '@trinity/data-access/rooms';
import { BannedMembersComponent } from './banned-members.component';

async function build(
  bans: BannedMember[],
  over: { unban?: ReturnType<typeof vi.fn> } = {},
) {
  const unban = over.unban ?? vi.fn(() => of(undefined));
  const bannedMembers = vi.fn(() => bans);
  const toastShow = vi.fn();
  const { fixture, container } = await render(BannedMembersComponent, {
    inputs: { roomId: '!r:hs' },
    providers: [
      MockProvider(RoomModerationService, { bannedMembers, unban }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    unban,
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
      { userId: '@bob:hs', name: 'Bob', reason: 'spam' },
    ]);
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('spam');
    expect(
      container.querySelectorAll('[data-testid=banned-member]'),
    ).toHaveLength(1);
  });

  it('unbans a member, drops them from the list, and toasts', async () => {
    const { cmp, fixture, container, unban, toastShow } = await build([
      { userId: '@bob:hs', name: 'Bob', reason: null },
    ]);

    cmp.unban({ userId: '@bob:hs', name: 'Bob', reason: null });
    fixture.detectChanges();

    expect(unban).toHaveBeenCalledWith('!r:hs', '@bob:hs');
    expect(cmp.banned()).toHaveLength(0);
    expect(
      container.querySelector('[data-testid=banned-members-empty]'),
    ).not.toBeNull();
    expect(toastShow).toHaveBeenCalledWith(
      'Unbanned Bob.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('keeps the member and toasts an error when the unban fails', async () => {
    const unban = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, toastShow } = await build(
      [{ userId: '@bob:hs', name: 'Bob', reason: null }],
      { unban },
    );

    cmp.unban({ userId: '@bob:hs', name: 'Bob', reason: null });

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
      [{ userId: '@bob:hs', name: 'Bob', reason: null }],
      { unban },
    );

    cmp.unban({ userId: '@bob:hs', name: 'Bob', reason: null });
    expect(cmp.isPending('@bob:hs')).toBe(true);
    cmp.unban({ userId: '@bob:hs', name: 'Bob', reason: null });

    expect(unban).toHaveBeenCalledTimes(1);
  });
});
