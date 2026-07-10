import { signal } from '@angular/core';
import { render } from '@testing-library/angular';
import {
  DialogRef,
  TrnAlertService,
  TrnToastService,
} from '@trinity/helm/overlay';
import { PresenceService } from '@trinity/data-access-profile';
import {
  RoomModerationService,
  type MemberSummary,
} from '@trinity/data-access-rooms';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
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
  } = {},
) {
  const close = vi.fn();
  const toastShow = vi.fn();
  const kick = opts.kick ?? vi.fn(() => of(undefined));
  const ban = opts.ban ?? vi.fn(() => of(undefined));
  const setPowerLevel = opts.setPowerLevel ?? vi.fn(() => of(undefined));
  const alertPrompt = opts.alertPrompt ?? vi.fn().mockResolvedValue('');
  const alertConfirm = opts.alertConfirm ?? vi.fn().mockResolvedValue(true);
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

  it('copies the user id and toasts', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { cmp, toastShow } = await build();

    cmp.copyId();

    expect(writeText).toHaveBeenCalledWith('@bob:hs');
    expect(toastShow).toHaveBeenCalled();
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
});
