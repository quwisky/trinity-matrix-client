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

  readonly state = this.runtime.state;
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

  recover(): void {
    this.runtime
      .recover()
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe();
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
  }
}
