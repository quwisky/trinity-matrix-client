import {
  ChangeDetectionStrategy,
  Component,
  InjectionToken,
  inject,
  input,
  output,
  signal,
  type Signal,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import { TrnTooltip } from '@trinity/components/generic-content';

/** Whether the room's right-hand slot presents its panel as a page, provided by the slot. */
export const RIGHT_PANEL_PAGE = new InjectionToken<Signal<boolean>>(
  'RIGHT_PANEL_PAGE',
);

/**
 * The top bar every right-hand panel shares: a title and a close button. Below md a room panel
 * is a page, so the button leads the bar as a Back arrow, like the room header's. The height
 * grows by the top inset rather than being eaten by it, so on a notched device the bar sits
 * below the cutout at full height. Padding is composed in one declaration; the `.safe-*`
 * helpers would fight Tailwind spacing over the same longhands.
 */
@Component({
  selector: 'trn-side-panel-header',
  imports: [TrnButton, TrnIconComponent, TrnTooltip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (page()) {
      <button
        trnBtn
        variant="secondary"
        presentation="ghost"
        shape="icon"
        size="md"
        trnTooltip="Back"
        aria-label="Back"
        [attr.data-testid]="closeTestId()"
        [attr.data-right-panel-focus]="focusClose() ? '' : null"
        (click)="closed.emit()"
      >
        <trn-icon name="arrow-left" size="lg" motion="nudge-left" />
      </button>
    }
    <div class="min-w-0 flex-1">
      <h2 class="truncate text-base font-semibold">{{ title() }}</h2>
      @if (subtitle()) {
        <p class="truncate text-xs text-muted-foreground">{{ subtitle() }}</p>
      }
    </div>
    @if (!page()) {
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
        <trn-icon name="x" size="lg" motion="rotate" />
      </button>
    }
  `,
  styleUrl: './side-panel-header.component.scss',
})
export class SidePanelHeaderComponent {
  readonly title = input.required<string>();
  /** A secondary line under the title, such as the room a panel belongs to. */
  readonly subtitle = input('');
  readonly closeLabel = input('Close');
  readonly closeTestId = input('side-panel-close');
  /** Marks the button as the element the panel focuses when it opens. */
  readonly focusClose = input(false);
  readonly closed = output<void>();
  protected readonly page =
    inject(RIGHT_PANEL_PAGE, { optional: true }) ?? signal(false);
}
