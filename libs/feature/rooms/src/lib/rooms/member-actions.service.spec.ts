import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TrnAlertService,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  IdentityPresenceService,
  IdentityService,
  IgnoredUsersService,
} from '@trinity/data-access/identity';
import {
  RoomActionPermissionsService,
  RoomModerationService,
  type MemberSummary,
} from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { TrustVerificationService } from '@trinity/data-access/trust';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberActionsService } from './member-actions.service';
import { RoomShellNavigationService } from './room-shell-navigation.service';
import { RoomShellStore } from './room-shell-store';
import { RoomSurfaceLifecycle } from './room-surface-lifecycle';
import { ShellStatusService } from './shell-status.service';

// The real surface service and dialog stack render member info here, so these tests pin the
// presentation a reader actually gets rather than the arguments of a mocked opener.
const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));

const BOB: MemberSummary = {
  userId: '@bob:hs',
  roomDisplayName: 'Bob',
  roomInitial: 'B',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
};

const ALLOWED = { available: true, reason: null };

function build({ narrow = false } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === BELOW_MD_QUERY && narrow,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  const transition = vi.fn();
  const onSelectRoom = vi.fn();
  const createDirectMessage = vi.fn(() => of('!dm:hs'));
  const kick = vi.fn(() => of(undefined));
  TestBed.configureTestingModule({
    providers: [
      MemberActionsService,
      ShellStatusService,
      MockProvider(TrnToastService),
      MockProvider(TrnAlertService, { prompt$: () => of('') }),
      MockProvider(RoomShellStore, {
        activeAccountId: signal<string | null>('@me:hs').asReadonly(),
        activeRoomId: signal<string | null>('!r:hs').asReadonly(),
      }),
      MockProvider(RoomSurfaceLifecycle, { transition }),
      MockProvider(RoomShellNavigationService, { onSelectRoom }),
      MockProvider(RoomLibraryService, {
        directRoomIds: signal<ReadonlySet<string>>(new Set()).asReadonly(),
        createDirectMessage,
      }),
      {
        provide: IdentityPresenceService,
        useValue: { presenceFor: () => signal(null) },
      },
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>('@me:hs').asReadonly(),
      }),
      MockProvider(RoomModerationService, { kick }),
      MockProvider(RoomActionPermissionsService, {
        member: () => ({
          kick: ALLOWED,
          ban: ALLOWED,
          setPower: ALLOWED,
          myPower: 100,
          targetPower: 0,
        }),
        role: () => ALLOWED,
      }),
      MockProvider(IgnoredUsersService, { isIgnored: () => false }),
      MockProvider(TrustVerificationService),
    ],
  });
  const tick = () => TestBed.inject(ApplicationRef).tick();
  return {
    members: TestBed.inject(MemberActionsService),
    surfaces: TestBed.inject(TrnSurfaceService),
    tick,
    transition,
    onSelectRoom,
    createDirectMessage,
    kick,
  };
}

function shell(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'trn-member-info trn-dialog-shell',
  );
}

function button(testId: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!found) throw new Error(`no ${testId}`);
  return found;
}

describe('MemberActionsService member info', () => {
  let surfaces: TrnSurfaceService | null = null;

  afterEach(() => {
    surfaces?.closeAll();
    surfaces = null;
    platform.mobile = false;
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('opens member info from the list as a centred dialog on a large screen', () => {
    const built = build();
    surfaces = built.surfaces;

    built.members.onSelectMember(BOB);
    built.tick();

    expect(shell()?.dataset['presentation']).toBe('dialog');
    expect(
      document.querySelector('trn-member-info trn-sheet-frame'),
    ).toBeNull();
    // A modal surface over the list, not a write to the Room surface slot.
    expect(built.transition).not.toHaveBeenCalled();
  });

  it('opens member info from the list as a bottom sheet below md', () => {
    const built = build({ narrow: true });
    surfaces = built.surfaces;

    built.members.onSelectMember(BOB);
    built.tick();

    expect(shell()?.dataset['presentation']).toBe('sheet');
    // The shared frame owns the touch handle and swipe-to-close.
    expect(
      document.querySelector('trn-member-info trn-sheet-frame'),
    ).not.toBeNull();
    expect(built.transition).not.toHaveBeenCalled();
  });

  it('opens member info from the list as a bottom sheet on a mobile OS at any width', () => {
    platform.mobile = true;
    const built = build();
    surfaces = built.surfaces;

    built.members.onSelectMember(BOB);
    built.tick();

    expect(shell()?.dataset['presentation']).toBe('sheet');
  });

  it('closes without touching the Room surface slot, so the list stays open', () => {
    const built = build();
    surfaces = built.surfaces;
    built.members.onSelectMember(BOB);
    built.tick();

    button('member-info-close').click();
    built.tick();

    expect(built.surfaces.hasOpen()).toBe(false);
    expect(built.transition).not.toHaveBeenCalled();
    expect(built.createDirectMessage).not.toHaveBeenCalled();
  });

  it('closes after a kick lands, leaving the list to show the change', () => {
    const built = build();
    surfaces = built.surfaces;
    built.members.onSelectMember(BOB);
    built.tick();

    button('member-info-kick').click();
    built.tick();

    expect(built.kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', undefined);
    expect(built.surfaces.hasOpen()).toBe(false);
    expect(built.transition).not.toHaveBeenCalled();
    expect(built.onSelectRoom).not.toHaveBeenCalled();
  });

  it('closes on Message and opens the direct message', () => {
    const built = build();
    surfaces = built.surfaces;
    built.members.onSelectMember(BOB);
    built.tick();

    button('member-info-message').click();
    built.tick();

    expect(built.surfaces.hasOpen()).toBe(false);
    expect(built.createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(built.onSelectRoom).toHaveBeenCalledWith({
      roomId: '!dm:hs',
      accountId: '@me:hs',
    });
  });
});
