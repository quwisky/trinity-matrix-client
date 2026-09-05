import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  inject,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  AvatarComponent,
  TrnSpinnerComponent,
} from '@trinity/components/generic-content';
import { TrnOverlaySurfaceDirective } from '@trinity/components/overlay';
import { isMobileOs } from '@trinity/platform-native';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import { take } from 'rxjs';
import { ApplicationRuntimeService } from '../../application-runtime.service';
import {
  CapabilityStatusService,
  type CapabilityStatusEntry,
} from '../../capability-status.service';
import { ApplicationRecoveryPresenter } from '../application-recovery.presenter';

@Component({
  selector: 'trn-system-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    TrnButton,
    TrnOverlaySurfaceDirective,
    TrnSpinnerComponent,
  ],
  templateUrl: './system-status.component.html',
  styleUrl: './system-status.component.scss',
  host: {
    '[class.system-status--mobile]': 'mobile',
    '(document:keydown)': 'keydown($event)',
  },
})
export class SystemStatusComponent implements AfterViewInit {
  readonly status = inject(CapabilityStatusService);
  readonly mobile = isMobileOs();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly runtime = inject(ApplicationRuntimeService);
  private readonly startupRecovery = inject(ApplicationRecoveryPresenter);

  @ViewChild('heading', { read: ElementRef })
  private readonly heading?: ElementRef<HTMLElement>;

  ngAfterViewInit(): void {
    this.heading?.nativeElement.focus();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.status.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), summary, [tabindex]',
      ),
    ].filter(
      (element) =>
        element.getClientRects().length > 0 &&
        (!element.closest('details:not([open])') ||
          element.tagName === 'SUMMARY'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  protected retry(entry: CapabilityStatusEntry): void {
    this.status.retry(entry);
  }

  protected recoverStartup(): void {
    const state = this.runtime.state();
    if (state.phase !== 'blocked') return;
    this.startupRecovery
      .confirmAndRecover(state.failure.recovery)
      .pipe(take(1))
      .subscribe((outcome) => this.startupRecovery.present(outcome));
  }

  protected recoveryMessage(
    outcome: CapabilityRecoveryOutcome | null,
  ): string | null {
    switch (outcome?.kind) {
      case 'pending':
        return 'Recovery is in progress. Reopening this view follows the same attempt.';
      case 'success':
        return 'Recovery completed.';
      case 'unavailable':
        return 'Recovery is no longer available for this scope.';
      case 'transition-in-progress':
        return 'Another Account transition is in progress. Try again after it settles.';
      case 'timeout':
        return 'Recovery is still unresolved after its observation window. It was not cancelled.';
      case 'failure':
        return 'Recovery settled without restoring this capability.';
      case 'partial':
        return 'Recovery completed partially. Remaining work is shown here.';
      case 'uncertain':
        return 'Recovery ownership is uncertain. Restart Trinity before trying again.';
      default:
        return null;
    }
  }
}
