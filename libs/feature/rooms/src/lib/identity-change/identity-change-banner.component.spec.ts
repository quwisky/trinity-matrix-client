import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnDialogRef, TrnSurfaceService } from '@trinity/components/overlay';
import { AvatarComponent } from '@trinity/components/generic-content';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { fireEvent, render, screen } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { IdentityChangeActionsService } from './identity-change-actions.service';
import { IdentityChangeBannerComponent } from './identity-change-banner.component';
import { IdentityChangeReviewComponent } from './identity-change-review.component';
import {
  RoomIdentityChangesService,
  type IdentityChange,
} from './room-identity-changes.service';

const KEY = { accountId: '@me:hs', roomId: '!r:hs' };

const change = (
  name: string,
  trust: IdentityChange['trust'],
): IdentityChange => ({
  userId: `@${name.toLowerCase()}:hs`,
  name,
  initial: name[0] ?? '?',
  avatarMxc: null,
  trust,
});

describe('identity change banner and review', () => {
  const changes = signal<readonly IdentityChange[]>([]);
  let open: Mock;
  let acknowledge: Mock;
  let withdraw: Mock;
  let close: Mock;

  beforeEach(() => {
    changes.set([]);
    open = vi.fn();
    acknowledge = vi.fn();
    withdraw = vi.fn();
    close = vi.fn();
  });

  const providers = () => [
    MockProvider(ConversationRuntime, {
      focused: signal({ key: KEY } as never),
    }),
    MockProvider(RoomIdentityChangesService, { changes: () => changes() }),
    MockProvider(IdentityChangeActionsService, {
      pending: () => null,
      acknowledge,
      withdraw,
      verifyAgain: vi.fn(),
    }),
    MockProvider(TrnSurfaceService, { open }),
    { provide: TrnDialogRef, useValue: { close } },
  ];

  const banner = () =>
    render(IdentityChangeBannerComponent, { providers: providers() });

  it('shows nothing while nobody changed identity', async () => {
    await banner();

    expect(screen.queryByTestId('identity-change-banner')).toBeNull();
  });

  it('names one person whose identity changed, with Acknowledge', async () => {
    changes.set([change('Bob', 'identity-changed')]);
    await banner();

    expect(screen.getByTestId('identity-change-banner').textContent).toContain(
      "Bob's identity changed.",
    );
    fireEvent.click(screen.getByRole('button', { name: /^Acknowledge/ }));
    expect(acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '@bob:hs', name: 'Bob' }),
    );
  });

  it('offers Verify again and Withdraw for a verified identity that changed', async () => {
    changes.set([change('Bob', 'verified-identity-changed')]);
    await banner();

    expect(screen.getByTestId('identity-change-banner').textContent).toContain(
      "Bob's verified identity changed.",
    );
    expect(screen.getByRole('button', { name: /^Verify again/ })).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: /^Withdraw verification/ }),
    );
    expect(withdraw).toHaveBeenCalledOnce();
  });

  it('sums up several people and opens the Review list for this room', async () => {
    changes.set([
      change('Bob', 'identity-changed'),
      change('Carol', 'verified-identity-changed'),
    ]);
    await banner();

    expect(screen.getByTestId('identity-change-banner').textContent).toContain(
      '2 people in this room changed identity.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(open).toHaveBeenCalledWith(
      IdentityChangeReviewComponent,
      expect.objectContaining({ inputs: { roomKey: KEY } }),
    );
  });

  it('lists each person in Review and closes once everyone is handled', async () => {
    changes.set([
      change('Bob', 'identity-changed'),
      change('Carol', 'verified-identity-changed'),
    ]);
    const { fixture } = await render(IdentityChangeReviewComponent, {
      providers: providers(),
      inputs: { roomKey: KEY },
      imports: [MockComponent(AvatarComponent)],
    });

    expect(screen.getByTestId('identity-review-@bob:hs').textContent).toContain(
      'Identity changed',
    );
    expect(
      screen.getByTestId('identity-review-@carol:hs').textContent,
    ).toContain('Verified identity changed');
    expect(close).not.toHaveBeenCalled();

    changes.set([]);
    fixture.detectChanges();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(close).toHaveBeenCalled();
  });
});
