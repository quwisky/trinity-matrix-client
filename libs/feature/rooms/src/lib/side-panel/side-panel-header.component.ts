import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnTooltip } from '@trinity/components/generic-content';

/**
 * The top bar every right-hand panel shares: a title and a close button. Below md a room panel
 * is a page, so the button leads the bar as a back arrow, like the room header's. The height grows by
 * the top inset rather than being eaten by it, so on a notched device the bar sits below the
 * cutout at full height. Padding is composed in one declaration; the `.safe-*` helpers would
 * fight Tailwind spacing over the same longhands.
 */
@Component({
  selector: 'trn-side-panel-header',
  imports: [TrnButton, TrnIconComponent, TrnTooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="flex-1 truncate text-base font-semibold">{{ title() }}</h2>
    <button
      trnBtn
      variant="secondary"
      presentation="ghost"
      shape="icon"
      size="md"
      [trnTooltip]="closeLabel()"
      [attr.aria-label]="closeLabel()"
      [attr.data-testid]="closeTestId()"
      [attr.data-right-panel-focus]="focusClose() ? '' : null"
      (click)="closed.emit()"
    >
      <trn-icon class="close-icon" name="x" size="lg" motion="rotate" />
      <trn-icon
        class="back-icon"
        name="arrow-left"
        size="lg"
        motion="nudge-left"
      />
    </button>
  `,
  styleUrl: './side-panel-header.component.scss',
})
export class SidePanelHeaderComponent {
  readonly title = input.required<string>();
  readonly closeLabel = input('Close');
  readonly closeTestId = input('side-panel-close');
  /** Marks the X as the element the panel focuses when it opens. */
  readonly focusClose = input(false);
  readonly closed = output<void>();
}
