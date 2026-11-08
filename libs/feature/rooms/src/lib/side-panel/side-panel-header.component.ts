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
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { TrnTooltip } from '@trinity/components/generic-content';

/** Whether the room's right-hand slot presents its panel as a page, provided by the slot. */
export const RIGHT_PANEL_PAGE = new InjectionToken<Signal<boolean>>(
  'RIGHT_PANEL_PAGE',
);

/**
 * The top bar every right-hand panel shares: the panel's icon, a title with an optional inline
 * subtitle, and a close button. Below md a room panel is a page, so the button leads the bar as
 * a Back arrow, like the room header's. Each inline padding composes its spacing and the
 * safe-area inset in one declaration.
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
    @if (icon(); as name) {
      <trn-icon class="side-panel-header__icon" [name]="name" size="lg" />
    }
    <h2 class="side-panel-header__title">
      {{ title() }}
      @if (subtitle()) {
        <span class="side-panel-header__subtitle">{{ subtitle() }}</span>
      }
    </h2>
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
        <trn-icon name="x" size="md" motion="rotate" />
      </button>
    }
  `,
  styleUrl: './side-panel-header.component.scss',
})
export class SidePanelHeaderComponent {
  readonly title = input.required<string>();
  /** Muted text after the title, such as the room a thread belongs to or a result count. */
  readonly subtitle = input('');
  readonly icon = input<TrnIconName | null>(null);
  readonly closeLabel = input('Close');
  readonly closeTestId = input('side-panel-close');
  /** Marks the button as the element the panel focuses when it opens. */
  readonly focusClose = input(false);
  readonly closed = output<void>();
  protected readonly page =
    inject(RIGHT_PANEL_PAGE, { optional: true }) ?? signal(false);
}
