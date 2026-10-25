import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnDialogActions } from '@trinity/components/overlay';
import { EMAIL_ADDRESSES_COPY } from './email-addresses.copy';

/** The "open the link, then Continue" step of verifying an email address. */
@Component({
  selector: 'trn-verify-link-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './verify-link-step.component.html',
  imports: [TrnButton, TrnDialogActions],
})
export class VerifyLinkStepComponent {
  protected readonly copy = EMAIL_ADDRESSES_COPY;

  readonly email = input.required<string>();
  readonly busy = input(false);
  readonly notVerified = input(false);
  readonly resendWaitMs = input(0);
  /** The fresh-link line, shown after a resend. */
  readonly resent = input(false);
  /** Why the last resend failed, if it did. */
  readonly error = input('');

  readonly continue = output<void>();
  readonly resend = output<void>();
  readonly cancelled = output<void>();
}
