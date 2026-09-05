import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import {
  TrnAlertService,
  TrnToasterComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import {
  ACCOUNT_REMOVAL_CONSEQUENCES,
  CLEAR_DATA_CONFIRMATION_WORD,
  CLEAR_DATA_MISTYPED_MESSAGE,
  classifyClearDataIntent,
  clearDataMessage,
} from '@trinity/data-access/accounts';
import {
  RESET_CONFIG_CONFIRMATION_WORD,
  RESET_CONFIG_CONSEQUENCES,
  RESET_CONFIG_MISTYPED_MESSAGE,
  classifyResetConfigIntent,
} from '@trinity/platform-native';
import { EMPTY, filter, map, switchMap, take, type Observable } from 'rxjs';
import {
  CapabilityHealthService,
  type ApplicationCapabilityHealth,
} from '../capability-health.service';
import { ApplicationRuntimeService } from '../application-runtime.service';
import type {
  ApplicationRecoveryOutcome,
  ApplicationRuntimeWarning,
  ApplicationStartupRecovery,
} from '../application-runtime.models';
import { preferenceFallbackMessage } from '../composition/preference-startup.policy';
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
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);

  readonly health = inject(CapabilityHealthService);
  readonly state = this.runtime.state;
  readonly capabilityProblems = computed(() =>
    this.health.problems().map((problem) => ({
      problem,
      recovering: this.health.recoveryInProgress(problem),
      message: capabilityProblemMessage(problem),
      retryLabel: capabilityRetryLabel(problem),
      statusTestId: capabilityStatusTestId(problem),
      retryTestId: capabilityRetryTestId(problem),
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
    const recovery = this.blocked()?.failure.recovery;
    if (!recovery) return;
    this.confirmedRecovery(recovery)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => this.presentRecoveryOutcome(outcome));
  }

  private confirmedRecovery(
    recovery: ApplicationStartupRecovery,
  ): Observable<ApplicationRecoveryOutcome> {
    if (recovery === 'reauthenticate') {
      return this.alert
        .confirm$({
          header: 'Remove account and sign in again',
          message: ACCOUNT_REMOVAL_CONSEQUENCES,
          confirmText: 'Remove account',
          cancelText: 'Cancel',
          variant: 'danger',
        })
        .pipe(
          filter(Boolean),
          switchMap(() => this.runtime.recover()),
        );
    }
    if (recovery === 'reset-installation') {
      return this.alert
        .prompt$({
          header: 'Erase all Trinity data',
          message: clearDataMessage(null),
          placeholder: CLEAR_DATA_CONFIRMATION_WORD,
          inputLabel: `Type ${CLEAR_DATA_CONFIRMATION_WORD} to confirm`,
          confirmText: 'Erase everything',
          cancelText: 'Cancel',
          variant: 'danger',
        })
        .pipe(
          map(classifyClearDataIntent),
          switchMap((intent) => {
            if (intent === 'mistyped') {
              this.toast.show(CLEAR_DATA_MISTYPED_MESSAGE, { duration: 4000 });
            }
            return intent === 'confirmed' ? this.runtime.recover() : EMPTY;
          }),
        );
    }
    if (recovery === 'reset-preferences') {
      return this.alert
        .prompt$({
          header: 'Reset settings to defaults',
          message: `${RESET_CONFIG_CONSEQUENCES}\n\nType ${RESET_CONFIG_CONFIRMATION_WORD} to confirm.`,
          placeholder: RESET_CONFIG_CONFIRMATION_WORD,
          inputLabel: `Type ${RESET_CONFIG_CONFIRMATION_WORD} to confirm`,
          confirmText: 'Reset settings',
          cancelText: 'Cancel',
          variant: 'danger',
        })
        .pipe(
          map(classifyResetConfigIntent),
          switchMap((intent) => {
            if (intent === 'mistyped') {
              this.toast.show(RESET_CONFIG_MISTYPED_MESSAGE, {
                duration: 4000,
              });
            }
            return intent === 'confirmed' ? this.runtime.recover() : EMPTY;
          }),
        );
    }
    return this.runtime.recover();
  }

  private presentRecoveryOutcome(recovery: ApplicationRecoveryOutcome): void {
    if (recovery.kind !== 'unavailable') return;
    if (recovery.reason === 'cleanup-in-progress') {
      this.toast.show(
        'Cleanup is still running. Leaving this screen does not cancel it; use recovery again to observe the same attempt.',
        { duration: 6000 },
      );
      return;
    }
    if (recovery.reason === 'partial-cleanup') {
      const restartRequired = recovery.cleanup.issues.some(
        ({ recovery }) => recovery === 'restart-application',
      );
      this.toast.show(
        restartRequired
          ? 'Cleanup finished with some residue. Restart Trinity before trying recovery again.'
          : 'Cleanup finished with residue. Use recovery again to retry only the remaining safe work.',
        { duration: 6000 },
      );
    }
  }
}

function capabilityProblemMessage(
  problem: ApplicationCapabilityHealth,
): string {
  if (problem.capability === 'accounts') {
    return 'A background account is unavailable. Other accounts and open conversations remain usable.';
  }
  switch (problem.capability) {
    case 'identity':
      return 'User presence is unavailable. Online status is unknown; you can keep messaging.';
    case 'preferences':
      if (problem.operation === 'apply-appearance') {
        return 'Appearance updates are paused. The last applied appearance remains active.';
      }
      return (
        preferenceFallbackMessage(problem.operation) ??
        'One preference operation is using a safe default. Other settings remain available.'
      );
    case 'room-library':
      return 'Saved room ordering is unavailable for one Account. The default order remains usable.';
    case 'trust':
      return 'Current encryption trust status is unavailable. Verification and recovery state are unknown; encrypted conversations remain usable.';
    case 'notifications':
      return problem.operation === 'room-rules'
        ? 'Room notification settings are unavailable. Their last known values may be stale; notification delivery continues independently.'
        : 'Trinity cannot currently show new device notifications. Messaging and Room notification settings remain usable.';
    case 'room-administration':
      switch (problem.operation) {
        case 'permissions':
          return 'Current Room permissions are unavailable. Administrative changes are paused; messaging remains usable.';
        case 'members':
          return 'Current Room membership is unavailable. A visible member list may be stale; messaging remains usable.';
        case 'bans':
          return 'Current Room bans are unavailable. A visible ban list may be stale; other Room settings remain usable.';
        default:
          return 'Current Room administration data is unavailable. Existing informational data may be stale.';
      }
    case 'push':
      return 'Mobile push registration is unavailable. Notifications may not arrive while Trinity is closed; in-app messaging remains usable.';
    case 'badge':
      return 'App-icon badge support is unavailable. Unread counts remain visible inside Trinity.';
    case 'updates':
      return 'Automatic update checks are unavailable. Trinity remains usable; check the app store or reload the installed app later.';
    default:
      return 'One optional capability is unavailable. The rest of Trinity remains usable.';
  }
}

function capabilityRetryLabel(problem: ApplicationCapabilityHealth): string {
  switch (problem.capability) {
    case 'accounts':
      return 'Retry background account';
    case 'identity':
      return 'Retry presence';
    case 'preferences':
      return 'Retry preference';
    case 'room-library':
      return 'Retry room ordering';
    case 'trust':
      return 'Retry Trust status';
    case 'notifications':
      return problem.operation === 'room-rules'
        ? 'Retry Room settings'
        : 'Retry notifications';
    case 'room-administration':
      return 'Retry Room administration';
    case 'push':
      return 'Retry mobile push';
    case 'badge':
      return 'Retry badge support';
    case 'updates':
      return 'Retry update check';
    default:
      return 'Retry capability';
  }
}

function capabilityStatusTestId(problem: ApplicationCapabilityHealth): string {
  if (problem.capability === 'identity') return 'app-presence-health';
  if (problem.capability === 'trust') return 'app-trust-health';
  if (problem.capability === 'notifications')
    return problem.operation === 'room-rules'
      ? 'app-notification-rules-health'
      : 'app-notification-presentation-health';
  if (problem.capability === 'room-administration')
    return `app-room-${problem.operation}-health`;
  if (problem.capability === 'push') return 'app-push-health';
  if (problem.capability === 'badge') return 'app-badge-health';
  if (problem.capability === 'updates') return 'app-updates-health';
  return 'app-capability-health';
}

function capabilityRetryTestId(problem: ApplicationCapabilityHealth): string {
  return capabilityStatusTestId(problem).replace('-health', '-retry');
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
