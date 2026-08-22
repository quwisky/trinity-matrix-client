import { Directive, ElementRef, inject } from '@angular/core';
import { HlmToggleGroupItem } from '@trinity/helm/toggle-group';

/**
 * One button in a {@link TrnToggleGroupComponent}.
 *
 * Nothing is listed for re-publication, and `value`/`disabled` are still bindable on the
 * button: Angular re-publishes a host directive's inputs one level only, so naming them here
 * throws NG0311, while HlmToggleGroupItem already publishes them onto this same host element
 * from BrnToggleGroupItem. `variant` and `size` are omitted because the group sets both for
 * the whole bar — an item that could disagree with its neighbours is a bar that looks broken.
 *
 * `aria-label` stays the caller's own binding rather than something this re-publishes, so a
 * call site labels one of these buttons the way it labels every other button.
 */
@Directive({
  selector: 'button[trnToggleGroupItem]',
  hostDirectives: [
    {
      directive: HlmToggleGroupItem,
      inputs: [],
      outputs: [],
    },
  ],
  host: {
    // Roving tabindex: the group hands exactly one item a stop in the tab order and moves it
    // with the arrow keys. Seeded to -1 so a group renders with none until the group says
    // otherwise — the group sets its first enabled item on init, and a seed of 0 here would
    // briefly put every button in the tab order on the first render.
    tabindex: '-1',
  },
})
export class TrnToggleGroupItemDirective {
  readonly element: HTMLElement =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
}
