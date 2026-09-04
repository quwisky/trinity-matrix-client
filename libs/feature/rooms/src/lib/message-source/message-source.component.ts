import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogRef,
  TrnOverlaySurfaceDirective,
  TrnToastService,
} from '@trinity/components/overlay';

/** Dialog that shows a message event's raw JSON ("view source"), with a copy action. */
@Component({
  selector: 'trn-message-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnOverlaySurfaceDirective],
  template: `
    <div
      trnOverlaySurface
      variant="neutral"
      size="xl"
      layout="dialog"
      class="flex flex-col gap-3 p-4"
      data-testid="message-source"
    >
      <h2 class="text-lg font-semibold">Message source</h2>
      <pre
        class="rounded min-h-0 flex-1 overflow-auto bg-muted p-3 text-xs leading-relaxed"
        data-testid="message-source-json"
        >{{ source() }}</pre>
      <div class="flex justify-end gap-2">
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
          presentation="ghost"
          size="sm"
          (click)="close()"
        >
          Close
        </button>
      </div>
    </div>
  `,
})
export class MessageSourceComponent {
  /** The pre-formatted JSON to display. */
  readonly source = input.required<string>();

  private readonly dialogRef = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly toast = inject(TrnToastService);

  /** Copy the source, toasting only once the write resolves — never on a rejection. */
  copy(): void {
    void (
      navigator.clipboard?.writeText(this.source()) ?? Promise.reject()
    ).then(
      () => this.toast.show('Source copied.', { duration: 2000 }),
      () => this.toast.show('Could not copy the source.', { duration: 2000 }),
    );
  }

  close(): void {
    this.dialogRef.close();
  }
}
