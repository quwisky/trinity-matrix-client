import { signal } from '@angular/core';
import { provideTrnIcons } from '@trinity/components/foundations';
import { provideRouter } from '@angular/router';
import {
  TrnAlertService,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { TrustVerificationService } from '@trinity/data-access/trust';
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

describe('ApplicationRootComponent', () => {
  async function setup(initial: ApplicationRuntimeState) {
    const state = signal(initial);
    const recover = vi.fn<() => Observable<ApplicationRecoveryOutcome>>(() =>
      of({ kind: 'accepted' }),
    );
    const prompt = vi.fn(() => of<string | null>(null));
    const confirm = vi.fn(() => of(true));
    const showToast = vi.fn();
    const hasOpenDialog = vi.fn(() => false);
    const rendered = await render(ApplicationRootComponent, {
      providers: [
        provideRouter([]),
        provideTrnIcons(),
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
      recover,
      prompt,
      confirm,
      hasOpenDialog,
      showToast,
      health: rendered.fixture.debugElement.injector.get(
        CapabilityHealthService,
      ),
    };
  }

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
      'required Account session',
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

  it('keeps System Status open when Escape dismisses a recovery confirmation', async () => {
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
        item.textContent?.includes('System Status'),
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

  it('keeps routed content while grouping scoped problems in System Status', async () => {
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

    expect(getByTestId('app-capability-summary').textContent).toContain(
      '1 limited capability',
    );
    const button = [...fixture.nativeElement.querySelectorAll('button')].find(
      (item: HTMLButtonElement) => item.textContent?.includes('System Status'),
    );
    button.click();
    fixture.detectChanges();
    const status = getByTestId('system-status');
    expect(status.textContent).toContain('Accounts');
    expect(status.textContent).toContain('Alice');
    expect(status.textContent).not.toContain('@private:example.org');
    expect(status.textContent).toContain('1 actionable scope');
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
    getByRole('button', { name: 'System Status' }).click();
    fixture.detectChanges();
    const navigation = getByRole('navigation', {
      name: 'System Status sections',
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
    getByRole('button', { name: 'System Status' }).click();
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

  it('returns mobile Back to sections before dismissing System Status', async () => {
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

  it('keeps an all-working System Status entry point available', async () => {
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
        item.textContent?.includes('System Status'),
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
