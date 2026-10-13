import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TrnActionAvailability, TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { SESSION_LOCK_UNAVAILABLE_COPY } from '../../application-runtime.models';
import type { SessionLockNotice } from './session-lock-notice.model';

/** The full-page notices of a tab that does not run Trinity (#1267). */
@Component({
  selector: 'trn-session-lock-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './session-lock-notice.component.html',
  imports: [TrnButton, TrnActionAvailability, TrnSpinnerComponent],
})
export class SessionLockNoticeComponent {
  protected readonly movingHere = computed(
    () => this.notice() === 'taking-over',
  );
  protected readonly timedOut = computed(
    () => this.notice() === 'handover-timed-out',
  );
  protected readonly actionLabel = computed(() =>
    this.timedOut() ? 'Try again' : 'Use here',
  );
  protected readonly secureConnection = SESSION_LOCK_UNAVAILABLE_COPY;

  readonly notice = input.required<SessionLockNotice>();
  /** "Use here", or "Try again" after a handover timed out. */
  readonly useHere = output<void>();
  readonly showStatus = output<void>();
}
