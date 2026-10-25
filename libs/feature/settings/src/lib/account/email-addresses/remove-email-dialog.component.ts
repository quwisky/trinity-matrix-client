import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import { EMAIL_ADDRESSES_COPY } from './email-addresses.copy';

/** Confirms removing one address; closes with `'remove'` when the person agrees. */
@Component({
  selector: 'trn-remove-email-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remove-email-dialog.component.html',
  imports: [TrnButton, TrnDialogActions, TrnDialogShellComponent],
})
export class RemoveEmailDialogComponent {
  private readonly ref = inject(TrnDialogRef, { optional: true });

  protected readonly copy = EMAIL_ADDRESSES_COPY;

  readonly address = input.required<string>();

  close(result?: 'remove'): void {
    this.ref?.close(result);
  }
}
