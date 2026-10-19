import {
  type MemberSummary,
  ContentReportingService,
  RoomActionPermissionsService,
  RoomModerationService,
} from '@trinity/data-access/room-administration';
import { signal } from '@angular/core';
import { fireEvent, render, screen, within } from '@trinity/testing';
import {
  TrnDialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  IgnoredUsersService,
  IdentityPresenceService,
  IdentityService,
  type PresenceDetails,
} from '@trinity/data-access/identity';
import {
  type CommonRoom,
  RoomLibraryService,
  RoomsInCommonService,
} from '@trinity/data-access/room-library';
import {
  TrustOperationError,
  TrustUsersService,
  TrustVerificationService,
  type UserTrust,
} from '@trinity/data-access/trust';
import { MockProvider } from 'ng-mocks';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import { NEVER, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { MemberInfoComponent } from './member-info.component';
import { ReportService } from '../report/report.service';

function member(over: Partial<MemberSummary> = {}): MemberSummary {
  return {
    userId: '@bob:hs',
    roomDisplayName: 'Bob',
    roomInitial: 'B',
    roomAvatarMxc: null,
    powerLevel: 0,
    isCreator: false,
    ...over,
  };
}

async function build(
  m: MemberSummary = member(),
  opts: {
    activeUserId?: string;
    canKick?: boolean;
    canBan?: boolean;
    canSetPower?: boolean;
    myPower?: number;
    targetPower?: number;
    kick?: Mock;
    ban?: Mock;
    setPowerLevel?: Mock;
    alertPrompt?: Mock;
    alertConfirm?: Mock;
    isIgnored?: boolean;
    ignore?: Mock;
    unignore?: Mock;
    createDirectMessage?: Mock;
    startUserVerification?: Mock;
    reportsOffered?: boolean;
    trust?: UserTrust | null;
    commonRooms?: readonly CommonRoom[] | null;
    presence?: PresenceDetails | null;
    presenceAvailable?: boolean;
    lookup?: Mock;
    navigate?: Mock;
  } = {},
) {
  const close = vi.fn();
  const toastShow = vi.fn();
  const kick = opts.kick ?? vi.fn(() => of(undefined));
  const ban = opts.ban ?? vi.fn(() => of(undefined));
  const setPowerLevel = opts.setPowerLevel ?? vi.fn(() => of(undefined));
  const alertPrompt = opts.alertPrompt ?? vi.fn(() => of(''));
  const alertConfirm = opts.alertConfirm ?? vi.fn(() => of(true));
  // Stands in for the service's projection: a write lands through the account-data echo.
  const ignoredIds = signal<readonly string[]>(
    opts.isIgnored ? [m.userId] : [],
  );
  const ignoreProjection = new Subject<void>();
  const reportUser$ = vi.fn(() => of(undefined));
  const ignore =
    opts.ignore ??
    vi.fn((id: string) => {
      ignoredIds.update((ids) => [...ids, id]);
      return of(undefined);
    });
  const unignore =
    opts.unignore ??
    vi.fn((id: string) => {
      ignoredIds.update((ids) => ids.filter((x) => x !== id));
      return of(undefined);
    });
  const createDirectMessage =
    opts.createDirectMessage ?? vi.fn(() => of('!dm:hs'));
  const startUserVerification =
    opts.startUserVerification ?? vi.fn(() => of(undefined));
  const { fixture, container } = await render(MemberInfoComponent, {
    inputs: {
      member: m,
      roomId: '!r:hs',
    },
    providers: [
      MockProvider(TrnDialogRef, { close }),
      MockProvider(WorkspaceNavigationService, {
        navigate: opts.navigate ?? vi.fn(() => of({ kind: 'ready' })),
      }),
      MockProvider(TrnToastService, { show: toastShow }),
      {
        provide: IdentityPresenceService,
        useValue: {
          presenceFor: () => signal('online'),
          presenceDetailsFor: () => signal(opts.presence ?? null),
          presenceAvailable: signal(opts.presenceAvailable ?? true),
          myPresence: signal('unavailable'),
          myStatusMessage: signal('Heads down'),
        },
      },
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>(
          opts.activeUserId ?? '@me:hs',
        ).asReadonly(),
        lookup: opts.lookup ?? vi.fn(() => NEVER),
      }),
      MockProvider(RoomModerationService, { kick, ban, setPowerLevel }),
      MockProvider(RoomActionPermissionsService, {
        member: () => ({
          kick: {
            available: opts.canKick ?? false,
            reason: opts.canKick ? null : 'Cannot remove this member.',
          },
          ban: {
            available: opts.canBan ?? false,
            reason: opts.canBan ? null : 'Cannot ban this member.',
          },
          setPower: {
            available: opts.canSetPower ?? false,
            reason: opts.canSetPower ? null : 'Cannot change this role.',
          },
          myPower: opts.myPower ?? 0,
          targetPower: opts.targetPower ?? m.powerLevel,
        }),
        role: (_roomId: string, _userId: string, level: number) => ({
          available:
            (opts.canSetPower ?? false) && level <= (opts.myPower ?? 0),
          reason:
            (opts.canSetPower ?? false) && level <= (opts.myPower ?? 0)
              ? null
              : 'Cannot assign this role.',
        }),
      }),
      MockProvider(RoomLibraryService, { createDirectMessage }),
      MockProvider(TrustVerificationService, { startUserVerification }),
      MockProvider(IgnoredUsersService, {
        isIgnored: (id: string) => ignoredIds().includes(id),
        runProjection: () => ignoreProjection,
        ignore,
        unignore,
      }),
      MockProvider(TrnAlertService, {
        prompt$: alertPrompt,
        confirm$: alertConfirm,
      }),
      MockProvider(ContentReportingService, {
        offers: () => opts.reportsOffered ?? true,
      }),
      MockProvider(ReportService, { reportUser$ }),
      MockProvider(TrustUsersService, {
        userTrust: () => signal(opts.trust ?? null).asReadonly(),
      }),
      MockProvider(RoomsInCommonService, {
        roomsInCommon: () => signal(opts.commonRooms ?? null).asReadonly(),
        accountIds: signal(['@me:hs']).asReadonly(),
      }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    fixture,
    container,
    close,
    toastShow,
    kick,
    ban,
    setPowerLevel,
    alertPrompt,
    alertConfirm,
    ignore,
    unignore,
    ignoredIds,
    ignoreProjection,
    reportUser$,
    createDirectMessage,
    startUserVerification,
  };
}

/**
 * The same component with NO `TrnDialogRef` — rendered in place (as settings embeds it)
 * rather than as a dialog. Everything it announces goes through outputs here, and it has to
 * carry its own way out: there is no backdrop of its own.
 */
async function buildPanel(m: MemberSummary = member()) {
  const messaged: string[] = [];
  let dismissals = 0;
  let roomOpened = 0;
  const { container, fixture } = await render(MemberInfoComponent, {
    inputs: { member: m, roomId: '!r:hs' },
    on: {
      messageUser: (userId: string) => messaged.push(userId),
      dismissed: () => {
        dismissals += 1;
      },
      roomOpened: () => {
        roomOpened += 1;
      },
    },
    providers: [
      MockProvider(TrnToastService),
      MockProvider(WorkspaceNavigationService, {
        navigate: () =>
          of({ kind: 'ready' as const, change: 'committed' as const }),
      }),
      {
        provide: IdentityPresenceService,
        useValue: {
          presenceFor: () => signal('online'),
          presenceDetailsFor: () => signal(null),
        },
      },
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>('@me:hs').asReadonly(),
        lookup: () => NEVER,
      }),
      MockProvider(RoomModerationService),
      MockProvider(RoomLibraryService, {
        createDirectMessage: vi.fn(() => of('!dm:hs')),
      }),
      MockProvider(TrustVerificationService),
      MockProvider(IgnoredUsersService, {
        isIgnored: () => false,
        runProjection: () => new Subject<void>(),
      }),
      MockProvider(ContentReportingService, { offers: () => true }),
      MockProvider(ReportService),
      MockProvider(TrnAlertService),
      MockProvider(TrustUsersService, {
        userTrust: () => signal(null).asReadonly(),
      }),
      MockProvider(RoomsInCommonService, {
        roomsInCommon: () => signal(null).asReadonly(),
        accountIds: signal(['@me:hs']).asReadonly(),
      }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
    container,
    messaged,
    dismissals: () => dismissals,
    roomOpened: () => roomOpened,
  };
}

function commonRoom(id: string): CommonRoom {
  return {
    id,
    accountId: '@me:hs',
    name: id,
    initial: 'R',
    avatarMxc: null,
    kind: 'room',
    memberCount: 3,
  };
}

/** The text a screen reader reads: without aria-hidden glyphs, with sr-only text. */
function accessibleText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy
    .querySelectorAll('[aria-hidden="true"]')
    .forEach((node) => node.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

const tabNames = () =>
  screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());

/** Block, report and moderation live on the Manage tab, hidden until it is chosen. */
async function openManage(fixture: { whenStable(): Promise<void> }) {
  screen.getByRole('tab', { name: 'Manage' }).click();
  await fixture.whenStable();
}

describe('MemberInfoComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows Profile, Rooms and Manage tabs for another person, Profile selected', async () => {
    await build();

    expect(tabNames()).toEqual(['Profile', 'Rooms', 'Manage']);
    expect(
      screen.getByRole('tab', { selected: true }).textContent?.trim(),
    ).toBe('Profile');
    expect(screen.getByRole('tabpanel').textContent).toContain('Copy ID');
  });

  it('shows only Profile and Rooms for yourself', async () => {
    await build(member({ userId: '@me:hs' }), { activeUserId: '@me:hs' });

    expect(tabNames()).toEqual(['Profile', 'Rooms']);
  });

  it('hides Manage when it would be empty', async () => {
    const { fixture } = await build();
    fixture.componentRef.setInput('showIdentityActions', false);
    fixture.componentRef.setInput('hideUnavailableModeration', true);
    await fixture.whenStable();

    expect(tabNames()).toEqual(['Profile', 'Rooms']);
  });

  it('falls back to Profile when Manage empties while it is selected', async () => {
    const { fixture } = await build();
    await openManage(fixture);

    fixture.componentRef.setInput('showIdentityActions', false);
    fixture.componentRef.setInput('hideUnavailableModeration', true);
    await fixture.whenStable();

    expect(
      screen.getByRole('tab', { selected: true }).textContent?.trim(),
    ).toBe('Profile');
    expect(screen.getByRole('tabpanel').textContent).toContain('Copy ID');
  });

  it('closes the card once a moderation write from Manage lands', async () => {
    const { fixture, kick, close } = await build(member(), { canKick: true });
    await openManage(fixture);

    screen.getByTestId('member-info-kick').click();

    expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', undefined);
    expect(close).toHaveBeenCalledWith(null);
  });

  it.each([
    {
      kind: 'room',
      intent: {
        kind: 'room',
        accountId: '@me:hs',
        roomId: '!a:hs',
        origin: 'room-action',
      },
    },
    {
      kind: 'space',
      intent: {
        kind: 'scope',
        accountId: '@me:hs',
        scope: { kind: 'space', spaceId: '!a:hs' },
      },
    },
  ] as const)(
    'opening a shared $kind navigates to it and closes the card',
    async ({ kind, intent }) => {
      const navigate = vi.fn(() => of({ kind: 'ready' }));
      const { cmp, close } = await build(member(), { navigate });

      cmp.openRoom({ ...commonRoom('!a:hs'), accountId: '@me:hs', kind });

      expect(navigate).toHaveBeenCalledWith(intent);
      expect(close).toHaveBeenCalledWith(null);
    },
  );

  it.each([
    { rooms: [commonRoom('!a:hs'), commonRoom('!b:hs')], label: 'Rooms (2)' },
    { rooms: null, label: 'Rooms' },
  ])(
    'Rooms tab reads "Rooms (2)" with two rooms in common and "Rooms" while unknown ($label)',
    async ({ rooms, label }) => {
      await build(member(), { commonRooms: rooms });

      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    },
  );

  it.each([
    { trust: 'verified', badge: 'Verified' },
    { trust: 'changed', badge: 'Identity changed — verify again' },
    { trust: 'unverified', badge: null },
    { trust: null, badge: null },
  ] as const)(
    'header shows the Verified badge for a verified person and Identity changed for a changed one, none when unverified ($trust)',
    async ({ trust, badge }) => {
      await build(member(), { trust });

      const shown = screen.queryByTestId('member-info-trust');
      expect(shown ? accessibleText(shown) : null).toBe(badge);
    },
  );

  it('arrow keys move between tabs', async () => {
    const { fixture } = await build();
    const profile = screen.getByRole('tab', { name: 'Profile' });

    profile.focus();
    fireEvent.keyDown(profile, { key: 'ArrowRight' });
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe('Rooms');
    expect(
      screen.getByRole('tab', { selected: true }).textContent?.trim(),
    ).toBe('Rooms');

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe('Profile');
  });

  it('puts focus on the close button when the card opens, not on the tabs', async () => {
    // CDK focuses the first tabbable element on open; jsdom has no layout for that check, so
    // this pins its inputs: nothing in the card takes focus, and the close button comes first.
    await build();

    const close = screen.getByTestId('member-info-close');
    const firstTab = screen.getAllByRole('tab')[0];
    expect(
      close.compareDocumentPosition(firstTab) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it('is built on the shared dialog shell as a dialog', async () => {
    const { container } = await build();

    expect(
      within(screen.getByTestId('dialog-surface')).getByRole('heading', {
        level: 2,
        name: 'Member info',
      }),
    ).toBeTruthy();
    expect(container.querySelector('trn-side-panel-header')).toBeNull();
  });

  it('does not use the dialog shell as the panel', async () => {
    const { container } = await buildPanel();

    expect(container.querySelector('trn-dialog-shell')).toBeNull();
  });

  it('fills the settings detail pane as the panel rather than a fixed-width edge panel', async () => {
    // The detail pane owns the width. The `panel` overlay layout is a fixed 32rem recipe,
    // which left an empty strip beside it on a desktop and overflowed the column at 390px.
    // The dialog and sheet presentations keep the shared shell and are not affected.
    const { container } = await buildPanel();

    const surface = container.querySelector('[trnoverlaysurface]');
    expect(surface?.getAttribute('data-trn-layout')).toBe('fullscreen');
  });

  it('carries its own close button as the panel, where nothing else closes it', async () => {
    // In place there is no backdrop of its own — without this the panel would be a dead
    // end: the list it replaced is gone, so there is nothing left to click.
    const { container } = await buildPanel();

    expect(
      container.querySelector('[data-testid="member-info-close"]'),
    ).not.toBeNull();
  });

  it('marks its named panel close button as the panel focus target', async () => {
    const { container } = await buildPanel();

    const targets = container.querySelectorAll('[data-right-panel-focus]');
    expect(targets).toHaveLength(1);
    expect(targets[0].tagName).toBe('BUTTON');
    expect(targets[0].getAttribute('aria-label')).toBe('Close member info');
  });

  it('names the dialog shell close button for member info', async () => {
    // Member info from the member list is always a dialog or sheet now, so the shell's X
    // keeps the name and test hook the panel's close button had.
    const { close } = await build();

    const closeButton = within(screen.getByTestId('dialog-surface')).getByRole(
      'button',
      { name: 'Close member info' },
    );
    expect(closeButton.dataset['testid']).toBe('member-info-close');
    expect(screen.queryByTestId('dialog-close')).toBeNull();

    closeButton.click();
    expect(close).toHaveBeenCalledWith(null);
  });

  it('announces a dismissal from the panel close button', async () => {
    const { container, dismissals, messaged } = await buildPanel();

    container
      .querySelector<HTMLButtonElement>('[data-testid="member-info-close"]')!
      .click();

    expect(dismissals()).toBe(1);
    expect(messaged).toEqual([]);
  });

  it('announces roomOpened, not a dismissal, when a shared room is opened', async () => {
    const { cmp, dismissals, roomOpened } = await buildPanel();

    cmp.openRoom(commonRoom('!a:hs'));

    expect(roomOpened()).toBe(1);
    expect(dismissals()).toBe(0);
  });

  it('keeps the Rooms panel hidden while Profile is selected', async () => {
    const { container } = await build(member(), { commonRooms: [] });

    const panel = container.querySelector<HTMLElement>('.member-info__rooms');
    expect(panel?.hidden).toBe(true);
  });

  it('announces the user id for "Message" rather than resolving a ref', async () => {
    const { container, dismissals, messaged } = await buildPanel();

    container
      .querySelector<HTMLButtonElement>('[data-testid="member-info-message"]')!
      .click();

    // A pick is a pick, not a bare close: the host distinguishes the two.
    expect(messaged).toEqual(['@bob:hs']);
    expect(dismissals()).toBe(0);
  });

  it('shows the member name, id, and role', async () => {
    const { container } = await build(member({ powerLevel: 100 }));
    expect(container.textContent).toContain('Bob');
    expect(
      container.querySelector('[data-testid="member-info-handle"]')
        ?.textContent,
    ).toBe('@bob:hs');
    expect(container.textContent).toContain('Admin');
  });

  it('verifies a member over a DM and closes the panel', async () => {
    const { cmp, createDirectMessage, startUserVerification, close } =
      await build(member({ userId: '@bob:hs' }));

    cmp.verify();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(startUserVerification).toHaveBeenCalledWith(
      '@bob:hs',
      createDirectMessage.mock.results[0].value,
    );
    expect(close).toHaveBeenCalledWith(null);
  });

  it('keeps the panel open and toasts when starting verification fails', async () => {
    const startUserVerification = vi.fn(() =>
      throwError(() => new Error('nope')),
    );
    const { cmp, close, toastShow } = await build(member(), {
      startUserVerification,
    });

    cmp.verify();

    expect(close).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('Could not start verification'),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('shows safe retry guidance when the counterpart identity is not ready', async () => {
    const startUserVerification = vi.fn(() =>
      throwError(
        () =>
          new TrustOperationError(
            'start-verification',
            'not-ready',
            'retry',
            'Verification is not ready for this user yet. Try again.',
          ),
      ),
    );
    const { cmp, close, toastShow } = await build(member(), {
      startUserVerification,
    });

    cmp.verify();

    expect(close).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(
      'Verification is not ready for this user yet. Try again.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('hides the Verify action for your own row', async () => {
    const { container } = await build(member({ userId: '@me:hs' }), {
      activeUserId: '@me:hs',
    });
    expect(
      container.querySelector('[data-testid=member-info-verify]'),
    ).toBeNull();
  });

  // One render per case (a second render() re-configures an instantiated TestBed).
  it.each([
    [100, 'Admin'],
    [50, 'Moderator'],
    [0, 'Member'],
  ] as const)('derives power %i → role %s', async (power, label) => {
    const { cmp } = await build(member({ powerLevel: power }));
    expect(cmp.role()).toBe(label);
  });

  it('exposes the role under a stable testid for the e2e harness', async () => {
    const { container } = await build(
      member({ powerLevel: 100, isCreator: true }),
    );

    expect(
      container.querySelector('[data-testid="member-info-role"]')?.textContent,
    ).toContain('Owner');
  });

  it('names the room creator the owner', async () => {
    const { cmp } = await build(member({ powerLevel: 100, isCreator: true }));

    expect(cmp.role()).toBe('Owner');
  });

  it('names a demoted creator by the power they now hold', async () => {
    // Consistent with the member list, which is a ranking: the panel must not call
    // someone the owner while the list files them under Member.
    const { cmp } = await build(member({ powerLevel: 0, isCreator: true }));

    expect(cmp.role()).toBe('Member');
  });

  it('closes resolving the user id when Message is picked', async () => {
    const { cmp, close } = await build();
    cmp.message();
    expect(close).toHaveBeenCalledWith('@bob:hs');
  });

  it('selects the user id handle when the Profile tab cannot copy it', async () => {
    vi.stubGlobal('navigator', {});
    const { container } = await build();
    const handle = container.querySelector<HTMLElement>(
      '[data-testid="member-info-handle"]',
    )!;

    container
      .querySelector<HTMLElement>('[data-testid="member-info-copy"]')!
      .click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement).toBe(handle);
    expect(document.getSelection()?.toString()).toBe('@bob:hs');
  });

  it.each([
    ['a different global name', of({ displayName: 'Robert' }), 'Robert'],
    ['the same name', of({ displayName: 'Bob' }), null],
    [
      'no name, which reads as the user id',
      of({ displayName: '@bob:hs' }),
      null,
    ],
    ['a failed lookup', throwError(() => new Error('down')), null],
  ])('passes the Profile tab a global name for %s', async (_, result, name) => {
    const lookup = vi.fn(() => result);
    const { cmp } = await build(member(), { lookup });

    expect(lookup).toHaveBeenCalledWith('@bob:hs');
    expect(cmp.globalName()).toBe(name);
  });

  it('reads your own Status from the presence you set', async () => {
    const { cmp } = await build(member({ userId: '@me:hs' }), {
      activeUserId: '@me:hs',
    });

    expect(cmp.presenceDetails()).toEqual({
      state: 'unavailable',
      statusMessage: 'Heads down',
      lastActiveAt: null,
      currentlyActive: true,
    });
  });

  it('hides your own Status while presence is unavailable', async () => {
    // Your presence defaults to online, which would misreport a server with presence off.
    const { cmp, container } = await build(member({ userId: '@me:hs' }), {
      activeUserId: '@me:hs',
      presenceAvailable: false,
    });

    expect(cmp.presenceDetails()).toBeNull();
    expect(
      container.querySelector('[data-testid="member-info-status"]'),
    ).toBeNull();
  });

  it("reads another person's Status from their presence", async () => {
    const presence: PresenceDetails = {
      state: 'online',
      statusMessage: 'On holiday',
      lastActiveAt: null,
      currentlyActive: true,
    };
    const { container } = await build(member(), { presence });

    expect(
      container
        .querySelector('[data-testid="member-info-status"]')
        ?.textContent?.trim(),
    ).toBe('Online · On holiday');
  });

  it('makes the complete user id keyboard focusable', async () => {
    const { container } = await build();
    const handle = container.querySelector<HTMLElement>(
      '[data-testid="member-info-handle"]',
    )!;

    handle.focus();

    expect(document.activeElement).toBe(handle);
    expect(handle.tabIndex).toBe(0);
  });

  it('closes resolving null when dismissed', async () => {
    const { cmp, close } = await build();
    cmp.close();
    expect(close).toHaveBeenCalledWith(null);
  });

  it('hides the Message action on your own row', async () => {
    const { cmp, container } = await build(member({ userId: '@me:hs' }), {
      activeUserId: '@me:hs',
    });
    expect(cmp.isSelf()).toBe(true);
    expect(
      container.querySelector('[data-testid="member-info-message"]'),
    ).toBeNull();
    // Copy ID stays available on the Profile tab.
    expect(
      container.querySelector('[data-testid="member-info-copy"]'),
    ).not.toBeNull();
  });

  it('runs no identity action once its owning Account is no longer active', async () => {
    const { cmp, fixture, createDirectMessage, startUserVerification } =
      await build(member(), { activeUserId: '@other:hs' });
    fixture.componentRef.setInput('owningAccountId', '@me:hs');
    await fixture.whenStable();

    cmp.verify();

    expect(createDirectMessage).not.toHaveBeenCalled();
    expect(startUserVerification).not.toHaveBeenCalled();
  });

  it('suppresses active-Account presence and retains the known role when an exact target is unavailable', async () => {
    const { cmp, fixture } = await build(member({ powerLevel: 100 }), {
      targetPower: 0,
    });
    fixture.componentRef.setInput('accountId', '@opening:hs');
    fixture.componentRef.setInput('exactTargetAvailable', false);
    await fixture.whenStable();

    expect(cmp.presenceState()).toBeNull();
    expect(cmp.role()).toBe('Admin');
  });

  it('hides Report on your own row', async () => {
    await build(member({ userId: '@me:hs' }), { activeUserId: '@me:hs' });

    expect(screen.queryByRole('button', { name: /^Report/ })).toBeNull();
  });

  it('hides Block on your own row', async () => {
    const { container } = await build(member({ userId: '@me:hs' }), {
      activeUserId: '@me:hs',
    });
    expect(
      container.querySelector('[data-testid="member-info-ignore"]'),
    ).toBeNull();
  });
});
