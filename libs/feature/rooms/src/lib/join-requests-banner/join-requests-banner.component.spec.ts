import { signal } from '@angular/core';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import {
  RoomActionPermissionsService,
  RoomMembersService,
  type KnockRequest,
} from '@trinity/data-access/room-administration';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinRequestsBannerComponent } from './join-requests-banner.component';

const KEY = { accountId: '@me:hs', roomId: '!r:hs' };

const request = (name: string): KnockRequest => ({
  userId: `@${name.toLowerCase()}:hs`,
  roomDisplayName: name,
  roomInitial: name[0] ?? '?',
  roomAvatarMxc: null,
  reason: null,
});

describe('join requests banner', () => {
  const requests = signal<readonly KnockRequest[]>([]);
  const canInvite = signal(true);
  const activeAccountId = signal('@me:hs');

  beforeEach(() => {
    requests.set([]);
    canInvite.set(true);
    activeAccountId.set('@me:hs');
  });

  const banner = (onReview = vi.fn()) =>
    render(JoinRequestsBannerComponent, {
      on: { review: onReview },
      providers: [
        MockProvider(ConversationRuntime, {
          focused: signal({ key: KEY } as never),
        }),
        MockProvider(WorkspaceNavigationService, { activeAccountId }),
        MockProvider(RoomMembersService, { knockingFor: () => requests }),
        MockProvider(RoomActionPermissionsService, {
          roomFor: () =>
            ({
              invite: { available: canInvite(), reason: null },
            }) as never,
        }),
      ],
    });

  it('says who asked to join for one request', async () => {
    requests.set([request('Dana')]);
    await banner();

    expect(screen.getByTestId('join-requests-banner').textContent).toContain(
      'Dana asked to join.',
    );
  });

  it('sums up several requests', async () => {
    requests.set([request('Dana'), request('Eli')]);
    await banner();

    expect(screen.getByTestId('join-requests-banner').textContent).toContain(
      '2 people asked to join.',
    );
  });

  it('is hidden without requests', async () => {
    await banner();

    expect(screen.queryByTestId('join-requests-banner')).toBeNull();
  });

  it('is hidden without invite permission', async () => {
    requests.set([request('Dana')]);
    canInvite.set(false);
    await banner();

    expect(screen.queryByTestId('join-requests-banner')).toBeNull();
  });

  it("is hidden for another account's room", async () => {
    requests.set([request('Dana')]);
    activeAccountId.set('@other:hs');
    await banner();

    expect(screen.queryByTestId('join-requests-banner')).toBeNull();
  });

  it('emits review from the Review button', async () => {
    requests.set([request('Dana')]);
    const onReview = vi.fn();
    await banner(onReview);

    fireEvent.click(screen.getByTestId('join-requests-review'));

    expect(onReview).toHaveBeenCalledOnce();
  });
});
