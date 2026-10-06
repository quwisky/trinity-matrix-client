import { Component, signal } from '@angular/core';
import { WORKSPACE_SYSTEM_STATUS } from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import { provideRouter, Router, type Routes } from '@angular/router';
import {
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import {
  TrustService,
  TrustVerificationService,
  type TrustStatus,
} from '@trinity/data-access/trust';
import { BUILD_INFO } from '@trinity/platform-native';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type {
  ApplicationRecoveryOutcome,
  ApplicationRuntimeState,
} from '../application-runtime.models';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { SystemStatusVisibilityService } from '../system-status-visibility.service';
import { CapabilityHealthService } from '../capability-health.service';
import { ApplicationRootComponent } from './application-root.component';
import { TrinityApplicationSessionAdapter } from '../composition/trinity-application-session.adapter';

@Component({
  standalone: true,
  template: '<p>probe</p>',
})
class RouteProbeComponent {}

describe('ApplicationRootComponent', () => {
  async function setup(initial: ApplicationRuntimeState, routes: Routes = []) {
    const state = signal(initial);
    const trust = signal<TrustStatus>('ready');
    const recover = vi.fn<() => Observable<ApplicationRecoveryOutcome>>(() =>
      of({ kind: 'accepted' }),
    );
    const prompt = vi.fn(() => of<string | null>(null));
    const confirm = vi.fn(() => of(true));
    const showToast = vi.fn();
    const hasOpenDialog = vi.fn(() => false);
    const rendered = await render(ApplicationRootComponent, {
      providers: [
        provideRouter(routes),
        provideTrnIcons(),
        {
          provide: WORKSPACE_SYSTEM_STATUS,
          useValue: {
            hasProblems: signal(false),
            bannerSlot: signal(null),
            show: vi.fn(),
          },
        },
        { provide: ApplicationRuntimeService, useValue: { state, recover } },
        {
          provide: BUILD_INFO,
          useValue: { version: '1.2.3', commit: 'test', builtAt: '' },
        },
        MockProvider(AccountIdentitiesService, {
          identityOf: (id: string) => ({
            userId: id,
            displayName: 'Alice',
            avatarMxc: null,
          }),
        }),
        MockProvider(TrustService, { status: trust.asReadonly() }),
        MockProvider(TrustVerificationService, { active: signal(null) }),
        MockProvider(TrnDialogService, { hasOpen: hasOpenDialog }),
        MockProvider(TrnAlertService, { prompt$: prompt, confirm$: confirm }),
        MockProvider(TrnToastService, { show: showToast }),
        MockProvider(TrinityApplicationSessionAdapter, {
          runInteractions: () => NEVER,
        }),
      ],
    });
    return {
      ...rendered,
      state,
      trust,
      recover,
      prompt,
      confirm,
      hasOpenDialog,
      showToast,
      router: rendered.fixture.debugElement.injector.get(Router),
      health: rendered.fixture.debugElement.injector.get(
        CapabilityHealthService,
      ),
    };
  }

  it('keeps the healthy fallback on login and removes it across every shell URL', async () => {
    const { fixture, router, getByTestId, queryByTestId } = await setup(
      { phase: 'ready', attempt: 1, settlements: [] },
      [
        { path: 'login', component: RouteProbeComponent },
        { path: 'rooms', component: RouteProbeComponent },
        { path: 'rooms/:roomId', component: RouteProbeComponent },
      ],
    );

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

    state.set({ phase: 'ready', attempt: 1, settlements: [] });
    fixture.detectChanges();
    expect(queryByTestId('app-booting')).toBeNull();
    expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
  });

  it('focuses blocked startup on user-function copy and confirms Account removal', async () => {
    const { fixture, getByTestId, recover, confirm } = await setup({
      phase: 'blocked',
      attempt: 1,
      failure: {
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      },
      settlements: [],
    });
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
    const installation = await setup({
      phase: 'blocked',
      attempt: 1,
      failure: {
        stage: 'account-restoration',
        recovery: 'reset-installation',
        diagnostic: { code: 'account-local-state-unavailable' },
      },
      settlements: [],
    });
    installation.prompt.mockReturnValueOnce(of('RESET TRINITY'));
    installation.getByTestId('app-startup-recovery').click();
    installation.fixture.detectChanges();
    expect(installation.recover).toHaveBeenCalledOnce();
    expect(installation.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ placeholder: 'RESET TRINITY' }),
    );

    installation.state.set({
      phase: 'blocked',
      attempt: 2,
      failure: {
        stage: 'preference-hydration',
        recovery: 'reset-preferences',
        diagnostic: { code: 'preference-safe-baseline-unavailable' },
      },
      settlements: [],
    });
    installation.fixture.detectChanges();
    installation.prompt.mockReturnValueOnce(of('DEFAULTS'));
    installation.getByTestId('app-startup-recovery').click();
    installation.fixture.detectChanges();
    expect(installation.recover).toHaveBeenCalledTimes(2);
    expect(installation.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ placeholder: 'DEFAULTS' }),
    );
  });

  it('keeps System status open when Escape dismisses a recovery confirmation', async () => {
    const { fixture, getByTestId, queryByTestId, confirm, hasOpenDialog } =
      await setup({
        phase: 'blocked',
        attempt: 1,
        failure: {
          stage: 'account-restoration',
          recovery: 'reauthenticate',
          diagnostic: { code: 'active-account-unavailable' },
        },
        settlements: [],
      });
    [...fixture.nativeElement.querySelectorAll('button')]
      .find((item: HTMLButtonElement) =>
        item.textContent?.includes('System status'),
      )
      .click();
    fixture.detectChanges();
    confirm.mockReturnValue(NEVER);
    [...fixture.nativeElement.querySelectorAll('button')]
      .find((item: HTMLButtonElement) =>
        item.textContent?.includes('Sign in again'),
      )
      .click();
    hasOpenDialog.mockReturnValue(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(getByTestId('system-status')).toBeTruthy();

    hasOpenDialog.mockReturnValue(false);
    const handledByConfirmation = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
    });
    handledByConfirmation.preventDefault();
    document.dispatchEvent(handledByConfirmation);
    fixture.detectChanges();
    expect(getByTestId('system-status')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(queryByTestId('system-status')).toBeNull();
  });

  it('keeps routed content while grouping scoped problems in System status', async () => {
    const { fixture, health, getByTestId } = await setup({
      phase: 'ready',
      attempt: 1,
      settlements: [],
    });
    const context = Symbol('private-account-id');
    health.presentForAccount(context, '@private:example.org');
    health.report(
      {
        capability: 'accounts',
        operation: 'restore',
        context,
        generation: 1,
        demanded: true,
        preparation: 'failed',
        ownership: 'retained',
        condition: 'degraded',
        code: 'account-restore-transient-network',
      },
      () => of({ kind: 'success' as const }),
    );
    fixture.detectChanges();

    expect(
      getByTestId('app-capability-summary').closest('trn-banner'),
    ).toBeTruthy();
    expect(getByTestId('app-capability-summary').textContent).toContain(
      'A background Account needs attention.',
    );
    const button = [...fixture.nativeElement.querySelectorAll('button')].find(
      (item: HTMLButtonElement) => item.textContent?.includes('System status'),
    );
    button.click();
    fixture.detectChanges();
    const status = getByTestId('system-status');
    expect(status.textContent).toContain('Accounts');
    expect(status.textContent).toContain('Alice');
    expect(status.textContent).not.toContain('@private:example.org');
    expect(status.textContent).toContain('1 actionable scope');
  });

  it('shows one banner at a time and yields the slot to the encryption prompt', async () => {
    const { fixture, health, trust, getByTestId, queryByTestId } = await setup({
      phase: 'ready',
      attempt: 1,
      settlements: [],
    });
    health.report(
      {
        capability: 'accounts',
        operation: 'restore',
        context: Symbol('account'),
        generation: 1,
        demanded: true,
        preparation: 'failed',
        ownership: 'retained',
        condition: 'degraded',
        code: 'account-restore-transient-network',
      },
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
    const { fixture, getByTestId, getByRole, queryByRole } = await setup({
      phase: 'blocked',
      attempt: 1,
      failure: {
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      },
      settlements: [],
    });
    // The startup entry point is available independently of a ready Workspace.
    getByRole('button', { name: 'System status' }).click();
    fixture.detectChanges();
    const navigation = getByRole('navigation', {
      name: 'System status sections',
    });
    expect(navigation).toBeTruthy();
    expect(getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(getByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(getByTestId('system-status').textContent).toContain(
      'Trinity could not finish starting',
    );

    getByRole('button', { name: 'Support details' }).click();
    fixture.detectChanges();
    expect(getByRole('heading', { name: 'Support details' })).toBeTruthy();
    expect(getByRole('button', { name: 'Copy support details' })).toBeTruthy();
    expect(queryByRole('heading', { name: 'Overview' })).toBeNull();
    expect(getByTestId('app-startup-blocked')).toBeTruthy();
  });

  it('keeps the selected capability through refresh and returns to Overview when it resolves', async () => {
    const { fixture, health, getByRole, getByTestId, queryByRole } =
      await setup({
        phase: 'ready',
        attempt: 1,
        settlements: [],
      });
    const fact = {
      capability: 'accounts',
      operation: 'restore',
      context: Symbol('account'),
      generation: 1,
      demanded: true,
      preparation: 'failed' as const,
      ownership: 'retained' as const,
      condition: 'degraded' as const,
      code: 'account-restore-transient-network',
    };
    health.report(fact, () => of({ kind: 'success' as const }));
    fixture.detectChanges();
    getByRole('button', { name: 'System status' }).click();
    fixture.detectChanges();
    getByRole('button', { name: 'Accounts' }).click();
    fixture.detectChanges();
    expect(queryByRole('heading', { name: 'Overview' })).toBeNull();
    expect(getByRole('heading', { name: 'Accounts' })).toBeTruthy();

    health.report(fact, () => of({ kind: 'success' as const }));
    fixture.detectChanges();
    expect(getByRole('button', { name: 'Accounts' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    health.reset();
    fixture.detectChanges();
    expect(queryByRole('button', { name: 'Accounts' })).toBeNull();
    expect(getByRole('heading', { name: 'Overview' })).toBeTruthy();
    expect(getByTestId('system-status-all-working')).toBeTruthy();
  });

  it('returns mobile Back to sections before dismissing System status', async () => {
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    try {
      const { fixture, getByTestId, getByRole, queryByTestId } = await setup({
        phase: 'ready',
        attempt: 1,
        settlements: [],
      });
      getByTestId('system-status-access').click();
      fixture.detectChanges();
      getByRole('button', { name: 'Back to sections' }).click();
      fixture.detectChanges();
      expect(getByTestId('system-status-detail')).toHaveClass(
        'settings-pane--hidden',
      );
      expect(getByTestId('system-status-directory')).not.toHaveClass(
        'settings-pane--hidden',
      );
      getByRole('button', { name: 'Support details' }).click();
      fixture.detectChanges();
      expect(getByRole('heading', { name: 'Support details' })).toBeTruthy();

      const visibility = fixture.debugElement.injector.get(
        SystemStatusVisibilityService,
      );
      visibility.back();
      fixture.detectChanges();
      expect(getByTestId('system-status-directory')).not.toHaveClass(
        'settings-pane--hidden',
      );
      visibility.back();
      fixture.detectChanges();
      expect(queryByTestId('system-status')).toBeNull();
      getByTestId('system-status-access').click();
      fixture.detectChanges();
      expect(getByRole('heading', { name: 'Overview' })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', width);
    }
  });

  it('keeps an all-working System status entry point available', async () => {
    const { fixture, getByTestId } = await setup({
      phase: 'ready',
      attempt: 1,
      settlements: [],
    });
    getByTestId('system-status-access').click();
    fixture.detectChanges();
    expect(getByTestId('system-status-all-working').textContent).toContain(
      'All systems are working',
    );
  });

  it('uses the safe generic catalogue entry for an unknown fault', async () => {
    const { fixture, health, getByTestId } = await setup({
      phase: 'ready',
      attempt: 1,
      settlements: [],
    });
    health.report(
      {
        capability: 'future',
        operation: 'unrecognized',
        context: Symbol(),
        generation: 1,
        demanded: true,
        preparation: 'failed',
        ownership: 'released',
        condition: 'degraded',
        code: 'safe-unknown-code',
      },
      () => of({ kind: 'unavailable' as const }),
    );
    fixture.detectChanges();
    [...fixture.nativeElement.querySelectorAll('button')]
      .find((item: HTMLButtonElement) =>
        item.textContent?.includes('System status'),
      )
      .click();
    fixture.detectChanges();
    expect(getByTestId('system-status').textContent).toContain(
      'A feature needs attention',
    );
    expect(
      fixture.nativeElement.querySelector('.system-status__entry').textContent,
    ).not.toContain('safe-unknown-code');
  });
});
