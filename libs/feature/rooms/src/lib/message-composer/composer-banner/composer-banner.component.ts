import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * The bar above the composer that says what the next send will do: replace a message being
 * edited, or answer one. Editing wins when both are set.
 *
 * Presentational. The host is `display: contents`, so the banner remains a direct child of the
 * composer element.
 */
@Component({
  selector: 'trn-composer-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent],
  templateUrl: './composer-banner.component.html',
  styleUrl: './composer-banner.component.scss',
})
export class ComposerBannerComponent {
  readonly editing = input(false);
  /** Display name of the author being replied to; empty when not replying. */
  readonly replyingTo = input('');

  readonly cancelEdit = output<void>();
  readonly cancelReply = output<void>();
}
