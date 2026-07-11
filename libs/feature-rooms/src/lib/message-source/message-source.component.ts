import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { DialogRef, TrnToastService } from '@trinity/helm/overlay';

/** Dialog that shows a message event's raw JSON ("view source"), with a copy action. */
@Component({
  selector: 'trn-message-source',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButton],
  template: `
    <div
      class="flex max-h-[80vh] w-[min(90vw,40rem)] flex-col gap-3 p-4"
      data-testid="message-source"
    >
      <h2 class="text-lg font-semibold">Message source</h2>
      <pre
        class="min-h-0 flex-1 overflow-auto rounded bg-muted p-3 text-xs leading-relaxed"
        data-testid="message-source-json"
        >{{ source() }}</pre>
      <div class="flex justify-end gap-2">
        <button
          hlmBtn
          variant="outline"
          size="sm"
          (click)="copy()"
          data-testid="message-source-copy"
        >
          Copy
        </button>
        <button hlmBtn variant="ghost" size="sm" (click)="close()">
          Close
        </button>
      </div>
    </div>
  `,
})
export class MessageSourceComponent {
  /** The pre-formatted JSON to display. */
  readonly source = input.required<string>();

  private readonly dialogRef =
    inject<DialogRef<void, MessageSourceComponent>>(DialogRef);
  private readonly toast = inject(TrnToastService);

  copy(): void {
    void navigator.clipboard?.writeText(this.source());
    this.toast.show('Source copied.', { duration: 2000 });
  }

  close(): void {
    this.dialogRef.close();
  }
}
