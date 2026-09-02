import { Directive, ElementRef, inject } from '@angular/core';
import { BrnToggleGroupItem } from '@spartan-ng/brain/toggle-group';
import { classes } from '@trinity/helm/utils';
import { trnToggleRecipe } from '../toggle/trn-toggle-recipe';
import { TRN_TOGGLE_GROUP_STYLE } from './trn-toggle-group-style.token';

/**
 * One button in a {@link TrnToggleGroupComponent}.
 *
 * Brain is composed directly and only its behavior inputs are re-published, so Helm's visual
 * classes never reach the element. `value` and `disabled` remain ordinary public bindings.
 *
 * Styling inputs are deliberately absent. The parent publishes a private Trinity recipe
 * context, so every projected item receives one semantic tone, ordinal size, presentation and
 * arrangement without accepting per-item Helm vocabulary or consumer paint classes.
 *
 * `aria-label` stays the caller's own binding rather than something this re-publishes, so a
 * call site labels one of these buttons the way it labels every other button.
 */
@Directive({
  selector: 'button[trnToggleGroupItem]',
  hostDirectives: [
    {
      directive: BrnToggleGroupItem,
      inputs: ['id', 'value', 'disabled', 'state', 'aria-label', 'type'],
      outputs: ['stateChange'],
    },
  ],
  host: {
    // Roving tabindex: the group hands exactly one item a stop in the tab order and moves it
    // with the arrow keys. Seeded to -1 so a group renders with none until the group says
    // otherwise — the group sets its first enabled item on init, and a seed of 0 here would
    // briefly put every button in the tab order on the first render.
    tabindex: '-1',
    'data-trn-toggle': '',
  },
})
export class TrnToggleGroupItemDirective {
  /**
   * The button itself, for the group to move focus and the tab stop with.
   *
   * Public because the group is a separate class and has no other way to reach it — not an
   * invitation. Nothing outside {@link TrnToggleGroupComponent} should be reading it: a
   * consumer holding this holds the DOM node this tier exists to keep out of call sites.
   */
  readonly element: HTMLElement =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    const style = inject(TRN_TOGGLE_GROUP_STYLE);
    classes(() =>
      trnToggleRecipe({
        arrangement: style.resolvedArrangement(),
        presentation: style.resolvedPresentation(),
        size: style.resolvedSize(),
        variant: style.resolvedVariant(),
      }),
    );
  }
}
