import {
  type MemberSummary,
  ContentReportingService,
  RoomActionPermissionsService,
  RoomModerationService,
} from '@trinity/data-access/room-administration';
import { signal } from '@angular/core';
import { render, screen, within } from '@trinity/testing';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  IgnoredUsersService,
  IdentityService,
} from '@trinity/data-access/identity';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { MemberManageTabComponent } from './member-manage-tab.component';
import { ReportService } from '../../report/report.service';

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
    reportsOffered?: boolean;
    inputs?: Record<string, unknown>;
  } = {},
) {
  // The tab announces a landed moderation write; the shell closes the card on it.
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
  const { fixture, container } = await render(MemberManageTabComponent, {
    inputs: { member: m, roomId: '!r:hs', ...opts.inputs },
    on: { finished: () => close(null) },
    providers: [
      MockProvider(TrnToastService, { show: toastShow }),
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
  };
}

describe('MemberManageTabComponent', () => {
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
    const { cmp, fixture, ignore } = await build(member(), {
      activeUserId: '@other:hs',
    });
    fixture.componentRef.setInput('owningAccountId', '@me:hs');
    await fixture.whenStable();

    cmp.toggleIgnore();

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
    expect(close).toHaveBeenCalledWith(null);
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
    // The picker lists the current role too, checked; picking it changes nothing.
    const radio = (level: number) =>
      container.querySelector<HTMLInputElement>(
        `[data-testid="member-info-role-${level}"] input`,
      );
    expect(radio(100)?.disabled).toBe(true);
    expect(radio(0)?.checked).toBe(true);
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

    cmp.toggleIgnore();
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Could not update the block.',
    );
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('keeps its status region in place, empty, until there is something to say', async () => {
    await build(member());

    expect(screen.getByRole('status').matches(':empty')).toBe(true);
  });

  it('drops the confirmation once the list changes elsewhere', async () => {
    const { cmp, fixture, ignoredIds } = await build(member());
    cmp.toggleIgnore();
    fixture.detectChanges();

    ignoredIds.set([]);
    fixture.detectChanges();

    expect(screen.getByRole('status').matches(':empty')).toBe(true);
  });

  it('offers to report the member, named, as the active account', async () => {
    const { reportUser$ } = await build(member());

    screen.getByRole('button', { name: 'Report Bob' }).click();

    expect(reportUser$).toHaveBeenCalledExactlyOnceWith({
      accountId: '@me:hs',
      userId: '@bob:hs',
      name: 'Bob',
    });
  });

  it('hides Report once this server has said it does not take user reports', async () => {
    await build(member(), { reportsOffered: false });

    expect(screen.queryByRole('button', { name: 'Report Bob' })).toBeNull();
  });

  it('Safety section holds Block and Report', async () => {
    await build();

    const safety = screen.getByRole('region', { name: 'Safety' });
    expect(within(safety).getByTestId('member-info-ignore')).toBeTruthy();
    expect(
      within(safety).getByRole('button', { name: 'Report Bob' }),
    ).toBeTruthy();
  });

  it('Moderation section titled "Moderation · Design team" uses the role picker', async () => {
    const { alertConfirm } = await build(member(), {
      canSetPower: true,
      myPower: 100,
      inputs: { targetName: 'Design team' },
    });

    const moderation = screen.getByRole('region', {
      name: 'Moderation · Design team',
    });
    within(moderation)
      .getByRole('radiogroup', { name: 'Role in Design team' })
      .querySelector<HTMLElement>('[data-testid="member-info-role-50"]')
      ?.click();

    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ header: 'Change role' }),
    );
  });

  it('a member who left keeps Ban and hides Remove', async () => {
    await build(member(), {
      canBan: true,
      inputs: { hideUnavailableModeration: true },
    });

    expect(screen.getByTestId('member-info-ban')).toBeTruthy();
    expect(screen.queryByTestId('member-info-kick')).toBeNull();
  });

  it('showIdentityActions=false hides Safety', async () => {
    await build(member(), { inputs: { showIdentityActions: false } });

    expect(screen.queryByRole('region', { name: 'Safety' })).toBeNull();
    expect(screen.queryByTestId('member-info-ignore')).toBeNull();
  });

  it('hasContent is false when nothing would show', async () => {
    const { cmp, fixture } = await build(member(), {
      inputs: { showIdentityActions: false, hideUnavailableModeration: true },
    });

    expect(cmp.hasContent()).toBe(false);

    fixture.componentRef.setInput('showIdentityActions', true);
    expect(cmp.hasContent()).toBe(true);
  });
});
