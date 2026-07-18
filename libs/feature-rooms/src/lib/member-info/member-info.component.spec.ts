import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import {
  DialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/helm/overlay';
import {
  IgnoredUsersService,
  PresenceService,
} from '@trinity/data-access-profile';
import {
  RoomModerationService,
  RoomsService,
  type MemberSummary,
} from '@trinity/data-access-rooms';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { VerificationService } from '@trinity/data-access-crypto';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberInfoComponent } from './member-info.component';

function member(over: Partial<MemberSummary> = {}): MemberSummary {
  return {
    userId: '@bob:hs',
    name: 'Bob',
    initial: 'B',
    avatarMxc: null,
    powerLevel: 0,
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
    kick?: ReturnType<typeof vi.fn>;
    ban?: ReturnType<typeof vi.fn>;
    setPowerLevel?: ReturnType<typeof vi.fn>;
    alertPrompt?: ReturnType<typeof vi.fn>;
    alertConfirm?: ReturnType<typeof vi.fn>;
    isIgnored?: boolean;
    ignore?: ReturnType<typeof vi.fn>;
    unignore?: ReturnType<typeof vi.fn>;
    createDirectMessage?: ReturnType<typeof vi.fn>;
    startUserVerification?: ReturnType<typeof vi.fn>;
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
      canKick: opts.canKick ?? false,
      canBan: opts.canBan ?? false,
      canSetPower: opts.canSetPower ?? false,
      myPower: opts.myPower ?? 0,
    },
    providers: [
      MockProvider(DialogRef, { close }),
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

describe('MemberInfoComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the member name, id, and role', async () => {
    const { container } = await build(member({ powerLevel: 100 }));
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('@bob:hs');
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
      'Could not copy the user ID.',
      expect.anything(),
    );
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

  it('hides kick/ban actions without permission', async () => {
    const { container } = await build(); // canKick/canBan default false
    expect(
      container.querySelector('[data-testid="member-info-kick"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="member-info-ban"]'),
    ).toBeNull();
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

  it('offers roles at or below your level, minus the member’s current one', async () => {
    const { cmp } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 100,
    });
    // Member (0) is the current role and excluded; Moderator + Admin remain.
    expect(cmp.roleOptions().map((r) => r.level)).toEqual([50, 100]);
  });

  it('renders a button only for each assignable role', async () => {
    const { container } = await build(member({ powerLevel: 0 }), {
      canSetPower: true,
      myPower: 50, // can reach Moderator, not Admin
    });
    expect(
      container.querySelector('[data-testid="member-info-role-50"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="member-info-role-100"]'),
    ).toBeNull();
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
