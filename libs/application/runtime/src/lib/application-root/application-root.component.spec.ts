import { ApplicationRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  WORKSPACE_SYSTEM_STATUS,
  WorkspaceBackService,
} from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import { provideRouter, Router, type Routes } from '@angular/router';
import {
  TrnAlertService,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { AppLockService } from '@trinity/data-access/app-lock';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  TrustService,
  TrustVerificationService,
  type TrustStatus,
} from '@trinity/data-access/trust';
import {
  AppRestartService,
  BUG_REPORT_LAUNCHER,
  BUILD_INFO,
  SessionLockService,
  type SessionLockState,
} from '@trinity/platform-native';
import {
  HostLockIntegrationService,
  NO_USER_PRESENCE,
} from '@trinity/runtime/host';
import { render, screen, TIMERS } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { EMPTY, NEVER, Observable, firstValueFrom, of } from 'rxjs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ApplicationRecoveryOutcome,
  ApplicationRuntimeState,
} from '../application-runtime.models';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { SystemStatusVisibilityService } from '../system-status-visibility.service';
import { CapabilityHealthService } from '../capability-health.service';
import { healthFact } from '../testing/capability-health.fixture';
import { ApplicationRootComponent } from './application-root.component';
import { TrinityApplicationSessionAdapter } from '../composition/trinity-application-session.adapter';
import { AppLockLifecycleBinding } from '../composition/app-lock-lifecycle.binding';

@Component({
  standalone: true,
  template: '<p>probe</p>',
})
class RouteProbeComponent {}

@Component({ template: '<p>Probe dialog</p>' })
class ProbeDialogComponent {}

/** Run the root's effects, then render what the overlay container now holds. */
function settle(fixture: { detectChanges(): void }): void {
  fixture.detectChanges();
  TestBed.inject(ApplicationRef).tick();
}

const READY: ApplicationRuntimeState = {
  phase: 'ready',
  attempt: 1,
  settlements: [],
};

function blocked(
  failure: Extract<ApplicationRuntimeState, { phase: 'blocked' }>['failure'],
  attempt = 1,
): ApplicationRuntimeState {
  return { phase: 'blocked', attempt, failure, settlements: [] };
}

/** Open System status through the entry button the capability banner and startup screens share. */
function openSystemStatus(fixture: {
  nativeElement: HTMLElement;
  detectChanges(): void;
}): void {
  [...fixture.nativeElement.querySelectorAll('button')]
    .find((item) => item.textContent?.includes('System status'))!
    .click();
  settle(fixture);
}

describe('ApplicationRootComponent', () => {
  beforeAll(() => {
    // jsdom has no top layer; record App lock's modal as an open attribute.
    HTMLDialogElement.prototype.showModal ??= function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '');
    };
  });
  afterEach(() => vi.useRealTimers());

  async function setup(
    initial: ApplicationRuntimeState,
    routes: Routes = [],
    lock: SessionLockState = 'held',
    appLocked = false,
  ) {
    const state = signal(initial);
    const trust = signal<TrustStatus>('ready');
    const recover = vi.fn<() => Observable<ApplicationRecoveryOutcome>>(() =>
      of({ kind: 'accepted' }),
    );
    const prompt = vi.fn(() => of<string | null>(null));
    const confirm = vi.fn(() => of(true));
    const showToast = vi.fn();
    const openReport = vi.fn();
    const lockState = signal<SessionLockState>(lock);
    const requestHandover = vi.fn();
    let lockLifetimeStarted = 0;
    const lockLifetime = new Observable<never>(() => {
      lockLifetimeStarted += 1;
    });
    const rendered = await render(ApplicationRootComponent, {
      providers: [
        provideRouter(routes),
        provideTrnIcons(),
        {
          provide: WORKSPACE_SYSTEM_STATUS,
          useValue: {
            hasProblems: signal(false),
            bannerSlot: signal(null),
            bannerSlotReserved: signal(false),
            bannerPrompt: signal(null),
            show: vi.fn(),
          },
        },
        { provide: ApplicationRuntimeService, useValue: { state, recover } },
        {
          provide: BUILD_INFO,
          useValue: { version: '1.2.3', commit: 'test', builtAt: '' },
        },
        { provide: BUG_REPORT_LAUNCHER, useValue: { open: openReport } },
        MockProvider(AccountIdentitiesService, {
          identityOf: (id: string) => ({
            userId: id,
            displayName: 'Alice',
            avatarMxc: null,
          }),
        }),
        MockProvider(TrustService, {
          status: trust.asReadonly(),
          recoverySetupElsewhere: signal(false).asReadonly(),
        }),
        MockProvider(TrustVerificationService, { active: signal(null) }),
        MockProvider(TrnAlertService, { prompt$: prompt, confirm$: confirm }),
        MockProvider(TrnToastService, { show: showToast }),
        MockProvider(TrinityApplicationSessionAdapter, {
          runInteractions: () => NEVER,
        }),
        MockProvider(SessionLockService, {
          state: lockState.asReadonly(),
          requestHandover,
        }),
        MockProvider(AppLockLifecycleBinding, {
          run: () => lockLifetime,
          visits: EMPTY,
        }),
        MockProvider(AppLockService, {
          appName: 'Trinity',
          locked: signal(appLocked).asReadonly(),
          status: signal(
            appLocked ? ('locked' as const) : ('off' as const),
          ).asReadonly(),
          support: signal(NO_USER_PRESENCE).asReadonly(),
          systemAvailable: signal(false).asReadonly(),
          pinState: signal<'ready'>('ready').asReadonly(),
          recoveryOnly: signal(false).asReadonly(),
          systemWaitUntil: signal(null).asReadonly(),
          refreshSupport: () => of(NO_USER_PRESENCE),
        }),
        MockProvider(HostLockIntegrationService, {
          coverPainted: () => of({ kind: 'completed' as const }),
        }),
        MockProvider(AccountRuntimeService),
        MockProvider(AppRestartService),
      ],
    });
    return {
      ...rendered,
      state,
      trust,
      recover,
      prompt,
      confirm,
      showToast,
      openReport,
      lockState,
      requestHandover,
      lockLifetimeStarted: () => lockLifetimeStarted,
      router: rendered.fixture.debugElement.injector.get(Router),
      health: rendered.fixture.debugElement.injector.get(
        CapabilityHealthService,
      ),
    };
  }

  it('runs App lock’s away timer from the first render, before anyone signs in', async () => {
    const { lockLifetimeStarted } = await setup({ phase: 'stopped' });
    expect(lockLifetimeStarted()).toBe(1);
  });

  it('mounts App lock’s cover outside the startup screens, closed while unlocked', async () => {
    const { container } = await setup({ phase: 'stopped' });
    const workspace = container.querySelector('div') as HTMLElement;
    const cover = document.querySelector('trn-app-lock-cover');
    expect(cover).toBeTruthy();
    // In its own <body> child, which an open CDK dialog's aria-hidden walk skips. A cover
    // inside a control-flow block would be put back into the root when the block renders.
    expect(cover?.parentElement).toBe(document.body);
    expect(container.contains(cover)).toBe(false);
    expect(screen.getByTestId('app-lock-cover').hasAttribute('open')).toBe(
      false,
    );
    expect(workspace.style.visibility).toBe('');
  });

  it('hides the workspace and opens the cover in the first frame when the app starts locked', async () => {
    const { container } = await setup({ phase: 'stopped' }, [], 'held', true);
    const workspace = container.querySelector('div') as HTMLElement;
    expect(workspace.contains(screen.getByTestId('app-booting'))).toBe(true);
    expect(workspace.style.visibility).toBe('hidden');
    expect(screen.getByTestId('app-lock-cover').hasAttribute('open')).toBe(
      true,
    );
    expect(workspace.contains(screen.getByTestId('app-lock-cover'))).toBe(
      false,
    );
  });

  it('keeps the healthy fallback on login and removes it across every shell URL', async () => {
    const { fixture, router, getByTestId, queryByTestId } = await setup(READY, [
      { path: 'login', component: RouteProbeComponent },
      { path: 'rooms', component: RouteProbeComponent },
      { path: 'rooms/:roomId', component: RouteProbeComponent },
    ]);

    await router.navigateByUrl('/login');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(getByTestId('system-status-access')).toBeTruthy();

    await router.navigateByUrl('/rooms?view=recent');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(queryByTestId('system-status-access')).toBeNull();

    await router.navigateByUrl('/rooms/room');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(queryByTestId('system-status-access')).toBeNull();

    await router.navigateByUrl('/login?returnTo=%2Frooms');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(getByTestId('system-status-access')).toBeTruthy();
  });

  it('keeps fast startup calm and reveals routed content only after readiness', async () => {
    const { fixture, state, getByTestId, queryByTestId } = await setup({
      phase: 'starting',
      attempt: 1,
      stage: 'account-restoration',
      settlements: [],
    });
    expect(getByTestId('app-booting').textContent).not.toContain(
      'Restoring your Accounts',
    );

    state.set(READY);
    fixture.detectChanges();
    expect(queryByTestId('app-booting')).toBeNull();
    expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
  });

  it('asks to unlock the keychain when it blocks startup', async () => {
    const { getByTestId } = await setup(
      blocked({
        stage: 'account-restoration',
        recovery: 'retry-startup',
        secondaryRecovery: 'reauthenticate',
        diagnostic: { code: 'account-secure-storage-unavailable' },
      }),
    );

    expect(getByTestId('app-startup-blocked').textContent).toContain(
      'Your system keychain is locked or unavailable. Unlock it and try again.',
    );
    expect(getByTestId('app-startup-recovery').textContent).toContain(
      'Retry startup',
    );
  });

  it('offers account removal behind a confirm when the keychain blocks startup', async () => {
    const { fixture, getByTestId, recover, confirm } = await setup(
      blocked({
        stage: 'account-restoration',
        recovery: 'retry-startup',
        secondaryRecovery: 'reauthenticate',
        diagnostic: { code: 'account-secure-storage-unavailable' },
      }),
    );
    const remove = getByTestId('app-startup-secondary-recovery');
    expect(remove.textContent).toContain('Remove account');

    confirm.mockReturnValueOnce(of(false));
    remove.click();
    fixture.detectChanges();
    expect(recover).not.toHaveBeenCalled();

    remove.click();
    fixture.detectChanges();
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        header: 'Remove account and sign in again',
        message: expect.stringContaining('local encryption keys'),
      }),
    );
    expect(recover).toHaveBeenCalledExactlyOnceWith('reauthenticate');
  });

  it('focuses blocked startup on user-function copy and confirms Account removal', async () => {
    const { fixture, getByTestId, recover, confirm } = await setup(
      blocked({
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      }),
    );
    expect(getByTestId('app-startup-blocked').textContent).toContain(
      'required account session',
    );
    getByTestId('app-startup-recovery').click();
    fixture.detectChanges();
    expect(recover).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        header: 'Remove account and sign in again',
        confirmText: 'Remove account',
        variant: 'danger',
      }),
    );
  });

  it('preserves exact RESET TRINITY and DEFAULTS confirmations', async () => {
    const installation = await setup(
      blocked({
        stage: 'account-restoration',
        recovery: 'reset-installation',
        diagnostic: { code: 'account-local-state-unavailable' },
      }),
    );
    installation.prompt.mockReturnValueOnce(of('RESET TRINITY'));
    installation.getByTestId('app-startup-recovery').click();
    installation.fixture.detectChanges();
    expect(installation.recover).toHaveBeenCalledOnce();
    expect(installation.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ placeholder: 'RESET TRINITY' }),
    );

    installation.state.set(
      blocked(
        {
          stage: 'preference-hydration',
          recovery: 'reset-preferences',
          diagnostic: { code: 'preference-safe-baseline-unavailable' },
        },
        2,
      ),
    );
    installation.fixture.detectChanges();
    installation.prompt.mockReturnValueOnce(of('DEFAULTS'));
    installation.getByTestId('app-startup-recovery').click();
    installation.fixture.detectChanges();
    expect(installation.recover).toHaveBeenCalledTimes(2);
    expect(installation.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ placeholder: 'DEFAULTS' }),
    );
  });

  it('presents System status as a surface that Escape closes', async () => {
    const { fixture, getByTestId } = await setup(READY);
    getByTestId('system-status-access').click();
    settle(fixture);
    expect(screen.getByRole('dialog', { name: 'System status' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBe(
      document.activeElement,
    );

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 27,
        bubbles: true,
      }),
    );
    settle(fixture);

    expect(screen.queryByRole('dialog', { name: 'System status' })).toBeNull();
    expect(
      fixture.debugElement.injector.get(SystemStatusVisibilityService).open(),
    ).toBe(false);
  });

  it('closes the System status surface when its state closes', async () => {
    const { fixture, getByTestId } = await setup(READY);
    getByTestId('system-status-access').click();
    settle(fixture);

    fixture.debugElement.injector.get(SystemStatusVisibilityService).close();
    settle(fixture);

    expect(screen.queryByRole('dialog', { name: 'System status' })).toBeNull();
  });

  it('stacks System status over an open dialog and closes it first', async () => {
    const { fixture, getByTestId } = await setup(READY);
    const surfaces = TestBed.inject(TrnSurfaceService);
    surfaces.open(ProbeDialogComponent, { ariaLabel: 'Probe' });
    settle(fixture);
    getByTestId('system-status-access').click();
    settle(fixture);
    expect(screen.getByRole('dialog', { name: 'System status' })).toBeTruthy();

    expect(surfaces.closeTopmost()).toBe(true);
    settle(fixture);

    expect(screen.queryByRole('dialog', { name: 'System status' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Probe' })).toBeTruthy();
    expect(
      fixture.debugElement.injector.get(SystemStatusVisibilityService).open(),
    ).toBe(false);
    surfaces.closeAll();
  });

  it('keeps routed content while grouping scoped problems in System status', async () => {
    const { fixture, health, getByTestId } = await setup(READY);
    const context = Symbol('private-account-id');
    health.presentForAccount(context, '@private:example.org');
    health.report(
      healthFact({
        capability: 'accounts',
        operation: 'restore',
        context,
        code: 'account-restore-transient-network',
      }),
      () => of({ kind: 'success' as const }),
    );
    fixture.detectChanges();

    expect(
      getByTestId('app-capability-summary').closest('trn-banner'),
    ).toBeTruthy();
    expect(getByTestId('app-capability-summary').textContent).toContain(
      'A background Account needs attention.',
    );
    openSystemStatus(fixture);
    const status = screen.getByTestId('system-status');
    expect(status.textContent).toContain('Accounts');
    expect(status.textContent).toContain('Alice');
    expect(status.textContent).not.toContain('@private:example.org');
    expect(status.textContent).toContain('1 actionable scope');
  });

  it('shows one banner at a time and yields the slot to the encryption prompt', async () => {
    const { fixture, health, trust, getByTestId, queryByTestId } =
      await setup(READY);
    health.report(
      healthFact({
        capability: 'accounts',
        operation: 'restore',
        context: Symbol('account'),
        code: 'account-restore-transient-network',
      }),
      () => of({ kind: 'success' as const }),
    );
    fixture.detectChanges();
    expect(getByTestId('app-capability-summary')).toBeTruthy();

    trust.set('needs-setup');
    fixture.detectChanges();
    expect(queryByTestId('app-capability-summary')).toBeNull();

    trust.set('ready');
    fixture.detectChanges();
    expect(getByTestId('app-capability-summary')).toBeTruthy();
  });

  it('opens Overview and navigates to safe Support details without leaving startup', async () => {
    const { fixture, getByRole } = await setup(
      blocked({
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      }),
    );
    // The startup entry point is available independently of a ready Workspace.
    getByRole('button', { name: 'System status' }).click();
    settle(fixture);
    const navigation = screen.getByRole('navigation', {
      name: 'System status sections',
    });
    expect(navigation).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByTestId('system-status').textContent).toContain(
      'Trinity could not finish starting',
    );

    screen.getByRole('button', { name: 'Support details' }).click();
    settle(fixture);
    expect(
      screen.getByRole('heading', { name: 'Support details' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Copy support details' }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Overview' })).toBeNull();
    expect(screen.getByTestId('app-startup-blocked')).toBeTruthy();
  });

  it('opens Report a bug over Support details, even while startup is blocked', async () => {
    const { fixture, getByRole, openReport } = await setup(
      blocked({
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      }),
    );

    getByRole('button', { name: 'System status' }).click();
    settle(fixture);
    screen.getByRole('button', { name: 'Support details' }).click();
    settle(fixture);
    screen.getByTestId('system-status-report-bug').click();
    settle(fixture);

    expect(openReport).toHaveBeenCalledOnce();
  });

  it('keeps the selected capability through refresh and returns to Overview when it resolves', async () => {
    const { fixture, health, getByRole } = await setup(READY);
    const fact = healthFact({
      capability: 'accounts',
      operation: 'restore',
      context: Symbol('account'),
      code: 'account-restore-transient-network',
    });
    health.report(fact, () => of({ kind: 'success' as const }));
    fixture.detectChanges();
    getByRole('button', { name: 'System status' }).click();
    settle(fixture);
    screen.getByRole('button', { name: 'Accounts' }).click();
    settle(fixture);
    expect(screen.queryByRole('heading', { name: 'Overview' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy();

    health.report(fact, () => of({ kind: 'success' as const }));
    settle(fixture);
    expect(screen.getByRole('button', { name: 'Accounts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    health.reset();
    settle(fixture);
    expect(screen.queryByRole('button', { name: 'Accounts' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByTestId('system-status-all-working')).toBeTruthy();
  });

  it('returns mobile Back to sections before dismissing System status', async () => {
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    try {
      const { fixture, getByTestId } = await setup(READY);
      getByTestId('system-status-access').click();
      settle(fixture);
      screen.getByRole('button', { name: 'Back to sections' }).click();
      settle(fixture);
      expect(screen.getByTestId('system-status-detail')).toHaveClass(
        'settings-pane--hidden',
      );
      expect(screen.getByTestId('system-status-directory')).not.toHaveClass(
        'settings-pane--hidden',
      );
      screen.getByRole('button', { name: 'Support details' }).click();
      settle(fixture);
      expect(
        screen.getByRole('heading', { name: 'Support details' }),
      ).toBeTruthy();

      const back = TestBed.inject(WorkspaceBackService);
      await firstValueFrom(back.back());
      settle(fixture);
      expect(screen.getByTestId('system-status-directory')).not.toHaveClass(
        'settings-pane--hidden',
      );
      // With the list showing nothing is registered; the host's Back closes the surface.
      await expect(firstValueFrom(back.back())).resolves.toEqual({
        kind: 'unhandled',
      });
      expect(TestBed.inject(TrnSurfaceService).closeTopmost()).toBe(true);
      settle(fixture);
      expect(screen.queryByTestId('system-status')).toBeNull();
      getByTestId('system-status-access').click();
      settle(fixture);
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', width);
    }
  });

  it('keeps an all-working System status entry point available', async () => {
    const { fixture, getByTestId } = await setup(READY);
    getByTestId('system-status-access').click();
    settle(fixture);
    expect(
      screen.getByTestId('system-status-all-working').textContent,
    ).toContain('All systems are working');
  });

  it('uses the safe generic catalogue entry for an unknown fault', async () => {
    const { fixture, health } = await setup(READY);
    health.report(
      healthFact({
        capability: 'future',
        operation: 'unrecognized',
        context: Symbol(),
        ownership: 'released',
        code: 'safe-unknown-code',
      }),
      () => of({ kind: 'unavailable' as const }),
    );
    fixture.detectChanges();
    openSystemStatus(fixture);
    expect(screen.getByTestId('system-status').textContent).toContain(
      'A feature needs attention',
    );
    expect(
      document.querySelector('.system-status__entry')?.textContent,
    ).not.toContain('safe-unknown-code');
  });

  it('never renders the routes while another tab runs Trinity', async () => {
    vi.useFakeTimers(TIMERS);
    const { fixture, queryByTestId } = await setup({
      phase: 'waiting-for-session',
      attempt: 1,
      settlements: [],
    });

    await vi.advanceTimersByTimeAsync(1_000);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('router-outlet')).toBeNull();
    expect(queryByTestId('app-startup-blocked')).toBeNull();
  });

  it('keeps the startup spinner for 500 ms, then shows the waiting notice instead of the workspace', async () => {
    vi.useFakeTimers(TIMERS);
    const { fixture, requestHandover, queryByTestId } = await setup(
      { phase: 'waiting-for-session', attempt: 1, settlements: [] },
      [],
      'waiting',
    );

    // A reloaded tab is usually granted its old page's lock by then: no false notice.
    await vi.advanceTimersByTimeAsync(400);
    fixture.detectChanges();
    expect(queryByTestId('app-booting')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();

    await vi.advanceTimersByTimeAsync(200);
    fixture.detectChanges();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Trinity is open in another tab',
      }),
    ).toBeInTheDocument();
    expect(queryByTestId('app-booting')).toBeNull();
    expect(queryByTestId('app-startup-blocked')).toBeNull();

    screen.getByRole('button', { name: 'Use here' }).click();

    expect(requestHandover).toHaveBeenCalledOnce();
  });

  it('follows the lock from "Use here" to "Try again"', async () => {
    vi.useFakeTimers(TIMERS);
    const { fixture, lockState } = await setup(
      { phase: 'waiting-for-session', attempt: 1, settlements: [] },
      [],
      'waiting',
    );
    await vi.advanceTimersByTimeAsync(600);

    lockState.set('taking-over');
    fixture.detectChanges();
    expect(screen.getByTestId('session-lock-status')).toHaveTextContent(
      'Moving Trinity to this tab…',
    );

    lockState.set('handover-timed-out');
    fixture.detectChanges();
    expect(screen.getByTestId('session-lock-status')).toHaveTextContent(
      'The other tab didn’t respond. It may be asleep or busy.',
    );
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  it('shows the secure-connection notice, not the startup recovery page, when the lock is unavailable', async () => {
    const { queryByTestId } = await setup(
      blocked({
        stage: 'session-lock',
        recovery: 'retry-startup',
        diagnostic: { code: 'session-lock-unavailable' },
      }),
      [],
      'unavailable',
    );

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Trinity needs a secure connection',
      }),
    ).toBeInTheDocument();
    expect(queryByTestId('app-startup-blocked')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry startup' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'System status' }),
    ).toBeInTheDocument();
  });
});
