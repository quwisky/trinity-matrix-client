import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { copyText } from '../shared/copy-text';
import {
  TrnDialogRef,
  TrnDialogActions,
  TrnDialogShellComponent,
  TrnToastService,
} from '@trinity/components/overlay';

/** Dialog that shows a message event's raw JSON ("view source"), with a copy action. */
@Component({
  selector: 'trn-message-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnDialogActions, TrnDialogShellComponent],
  template: `
    <trn-dialog-shell
      title="Message source"
      size="xl"
      (closed)="close()"
      data-testid="message-source"
    >
      <pre
        class="rounded overflow-auto bg-muted p-3 text-xs leading-relaxed"
        data-testid="message-source-json"
        >{{ source() }}</pre>
      <div trnDialogActions>
        <button
          trnBtn
          variant="secondary"
          presentation="outline"
          size="sm"
          (click)="copy()"
          data-testid="message-source-copy"
        >
          Copy
        </button>
        <button
          trnBtn
          variant="secondary"
          presentation="link"
          size="sm"
          (click)="close()"
        >
          Close
        </button>
      </div>
    </trn-dialog-shell>
  `,
})
export class MessageSourceComponent {
  /** The pre-formatted JSON to display. */
  readonly source = input.required<string>();

  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly toast = inject(TrnToastService);

  /** Copy the source, toasting only once the write resolves — never on a rejection. */
  copy(): void {
    copyText(this.source(), 'Source', this.toast);
  }

  close(): void {
    this.dialogRef.close();
  }
}
