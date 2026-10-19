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
} from '@trinity/data-access/identity';
import {
  type CommonRoom,
  RoomLibraryService,
  RoomsInCommonService,
} from '@trinity/data-access/room-library';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  TrustOperationError,
  TrustUsersService,
  TrustVerificationService,
  type UserTrust,
} from '@trinity/data-access/trust';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
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
      MockProvider(TrnToastService, { show: toastShow }),
      {
        provide: IdentityPresenceService,
        useValue: { presenceFor: () => signal('online') },
      },
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>(
          opts.activeUserId ?? '@me:hs',
        ).asReadonly(),
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
      }),
      MockProvider(MatrixClientService, {
        accountIds: signal(['@me:hs']).asReadonly(),
        activeUserId: signal<string | null>('@me:hs').asReadonly(),
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
  const { container } = await render(MemberInfoComponent, {
    inputs: { member: m, roomId: '!r:hs' },
    on: {
      messageUser: (userId: string) => messaged.push(userId),
      dismissed: () => {
        dismissals += 1;
      },
    },
    providers: [
      MockProvider(TrnToastService),
      {
        provide: IdentityPresenceService,
        useValue: { presenceFor: () => signal('online') },
      },
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>('@me:hs').asReadonly(),
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
      }),
      MockProvider(MatrixClientService, {
        accountIds: signal(['@me:hs']).asReadonly(),
        activeUserId: signal<string | null>('@me:hs').asReadonly(),
      }),
    ],
  });
  return { container, messaged, dismissals: () => dismissals };
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
    expect(screen.getByRole('tabpanel').textContent).toContain('Copy user ID');
  });

  it('shows only Profile and Rooms for yourself', async () => {
    await build(member({ userId: '@me:hs' }), { activeUserId: '@me:hs' });

    expect(tabNames()).toEqual(['Profile', 'Rooms']);
  });

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

  it('never offers Owner as a role you can assign', async () => {
    // The invariant this whole feature turns on. Owner is the room's CREATOR, and no
    // power level makes someone that — so offering it would be an action the server
    // cannot perform. The displayed role and the assignable roles deliberately come
    // from two different places, and this is what keeps them apart.
    //
    // The viewer's power is deliberately absurd. `roleOptions` hides presets ABOVE the
    // viewer's level, so asserting this as a mere admin would pass for the wrong reason:
    // an Owner preset added at 101 would be filtered out by rank rather than excluded by
    // design, and the test would keep passing while the invariant broke.
    const { cmp } = await build(member({ powerLevel: 0 }), { myPower: 10_000 });

    const labels = cmp.roleOptions().map((option) => option.label);
    expect(labels).not.toContain('Owner');
    expect(labels).toEqual(['Moderator', 'Admin']);
  });

  it('offers no way to assign Owner even to the creator themselves', async () => {
    const { cmp } = await build(member({ powerLevel: 100, isCreator: true }), {
      myPower: 10_000,
    });

    expect(cmp.roleOptions().map((option) => option.label)).not.toContain(
      'Owner',
    );
  });

  it('closes resolving the user id when Message is picked', async () => {
    const { cmp, close } = await build();
    cmp.message();
    expect(close).toHaveBeenCalledWith('@bob:hs');
  });

  it('copies the user id and toasts once the write resolves', async () => {
    // The real writeText returns a Promise; the toast must follow it, not fire blind.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build();

    cmp.copyId();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('@bob:hs');
    expect(toastShow).toHaveBeenCalledWith(
      'User ID copied.',
      expect.anything(),
    );
  });

  it('does not claim success when the clipboard write is rejected', async () => {
    // Denied permission / non-secure context. Telling the user "copied" here leaves
    // them believing they have the id when the clipboard is untouched.
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build();

    cmp.copyId();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).not.toHaveBeenCalledWith(
      'User ID copied.',
      expect.anything(),
    );
    expect(toastShow).toHaveBeenCalledWith(
      'Could not copy the user ID. It is selected above; copy it manually.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the same manual fallback when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const { cmp, toastShow } = await build();

    cmp.copyId();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      'Could not copy the user ID. It is selected above; copy it manually.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the fallback when clipboard exists without writeText', async () => {
    vi.stubGlobal('navigator', { clipboard: {} });
    const { cmp, toastShow } = await build();

    expect(() => cmp.copyId()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      'Could not copy the user ID. It is selected above; copy it manually.',
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('offers the fallback when writeText throws synchronously', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: () => {
          throw new Error('not available');
        },
      },
    });
    const { cmp, toastShow } = await build();

    expect(() => cmp.copyId()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastShow).toHaveBeenCalledWith(
      'Could not copy the user ID. It is selected above; copy it manually.',
      expect.objectContaining({ variant: 'danger' }),
    );
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
    // Copy user ID stays available.
    expect(
      container.querySelector('[data-testid="member-info-copy"]'),
    ).not.toBeNull();
  });

  it('shows kick/ban actions when permitted', async () => {
    const { container } = await build(member(), {
      canKick: true,
      canBan: true,
    });
    expect(
      container.querySelector('[data-testid="member-info-kick"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="member-info-ban"]'),
    ).not.toBeNull();
  });

  it('keeps kick/ban actions discoverable but unavailable without permission', async () => {
    const { container } = await build(); // canKick/canBan default false
    expect(
      container
        .querySelector('[data-testid="member-info-kick"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      container
        .querySelector('[data-testid="member-info-ban"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('kicks the member with the entered reason and closes on confirm', async () => {
    const alertPrompt = vi.fn(() => of('spam'));
    const { cmp, kick, close } = await build(member(), {
      canKick: true,
      alertPrompt,
    });

    await cmp.kick();

    expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', 'spam');
    expect(close).toHaveBeenCalledWith(null);
  });

  it('keeps Conversation moderation on the live room while its owning Account is active', async () => {
    const alertPrompt = vi.fn(() => of(''));
    const { cmp, fixture, kick } = await build(member(), {
      canKick: true,
      alertPrompt,
    });
    fixture.componentRef.setInput('owningAccountId', '@me:hs');
    await fixture.whenStable();

    cmp.kick();

    expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', undefined);
    expect(alertPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('using account @me:hs'),
      }),
    );
  });

  it('aims moderation at the owning Account once another Account is active', async () => {
    // #1041: member info outlives nothing on purpose, but between an Account switch and the
    // host closing it a command must still reach the Account it was opened for.
    const { cmp, fixture, kick, ban, setPowerLevel } = await build(member(), {
      canKick: true,
      canBan: true,
      canSetPower: true,
      myPower: 100,
      activeUserId: '@other:hs',
    });
    fixture.componentRef.setInput('owningAccountId', '@me:hs');
    await fixture.whenStable();
    const owner = { accountId: '@me:hs', roomId: '!r:hs' };

    cmp.kick();
    cmp.ban();
    cmp.setRole({ label: 'Moderator', level: 50 });

    expect(kick).toHaveBeenCalledWith(owner, '@bob:hs', undefined);
    expect(ban).toHaveBeenCalledWith(owner, '@bob:hs', undefined);
    expect(setPowerLevel).toHaveBeenCalledWith(owner, '@bob:hs', 50);
  });

  it('runs no identity action once its owning Account is no longer active', async () => {
    const { cmp, fixture, createDirectMessage, startUserVerification, ignore } =
      await build(member(), { activeUserId: '@other:hs' });
    fixture.componentRef.setInput('owningAccountId', '@me:hs');
    await fixture.whenStable();

    cmp.verify();
    cmp.toggleIgnore();

    expect(createDirectMessage).not.toHaveBeenCalled();
    expect(startUserVerification).not.toHaveBeenCalled();
    expect(ignore).not.toHaveBeenCalled();
  });

  it('disables Block, with the reason, while another account is active', async () => {
    const { fixture, container } = await build(member(), {
      activeUserId: '@other:hs',
    });
    fixture.componentRef.setInput('owningAccountId', '@me:hs');
    await fixture.whenStable();
    fixture.detectChanges();

    const block = container.querySelector<HTMLElement>(
      '[data-testid="member-info-ignore"]',
    )!;
    expect(block.getAttribute('aria-disabled')).toBe('true');
    expect(block.getAttribute('aria-description')).toBe(
      'Switch back to @me:hs to block or unblock from this card.',
    );
  });

  it('leaves Block enabled for the active owning account', async () => {
    const { fixture, container } = await build(member());
    fixture.componentRef.setInput('owningAccountId', '@me:hs');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      container
        .querySelector('[data-testid="member-info-ignore"]')!
        .getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('confirms exact Space context and keeps the command on the opening Account', async () => {
    const alertPrompt = vi.fn(() => of('spam'));
    const { cmp, fixture, kick, close } = await build(member(), {
      canKick: true,
      alertPrompt,
    });
    fixture.componentRef.setInput('accountId', '@opening:hs');
    fixture.componentRef.setInput('targetName', 'Design Space');
    fixture.componentRef.setInput('noun', 'Space');
    fixture.componentRef.setInput('embedded', true);
    let dismissed = false;
    cmp.dismissed.subscribe(() => (dismissed = true));
    await fixture.whenStable();

    cmp.kick();

    expect(alertPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Remove from space',
        message: expect.stringContaining(
          'Design Space using account @opening:hs',
        ),
      }),
    );
    expect(kick).toHaveBeenCalledWith(
      { accountId: '@opening:hs', roomId: '!r:hs' },
      '@bob:hs',
      'spam',
    );
    expect(dismissed).toBe(true);
    expect(close).not.toHaveBeenCalled();
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

  it('names a Space in its ban confirmation heading', async () => {
    const alertPrompt = vi.fn(() => of(''));
    const { cmp, fixture } = await build(member(), {
      canBan: true,
      alertPrompt,
    });
    fixture.componentRef.setInput('noun', 'Space');
    await fixture.whenStable();

    cmp.ban();

    expect(alertPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ header: 'Ban from space' }),
    );
  });

  it('does not kick when the confirmation is cancelled', async () => {
    const alertPrompt = vi.fn(() => of(null)); // cancelled
    const { cmp, kick } = await build(member(), { canKick: true, alertPrompt });

    await cmp.kick();

    expect(kick).not.toHaveBeenCalled();
  });

  it('bans the member (no reason → undefined) and closes on confirm', async () => {
    const alertPrompt = vi.fn(() => of(''));
    const { cmp, ban, close } = await build(member(), {
      canBan: true,
      alertPrompt,
    });

    await cmp.ban();

    expect(ban).toHaveBeenCalledWith('!r:hs', '@bob:hs', undefined);
    expect(close).toHaveBeenCalledWith(null);
  });

  it('toasts and stays open when a moderation action fails', async () => {
    const kick = vi.fn(() => throwError(() => new Error('nope')));
    const alertPrompt = vi.fn(() => of(''));
    const { cmp, close, toastShow } = await build(member(), {
      canKick: true,
      kick,
      alertPrompt,
    });

    await cmp.kick();

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'danger' }),
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('offers every preset except the member’s current one', async () => {
    const { cmp } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 100,
    });
    // Member (0) is the current role and excluded; Moderator + Admin remain.
    expect(cmp.roleOptions().map((r) => r.level)).toEqual([50, 100]);
  });

  it('renders higher roles as unavailable instead of hiding them', async () => {
    const { container } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 50, // can reach Moderator, not Admin
    });
    expect(
      container.querySelector('[data-testid="member-info-role-50"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="member-info-role-100"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="member-info-role-0"]'),
    ).toBeNull(); // current role
  });

  it('changes the role on confirm and closes', async () => {
    const setPowerLevel = vi.fn(() => of(undefined));
    const { cmp, close } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 100,
      setPowerLevel,
    });

    await cmp.setRole({ label: 'Moderator', level: 50 });

    expect(setPowerLevel).toHaveBeenCalledWith('!r:hs', '@bob:hs', 50);
    expect(close).toHaveBeenCalledWith(null);
  });

  it('styles a demotion from the live target role as danger', async () => {
    const alertConfirm = vi.fn(() => of(false));
    const { cmp } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 100,
      targetPower: 100,
      alertConfirm,
    });

    await cmp.setRole({ label: 'Moderator', level: 50 });

    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('does not change the role when the confirmation is cancelled', async () => {
    const setPowerLevel = vi.fn(() => of(undefined));
    const alertConfirm = vi.fn(() => of(false));
    const { cmp } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 100,
      setPowerLevel,
      alertConfirm,
    });

    await cmp.setRole({ label: 'Admin', level: 100 });

    expect(setPowerLevel).not.toHaveBeenCalled();
  });

  it('offers Block for a not-yet-ignored member and blocks them on click', async () => {
    const { cmp, container, ignore } = await build(member(), {
      isIgnored: false,
    });
    const btn = container.querySelector<HTMLElement>(
      '[data-testid="member-info-ignore"]',
    );
    expect(btn?.textContent?.trim()).toBe('Block');

    cmp.toggleIgnore();

    expect(ignore).toHaveBeenCalledWith('@bob:hs');
    expect(cmp.ignored()).toBe(true); // button flips to "Unblock"
  });

  it('follows the account ignore list, so a block made elsewhere shows here', async () => {
    const { fixture, container, ignoredIds, ignoreProjection } =
      await build(member());
    expect(ignoreProjection.observed).toBe(true);
    const btn = () =>
      container
        .querySelector<HTMLElement>('[data-testid="member-info-ignore"]')
        ?.textContent?.trim();
    expect(btn()).toBe('Block');

    ignoredIds.set(['@bob:hs']);
    fixture.detectChanges();

    expect(btn()).toBe('Unblock');
  });

  it('does not flip when a block write fails', async () => {
    const { cmp } = await build(member(), {
      ignore: vi.fn(() => throwError(() => new Error('offline'))),
    });

    cmp.toggleIgnore();

    expect(cmp.ignored()).toBe(false);
  });

  it('offers Unblock for an ignored member and unblocks them on click', async () => {
    const { cmp, fixture, unignore, toastShow } = await build(member(), {
      isIgnored: true,
    });
    await openManage(fixture);
    expect(cmp.ignored()).toBe(true);

    cmp.toggleIgnore();
    fixture.detectChanges();

    expect(unignore).toHaveBeenCalledWith('@bob:hs');
    expect(cmp.ignored()).toBe(false);
    expect(screen.getByRole('status').textContent?.trim()).toBe('Unblocked.');
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('confirms a block in the card, where no toast covers the button', async () => {
    const { cmp, fixture, toastShow } = await build(member());
    await openManage(fixture);

    cmp.toggleIgnore();
    fixture.detectChanges();

    expect(screen.getByRole('status').textContent?.trim()).toBe(
      "Blocked — you won't see their messages.",
    );
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('says in the card when a block fails', async () => {
    const { cmp, fixture, toastShow } = await build(member(), {
      ignore: vi.fn(() => throwError(() => new Error('offline'))),
    });
    await openManage(fixture);

    cmp.toggleIgnore();
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Could not update the block.',
    );
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('keeps its status region in place, empty, until there is something to say', async () => {
    const { fixture } = await build(member());
    await openManage(fixture);

    expect(screen.getByRole('status').matches(':empty')).toBe(true);
  });

  it('drops the confirmation once the list changes elsewhere', async () => {
    const { cmp, fixture, ignoredIds } = await build(member());
    await openManage(fixture);
    cmp.toggleIgnore();
    fixture.detectChanges();

    ignoredIds.set([]);
    fixture.detectChanges();

    expect(screen.getByRole('status').matches(':empty')).toBe(true);
  });

  it('offers to report the member, named, as the active account', async () => {
    const { fixture, reportUser$ } = await build(member());
    await openManage(fixture);

    screen.getByRole('button', { name: 'Report Bob' }).click();

    expect(reportUser$).toHaveBeenCalledExactlyOnceWith({
      accountId: '@me:hs',
      userId: '@bob:hs',
      name: 'Bob',
    });
  });

  it('hides Report once this server has said it does not take user reports', async () => {
    const { fixture } = await build(member(), { reportsOffered: false });
    await openManage(fixture);

    expect(screen.queryByRole('button', { name: 'Report Bob' })).toBeNull();
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
