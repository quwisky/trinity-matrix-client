import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { type MessageShield } from '@trinity/data-access/timeline';

/**
 * The not-encrypted mark beside a message's text outside the timeline (thread list, pins,
 * search, edit history), in the glyph and tone of the timeline row's own mark. Not
 * focusable: it sits inside the row's button, whose accessible name must say the same.
 */
@Component({
  selector: 'trn-unencrypted-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent],
  templateUrl: './unencrypted-mark.component.html',
  host: { class: 'inline-flex shrink-0 align-middle' },
})
export class UnencryptedMarkComponent {
  readonly shield = input.required<MessageShield>();
  readonly red = computed(() => this.shield().level === 'unencrypted');
  readonly icon = computed<TrnIconName>(() =>
    this.shield().level === 'unencrypted-history'
      ? 'lock-open'
      : 'shield-alert',
  );
}
