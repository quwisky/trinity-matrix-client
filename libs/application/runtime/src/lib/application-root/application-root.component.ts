import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  PRIMARY_OUTLET,
  Router,
  RouterOutlet,
} from '@angular/router';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { TrnToasterComponent } from '@trinity/components/overlay';
import { filter, map, take } from 'rxjs';
import { ApplicationRuntimeService } from '../application-runtime.service';
import type {
  ApplicationStartupRecovery,
  ApplicationStartupStage,
} from '../application-runtime.models';
import { CapabilityStatusService } from '../capability-status.service';
import { VerificationHostComponent } from '../verification-host/verification-host.component';
import { ApplicationRecoveryPresenter } from './application-recovery.presenter';
import { SystemStatusComponent } from './system-status/system-status.component';
import { TrinityApplicationSessionAdapter } from '../composition/trinity-application-session.adapter';

@Component({
  selector: 'trn-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './application-root.component.html',
  styleUrl: './application-root.component.scss',
  imports: [
    RouterOutlet,
    TrnButton,
    VerificationHostComponent,
    TrnToasterComponent,
    TrnSpinnerComponent,
    SystemStatusComponent,
  ],
})
export class ApplicationRootComponent {
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly recovery = inject(ApplicationRecoveryPresenter);
  private readonly session = inject(TrinityApplicationSessionAdapter);
  private readonly router = inject(Router);
  private readonly showStartupDetail = signal(false);
  private readonly routeUrl = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly status = inject(CapabilityStatusService);
  readonly state = this.runtime.state;
  readonly booting = computed(() => {
    const phase = this.state().phase;
    return phase === 'stopped' || phase === 'starting' || phase === 'stopping';
  });
  readonly startupStep = computed(() => {
    const state = this.state();
    return state.phase === 'starting' && this.showStartupDetail()
      ? startupStep(state.stage)
      : null;
  });
  readonly blocked = computed(() => {
    const state = this.state();
    return state.phase === 'blocked' ? state : null;
  });
  readonly recoveryAction = computed(() =>
    recoveryAction(this.blocked()?.failure.recovery ?? 'retry-startup'),
  );

  protected readonly isShellRoute = computed(
    () =>
      this.router.parseUrl(this.routeUrl()).root.children[PRIMARY_OUTLET]
        ?.segments[0]?.path === 'rooms',
  );

  constructor() {
    this.session
      .runInteractions()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
    const timer = window.setTimeout(
      () => this.showStartupDetail.set(true),
      500,
    );
    this.destroyRef.onDestroy(() => window.clearTimeout(timer));
  }

  dismissSummary(): void {
    for (const entry of this.status.visibleEntries())
      this.status.dismiss(entry);
  }

  recover(): void {
    const recovery = this.blocked()?.failure.recovery;
    if (!recovery) return;
    this.recovery
      .confirmAndRecover(recovery)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => this.recovery.present(outcome));
  }
}

function startupStep(stage: ApplicationStartupStage): string {
  switch (stage) {
    case 'host-negotiation':
      return 'Checking this device…';
    case 'preference-hydration':
      return 'Restoring your preferences…';
    case 'account-restoration':
      return 'Restoring your Accounts…';
    case 'session-capabilities':
      return 'Preparing messaging…';
    case 'workspace-restoration':
      return 'Opening your Workspace…';
    case 'readiness':
      return 'Finishing startup…';
  }
}

function recoveryAction(recovery: ApplicationStartupRecovery): {
  readonly label: string;
  readonly detail: string;
} {
  switch (recovery) {
    case 'reauthenticate':
      return {
        label: 'Sign in again',
        detail:
          'The required Account session is unavailable. Remove it and return to sign in.',
      };
    case 'reset-installation':
      return {
        label: 'Reset this installation',
        detail:
          'Required local application data is unavailable. Erase it and return to sign in.',
      };
    case 'reset-preferences':
      return {
        label: 'Reset preferences',
        detail:
          'Required preferences could not be read. Restore local defaults and try again.',
      };
    case 'retry-startup':
      return {
        label: 'Retry startup',
        detail:
          'A required part of Trinity did not become ready. Your data was not rolled back.',
      };
  }
}
