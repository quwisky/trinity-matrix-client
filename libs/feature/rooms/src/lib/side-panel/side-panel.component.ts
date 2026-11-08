import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { type TrnIconName } from '@trinity/components/foundations';
import { SidePanelHeaderComponent } from './side-panel-header.component';

/**
 * The frame every right-hand room panel shares: the header, an optional field strip
 * (`[sidePanelStrip]`), a body and an optional footer (`[sidePanelFooter]`). It paints the
 * sidebar surface; the slot that hosts it owns the width, the start border and the bottom inset.
 */
@Component({
  selector: 'trn-side-panel',
  imports: [SidePanelHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './side-panel.component.html',
  styleUrl: './side-panel.component.scss',
})
export class SidePanelComponent {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly icon = input<TrnIconName | null>(null);
  readonly closeLabel = input('Close');
  readonly closeTestId = input('side-panel-close');
  /** Marks the close button as the element the panel focuses when it opens. */
  readonly focusClose = input(false);
  /** The settings reuse of the member list has no panel to close, so no header. */
  readonly showHeader = input(true);
  /**
   * Whether the body scrolls and insets its rows. Off for a panel whose content is its own
   * scroller, such as the windowed member list or the thread's timeline.
   */
  readonly scroll = input(true);
  readonly closed = output<void>();
}
