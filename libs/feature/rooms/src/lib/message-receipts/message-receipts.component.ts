import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import {
  AvatarComponent,
  TrnTooltip,
} from '@trinity/components/generic-content';
import { type ReceiptView } from '@trinity/data-access/timeline';

/** Who has read the newest message, in a strip under the conversation; a click names them. */
@Component({
  selector: 'trn-message-receipts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnTooltip],
  host: {
    '(document:pointerdown)': 'closeOutside($event)',
    '(document:keydown.escape)': 'seenByOpen.set(false)',
  },
  templateUrl: './message-receipts.component.html',
  styleUrl: './message-receipts.component.scss',
})
export class MessageReceiptsComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Accessible label for the receipt avatars (which are decorative). */
  protected readonly seenByLabel = computed(
    () =>
      `Seen by ${this.receipts()
        .map((r) => r.name)
        .join(', ')}`,
  );

  readonly receipts = input.required<readonly ReceiptView[]>();

  /** Whether the "seen by" reader list is expanded; closes when the readers change. */
  protected readonly seenByOpen = linkedSignal({
    source: () =>
      this.receipts()
        .map((receipt) => receipt.userId)
        .join(),
    computation: () => false,
  });

  protected closeOutside(event: Event): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.seenByOpen.set(false);
    }
  }
}
