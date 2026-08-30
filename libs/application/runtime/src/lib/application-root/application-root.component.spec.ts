import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TrnDialogService } from '@trinity/components/overlay';
import { VerificationService } from '@trinity/data-access/crypto';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ApplicationRuntimeState } from '../application-runtime.models';
import { ApplicationRuntimeService } from '../application-runtime.service';
import { ApplicationRootComponent } from './application-root.component';

describe('ApplicationRootComponent', () => {
  async function setup(initial: ApplicationRuntimeState) {
    const state = signal(initial);
    const recover = vi.fn(() => of({ kind: 'accepted' as const }));
    const rendered = await render(ApplicationRootComponent, {
      providers: [
        provideRouter([]),
        { provide: ApplicationRuntimeService, useValue: { state, recover } },
        MockProvider(MatrixClientService, { syncState: signal(null) }),
        MockProvider(VerificationService, { active: signal(null) }),
        MockProvider(TrnDialogService),
      ],
    });
    return { ...rendered, state, recover };
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
      ],
    });

    expect(getByTestId('app-runtime-warnings').textContent).toContain(
      'Push notifications may be unavailable.',
    );
  });
});
