import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
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
  templateUrl: './message-receipts.component.html',
  styleUrl: './message-receipts.component.scss',
})
export class MessageReceiptsComponent {
  /** Whether the "seen by" reader list is expanded. */
  protected readonly seenByOpen = signal(false);

  /** Accessible label for the receipt avatars (which are decorative). */
  protected readonly seenByLabel = computed(
    () =>
      `Seen by ${this.receipts()
        .map((r) => r.name)
        .join(', ')}`,
  );

  readonly receipts = input.required<readonly ReceiptView[]>();
}
