import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TrnDialogService } from '@trinity/components/overlay';
import { TrustVerificationService } from '@trinity/data-access/trust';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ApplicationRuntimeState } from '../application-runtime.models';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { CapabilityHealthService } from '../capability-health.service';
import { ApplicationRootComponent } from './application-root.component';

describe('ApplicationRootComponent', () => {
  async function setup(initial: ApplicationRuntimeState) {
    const state = signal(initial);
    const recover = vi.fn(() => of({ kind: 'accepted' as const }));
    const rendered = await render(ApplicationRootComponent, {
      providers: [
        provideRouter([]),
        { provide: ApplicationRuntimeService, useValue: { state, recover } },
        MockProvider(TrustVerificationService, { active: signal(null) }),
        MockProvider(TrnDialogService),
      ],
    });
    return {
      ...rendered,
      state,
      recover,
      health: rendered.fixture.debugElement.injector.get(
        CapabilityHealthService,
      ),
    };
  }

  it('presents runtime progress while startup is active', async () => {
    const { getByTestId } = await setup({
      phase: 'starting',
      attempt: 1,
      stage: 'account-restoration',
      warnings: [],
    });

    expect(getByTestId('app-booting')).toBeTruthy();
  });

  it('presents typed recovery and delegates retry without owning startup', async () => {
    const { fixture, getByTestId, recover } = await setup({
      phase: 'blocked',
      attempt: 1,
      failure: {
        stage: 'account-restoration',
        recovery: 'reauthenticate',
        diagnostic: { code: 'active-account-unavailable' },
      },
      warnings: [],
    });

    expect(getByTestId('app-startup-recovery').textContent).toContain(
      'Sign in again',
    );
    getByTestId('app-startup-recovery').click();
    fixture.detectChanges();

    expect(recover).toHaveBeenCalledOnce();
  });

  it('reveals the routed application only after readiness', async () => {
    const { fixture, state, queryByTestId } = await setup({
      phase: 'starting',
      attempt: 1,
      stage: 'readiness',
      warnings: [],
    });

    state.set({ phase: 'ready', attempt: 1, warnings: [] });
    fixture.detectChanges();

    expect(queryByTestId('app-booting')).toBeNull();
    expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
  });

  it('surfaces optional startup warnings without blocking the application', async () => {
    const { getByTestId } = await setup({
      phase: 'ready',
      attempt: 1,
      warnings: [
        {
          stage: 'session-capabilities',
          scope: 'push',
          diagnostic: { code: 'push-registration-failed' },
        },
        {
          stage: 'session',
          scope: 'trust',
          diagnostic: { code: 'trust-projection-unavailable' },
        },
        {
          stage: 'session',
          scope: 'identity',
          diagnostic: { code: 'identity-presence-unavailable' },
        },
        {
          stage: 'session',
          scope: 'notifications',
          diagnostic: { code: 'room-notification-projection-unavailable' },
        },
        {
          stage: 'session',
          scope: 'room-administration',
          diagnostic: { code: 'room-administration-projection-unavailable' },
        },
        {
          stage: 'session-capabilities',
          scope: 'storage',
          diagnostic: { code: 'storage-persistence-denied' },
        },
      ],
    });

    const warnings = getByTestId('app-runtime-warnings');
    expect(warnings.textContent).toContain(
      'Push notifications may be unavailable.',
    );
    expect(warnings.textContent).toContain(
      'Encryption trust status may be unavailable.',
    );
    expect(warnings.textContent).toContain('User presence may be unavailable.');
    expect(warnings.textContent).toContain(
      'Room notification settings may be unavailable.',
    );
    expect(warnings.textContent).toContain(
      'Room permissions and member lists may be unavailable.',
    );
    expect(warnings.textContent).toContain(
      'Browser storage may be evicted; Trinity will keep using best-effort local storage.',
    );
    expect(warnings.getAttribute('aria-label')).toBe(
      'Application runtime warnings',
    );
    expect(warnings.tabIndex).toBe(0);
  });

  it('presents an opaque independently recoverable background Account scope', async () => {
    const { fixture, health, getByTestId } = await setup({
      phase: 'ready',
      attempt: 1,
      warnings: [],
    });
    const retry = vi.fn(() => of({ kind: 'success' as const }));
    health.report(
      {
        capability: 'accounts',
        operation: 'restore',
        context: Symbol('@private:example.org'),
        generation: 1,
        demanded: true,
        preparation: 'failed',
        ownership: 'retained',
        condition: 'degraded',
        code: 'account-restore-transient-network',
      },
      retry,
    );
    fixture.detectChanges();

    const status = getByTestId('app-capability-health');
    expect(status.textContent).toContain(
      'A background account is unavailable.',
    );
    expect(status.textContent).not.toContain('@private:example.org');
    getByTestId('app-capability-retry').click();
    fixture.detectChanges();
    expect(retry).toHaveBeenCalledOnce();
  });
});
