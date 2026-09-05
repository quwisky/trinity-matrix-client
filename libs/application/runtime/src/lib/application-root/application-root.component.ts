import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import { TrnToasterComponent } from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { take } from 'rxjs';
import {
  CapabilityHealthService,
  type ApplicationCapabilityHealth,
} from '../capability-health.service';
import { ApplicationRuntimeService } from '../application-runtime.service';
import type {
  ApplicationRuntimeWarning,
  ApplicationStartupRecovery,
} from '../application-runtime.models';
import { VerificationHostComponent } from '../verification-host/verification-host.component';

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
  ],
})
export class ApplicationRootComponent {
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly health = inject(CapabilityHealthService);
  readonly state = this.runtime.state;
  readonly capabilityProblems = computed(() =>
    this.health.problems().map((problem) => ({
      problem,
      recovering: this.health.recoveryInProgress(problem),
      message: capabilityProblemMessage(problem),
      retryLabel: capabilityRetryLabel(problem),
      statusTestId:
        problem.capability === 'identity'
          ? 'app-presence-health'
          : 'app-capability-health',
      retryTestId:
        problem.capability === 'identity'
          ? 'app-presence-retry'
          : 'app-capability-retry',
    })),
  );
  readonly booting = computed(() => {
    const phase = this.state().phase;
    return phase === 'stopped' || phase === 'starting' || phase === 'stopping';
  });
  readonly blocked = computed(() => {
    const state = this.state();
    return state.phase === 'blocked' ? state : null;
  });
  readonly recoveryAction = computed(() =>
    recoveryAction(this.blocked()?.failure.recovery ?? 'retry-startup'),
  );
  readonly warnings = computed(() => {
    const state = this.state();
    return state.phase === 'ready'
      ? state.warnings.map(warningMessage)
      : ([] as readonly string[]);
  });

  retryCapability(problem: ApplicationCapabilityHealth): void {
    this.health
      .recover(problem)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  recover(): void {
    this.runtime
      .recover()
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}

function capabilityProblemMessage(
  problem: ApplicationCapabilityHealth,
): string {
  if (problem.capability === 'accounts') {
    return 'A background account is unavailable. Other accounts and open conversations remain usable.';
  }
  return 'User presence is unavailable. Online status is unknown; you can keep messaging.';
}

function capabilityRetryLabel(problem: ApplicationCapabilityHealth): string {
  return problem.capability === 'accounts'
    ? 'Retry background account'
    : 'Retry presence';
}

function recoveryAction(recovery: ApplicationStartupRecovery): {
  readonly label: string;
  readonly detail: string;
} {
  switch (recovery) {
    case 'reauthenticate':
      return {
        label: 'Sign in again',
        detail: 'Remove the unavailable account session and return to sign in.',
      };
    case 'reset-installation':
      return {
        label: 'Reset this installation',
        detail: 'Clear local application data, then return to sign in.',
      };
    case 'reset-preferences':
      return {
        label: 'Reset preferences',
        detail:
          'Restore local preferences to their defaults and try startup again.',
      };
    case 'retry-startup':
      return {
        label: 'Retry',
        detail: 'Try the complete startup sequence again.',
      };
  }
}

function warningMessage(warning: ApplicationRuntimeWarning): string {
  switch (warning.scope) {
    case 'push':
      return 'Push notifications may be unavailable.';
    case 'notifications':
      return 'Room notification settings may be unavailable.';
    case 'badge':
      return 'App badge updates may be unavailable.';
    case 'updates':
      return 'Automatic update checks may be unavailable.';
    case 'accounts':
      return 'One inactive account could not be restored.';
    case 'preferences':
      return 'Some preferences could not be restored.';
    case 'host':
      return 'Some host integrations may be unavailable.';
    case 'workspace':
      return 'Some workspace state could not be restored.';
    case 'trust':
      return 'Encryption trust status may be unavailable.';
    case 'identity':
      return 'User presence may be unavailable.';
    case 'room-administration':
      return 'Room permissions and member lists may be unavailable.';
    case 'storage':
      return 'Browser storage may be evicted; Trinity will keep using best-effort local storage.';
  }
}
