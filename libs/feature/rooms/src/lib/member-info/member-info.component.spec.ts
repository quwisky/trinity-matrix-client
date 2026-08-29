import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import {
  TrnDialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  IgnoredUsersService,
  PresenceService,
} from '@trinity/data-access/profile';
import {
  RoomActionPermissionsService,
  RoomModerationService,
  RoomsService,
  type MemberSummary,
} from '@trinity/data-access/rooms';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { VerificationService } from '@trinity/data-access/crypto';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { MemberInfoComponent } from './member-info.component';

function member(over: Partial<MemberSummary> = {}): MemberSummary {
  return {
    userId: '@bob:hs',
    name: 'Bob',
    initial: 'B',
    avatarMxc: null,
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
  } = {},
) {
  const close = vi.fn();
  const toastShow = vi.fn();
  const kick = opts.kick ?? vi.fn(() => of(undefined));
  const ban = opts.ban ?? vi.fn(() => of(undefined));
  const setPowerLevel = opts.setPowerLevel ?? vi.fn(() => of(undefined));
  const alertPrompt = opts.alertPrompt ?? vi.fn().mockResolvedValue('');
  const alertConfirm = opts.alertConfirm ?? vi.fn().mockResolvedValue(true);
  const ignore = opts.ignore ?? vi.fn(() => of(undefined));
  const unignore = opts.unignore ?? vi.fn(() => of(undefined));
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
        provide: PresenceService,
        useValue: { presenceFor: () => signal('online') },
      },
      MockProvider(MatrixClientService, {
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
      MockProvider(RoomsService, { createDirectMessage }),
      MockProvider(VerificationService, { startUserVerification }),
      MockProvider(IgnoredUsersService, {
        isIgnored: () => opts.isIgnored ?? false,
        ignore,
        unignore,
      }),
      MockProvider(TrnAlertService, {
        prompt: alertPrompt,
        confirm: alertConfirm,
      }),
    ],
  });
  return {
    cmp: fixture.componentInstance,
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
    createDirectMessage,
    startUserVerification,
  };
}

/**
 * The same component with NO `TrnDialogRef` — the shell's right-hand panel rather than a
 * dialog. Everything it announces goes through outputs here, and it has to carry its own
 * way out: there is no backdrop, and above the `members` breakpoint no Escape either.
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
        provide: PresenceService,
        useValue: { presenceFor: () => signal('online') },
      },
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>('@me:hs').asReadonly(),
      }),
      MockProvider(RoomModerationService),
      MockProvider(RoomsService, {
        createDirectMessage: vi.fn(() => of('!dm:hs')),
      }),
      MockProvider(VerificationService),
      MockProvider(IgnoredUsersService, { isIgnored: () => false }),
      MockProvider(TrnAlertService),
    ],
  });
  return { container, messaged, dismissals: () => dismissals };
}

describe('MemberInfoComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('carries its own close button as the panel, where nothing else closes it', async () => {
    // In the slot there is no backdrop, and above the `members` breakpoint no Escape either
    // — without this the panel was a dead end: the roster it replaced is gone, so there is
    // nothing left to click.
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

  it('has no close button as a dialog, where the backdrop and Escape do it', async () => {
    // The pair to the test above, and the reason the header is conditional rather than
    // always on: a dialog that grew a second dismissal would be the odd one out among them.
    const { container } = await build();

    expect(
      container.querySelector('[data-testid="member-info-close"]'),
    ).toBeNull();
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
      container.querySelector<HTMLInputElement>(
        '[data-testid="member-info-handle"]',
      )?.value,
    ).toBe('@bob:hs');
    expect(container.textContent).toContain('Admin');
  });

  it('verifies a member over a DM and closes the panel', async () => {
    const { cmp, createDirectMessage, startUserVerification, close } =
      await build(member({ userId: '@bob:hs' }));

    cmp.verify();

    expect(createDirectMessage).toHaveBeenCalledWith('@bob:hs');
    expect(startUserVerification).toHaveBeenCalledWith('@bob:hs', '!dm:hs');
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
      expect.objectContaining({ variant: 'destructive' }),
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
      expect.objectContaining({ variant: 'destructive' }),
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
      expect.objectContaining({ variant: 'destructive' }),
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
      expect.objectContaining({ variant: 'destructive' }),
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
      expect.objectContaining({ variant: 'destructive' }),
    );
  });

  it('selects the complete user id when the handle receives keyboard focus', async () => {
    const { container } = await build();
    const handle = container.querySelector<HTMLInputElement>(
      '[data-testid="member-info-handle"]',
    )!;

    handle.focus();

    expect(document.activeElement).toBe(handle);
    expect(handle.selectionStart).toBe(0);
    expect(handle.selectionEnd).toBe('@bob:hs'.length);
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
    const alertPrompt = vi.fn().mockResolvedValue('spam');
    const { cmp, kick, close } = await build(member(), {
      canKick: true,
      alertPrompt,
    });

    await cmp.kick();

    expect(kick).toHaveBeenCalledWith('!r:hs', '@bob:hs', 'spam');
    expect(close).toHaveBeenCalledWith(null);
  });

  it('does not kick when the confirmation is cancelled', async () => {
    const alertPrompt = vi.fn().mockResolvedValue(null); // cancelled
    const { cmp, kick } = await build(member(), { canKick: true, alertPrompt });

    await cmp.kick();

    expect(kick).not.toHaveBeenCalled();
  });

  it('bans the member (no reason → undefined) and closes on confirm', async () => {
    const alertPrompt = vi.fn().mockResolvedValue('');
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
    const alertPrompt = vi.fn().mockResolvedValue('');
    const { cmp, close, toastShow } = await build(member(), {
      canKick: true,
      kick,
      alertPrompt,
    });

    await cmp.kick();

    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'destructive' }),
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

  it('styles a demotion from the live target role as destructive', async () => {
    const alertConfirm = vi.fn().mockResolvedValue(false);
    const { cmp } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 100,
      targetPower: 100,
      alertConfirm,
    });

    await cmp.setRole({ label: 'Moderator', level: 50 });

    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true }),
    );
  });

  it('does not change the role when the confirmation is cancelled', async () => {
    const setPowerLevel = vi.fn(() => of(undefined));
    const alertConfirm = vi.fn().mockResolvedValue(false);
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

  it('offers Unblock for an ignored member and unblocks them on click', async () => {
    const { cmp, unignore } = await build(member(), { isIgnored: true });
    expect(cmp.ignored()).toBe(true);

    cmp.toggleIgnore();

    expect(unignore).toHaveBeenCalledWith('@bob:hs');
    expect(cmp.ignored()).toBe(false);
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
