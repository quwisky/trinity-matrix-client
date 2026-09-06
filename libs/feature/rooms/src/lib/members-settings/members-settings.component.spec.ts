import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import {
  TrnAlertService,
  TrnDialogRef,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  RoomActionPermissionsService,
  RoomMembersService,
  RoomModerationService,
  type MemberSummary,
  type RoomMembersSnapshot,
} from '@trinity/data-access/room-administration';
import {
  IgnoredUsersService,
  IdentityPresenceService,
  IdentityService,
} from '@trinity/data-access/identity';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { TrustVerificationService } from '@trinity/data-access/trust';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { UserPickerService } from '../user-picker/user-picker.service';
import { MembersSettingsComponent } from './members-settings.component';

const TARGET = { accountId: '@opening:hs', roomId: '!target:hs' } as const;
const ALLOWED = { available: true, reason: null } as const;
const DENIED = { available: false, reason: 'Not allowed.' } as const;

const ADA: MemberSummary = {
  userId: '@ada:hs',
  roomDisplayName: 'Ada',
  roomInitial: 'A',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
};

function snapshot(
  over: Partial<RoomMembersSnapshot> = {},
): RoomMembersSnapshot {
  return {
    target: TARGET,
    availability: 'available',
    unavailableReason: null,
    members: [ADA],
    banned: [
      { userId: '@banned:hs', roomDisplayName: 'Banned Bob', reason: 'spam' },
    ],
    ...over,
  };
}

async function build(options: { readonly canManage?: boolean } = {}) {
  const snapshots = new BehaviorSubject(snapshot());
  const inviteUser = vi.fn(() => of(undefined));
  const pick = vi.fn(() => of('@invitee:hs'));
  const navigate = vi.fn(() =>
    of({ kind: 'ready' as const, change: 'committed' as const }),
  );
  const close = vi.fn();
  const canManage = options.canManage ?? true;
  const permission = canManage ? ALLOWED : DENIED;
  const { fixture, container } = await render(MembersSettingsComponent, {
    inputs: {
      accountId: TARGET.accountId,
      roomId: TARGET.roomId,
      targetName: 'Design Space',
      noun: 'Space',
    },
    providers: [
      provideTrnIcons(),
      MockProvider(RoomMembersService, { observe: () => snapshots }),
      MockProvider(RoomActionPermissionsService, {
        roomFor: () => ({ invite: permission, curateSpace: DENIED }),
        member: () => ({
          kick: permission,
          ban: permission,
          setPower: permission,
          myPower: canManage ? 100 : 0,
          targetPower: 0,
        }),
        role: () => permission,
        unban: () => permission,
      }),
      MockProvider(RoomModerationService, {
        kick: () => of(undefined),
        ban: () => of(undefined),
        unban: () => of(undefined),
        setPowerLevel: () => of(undefined),
      }),
      MockProvider(RoomLibraryService, {
        inviteUser,
        createDirectMessage: () => of('!dm:hs'),
      }),
      MockProvider(UserPickerService, { pick$: pick }),
      MockProvider(WorkspaceNavigationService, { navigate }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show: vi.fn() }),
      MockProvider(TrnAlertService, {
        confirm$: () => of(true),
        prompt$: () => of(''),
      }),
      MockProvider(IdentityPresenceService, {
        presenceFor: () => signal(null),
      }),
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>(TARGET.accountId).asReadonly(),
      }),
      MockProvider(IgnoredUsersService, {
        isIgnored: () => false,
        ignore: () => of(undefined),
        unignore: () => of(undefined),
      }),
      MockProvider(TrustVerificationService, {
        startUserVerification: () => of(undefined),
      }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    snapshots,
    inviteUser,
    pick,
    navigate,
    close,
  };
}

describe('MembersSettingsComponent', () => {
  it('keeps the roster readable while hiding ordinary-member administration', async () => {
    const { cmp, fixture, container } = await build({ canManage: false });

    cmp.selectMember(ADA);
    await fixture.whenStable();

    expect(container.textContent).toContain('Ada');
    expect(
      container.querySelector('[data-testid="member-info"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="member-info-kick"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="member-info-ban"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="members-settings-invite"]'),
    ).toBeNull();
  });

  it('returns member detail to the roster before the settings dialog retreats', async () => {
    const { cmp, fixture, container } = await build();
    cmp.selectMember(ADA);
    await fixture.whenStable();

    expect(cmp.dismissNestedSurface()).toBe(true);
    await fixture.whenStable();

    expect(
      container.querySelector('[data-testid="member-list"]'),
    ).not.toBeNull();
    expect(cmp.dismissNestedSurface()).toBe(false);
  });

  it('keeps banned membership local to Members and readable without unban authority', async () => {
    const { cmp, fixture, container } = await build({ canManage: false });
    cmp.selectDestination('banned');
    await fixture.whenStable();

    expect(container.textContent).toContain('Banned Bob');
    expect(container.textContent).toContain('spam');
    expect(
      container.querySelector('[data-testid="banned-member-unban"]'),
    ).toBeNull();
  });

  it('retains the last exact roster when the opening Account becomes unavailable', async () => {
    const { cmp, fixture, container, snapshots } = await build();
    const owner = { ...ADA, powerLevel: 100 };
    snapshots.next(snapshot({ members: [owner] }));
    cmp.selectMember(owner);
    await fixture.whenStable();

    snapshots.next(
      snapshot({
        availability: 'account-unavailable',
        unavailableReason: 'The opening Account signed out.',
        members: [],
        banned: [],
      }),
    );
    await fixture.whenStable();

    expect(cmp.snapshot()?.members).toEqual([owner]);
    expect(container.textContent).toContain('Ada');
    expect(container.textContent).toContain('Admin');
    expect(container.textContent).toContain('The opening Account signed out.');
    expect(
      container.querySelector('[data-testid="members-settings-invite"]'),
    ).toBeNull();
  });

  it('invites only the exact Space owned by the opening Account', async () => {
    const { cmp, inviteUser, pick } = await build();

    cmp.invite();

    expect(pick).toHaveBeenCalledWith({
      title: 'Invite to Design Space',
      confirmLabel: 'Invite',
    });
    expect(inviteUser).toHaveBeenCalledWith(TARGET, '@invitee:hs');
  });
});
