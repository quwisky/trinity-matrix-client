import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { MemberInfoComponent } from '../member-info/member-info.component';
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
  type KnockRequest,
  type MemberSummary,
  type RoomMembersSnapshot,
} from '@trinity/data-access/room-administration';
import {
  IgnoredUsersService,
  IdentityPresenceService,
  IdentityService,
} from '@trinity/data-access/identity';
import {
  InviteBlockedError,
  RoomLibraryService,
} from '@trinity/data-access/room-library';
import { TrustVerificationService } from '@trinity/data-access/trust';
import { MockProvider } from 'ng-mocks';
import { BehaviorSubject, NEVER, of, throwError } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { UserPickerService } from '../user-picker/user-picker.service';
import { InviteHistoryNoteService } from '../shared/invite-history-note';
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

const DANA: KnockRequest = {
  userId: '@dana:hs',
  roomDisplayName: 'Dana',
  roomInitial: 'D',
  roomAvatarMxc: null,
  reason: null,
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
    invited: [],
    knocking: [],
    ...over,
  };
}

async function build(
  options: {
    readonly canManage?: boolean;
    readonly initial?: RoomMembersSnapshot;
  } = {},
) {
  const snapshots = new BehaviorSubject(options.initial ?? snapshot());
  const inviteUser = vi.fn(() => of(undefined));
  const pick = vi.fn(() => of('@invitee:hs'));
  const pickUser = vi.fn(() =>
    of({ userId: '@invitee:hs', displayName: 'Ivy' as string | null }),
  );
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
      MockProvider(UserPickerService, {
        pick$: pick,
        pickUser$: pickUser,
      }),
      MockProvider(InviteHistoryNoteService, {
        noteFor: (key: { accountId: string; roomId: string }) =>
          key.accountId === TARGET.accountId && key.roomId === TARGET.roomId
            ? { text: 'From when they join.' }
            : null,
      }),
      MockProvider(WorkspaceNavigationService, { navigate }),
      MockProvider(TrnDialogRef, { close }),
      MockProvider(TrnToastService, { show: vi.fn() }),
      MockProvider(TrnAlertService, {
        confirm$: () => of(true),
        prompt$: () => of(''),
      }),
      MockProvider(IdentityPresenceService, {
        presenceFor: () => signal(null),
        presenceDetailsFor: () => signal(null),
      }),
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>(TARGET.accountId).asReadonly(),
        lookup: () => NEVER,
      }),
      MockProvider(IgnoredUsersService, {
        isIgnored: () => false,
        runProjection: () => NEVER,
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
    pick: pickUser,
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

  it('closes the settings dialog once a shared room is opened from member detail', async () => {
    const { cmp, fixture, close } = await build();
    cmp.selectMember(ADA);
    await fixture.whenStable();

    fixture.debugElement
      .query(By.directive(MemberInfoComponent))
      .componentInstance.roomOpened.emit();

    expect(close).toHaveBeenCalledWith(false);
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
      note: { text: 'From when they join.' },
    });
    expect(inviteUser).toHaveBeenCalledWith(TARGET, '@invitee:hs');
  });

  it('says the invitee is not accepting invites when their server blocks them', async () => {
    const { cmp, inviteUser } = await build();
    inviteUser.mockReturnValue(
      throwError(() => new InviteBlockedError('@invitee:hs')),
    );

    cmp.invite();

    expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
      "Ivy isn't accepting invites.",
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('shows Requests and Invited counts only when non-zero', async () => {
    const { fixture, container, snapshots } = await build();
    const count = (testId: string) =>
      container.querySelector(`[data-testid="${testId}"] span`)?.textContent;

    expect(count('members-settings-requests')).toBeUndefined();
    expect(count('members-settings-invited')).toBeUndefined();

    snapshots.next(snapshot({ knocking: [DANA], invited: [ADA] }));
    await fixture.whenStable();

    expect(count('members-settings-requests')).toBe('1');
    expect(count('members-settings-invited')).toBe('1');
  });

  it('opens on Requests when there are requests you may approve', async () => {
    const { cmp, fixture, container } = await build({
      initial: snapshot({ knocking: [DANA] }),
    });
    await fixture.whenStable();

    expect(cmp.destination()).toBe('requests');
    expect(
      container.querySelector('[data-testid="pending-member-@dana:hs"]'),
    ).not.toBeNull();
  });

  it('opens on Current members when you may not approve requests', async () => {
    const { cmp } = await build({
      canManage: false,
      initial: snapshot({ knocking: [DANA] }),
    });

    expect(cmp.destination()).toBe('current');
  });

  it('keeps the last requests and invites when the Account becomes unavailable', async () => {
    const { cmp, snapshots } = await build({
      initial: snapshot({ knocking: [DANA], invited: [ADA] }),
    });

    snapshots.next(
      snapshot({
        availability: 'account-unavailable',
        unavailableReason: 'Signed out.',
        knocking: [],
        invited: [],
      }),
    );

    expect(cmp.snapshot()?.knocking).toEqual([DANA]);
    expect(cmp.snapshot()?.invited).toEqual([ADA]);
  });
});
